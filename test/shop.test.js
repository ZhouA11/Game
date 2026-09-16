// 步骤5 · 商店与玩家面板 单元测试（§5 验收）

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'

import { listShopProducts, buyProductOp, createProductOp } from '../src/games/shop.js'
import { reduceSpankOp, listReducibleTargets, applyPenaltyStmts } from '../src/kernel/spank.js'
import { synthesizeFragmentOp } from '../src/kernel/fragments.js'
import { handleGamesRequest } from '../src/games/router.js'

let DB

async function newUser(db, username, balance = 100000, activity = 1000) {
  await db.prepare("INSERT INTO users (username, password, role, balance, activity) VALUES (?, 'x', 'player', ?, ?)")
    .bind(username, balance, activity).run()
}
const balanceOf = async (db, u) => (await db.prepare('SELECT balance FROM users WHERE username = ?').bind(u).first())?.balance ?? 0
const activityOf = async (db, u) => (await db.prepare('SELECT activity FROM users WHERE username = ?').bind(u).first())?.activity ?? 0
const itemCount = async (db, u, id) =>
  (await db.prepare('SELECT count FROM player_items WHERE username = ? AND item_id = ?').bind(u, id).first())?.count ?? 0
const spankCount = async (db, u, id) =>
  (await db.prepare('SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?').bind(u, id).first())?.count ?? 0
const exec = (db, stmts) => db.batch(stmts)
let keySeq = 0
const nextKey = () => `shop-key-${++keySeq}`

beforeAll(async () => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT, price REAL)`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
})

// ============ T5.2 上架硬校验 ============
describe('上架硬校验（服务端）', () => {
  it('引用收藏外观的商品被拒绝（G16）', async () => {
    await expect(createProductOp(DB, { item_id: 21, currency: 'coin', price: 10 }, 'zhou'))
      .rejects.toMatchObject({ code: 'PRODUCT_FORBIDDEN' })
  })
  it('引用奖励/碎片的商品被拒绝（G8/G10）', async () => {
    // item_templates 中不存在奖励/碎片类目——用不存在的 id 模拟非法引用
    await expect(createProductOp(DB, { item_id: 9999, currency: 'coin', price: 10 }, 'zhou'))
      .rejects.toMatchObject({ code: 'INVALID_REF' })
  })
  it('减免券定价低于减免折算价被拦截（T5.4）', async () => {
    // 消除券·华丽：减免量6 × 单位折算价10 = 60
    await expect(createProductOp(DB, { item_id: 13, currency: 'coin', price: 50 }, 'zhou'))
      .rejects.toMatchObject({ code: 'PRICE_BELOW_FLOOR' })
    // 等于折算价可上架
    const p = await createProductOp(DB, { item_id: 13, currency: 'coin', price: 60, daily_limit: 3 }, 'zhou')
    expect(p.price).toBe(60)
  })
  it('商品列表只含游戏类/减免类道具（T5.1）', async () => {
    const products = await listShopProducts(DB)
    expect(products.length).toBeGreaterThanOrEqual(11)
    for (const p of products) {
      expect(['game', 'clear']).toContain(p.category)
      expect(['coin', 'activity']).toContain(p.currency)
    }
  })
})

// ============ T5.3 币种可配 + 验收：正确扣减/按币种拦截 ============
describe('购买与币种', () => {
  it('金币商品扣金币，活跃值商品扣活跃值；余额不足按该币种拦截（验收②）', async () => {
    await newUser(DB, 'm_cur', 1000, 50)
    // 金币商品
    const r1 = await buyProductOp(DB, { username: 'm_cur', productId: 1, idempotencyKey: nextKey() })
    expect(r1.currency).toBe('coin')
    expect(await balanceOf(DB, 'm_cur')).toBe(1000 - 20)
    expect(await activityOf(DB, 'm_cur')).toBe(50)
    // 活跃值商品
    const r2 = await buyProductOp(DB, { username: 'm_cur', productId: 11, idempotencyKey: nextKey() })
    expect(r2.currency).toBe('activity')
    expect(await activityOf(DB, 'm_cur')).toBe(50 - 30)
    expect(await balanceOf(DB, 'm_cur')).toBe(1000 - 20)
    // 活跃值不足 → 按活跃值拦截
    await expect(buyProductOp(DB, { username: 'm_cur', productId: 11, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: '活跃值不足' })
    // 金币充足但活跃值不足时金币商品仍可买
    const r3 = await buyProductOp(DB, { username: 'm_cur', productId: 1, idempotencyKey: nextKey() })
    expect(r3.currency).toBe('coin')
  })

  it('断网重试不双扣（验收①）：同键重放返回首次结果', async () => {
    await newUser(DB, 'm_idem', 1000)
    const key = nextKey()
    const r1 = await buyProductOp(DB, { username: 'm_idem', productId: 2, idempotencyKey: key })
    const r2 = await buyProductOp(DB, { username: 'm_idem', productId: 2, idempotencyKey: key })
    expect(r2.replayed).toBe(true)
    expect(await balanceOf(DB, 'm_idem')).toBe(1000 - 30)
    expect(await itemCount(DB, 'm_idem', 2)).toBe(1)
  })

  it('减免券限购生效（T5.4）', async () => {
    await newUser(DB, 'm_limit', 100000)
    // 赦免券·鎏金 限购 1/日
    await buyProductOp(DB, { username: 'm_limit', productId: 10, idempotencyKey: nextKey() })
    await expect(buyProductOp(DB, { username: 'm_limit', productId: 10, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'PURCHASE_LIMIT' })
    // 游戏道具 5/日
    for (let i = 0; i < 5; i++) await buyProductOp(DB, { username: 'm_limit', productId: 1, idempotencyKey: nextKey() })
    await expect(buyProductOp(DB, { username: 'm_limit', productId: 1, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'PURCHASE_LIMIT' })
  })
})

// ============ 验收：e2e 购买 → 使用减免券 → Spank 扣减 ============
describe('e2e：惩罚区 → 减免券转化', () => {
  it('购买减免券 → 等级匹配选目标 → Spank 扣减、券消耗', async () => {
    await newUser(DB, 'm_e2e', 100000)
    // 施加 Spank：戒尺(L3) 10 点
    await exec(DB, (await applyPenaltyStmts(DB, { username: 'm_e2e', penaltyId: 4, spanks: 10, source: 'game_drop' })).stmts)
    // 购买消除券·华丽（L3，-6）
    await buyProductOp(DB, { username: 'm_e2e', productId: 9, idempotencyKey: nextKey() })
    expect(await itemCount(DB, 'm_e2e', 13)).toBe(1)
    // 惩罚区可选目标：L3 券可作用 L1~L3
    const { targets } = await listReducibleTargets(DB, 'm_e2e', 13)
    expect(targets.some(t => t.penalty_id === 4)).toBe(true)
    // 使用减免券 → Spank 扣减
    const r = await reduceSpankOp(DB, { username: 'm_e2e', couponItemId: 13, targetPenaltyId: 4, idempotencyKey: nextKey() })
    expect(r.applied).toBe(6)
    expect(await spankCount(DB, 'm_e2e', 4)).toBe(4)
    expect(await itemCount(DB, 'm_e2e', 13)).toBe(0)
  })

  it('等级不足的目标不可选、券不消耗（验收③）', async () => {
    await newUser(DB, 'm_rank', 100000)
    await exec(DB, (await applyPenaltyStmts(DB, { username: 'm_rank', penaltyId: 5, spanks: 15, source: 'game_drop' })).stmts) // 乌木杖 L4
    // 购买 L1 减免券
    await buyProductOp(DB, { username: 'm_rank', productId: 7, idempotencyKey: nextKey() })
    const { targets } = await listReducibleTargets(DB, 'm_rank', 11)
    expect(targets.some(t => t.penalty_id === 5)).toBe(false)  // 不可选
    await expect(reduceSpankOp(DB, { username: 'm_rank', couponItemId: 11, targetPenaltyId: 5, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'RARITY_MISMATCH' })
    expect(await itemCount(DB, 'm_rank', 11)).toBe(1)          // 券不消耗
  })
})

// ============ 验收：碎片集齐 → 合成 → 入背包 ============
describe('e2e：碎片合成', () => {
  it('集齐 5 片华丽碎片 → 合成消除券·华丽入背包', async () => {
    await newUser(DB, 'm_frag', 100000)
    await DB.prepare(
      `INSERT INTO player_fragments (username, recipe_id, count) VALUES ('m_frag', 1, 5)
       ON CONFLICT(username, recipe_id) DO UPDATE SET count = 5`
    ).run()
    const r = await synthesizeFragmentOp(DB, { username: 'm_frag', recipeId: 1, idempotencyKey: nextKey() })
    expect(r.piecesUsed).toBe(5)
    expect(await itemCount(DB, 'm_frag', 13)).toBe(1)
    expect((await DB.prepare("SELECT count FROM player_fragments WHERE username = 'm_frag' AND recipe_id = 1").first()).count).toBe(0)
  })
})

// ============ 路由 ============
describe('商城路由', () => {
  it('未登录访问商品列表 401；管理端上架需管理员', async () => {
    const r1 = await handleGamesRequest(new Request('https://x/api/mall/products'), DB, ['mall', 'products'])
    expect(r1.status).toBe(401)
    const r2 = await handleGamesRequest(
      new Request('https://x/api/mall/admin/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: 1, price: 20 }),
      }), DB, ['mall', 'admin', 'products']
    )
    expect(r2.status).toBe(401)
  })
})
