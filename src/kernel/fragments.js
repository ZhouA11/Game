// 互通内核 · 碎片系统（T1.4，G10）
// 碎片绑定唯一合成目标；配方：L3 目标 5 片、L4 目标 7 片（服务端按目标稀有度强制）
// 碎片仅由游戏掉落，严禁上架商城、不可交易；合成入口在个人面板

import { KernelError, toInt } from './util.js'
import { kernelWrite } from './idempotency.js'
import { grantRewardStmts } from './backpack.js'

// 按目标稀有度推导所需碎片数（服务端权威，忽略客户端/存储值）
export function requiredPieces(rarity) {
  if (rarity === 3) return 5
  if (rarity === 4) return 7
  return null // 仅 L3/L4 可碎片合成
}

/**
 * 碎片入包语句构造器（供游戏掉落/彩池出奖并入同一 batch 事务）
 */
export async function grantFragmentStmts(DB, { username, recipeId, quantity = 1 }) {
  const q = toInt(quantity, 1, 1, 999)
  const recipe = await DB.prepare(
    'SELECT id, target_type, target_id, pieces_required FROM fragment_recipes WHERE id = ? AND is_active = 1'
  ).bind(recipeId).first()
  if (!recipe) throw new KernelError('NOT_FOUND', '碎片配方不存在', 404)

  const stmts = [DB.prepare(
    `INSERT INTO player_fragments (username, recipe_id, count) VALUES (?, ?, ?)
     ON CONFLICT(username, recipe_id) DO UPDATE SET count = count + excluded.count, updated_at = datetime('now')`
  ).bind(username, recipeId, q)]
  return { stmts, recipe, quantity: q }
}

/**
 * 碎片合成：事务内扣碎片 + 发放目标；任一步失败整体回滚
 */
export function synthesizeFragmentOp(DB, { username, recipeId, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'fragment_synthesize', username },
    async () => {
      const recipe = await DB.prepare(
        'SELECT id, target_type, target_id, pieces_required, is_active FROM fragment_recipes WHERE id = ?'
      ).bind(recipeId).first()
      if (!recipe || !recipe.is_active) throw new KernelError('NOT_FOUND', '碎片配方不存在', 404)

      // 目标必须是激活中的 L3/L4 模板
      let target = null
      if (recipe.target_type === 'item') {
        target = await DB.prepare(
          "SELECT id, name, rarity, is_active, 'item' AS type FROM item_templates WHERE id = ?"
        ).bind(recipe.target_id).first()
      } else if (recipe.target_type === 'reward') {
        target = await DB.prepare(
          "SELECT id, name, rarity, is_active, 'reward' AS type FROM reward_templates WHERE id = ?"
        ).bind(recipe.target_id).first()
      } else {
        throw new KernelError('INVALID_PARAM', '配方目标类型不正确')
      }
      if (!target || !target.is_active) throw new KernelError('NOT_FOUND', '合成目标不存在或已停用', 404)

      const required = requiredPieces(target.rarity)
      if (!required) throw new KernelError('INVALID_PARAM', '仅L3/L4目标可碎片合成')
      // 服务端强制所需碎片数（与配方存储值无关）

      const frag = await DB.prepare(
        'SELECT count FROM player_fragments WHERE username = ? AND recipe_id = ?'
      ).bind(username, recipeId).first()
      const owned = frag ? frag.count : 0
      if (owned < required) {
        throw new KernelError('FRAGMENT_INSUFFICIENT', `碎片数量不足（${owned}/${required}）`)
      }

      const stmts = [
        // 扣碎片（守卫：数量足够才扣）
        DB.prepare(
          'UPDATE player_fragments SET count = count - ?, updated_at = datetime(\'now\') WHERE username = ? AND recipe_id = ? AND count >= ?'
        ).bind(required, username, recipeId, required),
      ]

      // 发放目标
      if (target.type === 'item') {
        stmts.push(DB.prepare(
          `INSERT INTO player_items (username, item_id, count) VALUES (?, ?, 1)
           ON CONFLICT(username, item_id) DO UPDATE SET count = count + 1, updated_at = datetime('now')`
        ).bind(username, target.id))
      } else {
        const { stmts: rewardStmts } = await grantRewardStmts(DB, {
          username, rewardId: target.id, quantity: 1, source: 'fragment_synthesize',
        })
        stmts.push(...rewardStmts)
      }

      // 合成流水（前端资产变更记录可见：道具/奖励入账）
      if (target.type === 'item') {
        stmts.push(DB.prepare(
          'INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)'
        ).bind(username, 'item', `碎片合成道具：${target.name}`, `x1（消耗碎片${required}）`))
      } else {
        stmts.push(DB.prepare(
          'INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)'
        ).bind(username, 'reward', `碎片合成奖励：${target.name}`, `x1（消耗碎片${required}）`))
      }

      const response = {
        action: 'fragment_synthesize',
        recipeId,
        targetType: target.type,
        targetId: target.id,
        targetName: target.name,
        piecesUsed: required,
      }
      return { response, stmts }
    }
  )
}

/**
 * 碎片进度（个人面板碎片进度条）
 */
export async function listFragments(DB, username) {
  const rows = await DB.prepare(
    `SELECT r.id AS recipe_id, r.target_type, r.target_id, r.pieces_required,
            COALESCE(f.count, 0) AS owned,
            t.name AS target_name, t.rarity AS target_rarity, t.image AS target_image
     FROM fragment_recipes r
     LEFT JOIN player_fragments f ON f.recipe_id = r.id AND f.username = ?
     LEFT JOIN item_templates t ON r.target_type = 'item' AND t.id = r.target_id
     WHERE r.is_active = 1
     ORDER BY r.id`
  ).bind(username).all()

  // reward 目标单独补齐名称（SQLite LEFT JOIN 两种表不便合一）
  const list = rows.results || []
  for (const row of list) {
    if (row.target_type === 'reward') {
      const t = await DB.prepare(
        'SELECT name, rarity, image FROM reward_templates WHERE id = ?'
      ).bind(row.target_id).first()
      row.target_name = t ? t.name : ''
      row.target_rarity = t ? t.rarity : null
      row.target_image = t ? t.image : ''
    }
  }
  return list
}
