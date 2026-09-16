// 互通内核 · 奖励背包与履约（T1.8，G8）
// 游戏开出 → 入玩家奖励背包 → 手动核销；库存为 0 时掉落自动跳过

import { KernelError, toInt } from './util.js'
import { kernelWrite } from './idempotency.js'

/**
 * 奖励入包语句构造器（供游戏掉落/后台发放并入同一 batch 事务）。
 * - 库存扣减带守卫（stock > 0），无限库存（-1）不扣减
 * - 背包按 (username, reward_id, status=pending) 聚合数量
 *
 * @returns {Promise<{stmts: object[], template: object}>}
 */
export async function grantRewardStmts(DB, { username, rewardId, quantity = 1, source = 'game_drop', decrementStock = true }) {
  const q = toInt(quantity, 1, 1, 9999)
  const tpl = await DB.prepare(
    'SELECT id, name, rarity, kind, value, stock FROM reward_templates WHERE id = ? AND is_active = 1'
  ).bind(rewardId).first()
  if (!tpl) throw new KernelError('TEMPLATE_NOT_FOUND', '奖励模板不存在或已停用')
  if (tpl.stock === 0) throw new KernelError('REWARD_OUT_OF_STOCK', '奖励库存不足')

  const stmts = []
  if (decrementStock && tpl.stock > 0) {
    stmts.push(DB.prepare(
      "UPDATE reward_templates SET stock = stock - ?, updated_at = datetime('now') WHERE id = ? AND stock > 0"
    ).bind(q, rewardId))
  }
  stmts.push(DB.prepare(
    `INSERT INTO player_reward_bag (username, reward_id, quantity, status, source)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT(username, reward_id, status) DO UPDATE SET
       quantity = quantity + excluded.quantity, updated_at = datetime('now')`
  ).bind(username, rewardId, q, source))

  return { stmts, template: tpl, quantity: q }
}

/**
 * 手动核销奖励（履约流：入包 → 核销）
 */
export function redeemRewardOp(DB, { username, rewardId, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'reward_redeem', username },
    async () => {
      const row = await DB.prepare(
        `SELECT b.username, b.reward_id, b.quantity, t.name
         FROM player_reward_bag b
         JOIN reward_templates t ON t.id = b.reward_id
         WHERE b.username = ? AND b.reward_id = ? AND b.status = 'pending'`
      ).bind(username, rewardId).first()
      if (!row || row.quantity <= 0) {
        throw new KernelError('NOT_FOUND', '背包中没有该待核销奖励', 404)
      }

      const left = row.quantity - 1
      const stmts = [left > 0
        ? DB.prepare(
            "UPDATE player_reward_bag SET quantity = quantity - 1, updated_at = datetime('now') WHERE username = ? AND reward_id = ? AND status = 'pending'"
          ).bind(username, rewardId)
        : DB.prepare(
            "DELETE FROM player_reward_bag WHERE username = ? AND reward_id = ? AND status = 'pending'"
          ).bind(username, rewardId),
        // 前端资产变更记录可见
        DB.prepare(
          'INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)'
        ).bind(username, 'reward', `核销奖励：${row.name}`, left > 0 ? `剩余${left}` : '已用完'),
      ]

      const response = { action: 'reward_redeem', rewardId, remaining: Math.max(0, left) }
      return { response, stmts }
    }
  )
}

/**
 * 奖励背包列表（四区之一，个人面板步骤5接入）
 */
export async function listRewardBag(DB, username) {
  const rows = await DB.prepare(
    `SELECT b.reward_id, b.quantity, b.status, b.source, b.created_at, b.updated_at,
            t.name, t.rarity, t.kind, t.value, t.description, t.image
     FROM player_reward_bag b
     JOIN reward_templates t ON t.id = b.reward_id
     WHERE b.username = ? AND b.quantity > 0
     ORDER BY b.updated_at DESC`
  ).bind(username).all()
  return rows.results || []
}
