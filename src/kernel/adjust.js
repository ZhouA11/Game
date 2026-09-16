// 互通内核 · 后台人工调整（T1.7，G15）
// 可对玩家的资产（金币/活跃值）、奖励、道具、惩罚（Spank）做发放/扣减/补发/回收/清零
// 全部走统一 debit/credit + 幂等 + 审计 + 原因必填，超阈值待管理员审批

import { KernelError, toInt, toMoney } from './util.js'
import { kernelWrite } from './idempotency.js'
import { ledgerStmts } from './ledger.js'
import { audit, auditStmt, getParam } from './templates.js'

export const ADJUST_TARGET_TYPES = ['coin', 'activity', 'reward', 'item', 'penalty']

// ---------- 应用语句构造器（发放/扣减的具体写操作，供创建与审批两个入口复用） ----------
async function buildApplyStmts(DB, { username, targetType, targetId, delta, operator, reason, refId }) {
  const d = Number(delta)
  const stmts = []

  if (targetType === 'coin' || targetType === 'activity') {
    const col = targetType === 'coin' ? 'balance' : 'activity'
    const user = await DB.prepare(`SELECT username, ${col} AS cur FROM users WHERE username = ?`).bind(username).first()
    const cur = Number(user?.cur) || 0
    const after = Math.round((cur + d) * 100) / 100
    if (after < 0) throw new KernelError('ADJUST_NEGATIVE', `调整后${targetType === 'coin' ? '金币' : '活跃值'}为负（当前${cur}，调整${d}）`)
    const { stmts: ls } = await ledgerStmts(DB, {
      username, currency: targetType, delta: d, reason: 'admin_adjust',
      refType: 'adjustment', refId, createdBy: operator,
      assetLog: {
        action: 'balance',
        title: `管理员调整${targetType === 'coin' ? '筹码' : '活跃值'}`,
        detail: `${cur} → ${after}（${d >= 0 ? '+' : ''}${d}）`,
      },
    })
    stmts.push(...ls)
    return { stmts, summary: `${cur} → ${after}` }
  }

  if (targetType === 'item') {
    if (!targetId) throw new KernelError('INVALID_PARAM', '道具调整必须指定模板ID')
    const tpl = await DB.prepare('SELECT id, name FROM item_templates WHERE id = ?').bind(targetId).first()
    if (!tpl) throw new KernelError('NOT_FOUND', '道具模板不存在', 404)
    const row = await DB.prepare(
      'SELECT count FROM player_items WHERE username = ? AND item_id = ?'
    ).bind(username, targetId).first()
    const cur = row ? row.count : 0
    if (cur + d < 0) throw new KernelError('ADJUST_NEGATIVE', `调整后道具数量为负（当前${cur}，调整${d}）`)
    stmts.push(DB.prepare(
      `INSERT INTO player_items (username, item_id, count) VALUES (?, ?, ?)
       ON CONFLICT(username, item_id) DO UPDATE SET count = MAX(0, count + excluded.count), updated_at = datetime('now')`
    ).bind(username, targetId, d))
    if (d > 0) {
      stmts.push(DB.prepare(
        'INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)'
      ).bind(username, 'item', `管理员发放道具：${tpl.name}`, `x${d}（${reason}）`))
    }
    return { stmts, summary: `${cur} → ${Math.max(0, cur + d)}` }
  }

  if (targetType === 'reward') {
    if (!targetId) throw new KernelError('INVALID_PARAM', '奖励调整必须指定模板ID')
    const tpl = await DB.prepare('SELECT id, name FROM reward_templates WHERE id = ?').bind(targetId).first()
    if (!tpl) throw new KernelError('NOT_FOUND', '奖励模板不存在', 404)
    const row = await DB.prepare(
      "SELECT quantity FROM player_reward_bag WHERE username = ? AND reward_id = ? AND status = 'pending'"
    ).bind(username, targetId).first()
    const cur = row ? row.quantity : 0
    if (cur + d < 0) throw new KernelError('ADJUST_NEGATIVE', `调整后奖励数量为负（当前${cur}，调整${d}）`)
    if (d > 0) {
      // 管理员发放走后台通道，不扣模板库存（库存约束仅约束游戏掉落）
      stmts.push(DB.prepare(
        `INSERT INTO player_reward_bag (username, reward_id, quantity, status, source)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(username, reward_id, status) DO UPDATE SET
           quantity = quantity + excluded.quantity, updated_at = datetime('now')`
      ).bind(username, targetId, d, `admin:${operator}`))
      stmts.push(DB.prepare(
        'INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)'
      ).bind(username, 'reward', `管理员发放奖励：${tpl.name}`, `x${d}（${reason}）`))
    } else {
      stmts.push(DB.prepare(
        `UPDATE player_reward_bag SET quantity = MAX(0, quantity + ?), updated_at = datetime('now')
         WHERE username = ? AND reward_id = ? AND status = 'pending'`
      ).bind(d, username, targetId))
    }
    return { stmts, summary: `${cur} → ${Math.max(0, cur + d)}` }
  }

  // penalty：Spank 调整（正=施加，负=扣减）
  if (!targetId) throw new KernelError('INVALID_PARAM', '惩罚调整必须指定道具ID')
  const tpl = await DB.prepare(
    'SELECT id, name, spank_cap FROM penalty_templates WHERE id = ?'
  ).bind(targetId).first()
  if (!tpl) throw new KernelError('NOT_FOUND', '惩罚道具模板不存在', 404)
  const row = await DB.prepare(
    'SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?'
  ).bind(username, targetId).first()
  const cur = row ? row.count : 0
  if (cur + d < 0) throw new KernelError('ADJUST_NEGATIVE', `调整后Spank为负（当前${cur}，调整${d}）`)

  if (d > 0) {
    // 上限保护：超过 spank_cap 部分截断
    const after = Math.min(tpl.spank_cap, cur + d)
    const applied = after - cur
    if (applied > 0) {
      stmts.push(DB.prepare(
        `INSERT INTO player_spanks (username, penalty_id, count) VALUES (?, ?, ?)
         ON CONFLICT(username, penalty_id) DO UPDATE SET
           count = MIN(player_spanks.count + excluded.count,
                       (SELECT spank_cap FROM penalty_templates WHERE id = excluded.penalty_id)),
           updated_at = datetime('now')`
      ).bind(username, targetId, applied))
      stmts.push(DB.prepare(
        'INSERT INTO spank_logs (username, penalty_id, delta, source, admin, note) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(username, targetId, applied, 'admin_adjust', operator, reason))
    }
    return { stmts, summary: `${cur} → ${after}` }
  }

  const after = Math.max(0, cur + d)
  stmts.push(DB.prepare(
    `UPDATE player_spanks SET count = MAX(0, count + ?), updated_at = datetime('now') WHERE username = ? AND penalty_id = ?`
  ).bind(d, username, targetId))
  stmts.push(DB.prepare(
    'INSERT INTO spank_logs (username, penalty_id, delta, source, admin, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(username, targetId, d, 'admin_adjust', operator, reason))
  return { stmts, summary: `${cur} → ${after}` }
}

// ---------- 创建调整（原因必填；超阈值 → pending 待审批） ----------
export function createAdjustmentOp(DB, { operator, username, targetType, targetId = null, delta, reason, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'admin_adjust', username: operator },
    async () => {
      if (!ADJUST_TARGET_TYPES.includes(targetType)) {
        throw new KernelError('INVALID_PARAM', '调整对象类型不正确（资产/奖励/道具/惩罚）')
      }
      if (!reason || !String(reason).trim()) {
        throw new KernelError('ADJUST_REASON_REQUIRED', '调整原因必填')
      }
      const d = toMoney(delta)
      if (d === 0) throw new KernelError('INVALID_PARAM', '调整量不能为0')

      const user = await DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first()
      if (!user) throw new KernelError('USER_NOT_FOUND', '用户不存在', 404)

      // 阈值：资产类与数量类分别配置（超阈值需管理员审批）
      const threshold = targetType === 'coin' || targetType === 'activity'
        ? Number(await getParam(DB, 'adjust_threshold_coin', '1000'))
        : Number(await getParam(DB, 'adjust_threshold_count', '10'))
      const pending = Math.abs(d) > threshold

      const stmts = []
      let response
      if (pending) {
        // 待审批：仅登记，不执行
        stmts.push(DB.prepare(
          `INSERT INTO admin_adjustments (username, target_type, target_id, delta, reason, status, requested_by, idempotency_key)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).bind(username, targetType, targetId || null, d, String(reason).trim(), operator, idempotencyKey))
        response = {
          action: 'admin_adjust', username, targetType, targetId: targetId || null, delta: d,
          status: 'pending', threshold,
          msg: `调整量超过阈值（${threshold}），已登记待审批，未生效`,
        }
      } else {
        // 免审批：登记+执行同 batch（refId 用幂等键关联账本流水）
        const refId = idempotencyKey || ''
        const { stmts: applyStmts, summary } = await buildApplyStmts(DB, {
          username, targetType, targetId, delta: d, operator, reason: String(reason).trim(), refId,
        })
        stmts.push(DB.prepare(
          `INSERT INTO admin_adjustments (username, target_type, target_id, delta, reason, status, requested_by, idempotency_key, applied_at)
           VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, datetime('now'))`
        ).bind(username, targetType, targetId || null, d, String(reason).trim(), operator, idempotencyKey))
        stmts.push(...applyStmts)
        response = {
          action: 'admin_adjust', username, targetType, targetId: targetId || null, delta: d,
          status: 'applied', summary,
        }
      }
      // 审计随 batch 原子落库
      stmts.push(auditStmt(DB, {
        scope: 'admin_adjustment', action: pending ? 'create_pending' : 'create_applied',
        targetId: `${username}:${targetType}`, before: null, after: response, operator,
      }))
      return { response, stmts }
    }
  )
}

// ---------- 审批 / 驳回 ----------
export async function approveAdjustment(DB, id, operator) {
  const row = await DB.prepare('SELECT * FROM admin_adjustments WHERE id = ?').bind(id).first()
  if (!row) throw new KernelError('NOT_FOUND', '调整记录不存在', 404)
  if (row.status !== 'pending') throw new KernelError('ALREADY_PROCESSED', '该调整已处理')

  const { stmts, summary } = await buildApplyStmts(DB, {
    username: row.username, targetType: row.target_type, targetId: row.target_id,
    delta: row.delta, operator, reason: row.reason, refId: `adjust:${row.id}`,
  })
  stmts.push(DB.prepare(
    `UPDATE admin_adjustments SET status = 'applied', approved_by = ?, applied_at = datetime('now') WHERE id = ? AND status = 'pending'`
  ).bind(operator, id))
  stmts.push(auditStmt(DB, { scope: 'admin_adjustment', action: 'approve', targetId: id, before: row, after: { ...row, status: 'applied', approved_by: operator }, operator }))
  await DB.batch(stmts)
  return { id, status: 'applied', summary }
}

export async function rejectAdjustment(DB, id, operator) {
  const row = await DB.prepare('SELECT * FROM admin_adjustments WHERE id = ?').bind(id).first()
  if (!row) throw new KernelError('NOT_FOUND', '调整记录不存在', 404)
  if (row.status !== 'pending') throw new KernelError('ALREADY_PROCESSED', '该调整已处理')
  await DB.batch([
    DB.prepare(
      `UPDATE admin_adjustments SET status = 'rejected', approved_by = ? WHERE id = ? AND status = 'pending'`
    ).bind(operator, id),
    auditStmt(DB, { scope: 'admin_adjustment', action: 'reject', targetId: id, before: row, after: { ...row, status: 'rejected' }, operator }),
  ])
  return { id, status: 'rejected' }
}

// ---------- 查询 ----------
export async function listAdjustments(DB, { username = null, status = null, limit = 50 } = {}) {
  let sql = 'SELECT * FROM admin_adjustments'
  const where = []
  const params = []
  if (username) { where.push('username = ?'); params.push(username) }
  if (status) { where.push('status = ?'); params.push(status) }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY id DESC LIMIT ?'
  params.push(Math.max(1, Math.min(200, toInt(limit, 50, 1, 200))))
  const rows = await DB.prepare(sql).bind(...params).all()
  return rows.results || []
}
