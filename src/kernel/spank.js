// 互通内核 · Spank 累计与减免（T1.6，G9/G11）
// 惩罚=各惩罚道具上的 Spank 累计；写入来源只有三种：game_drop / player_reduce / admin_adjust
// 不做惩罚结算（Spank 不自动扣款，系统内不存在结算阈值）

import { KernelError, toInt } from './util.js'
import { kernelWrite } from './idempotency.js'

/**
 * 施加 Spank 的语句构造器（供游戏结算/发放掉落并入同一 batch 事务）。
 * 上限保护：累计达到 spank_cap 后不再累加（超出部分截断）。
 *
 * @returns {Promise<{applied: number, countAfter: number, stmts: object[]}>}
 */
export async function applyPenaltyStmts(DB, { username, penaltyId, spanks, source = 'game_drop', couponItemId = null, admin = '', note = '' }) {
  const n = toInt(spanks, 0, 0, 999999)
  if (n <= 0) throw new KernelError('INVALID_PARAM', 'Spank数量必须大于0')

  const tpl = await DB.prepare(
    'SELECT id, name, rarity, spank_cap FROM penalty_templates WHERE id = ? AND is_active = 1'
  ).bind(penaltyId).first()
  if (!tpl) throw new KernelError('TEMPLATE_NOT_FOUND', '惩罚道具不存在或已停用')

  const row = await DB.prepare(
    'SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?'
  ).bind(username, penaltyId).first()
  const cur = row ? row.count : 0
  const countAfter = Math.min(tpl.spank_cap, cur + n)
  const applied = countAfter - cur

  if (applied <= 0) {
    // 已达上限：不再累加，不写流水
    return { applied: 0, countAfter: cur, stmts: [] }
  }

  const stmts = [
    DB.prepare(
      `INSERT INTO player_spanks (username, penalty_id, count) VALUES (?, ?, ?)
       ON CONFLICT(username, penalty_id) DO UPDATE SET
         count = MIN(player_spanks.count + excluded.count,
                     (SELECT spank_cap FROM penalty_templates WHERE id = excluded.penalty_id)),
         updated_at = datetime('now')`
    ).bind(username, penaltyId, applied),
    DB.prepare(
      'INSERT INTO spank_logs (username, penalty_id, delta, source, coupon_item_id, admin, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, penaltyId, applied, source, couponItemId, admin, note),
  ]
  return { applied, countAfter, stmts }
}

/**
 * 减免 Spank（玩家手动使用减免券，G9）：目标由玩家选择，只能作用于稀有度不超过券等级的惩罚道具。
 * 券一次用尽：减免量超过剩余 Spank 时减免至 0，余量作废。
 * 等级不匹配 / 无 Spank 可减时报错且券不消耗。
 */
export function reduceSpankOp(DB, { username, couponItemId, targetPenaltyId, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'reduce_spank', username },
    async () => {
      const coupon = await DB.prepare(
        `SELECT t.id, t.name, t.rarity, t.action_value, p.count AS owned
         FROM item_templates t
         LEFT JOIN player_items p ON p.item_id = t.id AND p.username = ?
         WHERE t.id = ? AND t.category = 'clear' AND t.action = 'spank_reduce' AND t.is_active = 1`
      ).bind(username, couponItemId).first()
      if (!coupon) throw new KernelError('NOT_FOUND', '减免券不存在', 404)
      if (!coupon.owned || coupon.owned <= 0) throw new KernelError('ITEM_NOT_OWNED', '没有可用的该减免券')

      const target = await DB.prepare(
        'SELECT id, name, rarity FROM penalty_templates WHERE id = ? AND is_active = 1'
      ).bind(targetPenaltyId).first()
      if (!target) throw new KernelError('TEMPLATE_NOT_FOUND', '惩罚道具不存在或已停用')

      // G9 等级匹配：目标稀有度超过券等级 → 不可选、券不消耗
      if (target.rarity > coupon.rarity) {
        throw new KernelError('RARITY_MISMATCH', '减免目标稀有度超过券等级，券未消耗')
      }

      const srow = await DB.prepare(
        'SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?'
      ).bind(username, targetPenaltyId).first()
      const remaining = srow ? srow.count : 0
      if (remaining <= 0) {
        throw new KernelError('NO_SPANK_TO_REDUCE', '目标道具没有可减免的Spank，券未消耗')
      }

      const reduceValue = Math.max(1, toInt(coupon.action_value, 1, 1, 9999))
      const applied = Math.min(reduceValue, remaining)
      const voided = reduceValue - applied
      const countAfter = remaining - applied

      const stmts = [
        // 消耗券
        DB.prepare(
          'UPDATE player_items SET count = count - 1, updated_at = datetime(\'now\') WHERE username = ? AND item_id = ? AND count >= 1'
        ).bind(username, couponItemId),
        // 减免 Spank（归零保护）
        DB.prepare(
          `UPDATE player_spanks SET count = MAX(0, count - ?), updated_at = datetime('now') WHERE username = ? AND penalty_id = ?`
        ).bind(applied, username, targetPenaltyId),
        // 减免流水（可追溯：哪张券、减了多少、作废多少）
        DB.prepare(
          'INSERT INTO spank_logs (username, penalty_id, delta, source, coupon_item_id, note) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(username, targetPenaltyId, -applied, 'player_reduce', couponItemId,
          voided > 0 ? `券面${reduceValue}，实减${applied}，作废${voided}` : ''),
      ]

      const response = {
        action: 'reduce_spank',
        couponId: couponItemId,
        penaltyId: targetPenaltyId,
        applied,
        voided,
        remaining: countAfter,
      }
      return { response, stmts }
    }
  )
}

/**
 * Spank 面板（§5 玩家端）：按惩罚道具分组的累计 + 每张券的可减免性
 */
export async function listSpanks(DB, username) {
  const rows = await DB.prepare(
    `SELECT t.id AS penalty_id, t.name, t.rarity, t.spank_cap,
            COALESCE(s.count, 0) AS count
     FROM penalty_templates t
     LEFT JOIN player_spanks s ON s.penalty_id = t.id AND s.username = ?
     WHERE t.is_active = 1
     ORDER BY t.rarity, t.id`
  ).bind(username).all()

  const coupons = await DB.prepare(
    `SELECT t.id, t.name, t.rarity, t.action_value, COALESCE(p.count, 0) AS owned
     FROM item_templates t
     LEFT JOIN player_items p ON p.item_id = t.id AND p.username = ?
     WHERE t.category = 'clear' AND t.action = 'spank_reduce' AND t.is_active = 1
     ORDER BY t.rarity`
  ).bind(username).all()

  return { penalties: rows.results || [], coupons: coupons.results || [] }
}

/**
 * 可减免目标列表：稀有度不超过券等级 且 玩家在该道具上有 Spank（G9：等级不足不可选）
 */
export async function listReducibleTargets(DB, username, couponItemId) {
  const coupon = await DB.prepare(
    `SELECT t.id, t.name, t.rarity, t.action_value, COALESCE(p.count, 0) AS owned
     FROM item_templates t
     LEFT JOIN player_items p ON p.item_id = t.id AND p.username = ?
     WHERE t.id = ? AND t.category = 'clear' AND t.action = 'spank_reduce' AND t.is_active = 1`
  ).bind(username, couponItemId).first()
  if (!coupon) throw new KernelError('NOT_FOUND', '减免券不存在', 404)

  const rows = await DB.prepare(
    `SELECT t.id AS penalty_id, t.name, t.rarity, s.count
     FROM penalty_templates t
     JOIN player_spanks s ON s.penalty_id = t.id AND s.username = ?
     WHERE t.is_active = 1 AND t.rarity <= ? AND s.count > 0
     ORDER BY t.rarity, t.id`
  ).bind(username, coupon.rarity).all()

  return { coupon, targets: rows.results || [] }
}
