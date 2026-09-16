// 步骤1 · 互通内核 单元测试
// 覆盖 02-步骤1-互通内核.md §4「本步验收」全部分支 + 内核各模块关键路径

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations, withFailureOn } from './d1-adapter.js'

import { applyLedger } from '../src/kernel/ledger.js'
import { KernelError } from '../src/kernel/util.js'
import { applyPenaltyStmts, reduceSpankOp, listSpanks, listReducibleTargets } from '../src/kernel/spank.js'
import { resolveEventStmts, resolveEvent, setAutoMount } from '../src/kernel/resolver.js'
import { grantRewardStmts, redeemRewardOp, listRewardBag } from '../src/kernel/backpack.js'
import { requiredPieces, synthesizeFragmentOp, listFragments } from '../src/kernel/fragments.js'
import {
  rollDrop, grantDropStmts, createDropEntry, getSideControls, setSideControls,
} from '../src/kernel/drops.js'
import {
  createAdjustmentOp, approveAdjustment, rejectAdjustment, listAdjustments,
} from '../src/kernel/adjust.js'
import {
  createTemplate, updateTemplate, disableTemplate, deleteTemplate,
  listRarity, updateRarity, updateParams,
} from '../src/kernel/templates.js'
import { handleKernelRequest } from '../src/kernel/router.js'

let DB
const exec = (db, stmts) => (stmts.length ? db.batch(stmts) : Promise.resolve([]))

async function newUser(db, username, balance = 1000) {
  await db.prepare(
    "INSERT INTO users (username, password, role, balance) VALUES (?, 'x', 'player', ?)"
  ).bind(username, balance).run()
}
async function giveItem(db, username, itemId, count = 1) {
  await db.prepare(
    'INSERT INTO player_items (username, item_id, count) VALUES (?, ?, ?)'
  ).bind(username, itemId, count).run()
}
async function giveFragments(db, username, recipeId, count) {
  await db.prepare(
    `INSERT INTO player_fragments (username, recipe_id, count) VALUES (?, ?, ?)
     ON CONFLICT(username, recipe_id) DO UPDATE SET count = count + excluded.count`
  ).bind(username, recipeId, count).run()
}
const spankCount = async (db, username, penaltyId) =>
  (await db.prepare('SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?').bind(username, penaltyId).first())?.count ?? 0
const itemCount = async (db, username, itemId) =>
  (await db.prepare('SELECT count FROM player_items WHERE username = ? AND item_id = ?').bind(username, itemId).first())?.count ?? 0
const balanceOf = async (db, username) =>
  (await db.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first())?.balance ?? 0
const activityOf = async (db, username) =>
  (await db.prepare('SELECT activity FROM users WHERE username = ?').bind(username).first())?.activity ?? 0

// 种子模板ID：木拍1(L1,1~2,cap500) 藤条2(L2,3~5) 铁尺3(L2,8~12) 戒尺4(L3,6~10) 乌木杖5(L4,12~20)
// 道具：稳定爪1 透视镜2 连败保险3 换机券4 Nudge包5 Fever槽6 | 减免券 普通11(L1,-1) 精致12(L2,-3) 华丽13(L3,-6) 鎏金14(L4,-12)
// 奖励：奶茶券1(L1,stock-1) 月卡2(L2,stock10) 电影票3(L3,stock5)

beforeAll(() => {
  DB = createTestDB()
  // products 表在线上为手工建表（不在迁移文件中），测试引导需先补建
  DB.exec(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL,
    description TEXT, image TEXT, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
})

// ============ 统一账本 ============
describe('统一账本 debit/credit', () => {
  it('充值与扣款正确记账并记录余额快照', async () => {
    await newUser(DB, 'u_ledger', 100)
    const r1 = await applyLedger(DB, { username: 'u_ledger', currency: 'coin', delta: 50, reason: 'test_credit' })
    expect(r1.balance).toBe(150)
    const r2 = await applyLedger(DB, { username: 'u_ledger', currency: 'coin', delta: -30, reason: 'test_debit' })
    expect(r2.balance).toBe(120)
    const entries = await DB.prepare("SELECT delta, balance_after FROM ledger_entries WHERE username = 'u_ledger' ORDER BY id").all()
    expect(entries.results.map(e => [e.delta, e.balance_after])).toEqual([[50, 150], [-30, 120]])
  })

  it('余额不足时扣款失败且不写任何流水', async () => {
    await newUser(DB, 'u_broke', 10)
    await expect(applyLedger(DB, { username: 'u_broke', currency: 'coin', delta: -50, reason: 'test' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    const n = await DB.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE username = 'u_broke'").first()
    expect(n.c).toBe(0)
    expect(await balanceOf(DB, 'u_broke')).toBe(10)
  })

  it('金币与活跃值相互独立', async () => {
    await newUser(DB, 'u_dual', 0)
    await applyLedger(DB, { username: 'u_dual', currency: 'activity', delta: 5, reason: 'play' })
    expect(await activityOf(DB, 'u_dual')).toBe(5)
    expect(await balanceOf(DB, 'u_dual')).toBe(0)
    await expect(applyLedger(DB, { username: 'u_dual', currency: 'activity', delta: -10, reason: 'x' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
  })
})

// ============ T1.6 Spank 累计与减免 ============
describe('Spank 累计与减免事务模型', () => {
  it('Spank 累加且按道具隔离（玩家×道具）', async () => {
    await newUser(DB, 's_alice')
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_alice', penaltyId: 1, spanks: 3, source: 'game_drop' })).stmts)
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_alice', penaltyId: 2, spanks: 2, source: 'game_drop' })).stmts)
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_alice', penaltyId: 1, spanks: 4, source: 'game_drop' })).stmts)
    // 同一玩家不同道具隔离
    expect(await spankCount(DB, 's_alice', 1)).toBe(7)
    expect(await spankCount(DB, 's_alice', 2)).toBe(2)
    // 不同玩家隔离
    await newUser(DB, 's_bob')
    expect(await spankCount(DB, 's_bob', 1)).toBe(0)
  })

  it('累计达到道具上限后不再累加', async () => {
    await newUser(DB, 's_cap')
    // 临时把木拍上限调到 5
    await DB.prepare('UPDATE penalty_templates SET spank_cap = 5 WHERE id = 1').run()
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_cap', penaltyId: 1, spanks: 4, source: 'game_drop' })).stmts)
    const r = await applyPenaltyStmts(DB, { username: 's_cap', penaltyId: 1, spanks: 10, source: 'game_drop' })
    expect(r.applied).toBe(1) // 4+10 截断为 5
    await exec(DB, r.stmts)
    expect(await spankCount(DB, 's_cap', 1)).toBe(5)
    await DB.prepare('UPDATE penalty_templates SET spank_cap = 500 WHERE id = 1').run()
  })

  it('减免券只能作用于等级达标目标：可减列表不含超等级道具', async () => {
    await newUser(DB, 's_match')
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_match', penaltyId: 3, spanks: 8, source: 'game_drop' })).stmts) // 铁尺 L2
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_match', penaltyId: 4, spanks: 6, source: 'game_drop' })).stmts) // 戒尺 L3
    const { targets } = await listReducibleTargets(DB, 's_match', 12) // 精致券 L2
    const ids = targets.map(t => t.penalty_id)
    expect(ids).toContain(3)
    expect(ids).not.toContain(4) // L3 > L2 不可选
  })

  it('等级不足的目标不可选、且券不消耗', async () => {
    await newUser(DB, 's_mismatch')
    await giveItem(DB, 's_mismatch', 12, 1) // 精致券 L2
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_mismatch', penaltyId: 4, spanks: 6, source: 'game_drop' })).stmts) // 戒尺 L3
    await expect(reduceSpankOp(DB, { username: 's_mismatch', couponItemId: 12, targetPenaltyId: 4 }))
      .rejects.toMatchObject({ code: 'RARITY_MISMATCH' })
    expect(await itemCount(DB, 's_mismatch', 12)).toBe(1) // 券未消耗
    expect(await spankCount(DB, 's_mismatch', 4)).toBe(6) // Spank 未变
  })

  it('正常减免：扣券、减Spank、写流水', async () => {
    await newUser(DB, 's_ok')
    await giveItem(DB, 's_ok', 12, 2)
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_ok', penaltyId: 3, spanks: 8, source: 'game_drop' })).stmts)
    const r = await reduceSpankOp(DB, { username: 's_ok', couponItemId: 12, targetPenaltyId: 3 })
    expect(r.applied).toBe(3)
    expect(await itemCount(DB, 's_ok', 12)).toBe(1)
    expect(await spankCount(DB, 's_ok', 3)).toBe(5)
    const log = await DB.prepare("SELECT delta, source, coupon_item_id FROM spank_logs WHERE username = 's_ok' AND delta < 0").first()
    expect(log).toMatchObject({ delta: -3, source: 'player_reduce', coupon_item_id: 12 })
  })

  it('减免量超过剩余Spank时归零并作废余量', async () => {
    await newUser(DB, 's_void')
    await giveItem(DB, 's_void', 14, 1) // 鎏金券 L4，面值12
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_void', penaltyId: 4, spanks: 5, source: 'game_drop' })).stmts) // 戒尺仅5
    const r = await reduceSpankOp(DB, { username: 's_void', couponItemId: 14, targetPenaltyId: 4 })
    expect(r.applied).toBe(5)
    expect(r.voided).toBe(7)
    expect(await spankCount(DB, 's_void', 4)).toBe(0)   // 归零
    expect(await itemCount(DB, 's_void', 14)).toBe(0)   // 券一次用尽
  })

  it('目标无Spank可减时报错且券不消耗', async () => {
    await newUser(DB, 's_zero')
    await giveItem(DB, 's_zero', 11, 1)
    await expect(reduceSpankOp(DB, { username: 's_zero', couponItemId: 11, targetPenaltyId: 1 }))
      .rejects.toMatchObject({ code: 'NO_SPANK_TO_REDUCE' })
    expect(await itemCount(DB, 's_zero', 11)).toBe(1)
  })

  it('Spank 面板按道具分组返回累计与持有券', async () => {
    await newUser(DB, 's_panel')
    await exec(DB, (await applyPenaltyStmts(DB, { username: 's_panel', penaltyId: 1, spanks: 2, source: 'game_drop' })).stmts)
    const panel = await listSpanks(DB, 's_panel')
    const wood = panel.penalties.find(p => p.penalty_id === 1)
    expect(wood.count).toBe(2)
    expect(panel.coupons.length).toBeGreaterThanOrEqual(4)
  })
})

// ============ T1.7 后台人工调整 ============
describe('后台人工调整模型（四类数据）', () => {
  it('资产调整（金币）：走统一账本并写审计', async () => {
    await newUser(DB, 'a_coin', 100)
    const r = await createAdjustmentOp(DB, {
      operator: 'zhou', username: 'a_coin', targetType: 'coin', delta: 100, reason: '补偿', idempotencyKey: 'adj-c1',
    })
    expect(r.status).toBe('applied')
    expect(await balanceOf(DB, 'a_coin')).toBe(200)
    const adj = await DB.prepare("SELECT status, requested_by, reason FROM admin_adjustments WHERE idempotency_key = 'adj-c1'").first()
    expect(adj).toMatchObject({ status: 'applied', requested_by: 'zhou', reason: '补偿' })
    const ledger = await DB.prepare("SELECT reason, ref_type FROM ledger_entries WHERE username = 'a_coin'").first()
    expect(ledger).toMatchObject({ reason: 'admin_adjust', ref_type: 'adjustment' })
  })

  it('资产调整（活跃值）', async () => {
    await newUser(DB, 'a_act', 0)
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_act', targetType: 'activity', delta: 7, reason: '活动补偿', idempotencyKey: 'adj-a1' })
    expect(await activityOf(DB, 'a_act')).toBe(7)
  })

  it('道具调整：发放与回收', async () => {
    await newUser(DB, 'a_item')
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_item', targetType: 'item', targetId: 1, delta: 2, reason: '发放稳定爪', idempotencyKey: 'adj-i1' })
    expect(await itemCount(DB, 'a_item', 1)).toBe(2)
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_item', targetType: 'item', targetId: 1, delta: -1, reason: '回收1个', idempotencyKey: 'adj-i2' })
    expect(await itemCount(DB, 'a_item', 1)).toBe(1)
    // 回收后不能为负
    await expect(createAdjustmentOp(DB, { operator: 'zhou', username: 'a_item', targetType: 'item', targetId: 1, delta: -5, reason: '超收', idempotencyKey: 'adj-i3' }))
      .rejects.toMatchObject({ code: 'ADJUST_NEGATIVE' })
  })

  it('奖励调整：发放与回收', async () => {
    await newUser(DB, 'a_reward')
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_reward', targetType: 'reward', targetId: 1, delta: 2, reason: '补发奶茶券', idempotencyKey: 'adj-r1' })
    const bag = await listRewardBag(DB, 'a_reward')
    expect(bag.find(b => b.reward_id === 1).quantity).toBe(2)
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_reward', targetType: 'reward', targetId: 1, delta: -1, reason: '回收', idempotencyKey: 'adj-r2' })
    expect((await listRewardBag(DB, 'a_reward')).find(b => b.reward_id === 1).quantity).toBe(1)
    await expect(createAdjustmentOp(DB, { operator: 'zhou', username: 'a_reward', targetType: 'reward', targetId: 1, delta: -9, reason: '超收', idempotencyKey: 'adj-r3' }))
      .rejects.toMatchObject({ code: 'ADJUST_NEGATIVE' })
  })

  it('惩罚（Spank）调整：施加与扣减，写 spank_logs', async () => {
    await newUser(DB, 'a_spank')
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_spank', targetType: 'penalty', targetId: 2, delta: 5, reason: '追加惩罚', idempotencyKey: 'adj-p1' })
    expect(await spankCount(DB, 'a_spank', 2)).toBe(5)
    await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_spank', targetType: 'penalty', targetId: 2, delta: -2, reason: '表现良好', idempotencyKey: 'adj-p2' })
    expect(await spankCount(DB, 'a_spank', 2)).toBe(3)
    const logs = await DB.prepare("SELECT delta, source, admin FROM spank_logs WHERE username = 'a_spank' ORDER BY id").all()
    expect(logs.results.map(l => [l.delta, l.source, l.admin])).toEqual([[5, 'admin_adjust', 'zhou'], [-2, 'admin_adjust', 'zhou']])
  })

  it('调整原因必填', async () => {
    await newUser(DB, 'a_reason')
    await expect(createAdjustmentOp(DB, { operator: 'zhou', username: 'a_reason', targetType: 'coin', delta: 1, reason: '  ', idempotencyKey: 'adj-er' }))
      .rejects.toMatchObject({ code: 'ADJUST_REASON_REQUIRED' })
  })

  it('幂等：重复提交返回首次结果，绝不双扣', async () => {
    await newUser(DB, 'a_idem', 100)
    const r1 = await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_idem', targetType: 'coin', delta: 50, reason: '首充', idempotencyKey: 'adj-idem' })
    const r2 = await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_idem', targetType: 'coin', delta: 50, reason: '首充', idempotencyKey: 'adj-idem' })
    expect(r2.replayed).toBe(true)
    expect(r2.status).toBe(r1.status)
    expect(await balanceOf(DB, 'a_idem')).toBe(150) // 只生效一次
  })

  it('超阈值待审批：审批后生效、驳回不生效', async () => {
    await newUser(DB, 'a_thr', 0)
    const r = await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_thr', targetType: 'item', targetId: 5, delta: 99, reason: '大批量发放', idempotencyKey: 'adj-t1' })
    expect(r.status).toBe('pending')
    expect(await itemCount(DB, 'a_thr', 5)).toBe(0) // 未生效
    const pend = await listAdjustments(DB, { status: 'pending' })
    const row = pend.find(a => a.idempotency_key === 'adj-t1')
    expect(row).toBeTruthy()
    await approveAdjustment(DB, row.id, 'zhou')
    expect(await itemCount(DB, 'a_thr', 5)).toBe(99)

    const r2 = await createAdjustmentOp(DB, { operator: 'zhou', username: 'a_thr', targetType: 'item', targetId: 6, delta: 20, reason: '驳回示例', idempotencyKey: 'adj-t2' })
    expect(r2.status).toBe('pending')
    const row2 = (await listAdjustments(DB, { status: 'pending' })).find(a => a.idempotency_key === 'adj-t2')
    await rejectAdjustment(DB, row2.id, 'zhou')
    expect(await itemCount(DB, 'a_thr', 6)).toBe(0)
    await expect(approveAdjustment(DB, row2.id, 'zhou')).rejects.toMatchObject({ code: 'ALREADY_PROCESSED' })
  })

  it('调整后资产为负时拦截（金币）', async () => {
    await newUser(DB, 'a_neg', 10)
    await expect(createAdjustmentOp(DB, { operator: 'zhou', username: 'a_neg', targetType: 'coin', delta: -100, reason: '多扣', idempotencyKey: 'adj-n1' }))
      .rejects.toMatchObject({ code: 'ADJUST_NEGATIVE' })
    expect(await balanceOf(DB, 'a_neg')).toBe(10)
  })
})

// ============ T1.4 碎片配方 ============
describe('碎片配方与合成', () => {
  it('L3目标需5片、L4目标需7片（服务端强制，忽略存储值）', () => {
    expect(requiredPieces(3)).toBe(5)
    expect(requiredPieces(4)).toBe(7)
    expect(requiredPieces(1)).toBeNull()
    expect(requiredPieces(2)).toBeNull()
  })

  it('碎片合成：扣碎片+发放目标（奖励目标，含扣库存）', async () => {
    await newUser(DB, 'f_ok')
    // 种子配方：reward 3（电影票 L3，库存5）→ 5片
    await giveFragments(DB, 'f_ok', 3, 5)
    const r = await synthesizeFragmentOp(DB, { username: 'f_ok', recipeId: 3, idempotencyKey: 'frag-1' })
    expect(r.piecesUsed).toBe(5)
    const stock = (await DB.prepare('SELECT stock FROM reward_templates WHERE id = 3').first()).stock
    expect(stock).toBe(4)
    const bag = await listRewardBag(DB, 'f_ok')
    expect(bag.find(b => b.reward_id === 3).quantity).toBe(1)
    const frag = await DB.prepare("SELECT count FROM player_fragments WHERE username = 'f_ok' AND recipe_id = 3").first()
    expect(frag.count).toBe(0)
  })

  it('碎片不足时拒绝且不产生任何变动', async () => {
    await newUser(DB, 'f_low')
    await giveFragments(DB, 'f_low', 1, 4) // 配方1：消除券·华丽 L3 需5片
    await expect(synthesizeFragmentOp(DB, { username: 'f_low', recipeId: 1 }))
      .rejects.toMatchObject({ code: 'FRAGMENT_INSUFFICIENT' })
    expect((await DB.prepare("SELECT count FROM player_fragments WHERE username = 'f_low' AND recipe_id = 1").first()).count).toBe(4)
    expect(await itemCount(DB, 'f_low', 13)).toBe(0)
  })

  it('合成事务回滚：任一步失败整体回滚，碎片不丢失', async () => {
    await newUser(DB, 'f_rb')
    await giveFragments(DB, 'f_rb', 3, 5)
    const FailingDB = withFailureOn(DB, 'asset_logs') // 命中合成流水语句时注入失败
    await expect(synthesizeFragmentOp(FailingDB, { username: 'f_rb', recipeId: 3 }))
      .rejects.toThrow('INJECTED_FAILURE')
    // 全部回滚：碎片仍在、库存未扣、背包为空
    expect((await DB.prepare("SELECT count FROM player_fragments WHERE username = 'f_rb' AND recipe_id = 3").first()).count).toBe(5)
    expect((await DB.prepare('SELECT stock FROM reward_templates WHERE id = 3').first()).stock).toBe(4) // 未被本次合成扣减（仍是上一用例后的4）
    expect((await listRewardBag(DB, 'f_rb')).length).toBe(0)
  })

  it('所需碎片数按目标稀有度服务端推导（L4目标即使配方错存5片也需7片）', async () => {
    const db2 = createTestDB()
    db2.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT, price REAL)`)
    applyMigrations(db2, fileURLToPath(new URL('../migrations', import.meta.url)))
    await newUser(db2, 'f_l4')
    // 人为把 L4 目标（赦免券·鎏金）的种子配方错存为 5 片
    await db2.prepare("UPDATE fragment_recipes SET pieces_required = 5 WHERE target_type = 'item' AND target_id = 14").run()
    await giveFragments(db2, 'f_l4', 2, 5)
    await expect(synthesizeFragmentOp(db2, { username: 'f_l4', recipeId: 2 }))
      .rejects.toMatchObject({ code: 'FRAGMENT_INSUFFICIENT' })
    await giveFragments(db2, 'f_l4', 2, 2) // 凑足7
    const r = await synthesizeFragmentOp(db2, { username: 'f_l4', recipeId: 2 })
    expect(r.piecesUsed).toBe(7)
    expect(await itemCount(db2, 'f_l4', 14)).toBe(1)
  })

  it('碎片进度列表返回持有与所需', async () => {
    await newUser(DB, 'f_list')
    await giveFragments(DB, 'f_list', 2, 3)
    const list = await listFragments(DB, 'f_list')
    const row = list.find(f => f.recipe_id === 2)
    expect(row.owned).toBe(3)
    expect(row.pieces_required).toBe(7)
    expect(row.target_name).toBe('赦免券·鎏金')
  })
})

// ============ T1.8 奖励背包与履约 ============
describe('奖励背包与履约', () => {
  it('游戏开出→入包→手动核销', async () => {
    await newUser(DB, 'b_ok')
    await exec(DB, (await grantRewardStmts(DB, { username: 'b_ok', rewardId: 1, source: 'game_drop' })).stmts)
    await exec(DB, (await grantRewardStmts(DB, { username: 'b_ok', rewardId: 1, source: 'game_drop' })).stmts)
    let bag = await listRewardBag(DB, 'b_ok')
    expect(bag.find(b => b.reward_id === 1).quantity).toBe(2)
    await redeemRewardOp(DB, { username: 'b_ok', rewardId: 1, idempotencyKey: 'red-1' })
    bag = await listRewardBag(DB, 'b_ok')
    expect(bag.find(b => b.reward_id === 1).quantity).toBe(1)
    await redeemRewardOp(DB, { username: 'b_ok', rewardId: 1, idempotencyKey: 'red-2' })
    bag = await listRewardBag(DB, 'b_ok')
    expect(bag.find(b => b.reward_id === 1)).toBeUndefined() // 核销完即从背包移除
  })

  it('库存为0时掉落池自动跳过并记录次数', async () => {
    await newUser(DB, 'b_skip')
    // 新建一个 0 库存奖励并放入池
    const tpl = await createTemplate(DB, 'reward', { name: '绝版手办', rarity: 4, kind: 'physical', value: 300, stock: 0 }, 'zhou')
    await createDropEntry(DB, { game: 'test', side: 'reward', ref_type: 'reward', ref_id: tpl.id, weight: 1000 }, 'zhou')
    await createDropEntry(DB, { game: 'test', side: 'reward', ref_type: 'coin', amount: 1, weight: 1 }, 'zhou')
    await setSideControls(DB, 'test', 'default', 1, 0, 'zhou')
    // rng 固定 0.999：若不跳过必命中权重1000的绝版手办；跳过后落到金币条目
    const { entry, skipStmts } = await rollDrop(DB, { game: 'test', rng: () => 0.999 })
    expect(entry.ref_type).toBe('coin')
    expect(skipStmts.length).toBe(1)
    await exec(DB, skipStmts)
    const skip = await DB.prepare('SELECT COUNT(*) AS c FROM drop_skip_logs').first()
    expect(skip.c).toBe(1)
  })

  it('核销幂等：重复提交只核销一次', async () => {
    await newUser(DB, 'b_idem')
    await exec(DB, (await grantRewardStmts(DB, { username: 'b_idem', rewardId: 2, source: 'game_drop' })).stmts)
    await redeemRewardOp(DB, { username: 'b_idem', rewardId: 2, idempotencyKey: 'red-idem' })
    await redeemRewardOp(DB, { username: 'b_idem', rewardId: 2, idempotencyKey: 'red-idem' })
    const bag = await listRewardBag(DB, 'b_idem')
    expect(bag.find(b => b.reward_id === 2)).toBeUndefined() // 只有一份，未双核销报错
  })
})

// ============ T1.5 Resolver ============
describe('Resolver（事件解析器）', () => {
  it('自动挂载道具在挂载点生效：消耗+写效果流水', async () => {
    await newUser(DB, 'r_basic')
    await giveItem(DB, 'r_basic', 1, 1) // 稳定爪 auto=1 grab.before
    const { effects } = await resolveEvent(DB, { username: 'r_basic', game: 'grab', event: 'grab.before', scope: 'grab' })
    expect(effects.length).toBe(1)
    expect(effects[0]).toMatchObject({ itemId: 1, action: 'rate_boost', value: 15 })
    expect(await itemCount(DB, 'r_basic', 1)).toBe(0)
    const log = await DB.prepare("SELECT game, event, action FROM effect_logs WHERE username = 'r_basic'").first()
    expect(log).toMatchObject({ game: 'grab', event: 'grab.before', action: 'rate_boost' })
  })

  it('按优先级升序应用（小者先）', async () => {
    await newUser(DB, 'r_prio')
    await giveItem(DB, 'r_prio', 3, 1) // 连败保险 priority 200
    await giveItem(DB, 'r_prio', 1, 1) // 稳定爪 priority 100
    const { effects } = await resolveEvent(DB, { username: 'r_prio', game: 'grab', event: 'grab.before', scope: 'grab' })
    expect(effects.map(e => e.action)).toEqual(['rate_boost', 'insurance'])
  })

  it('手动道具（auto_mount=0）不自动生效；玩家开关可关闭自动道具', async () => {
    await newUser(DB, 'r_manual')
    await giveItem(DB, 'r_manual', 2, 1) // 透视镜 auto=0
    await giveItem(DB, 'r_manual', 1, 1)
    // 玩家关闭稳定爪自动挂载
    await setAutoMount(DB, 'r_manual', 1, 'off')
    const { effects } = await resolveEvent(DB, { username: 'r_manual', game: 'grab', event: 'grab.before', scope: 'grab' })
    expect(effects.length).toBe(0)
    expect(await itemCount(DB, 'r_manual', 2)).toBe(1)
    expect(await itemCount(DB, 'r_manual', 1)).toBe(1)
    // 重新开启后生效
    await setAutoMount(DB, 'r_manual', 1, 'on')
    const { effects: e2 } = await resolveEvent(DB, { username: 'r_manual', game: 'grab', event: 'grab.before', scope: 'grab' })
    expect(e2.length).toBe(1)
  })

  it('作用域过滤：slot限定道具不在grab挂载点生效', async () => {
    await newUser(DB, 'r_scope')
    // 自建一个 slot 限定、挂载 grab.before 的道具（验证 scope 过滤本身）
    const it = await createTemplate(DB, 'item', { name: '测试槽机', rarity: 1, category: 'game', action: 'rate_boost', action_value: 5, mount_events: 'grab.before', scope: 'slot', auto_mount: 1 }, 'zhou')
    await giveItem(DB, 'r_scope', it.id, 1)
    const { effects } = await resolveEvent(DB, { username: 'r_scope', game: 'grab', event: 'grab.before', scope: 'grab' })
    expect(effects.length).toBe(0)
    const { effects: e2 } = await resolveEvent(DB, { username: 'r_scope', game: 'slot', event: 'grab.before', scope: 'slot' })
    expect(e2.length).toBe(1)
  })

  it('游戏侧上下文过滤（连败保险仅在连败3次后生效）', async () => {
    await newUser(DB, 'r_ins')
    await giveItem(DB, 'r_ins', 3, 1)
    const noFail = await resolveEvent(DB, {
      username: 'r_ins', game: 'grab', event: 'grab.before', scope: 'grab',
      filterFn: (row) => row.action !== 'insurance' || false, // 未连败：保险不生效
    })
    expect(noFail.effects.length).toBe(0)
    const afterFail = await resolveEvent(DB, {
      username: 'r_ins', game: 'grab', event: 'grab.before', scope: 'grab',
      filterFn: (row) => row.action !== 'insurance' || true, // 连败3次：保险生效
    })
    expect(afterFail.effects.map(e => e.action)).toEqual(['insurance'])
  })

  it('解析器事务回滚：失败时道具不消耗、流水不残留', async () => {
    await newUser(DB, 'r_rb')
    await giveItem(DB, 'r_rb', 1, 1)
    const FailingDB = withFailureOn(DB, 'effect_logs')
    await expect(resolveEvent(FailingDB, { username: 'r_rb', game: 'grab', event: 'grab.before', scope: 'grab' }))
      .rejects.toThrow('INJECTED_FAILURE')
    expect(await itemCount(DB, 'r_rb', 1)).toBe(1)
    const logs = await DB.prepare("SELECT COUNT(*) AS c FROM effect_logs WHERE username = 'r_rb'").first()
    expect(logs.c).toBe(0)
  })

  it('未知挂载点拒绝', async () => {
    await newUser(DB, 'r_bad')
    await expect(resolveEventStmts(DB, { username: 'r_bad', game: 'grab', event: 'hack.now', scope: 'grab' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAM' })
  })
})

// ============ T1.3 掉落池引用 ============
describe('掉落池与内容发放', () => {
  it('总控概率决定落侧：全奖励侧时惩罚条目不出现', async () => {
    await newUser(DB, 'd_side')
    await createDropEntry(DB, { game: 'dgame', side: 'reward', ref_type: 'coin', amount: 10, weight: 1 }, 'zhou')
    await createDropEntry(DB, { game: 'dgame', side: 'penalty', ref_type: 'penalty', ref_id: 1, weight: 1000 }, 'zhou')
    await setSideControls(DB, 'dgame', 'default', 1, 0, 'zhou')
    const { entry } = await rollDrop(DB, { game: 'dgame', rng: () => 0.5 })
    expect(entry.side).toBe('reward')
    const controls = await getSideControls(DB, 'dgame', 'default')
    expect(controls).toEqual({ reward_side_prob: 1, penalty_side_prob: 0 })
  })

  it('目标侧无可用条目时回退另一侧', async () => {
    await createDropEntry(DB, { game: 'dfall', side: 'penalty', ref_type: 'coin', amount: 5, weight: 1 }, 'zhou')
    await setSideControls(DB, 'dfall', 'default', 1, 0.000001, 'zhou')
    // rng 命中奖励侧（pReward≈1），但奖励侧无条目 → 回退惩罚侧
    const { entry } = await rollDrop(DB, { game: 'dfall', rng: () => 0.5 })
    expect(entry.side).toBe('penalty')
  })

  it('按权重抽取', async () => {
    await createDropEntry(DB, { game: 'dw', side: 'reward', ref_type: 'coin', amount: 1, weight: 1 }, 'zhou')
    await createDropEntry(DB, { game: 'dw', side: 'reward', ref_type: 'coin', amount: 100, weight: 3 }, 'zhou')
    await setSideControls(DB, 'dw', 'default', 1, 0, 'zhou')
    const a = await rollDrop(DB, { game: 'dw', rng: () => 0.1 })  // 0.4 → 第一条
    const b = await rollDrop(DB, { game: 'dw', rng: () => 0.9 })  // 3.6 → 第二条
    expect(a.entry.amount).toBe(1)
    expect(b.entry.amount).toBe(100)
  })

  it('五类条目发放：金币/道具/奖励/惩罚/碎片', async () => {
    await newUser(DB, 'd_grant', 0)
    // 金币
    let g = await grantDropStmts(DB, { username: 'd_grant', entry: { game: 'x', id: 1, ref_type: 'coin', amount: 66 }, source: 'test' })
    await exec(DB, g.stmts)
    expect(await balanceOf(DB, 'd_grant')).toBe(66)
    // 道具
    g = await grantDropStmts(DB, { username: 'd_grant', entry: { game: 'x', id: 2, ref_type: 'item', ref_id: 4 }, source: 'test' })
    await exec(DB, g.stmts)
    expect(await itemCount(DB, 'd_grant', 4)).toBe(1)
    // 奖励（扣库存）
    const stockBefore = (await DB.prepare('SELECT stock FROM reward_templates WHERE id = 2').first()).stock // 10
    g = await grantDropStmts(DB, { username: 'd_grant', entry: { game: 'x', id: 3, ref_type: 'reward', ref_id: 2 }, source: 'test' })
    await exec(DB, g.stmts)
    expect((await DB.prepare('SELECT stock FROM reward_templates WHERE id = 2').first()).stock).toBe(stockBefore - 1)
    expect((await listRewardBag(DB, 'd_grant')).find(b => b.reward_id === 2).quantity).toBe(1)
    // 惩罚（Spank 在 [min,max] 内随机，服务端决定）
    g = await grantDropStmts(DB, { username: 'd_grant', entry: { game: 'x', id: 4, ref_type: 'penalty', ref_id: 2 }, source: 'test', rng: () => 0.99 })
    await exec(DB, g.stmts)
    expect(g.granted.spanks).toBe(5) // 藤条 3~5，rng=0.99 → 上限5
    expect(await spankCount(DB, 'd_grant', 2)).toBe(5)
    // 碎片
    g = await grantDropStmts(DB, { username: 'd_grant', entry: { game: 'x', id: 5, ref_type: 'fragment', ref_id: 1 }, source: 'test' })
    await exec(DB, g.stmts)
    expect((await DB.prepare("SELECT count FROM player_fragments WHERE username = 'd_grant' AND recipe_id = 1").first()).count).toBe(1)
  })

  it('非法引用被拦截（资产/奖励/碎片之外的错误对象）', async () => {
    await expect(createDropEntry(DB, { game: 'dbad', side: 'reward', ref_type: 'reward', ref_id: 99999 }, 'zhou'))
      .rejects.toMatchObject({ code: 'INVALID_REF' })
    await expect(createDropEntry(DB, { game: 'dbad', side: 'reward', ref_type: 'avatar', ref_id: 1 }, 'zhou'))
      .rejects.toMatchObject({ code: 'INVALID_REF' })
    // 收藏外观（appearance 道具）不能作为奖励侧金币发放——道具引用本身合法，但外观道具不可上架商城由步骤5校验
  })
})

// ============ T1.1/T1.2 稀有度与模板库 ============
describe('稀有度主轴与三类模板库', () => {
  it('稀有度四级参数已落地且等级/名称不可改、派生参数可调', async () => {
    const rarity = await listRarity(DB)
    expect(rarity.map(r => [r.level, r.name])).toEqual([[1, '普通'], [2, '精致'], [3, '华丽'], [4, '鎏金']])
    await updateRarity(DB, 1, { price_min: 6 }, 'zhou')
    const after = (await listRarity(DB)).find(r => r.level === 1)
    expect(after.price_min).toBe(6)
    expect(after.name).toBe('普通') // 名称不可变
  })

  it('模板创建/编辑/停用，审计随之落库', async () => {
    const tpl = await createTemplate(DB, 'penalty', { name: '羽毛挠', rarity: 1, spank_min: 1, spank_max: 1, spank_cap: 10 }, 'zhou')
    expect(tpl.rarity).toBe(1)
    const upd = await updateTemplate(DB, 'penalty', tpl.id, { spank_max: 3 }, 'zhou')
    expect(upd.spank_max).toBe(3)
    const dis = await disableTemplate(DB, 'penalty', tpl.id, 'zhou')
    expect(dis.is_active).toBe(0)
    const auditRows = await DB.prepare("SELECT scope, action FROM config_audit WHERE scope = 'penalty_template' ORDER BY id DESC LIMIT 3").all()
    expect(auditRows.results.map(r => r.action)).toEqual(['disable', 'update', 'create'])
  })

  it('引用保护：被掉落池引用的模板不可删除，只能停用', async () => {
    const tpl = await createTemplate(DB, 'reward', { name: '测试券', rarity: 1, kind: 'coupon', value: 5, stock: 1 }, 'zhou')
    await createDropEntry(DB, { game: 'gtest', side: 'reward', ref_type: 'reward', ref_id: tpl.id, weight: 1 }, 'zhou')
    await expect(deleteTemplate(DB, 'reward', tpl.id, 'zhou'))
      .rejects.toMatchObject({ code: 'TEMPLATE_REFERENCED' })
    // 停用仍允许
    await disableTemplate(DB, 'reward', tpl.id, 'zhou')
    // 移除引用后可删除
    const pools = await DB.prepare('SELECT id FROM drop_pools WHERE ref_id = ?').bind(tpl.id).all()
    for (const p of pools.results) await DB.prepare('DELETE FROM drop_pools WHERE id = ?').bind(p.id).run()
    const del = await deleteTemplate(DB, 'reward', tpl.id, 'zhou')
    expect(del.deleted).toBe(true)
  })

  it('减免类道具强制手动使用（不允许自动挂载）', async () => {
    await expect(createTemplate(DB, 'item', { name: '坏券', rarity: 1, category: 'clear', action: 'spank_reduce', action_value: 1, auto_mount: 1 }, 'zhou'))
      .rejects.toMatchObject({ code: 'INVALID_PARAM' })
  })

  it('全局参数可更新并落配置版本快照', async () => {
    const params = await updateParams(DB, { play_cost_coin: 20 }, 'zhou')
    const p = params.find(x => x.key === 'play_cost_coin')
    expect(p.value).toBe('20')
    const ver = await DB.prepare('SELECT version FROM config_versions ORDER BY id DESC LIMIT 1').first()
    expect(ver.version).toBeGreaterThanOrEqual(1)
  })
})

// ============ 路由层（鉴权与响应包） ============
describe('内核路由', () => {
  const makeReq = (path, opts = {}) => new Request(`https://x/api${path}`, opts)

  it('公示接口无需登录（G4）', async () => {
    const res = await handleKernelRequest(makeReq('/kernel/public/config?game=test'), DB, ['kernel', 'public', 'config'])
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.pools)).toBe(true)
  })

  it('玩家接口未授权返回 401 统一响应包', async () => {
    const res = await handleKernelRequest(makeReq('/kernel/me/spanks'), DB, ['kernel', 'me', 'spanks'])
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('UNAUTHORIZED')
  })

  it('非管理员访问运营接口返回 403', async () => {
    await newUser(DB, 'r_user')
    await DB.prepare("INSERT INTO tokens (token, username, expires_at) VALUES ('tok-player', 'r_user', 9999999999999)").run()
    const res = await handleKernelRequest(
      makeReq('/admin/kernel/rarity', { headers: { Authorization: 'Bearer tok-player' } }),
      DB, ['admin', 'kernel', 'rarity']
    )
    expect(res.status).toBe(403)
  })

  it('管理员可读稀有度配置', async () => {
    await newUser(DB, 'r_admin', 0)
    await DB.prepare("UPDATE users SET role = 'admin' WHERE username = 'r_admin'").run()
    await DB.prepare("INSERT INTO tokens (token, username, expires_at) VALUES ('tok-admin', 'r_admin', 9999999999999)").run()
    const res = await handleKernelRequest(
      makeReq('/admin/kernel/rarity', { headers: { Authorization: 'Bearer tok-admin' } }),
      DB, ['admin', 'kernel', 'rarity']
    )
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.rarity.length).toBe(4)
  })

  it('写接口缺少幂等键返回 IDEMPOTENCY_KEY_REQUIRED（G2）', async () => {
    await newUser(DB, 'r_idem')
    await DB.prepare("UPDATE users SET role = 'admin' WHERE username = 'r_idem'").run()
    await DB.prepare("INSERT INTO tokens (token, username, expires_at) VALUES ('tok-idem', 'r_idem', 9999999999999)").run()
    const res = await handleKernelRequest(
      makeReq('/admin/kernel/adjustments', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-idem', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'r_idem', target_type: 'coin', delta: 1, reason: 'x' }),
      }),
      DB, ['admin', 'kernel', 'adjustments']
    )
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })
})
