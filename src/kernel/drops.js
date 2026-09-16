// 互通内核 · 掉落池引用（T1.3，§4）
// 游戏掉落表 = 模板ID + 权重的引用表（ref_type 五类：金币/道具/奖励/惩罚/碎片）
// 并按选项叠加奖励侧/惩罚侧总控概率；后台改模板或概率即时生效（走配置版本）

import { KernelError, toInt, toMoney } from './util.js'
import { audit, auditStmt } from './templates.js'
import { ledgerStmts } from './ledger.js'
import { applyPenaltyStmts } from './spank.js'
import { grantRewardStmts } from './backpack.js'
import { grantFragmentStmts } from './fragments.js'

export const REF_TYPES = ['coin', 'item', 'reward', 'penalty', 'fragment']
export const SIDES = ['reward', 'penalty']

// ---------- 掉落池 CRUD（管理员，步骤6后台接UI） ----------
export async function listDropPools(DB, game) {
  const rows = game
    ? await DB.prepare('SELECT * FROM drop_pools WHERE game = ? ORDER BY option, side, id').bind(game).all()
    : await DB.prepare('SELECT * FROM drop_pools ORDER BY game, option, side, id').all()
  return rows.results || []
}

// 校验引用合法性：ref_type 对应模板必须存在（§5：商品引用非法对象要拦截）
async function validateEntry(DB, { side, ref_type, ref_id, amount }) {
  if (!SIDES.includes(side)) throw new KernelError('INVALID_PARAM', '落侧只能是 reward 或 penalty')
  if (!REF_TYPES.includes(ref_type)) throw new KernelError('INVALID_REF', '引用类型非法（仅允许金币/道具/奖励/惩罚/碎片）')
  if (ref_type === 'coin') {
    if (!amount || toMoney(amount) <= 0) throw new KernelError('INVALID_REF', '金币条目必须配置正数金额')
    return
  }
  if (!ref_id) throw new KernelError('INVALID_REF', '该类型条目必须引用模板ID')
  if (ref_type === 'item') {
    const t = await DB.prepare('SELECT id FROM item_templates WHERE id = ? AND is_active = 1').bind(ref_id).first()
    if (!t) throw new KernelError('INVALID_REF', '引用的道具模板不存在或已停用')
  } else if (ref_type === 'reward') {
    const t = await DB.prepare('SELECT id FROM reward_templates WHERE id = ? AND is_active = 1').bind(ref_id).first()
    if (!t) throw new KernelError('INVALID_REF', '引用的奖励模板不存在或已停用')
    // G8：奖励只能从游戏产出——掉落池正是游戏产出入口，无需额外限制
  } else if (ref_type === 'penalty') {
    const t = await DB.prepare('SELECT id FROM penalty_templates WHERE id = ? AND is_active = 1').bind(ref_id).first()
    if (!t) throw new KernelError('INVALID_REF', '引用的惩罚道具模板不存在或已停用')
  } else if (ref_type === 'fragment') {
    const r = await DB.prepare('SELECT id FROM fragment_recipes WHERE id = ? AND is_active = 1').bind(ref_id).first()
    if (!r) throw new KernelError('INVALID_REF', '引用的碎片配方不存在或已停用')
  }
}

export async function createDropEntry(DB, data, operator = '') {
  const game = String(data.game || '').trim()
  if (!game) throw new KernelError('INVALID_PARAM', '缺少游戏标识')
  const option = String(data.option || 'default').trim() || 'default'
  const side = data.side === 'penalty' ? 'penalty' : 'reward'
  const ref_type = String(data.ref_type || '')
  const ref_id = data.ref_id ? toInt(data.ref_id, 0, 1, 1e12) : null
  const amount = data.amount !== undefined && data.amount !== null ? toMoney(data.amount) : null
  await validateEntry(DB, { side, ref_type, ref_id, amount })
  const weight = toMoney(data.weight, 1)
  if (weight <= 0) throw new KernelError('INVALID_PARAM', '权重必须大于0')

  const result = await DB.prepare(
    `INSERT INTO drop_pools (game, option, side, ref_type, ref_id, amount, weight) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(game, option, side, ref_type, ref_id, amount, weight).run()
  const created = await DB.prepare('SELECT * FROM drop_pools WHERE id = ?').bind(result.meta.last_row_id).first()
  await audit(DB, { scope: 'drop_pool', action: 'create', targetId: created.id, before: null, after: created, operator })
  return created
}

export async function updateDropEntry(DB, id, data, operator = '') {
  const before = await DB.prepare('SELECT * FROM drop_pools WHERE id = ?').bind(id).first()
  if (!before) throw new KernelError('NOT_FOUND', '掉落池条目不存在', 404)
  const merged = { ...before, ...data }
  const side = merged.side === 'penalty' ? 'penalty' : 'reward'
  const ref_id = merged.ref_id ? toInt(merged.ref_id, 0, 1, 1e12) : null
  await validateEntry(DB, { side, ref_type: merged.ref_type, ref_id, amount: merged.amount })
  const weight = toMoney(merged.weight, 1)
  if (weight <= 0) throw new KernelError('INVALID_PARAM', '权重必须大于0')

  await DB.prepare(
    `UPDATE drop_pools SET option = ?, side = ?, ref_type = ?, ref_id = ?, amount = ?, weight = ?,
      is_active = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(
    String(merged.option || 'default'), side, merged.ref_type, ref_id, merged.amount, weight,
    merged.is_active ? 1 : 0, id
  ).run()
  const after = await DB.prepare('SELECT * FROM drop_pools WHERE id = ?').bind(id).first()
  await audit(DB, { scope: 'drop_pool', action: 'update', targetId: id, before, after, operator })
  return after
}

export async function deleteDropEntry(DB, id, operator = '') {
  const before = await DB.prepare('SELECT * FROM drop_pools WHERE id = ?').bind(id).first()
  if (!before) throw new KernelError('NOT_FOUND', '掉落池条目不存在', 404)
  await DB.prepare('DELETE FROM drop_pools WHERE id = ?').bind(id).run()
  await audit(DB, { scope: 'drop_pool', action: 'delete', targetId: id, before, after: null, operator })
  return { deleted: true }
}

// ---------- 奖励侧/惩罚侧总控概率 ----------
export async function getSideControls(DB, game, option = 'default') {
  const row = await DB.prepare(
    'SELECT reward_side_prob, penalty_side_prob FROM drop_side_controls WHERE game = ? AND option = ?'
  ).bind(game, option).first()
  return row
    ? { reward_side_prob: row.reward_side_prob, penalty_side_prob: row.penalty_side_prob }
    : { reward_side_prob: 0.5, penalty_side_prob: 0.5 }
}

export async function setSideControls(DB, game, option, rewardSideProb, penaltySideProb, operator = '') {
  if (!game) throw new KernelError('INVALID_PARAM', '缺少游戏标识')
  const rw = toMoney(rewardSideProb)
  const pw = toMoney(penaltySideProb)
  if (rw < 0 || pw < 0) throw new KernelError('INVALID_PARAM', '总控概率不能为负数')
  await DB.prepare(
    `INSERT INTO drop_side_controls (game, option, reward_side_prob, penalty_side_prob)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(game, option) DO UPDATE SET
       reward_side_prob = excluded.reward_side_prob,
       penalty_side_prob = excluded.penalty_side_prob,
       updated_at = datetime('now')`
  ).bind(game, option || 'default', rw, pw).run()
  await audit(DB, { scope: 'drop_control', action: 'update', targetId: `${game}:${option}`, before: null, after: { reward_side_prob: rw, penalty_side_prob: pw }, operator })
  return { game, option: option || 'default', reward_side_prob: rw, penalty_side_prob: pw }
}

// ---------- 抽取（服务端权威，§硬约束1；rng 注入便于测试与蒙特卡洛复算） ----------
/**
 * 从掉落池抽一个条目。
 * 1) 按总控概率归一化决定落侧；一侧无有效条目时落到另一侧
 * 2) 池内按权重抽取；奖励条目库存为0时自动跳过（记录跳过次数）
 *
 * @returns {Promise<{entry: object|null, skipStmts: object[]}>}
 *   skipStmts：0库存跳过记录语句，调用方并入结算 batch（§2.3 记录次数）
 */
export async function rollDrop(DB, { game, option = 'default', rng = Math.random, entryFilter = null }) {
  const controls = await getSideControls(DB, game, option)
  const rows = await DB.prepare(
    `SELECT p.*, COALESCE(r.stock, -1) AS reward_stock, COALESCE(r.name, i.name, pt.name, '') AS ref_name
     FROM drop_pools p
     LEFT JOIN reward_templates r ON p.ref_type = 'reward' AND r.id = p.ref_id
     LEFT JOIN item_templates i ON p.ref_type = 'item' AND i.id = p.ref_id
     LEFT JOIN penalty_templates pt ON p.ref_type = 'penalty' AND pt.id = p.ref_id
     WHERE p.game = ? AND p.option = ? AND p.is_active = 1`
  ).bind(game, option).all()
  const entries = (rows.results || []).filter(e => (typeof entryFilter === 'function' ? entryFilter(e) : true))
  if (entries.length === 0) return { entry: null, skipStmts: [] }

  const skipStmts = []
  const pickWeighted = (list) => {
    // 库存为0的奖励条目自动跳过（回退到池内替代条目）
    const usable = list.filter(e => !(e.ref_type === 'reward' && e.reward_stock === 0))
    const skipped = list.filter(e => e.ref_type === 'reward' && e.reward_stock === 0)
    for (const e of skipped) {
      skipStmts.push(DB.prepare(
        'INSERT INTO drop_skip_logs (game, option, entry_id) VALUES (?, ?, ?)'
      ).bind(game, option, e.id))
    }
    if (usable.length === 0) return null
    const total = usable.reduce((s, e) => s + (Number(e.weight) || 0), 0)
    if (total <= 0) return usable[Math.floor(rng() * usable.length)]
    let r = rng() * total
    for (const e of usable) {
      r -= (Number(e.weight) || 0)
      if (r < 0) return e
    }
    return usable[usable.length - 1]
  }

  // 总控概率：按两侧概率归一化（缺省 0.5/0.5）
  const rw = Math.max(0, Number(controls.reward_side_prob) || 0)
  const pw = Math.max(0, Number(controls.penalty_side_prob) || 0)
  let entry = null
  if (rw <= 0 && pw <= 0) {
    entry = pickWeighted(entries)
  } else {
    const pReward = rw / (rw + pw)
    let side = rng() < pReward ? 'reward' : 'penalty'
    let sideEntries = entries.filter(e => e.side === side)
    entry = pickWeighted(sideEntries)
    if (!entry) {
      // 该侧无可用条目 → 回退另一侧
      side = side === 'reward' ? 'penalty' : 'reward'
      sideEntries = entries.filter(e => e.side === side)
      entry = pickWeighted(sideEntries)
    }
  }
  return { entry, skipStmts }
}

/**
 * 按条目发放内容（返回语句供游戏并入结算 batch，与结算同事务）。
 * ref_type 五类分发：金币→账本 / 道具→库存 / 奖励→背包+扣库存 / 惩罚→Spank累计 / 碎片→碎片入包
 *
 * @returns {Promise<{granted: object, stmts: object[]}>}
 */
export async function grantDropStmts(DB, { username, entry, source = 'game_drop', rng = Math.random }) {
  if (!entry) return { granted: null, stmts: [] }
  const stmts = []
  let granted

  if (entry.ref_type === 'coin') {
    const amount = toMoney(entry.amount)
    if (amount <= 0) throw new KernelError('INVALID_REF', '金币条目金额非法')
    const { stmts: ls, balance } = await ledgerStmts(DB, {
      username, currency: 'coin', delta: amount, reason: 'drop_coin',
      refType: 'drop', refId: `${entry.game || ''}:${entry.id}`, assetLog: {
        action: 'balance', title: '游戏获得金币', detail: `+${amount}`,
      },
    })
    stmts.push(...ls)
    granted = { type: 'coin', amount, balance }
  } else if (entry.ref_type === 'item') {
    const tpl = await DB.prepare(
      "SELECT id, name, category FROM item_templates WHERE id = ? AND is_active = 1"
    ).bind(entry.ref_id).first()
    if (!tpl) throw new KernelError('INVALID_REF', '引用的道具模板不存在或已停用')
    stmts.push(DB.prepare(
      `INSERT INTO player_items (username, item_id, count) VALUES (?, ?, 1)
       ON CONFLICT(username, item_id) DO UPDATE SET count = count + 1, updated_at = datetime('now')`
    ).bind(username, entry.ref_id))
    granted = { type: 'item', itemId: tpl.id, name: tpl.name, category: tpl.category }
  } else if (entry.ref_type === 'reward') {
    const { stmts: rs, template } = await grantRewardStmts(DB, {
      username, rewardId: entry.ref_id, quantity: 1, source,
    })
    stmts.push(...rs)
    granted = { type: 'reward', rewardId: template.id, name: template.name, rarity: template.rarity }
  } else if (entry.ref_type === 'penalty') {
    // 服务端决定单次 Spank 数量：优先使用预生成值（抓娃娃铺场时已落库，开娃不掷骰），
    // 否则在 [spank_min, spank_max] 内随机
    const tpl = await DB.prepare(
      'SELECT id, name, rarity, spank_min, spank_max FROM penalty_templates WHERE id = ? AND is_active = 1'
    ).bind(entry.ref_id).first()
    if (!tpl) throw new KernelError('INVALID_REF', '引用的惩罚道具模板不存在或已停用')
    const min = Math.max(1, toInt(tpl.spank_min, 1, 1, 9999))
    const max = Math.max(min, toInt(tpl.spank_max, min, 1, 9999))
    const spanks = entry.spanks != null
      ? toInt(entry.spanks, min, 1, 9999)
      : min + Math.floor(rng() * (max - min + 1))
    const { applied, countAfter, stmts: ss } = await applyPenaltyStmts(DB, {
      username, penaltyId: tpl.id, spanks, source: 'game_drop',
      note: `游戏掉落：${source}`,
    })
    stmts.push(...ss)
    granted = { type: 'penalty', penaltyId: tpl.id, name: tpl.name, spanks, applied, countAfter }
  } else if (entry.ref_type === 'fragment') {
    const { stmts: fs, recipe } = await grantFragmentStmts(DB, {
      username, recipeId: entry.ref_id, quantity: 1,
    })
    stmts.push(...fs)
    granted = { type: 'fragment', recipeId: recipe.id, targetType: recipe.target_type, targetId: recipe.target_id }
  } else {
    throw new KernelError('INVALID_REF', '引用类型非法')
  }

  return { granted, stmts }
}
