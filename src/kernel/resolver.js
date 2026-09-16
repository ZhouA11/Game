// 互通内核 · 事件解析器 Resolver（T1.5）
// 小游戏在结算链固定挂载点发布事件，Resolver 统一执行：
//   查库存 → 等级匹配过滤 → 按优先级应用 → 消耗道具 → 写效果流水
// 与游戏结算同事务：本模块只返回语句（stmts）与效果（effects），由游戏并入其结算 batch；
// 任一步失败，D1 batch 整体回滚。游戏类道具效果只能从预置动作类型组合（§2.1，不允许自由逻辑）。

import { KernelError } from './util.js'

// 挂载点清单（§2.1：grab.before / spin.before / penalty.before 等）
export const MOUNT_EVENTS = [
  'grab.before', 'grab.after',
  'spin.before', 'spin.after',
  'penalty.before', 'fever.end',
]

// 预置动作类型（道具效果只能从中选择；spank_reduce 为减免券专用、一律手动，不进入自动解析）
export const ITEM_ACTIONS = [
  'rate_boost', 'reveal', 'insurance', 'reroll',
  'nudge_pack', 'fever_boost', 'spank_reduce',
]

// 游戏作用域：all 全部 / grab 爪机限定 / slot 老虎机限定
const SCOPES = ['all', 'grab', 'slot']

/**
 * 解析挂载点事件：返回需要消耗的自动挂载道具及其效果。
 *
 * @param {object} DB
 * @param {object} opts
 *   - username {string}
 *   - game {string}      游戏标识（写流水用）
 *   - event {string}     挂载点（须在 MOUNT_EVENTS 内）
 *   - scope {string}     调用方游戏作用域 grab / slot
 *   - filterFn {Function} 可选，游戏侧上下文过滤（如连败保险仅在连败3次后生效），
 *                         入参为库存行 { item_id, name, action, action_value, priority }，
 *                         返回 false 则跳过该道具
 * @returns {Promise<{effects: object[], stmts: object[]}>}
 *   effects：按优先级升序的效果描述（游戏据此修改结算结果）
 */
export async function resolveEventStmts(DB, opts) {
  const { username, game, event, scope = 'all', filterFn = null } = opts
  if (!MOUNT_EVENTS.includes(event)) {
    throw new KernelError('INVALID_PARAM', `未知的挂载点：${event}`)
  }
  if (!SCOPES.includes(scope)) {
    throw new KernelError('INVALID_PARAM', '道具作用域不正确')
  }

  // 1. 查库存：自动挂载生效的道具（玩家开关 COALESCE 优先于模板默认）
  const rows = await DB.prepare(
    `SELECT p.item_id, p.count, p.auto_mount AS user_auto, t.name, t.action, t.action_value,
            t.priority, t.scope, t.auto_mount, t.rarity
     FROM player_items p
     JOIN item_templates t ON t.id = p.item_id
     WHERE p.username = ? AND p.count > 0
       AND t.is_active = 1 AND t.category = 'game'
       AND COALESCE(p.auto_mount, t.auto_mount) = 1
       AND (',' || t.mount_events || ',') LIKE ('%,' || ? || ',%')
       AND (t.scope = 'all' OR t.scope = ?)
     ORDER BY t.priority ASC, t.id ASC`
  ).bind(username, event, scope).all()

  const effects = []
  const stmts = []
  for (const row of (rows.results || [])) {
    // 游戏侧上下文过滤（不引入自由逻辑，仅是开关判断）
    if (typeof filterFn === 'function' && !filterFn(row)) continue

    // 3. 按优先级应用（SQL 已按 priority ASC 排序）→ 4. 消耗道具 → 5. 写效果流水
    stmts.push(DB.prepare(
      `UPDATE player_items SET count = count - 1, updated_at = datetime('now')
       WHERE username = ? AND item_id = ? AND count >= 1`
    ).bind(username, row.item_id))
    stmts.push(DB.prepare(
      'INSERT INTO effect_logs (username, game, event, item_id, action, value, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, game, event, row.item_id, row.action, row.action_value,
      JSON.stringify({ name: row.name, priority: row.priority })))

    effects.push({
      itemId: row.item_id,
      name: row.name,
      action: row.action,
      value: row.action_value,
      priority: row.priority,
    })
  }

  return { effects, stmts }
}

/**
 * 独立执行解析（自带事务）。一般由游戏在结算链中调用：
 * const { effects, stmts } = await resolveEventStmts(...)
 * 游戏把 stmts 与自身结算语句合并为一个 batch 提交，保证同事务。
 */
export async function resolveEvent(DB, opts) {
  const { effects, stmts } = await resolveEventStmts(DB, opts)
  if (stmts.length > 0) await DB.batch(stmts)
  return { effects }
}

/**
 * 玩家道具自动挂载开关（G：道具库存与自动挂载开关）
 * mode: 'default' 跟随模板默认 / 'on' 强制开 / 'off' 强制关
 */
export async function setAutoMount(DB, username, itemId, mode) {
  const tpl = await DB.prepare(
    "SELECT id FROM item_templates WHERE id = ? AND category = 'game' AND is_active = 1"
  ).bind(itemId).first()
  if (!tpl) throw new KernelError('NOT_FOUND', '道具不存在', 404)

  const value = mode === 'on' ? 1 : mode === 'off' ? 0 : null
  const existing = await DB.prepare(
    'SELECT username FROM player_items WHERE username = ? AND item_id = ?'
  ).bind(username, itemId).first()
  if (existing) {
    await DB.prepare(
      "UPDATE player_items SET auto_mount = ?, updated_at = datetime('now') WHERE username = ? AND item_id = ?"
    ).bind(value, username, itemId).run()
  } else {
    await DB.prepare(
      'INSERT INTO player_items (username, item_id, count, auto_mount) VALUES (?, ?, 0, ?)'
    ).bind(username, itemId, value).run()
  }
  return { itemId, autoMount: mode }
}
