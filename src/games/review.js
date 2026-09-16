// 步骤6 · 配置提审 → 预发验证 → 全量发布 → 回滚（T6.6/T6.7/T6.10，G3/G5/G17）
// 越界（返还率超出目标区间）禁止提审/发布，必须先调整概率配置

import { KernelError, toInt } from '../kernel/util.js'
import { auditStmt, audit } from '../kernel/templates.js'
import { computeGameRTP } from './rtp.js'

// rarity 范围的返还率 = 以稀有度权重（铺场权重）作为抓娃娃选项概率重算
// payload 为 null 时读取线上 rarity_levels（发布后回读场景）
async function rtpForScope(DB, scope, payload) {
  if (scope === 'rarity') {
    let weights = payload
    if (!weights) {
      const rows = await DB.prepare('SELECT level, field_weight FROM rarity_levels ORDER BY level').all()
      weights = rows.results || []
    }
    // 兼容对象行与 [level, weight] 元组两种形态
    const axis = weights.map(r => Array.isArray(r) ? r : [r.level, r.field_weight])
    return computeGameRTP(DB, 'grab', null, 10, axis)
  }
  return computeGameRTP(DB, scope, payload)
}

/**
 * 提审：保存即自动重算返还率（三张表），越界拦截
 * scope: grab（payload: {pools, controls}）/ slot（payload: slot_config JSON）/ rarity（payload: [{level,...}]）
 */
export async function submitReviewOp(DB, { scope, payload, note = '', operator }) {
  if (!['grab', 'slot', 'rarity'].includes(scope)) {
    throw new KernelError('INVALID_PARAM', '配置范围只能是 grab / slot / rarity')
  }
  if (!payload || typeof payload !== 'object') {
    throw new KernelError('INVALID_PARAM', '缺少配置载荷')
  }
  if (scope === 'slot' && !payload.pays) {
    throw new KernelError('INVALID_PARAM', '老虎机配置载荷不完整')
  }
  if (scope === 'rarity' && !Array.isArray(payload)) {
    throw new KernelError('INVALID_PARAM', '稀有度载荷应为四级参数数组')
  }

  // 保存即自动重算（无需人工跑模拟）
  const rtp = await rtpForScope(DB, scope, payload)
  if (rtp.rtp < rtp.range.min || rtp.rtp > rtp.range.max) {
    // 越界：拦截提审 + 落审计
    const detail = { scope, operator, rtp: rtp.rtp, range: rtp.range, action: 'blocked' }
    await audit(DB, {
      scope: 'config_review', action: 'submit_blocked', targetId: scope,
      before: null, after: detail, operator,
    })
    throw new KernelError(
      'RTP_OUT_OF_RANGE',
      `整机返还率 ${(rtp.rtp * 100).toFixed(2)}% 超出目标区间 ${(rtp.range.min * 100).toFixed(0)}%~${(rtp.range.max * 100).toFixed(0)}%，禁止提审，请先调整概率配置`
    )
  }

  const result = await DB.prepare(
    `INSERT INTO config_reviews (scope, payload, note, status, rtp_result, created_by)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).bind(scope, JSON.stringify(payload), note, JSON.stringify(rtp), operator).run()
  const row = await DB.prepare('SELECT * FROM config_reviews WHERE id = ?').bind(result.meta.last_row_id).first()
  await audit(DB, { scope: 'config_review', action: 'submit', targetId: row.id, before: null, after: { scope, note, rtp: rtp.rtp }, operator })
  return row
}

// 预发验证：用载荷独立重算返还率（复核提审结论），通过后标记 staging
export async function stagingReviewOp(DB, { id, operator }) {
  const row = await DB.prepare('SELECT * FROM config_reviews WHERE id = ?').bind(id).first()
  if (!row) throw new KernelError('NOT_FOUND', '提审记录不存在', 404)
  if (row.status !== 'pending') throw new KernelError('INVALID_STATE', `状态不正确：当前 ${row.status}`)
  const payload = JSON.parse(row.payload)
  const rtp = await rtpForScope(DB, row.scope, payload)
  if (rtp.rtp < rtp.range.min || rtp.rtp > rtp.range.max) {
    throw new KernelError('RTP_OUT_OF_RANGE', '预发验证失败：返还率越界')
  }
  await DB.batch([
    DB.prepare("UPDATE config_reviews SET status = 'staging', reviewed_by = ?, rtp_result = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .bind(operator, JSON.stringify(rtp), id),
    auditStmt(DB, { scope: 'config_review', action: 'staging', targetId: id, before: { status: 'pending' }, after: { status: 'staging', rtp: rtp.rtp }, operator }),
  ])
  return { id, status: 'staging', rtp: rtp.rtp }
}

// 发布：再次校验越界（不得绕过拦截直接发布）→ 应用载荷 → 快照 → 审计
export async function publishReviewOp(DB, { id, operator }) {
  return applyReviewLifecycle(DB, { id, operator, from: 'staging', to: 'published' })
}

async function applyReviewLifecycle(DB, { id, operator, from, to }) {
  const row = await DB.prepare('SELECT * FROM config_reviews WHERE id = ?').bind(id).first()
  if (!row) throw new KernelError('NOT_FOUND', '提审记录不存在', 404)
  if (row.status !== from) throw new KernelError('INVALID_STATE', `状态不正确：当前 ${row.status}`)

  const payload = JSON.parse(row.payload)
  // 发布前最后复核（不得绕过拦截直接发布）
  const rtp = await rtpForScope(DB, row.scope, payload)
  if (rtp.rtp < rtp.range.min || rtp.rtp > rtp.range.max) {
    throw new KernelError('RTP_OUT_OF_RANGE', '返还率越界，禁止发布')
  }

  await applyReviewPayload(DB, row.scope, payload, operator)

  const st = await DB.prepare(
    `UPDATE config_reviews SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = ?`
  ).bind(to, operator, id, from).run()

  // 应用后回读真实线上返还率（发布状态审计）
  const live = await rtpForScope(DB, row.scope, null)
  await audit(DB, {
    scope: 'config_review', action: to, targetId: id,
    before: { status: from }, after: { status: to, liveRtp: live.rtp }, operator,
  })
  return { id, status: to, liveRtp: live.rtp, changes: st.meta.changes }
}

// 一键回滚：恢复到上一条已发布的同 scope 载荷
export async function rollbackReviewOp(DB, { id, operator }) {
  const row = await DB.prepare('SELECT * FROM config_reviews WHERE id = ?').bind(id).first()
  if (!row || row.status !== 'published') throw new KernelError('INVALID_STATE', '只能回滚已发布的配置')
  const prev = await DB.prepare(
    `SELECT * FROM config_reviews WHERE scope = ? AND status = 'published' AND id < ? ORDER BY id DESC LIMIT 1`
  ).bind(row.scope, id).first()
  if (!prev) throw new KernelError('NOT_FOUND', '没有可回滚的历史版本', 404)

  await applyReviewPayload(DB, row.scope, JSON.parse(prev.payload), operator)
  await DB.batch([
    DB.prepare("UPDATE config_reviews SET status = 'rolled_back' WHERE id = ?").bind(id),
    auditStmt(DB, { scope: 'config_review', action: 'rollback', targetId: id, before: { status: 'published' }, after: { restoredFrom: prev.id }, operator }),
  ])
  return { id, status: 'rolled_back', restoredFrom: prev.id }
}

// ---------- 载荷应用（发布/回滚共用） ----------
export async function applyReviewPayload(DB, scope, payload, operator) {
  const stmts = []
  if (scope === 'grab') {
    stmts.push(DB.prepare("DELETE FROM drop_pools WHERE game = 'grab'"))
    for (const e of payload.pools || []) {
      stmts.push(DB.prepare(
        'INSERT INTO drop_pools (game, option, side, ref_type, ref_id, amount, weight, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind('grab', e.option, e.side, e.ref_type, e.ref_id ?? null, e.amount ?? null, e.weight, e.is_active ?? 1))
    }
    for (const c of payload.controls || []) {
      stmts.push(DB.prepare(
        `INSERT INTO drop_side_controls (game, option, reward_side_prob, penalty_side_prob)
         VALUES ('grab', ?, ?, ?)
         ON CONFLICT(game, option) DO UPDATE SET reward_side_prob = excluded.reward_side_prob,
           penalty_side_prob = excluded.penalty_side_prob, updated_at = datetime('now')`
      ).bind(c.option, c.reward_side_prob, c.penalty_side_prob))
    }
  } else if (scope === 'slot') {
    stmts.push(DB.prepare("UPDATE slot_config SET config = ?, updated_at = datetime('now') WHERE id = 1").bind(JSON.stringify(payload)))
  } else if (scope === 'rarity') {
    for (const r of payload) {
      stmts.push(DB.prepare(
        `UPDATE rarity_levels SET field_weight = ?, price_min = ?, price_max = ?, drop_weight = ?, is_active = ?, updated_at = datetime('now') WHERE level = ?`
      ).bind(r.field_weight, r.price_min, r.price_max, r.drop_weight, r.is_active ?? 1, r.level))
    }
  } else {
    throw new KernelError('INVALID_PARAM', '未知配置范围')
  }
  stmts.push(auditStmt(DB, { scope: `${scope}_config`, action: 'publish_apply', targetId: scope, before: null, after: payload, operator }))
  await DB.batch(stmts)
}

// ---------- 列表 ----------
export async function listReviews(DB, { scope = null, status = null, limit = 50 } = {}) {
  let sql = 'SELECT * FROM config_reviews'
  const where = []
  const params = []
  if (scope) { where.push('scope = ?'); params.push(scope) }
  if (status) { where.push('status = ?'); params.push(status) }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY id DESC LIMIT ?'
  params.push(Math.max(1, Math.min(200, toInt(limit, 50, 1, 200))))
  const rows = await DB.prepare(sql).bind(...params).all()
  return rows.results || []
}

// ---------- T6.1 数据看板 ----------
export async function getDashboard(DB) {
  // 各游戏返还率（系统计算，禁止手工填）
  const rtp = { grab: await computeGameRTP(DB, 'grab'), slot: await computeGameRTP(DB, 'slot') }

  // 各惩罚道具 Spank 累计与减免率（减免率随稀有度递增为健康）
  const spankStats = await DB.prepare(
    `SELECT p.id AS penalty_id, p.name, p.rarity,
            COALESCE(SUM(CASE WHEN l.delta > 0 THEN l.delta END), 0) AS applied,
            COALESCE(SUM(CASE WHEN l.delta < 0 THEN -l.delta END), 0) AS reduced
     FROM penalty_templates p LEFT JOIN spank_logs l ON l.penalty_id = p.id
     WHERE p.is_active = 1 GROUP BY p.id ORDER BY p.rarity, p.id`
  ).all()
  const penalties = (spankStats.results || []).map(r => ({
    ...r, reduceRate: r.applied > 0 ? Math.round((r.reduced / r.applied) * 100) : 0,
  }))

  // 奖励库存告警（低库存/0库存）与跳过次数
  const stockAlerts = await DB.prepare(
    'SELECT id, name, stock FROM reward_templates WHERE is_active = 1 AND stock >= 0 AND stock <= 5 ORDER BY stock, id'
  ).all()
  const skips = await DB.prepare('SELECT COUNT(*) AS c FROM drop_skip_logs').first()

  // 碎片：合成次数 与 当前持有
  const synth = await DB.prepare("SELECT COUNT(*) AS c FROM idempotency_records WHERE endpoint = 'fragment_synthesize'").first()
  const fragHeld = await DB.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM player_fragments').first()

  // 奖励/惩罚发放分布（按稀有度，来自 Spank 流水与抓取流水）
  const rarityDist = await DB.prepare(
    `SELECT p.rarity, COUNT(*) AS hits FROM spank_logs l JOIN penalty_templates p ON p.id = l.penalty_id GROUP BY p.rarity`
  ).all()

  // 后台人工调整量（按操作人/类型统计）
  const adjustments = await DB.prepare(
    `SELECT requested_by AS operator, target_type, COUNT(*) AS count, SUM(ABS(delta)) AS total_amount
     FROM admin_adjustments GROUP BY requested_by, target_type ORDER BY count DESC`
  ).all()
  const pendingAdjustments = await DB.prepare("SELECT COUNT(*) AS c FROM admin_adjustments WHERE status = 'pending'").first()

  return {
    rtp: { grab: { rtp: rtp.grab.rtp, range: rtp.grab.range, perOption: rtp.grab.perOption },
           slot: { rtp: rtp.slot.rtp, range: rtp.slot.range, perOption: rtp.slot.perOption } },
    penalties,
    stockAlerts: stockAlerts.results || [],
    dropSkipCount: skips?.c || 0,
    fragments: { synthCount: synth?.c || 0, held: fragHeld?.c || 0 },
    rarityDist: rarityDist.results || [],
    adjustments: adjustments.results || [],
    pendingAdjustments: pendingAdjustments?.c || 0,
  }
}

// ---------- T6.3 引用面查询 / 奖励发货状态 ----------
export async function listTemplateRefs(DB, kind, id) {
  const map = { reward: 'reward', penalty: 'penalty', item: 'item' }
  const rows = await DB.prepare(
    'SELECT * FROM drop_pools WHERE ref_type = ? AND ref_id = ? AND is_active = 1'
  ).bind(map[kind] || kind, id).all()
  return rows.results || []
}

export async function listRewardBags(DB, username) {
  const rows = username
    ? await DB.prepare(
        `SELECT b.username, b.reward_id, b.quantity, b.status, b.updated_at, t.name, t.rarity
         FROM player_reward_bag b JOIN reward_templates t ON t.id = b.reward_id
         WHERE b.username = ? ORDER BY b.updated_at DESC LIMIT 100`
      ).bind(username).all()
    : await DB.prepare(
        `SELECT b.username, b.reward_id, b.quantity, b.status, b.updated_at, t.name, t.rarity
         FROM player_reward_bag b JOIN reward_templates t ON t.id = b.reward_id
         ORDER BY b.updated_at DESC LIMIT 100`
      ).all()
  return rows.results || []
}

// 发货流转：待核销 → 已发货（实物/券码出库）
export async function deliverRewardOp(DB, { username, rewardId, operator }) {
  const row = await DB.prepare(
    "SELECT quantity FROM player_reward_bag WHERE username = ? AND reward_id = ? AND status = 'pending'"
  ).bind(username, rewardId).first()
  if (!row || row.quantity <= 0) throw new KernelError('NOT_FOUND', '没有待发货的奖励', 404)
  await DB.batch([
    DB.prepare("UPDATE player_reward_bag SET quantity = quantity - 1 WHERE username = ? AND reward_id = ? AND status = 'pending'").bind(username, rewardId),
    DB.prepare(
      `INSERT INTO player_reward_bag (username, reward_id, quantity, status, source) VALUES (?, ?, 1, 'delivered', ?)
       ON CONFLICT(username, reward_id, status) DO UPDATE SET quantity = quantity + 1, updated_at = datetime('now')`
    ).bind(username, rewardId, `admin:${operator}`),
    auditStmt(DB, { scope: 'reward_delivery', action: 'deliver', targetId: `${username}:${rewardId}`, before: row, after: { delivered: 1 }, operator }),
  ])
  return { username, rewardId, delivered: 1 }
}
