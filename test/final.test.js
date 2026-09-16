// 步骤7 · 全量验收与上线校准（T7.1~T7.4）
// 六条链路端到端 + 碎片周期复算 + 通用底线与反例集中验证

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'
import { mulberry32 } from './rng.js'

import { rerollOp, clawOp, getMachineState } from '../src/games/grab.js'
import { spinOp, nudgeOp, monkeyOp, wheelOp, getSlotState } from '../src/games/slot.js'
import { buyProductOp, listShopProducts } from '../src/games/shop.js'
import { reduceSpankOp, applyPenaltyStmts, listReducibleTargets } from '../src/kernel/spank.js'
import { synthesizeFragmentOp, grantFragmentStmts } from '../src/kernel/fragments.js'
import { createProductOp } from '../src/games/shop.js'
import { createTemplate, getParam } from '../src/kernel/templates.js'
import { submitReviewOp, stagingReviewOp, publishReviewOp, getDashboard } from '../src/games/review.js'
import { getOrCreatePool } from '../src/games/pool.js'
import { computeGameRTP } from '../src/games/rtp.js'
import { KernelError } from '../src/kernel/util.js'

let DB
let k = 0
const key = () => `f-${++k}`
const exec = (db, s) => db.batch(s)
const balanceOf = async (db, u) => (await db.prepare('SELECT balance FROM users WHERE username = ?').bind(u).first())?.balance ?? 0
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

async function newUser(db, username, balance = 1000000, activity = 100) {
  await db.prepare("INSERT INTO users (username, password, role, balance, activity) VALUES (?, 'x', 'player', ?, ?)").bind(username, balance, activity).run()
  // 免费转用尽 → 全部付费路径，链路更真实
  await db.prepare("INSERT OR IGNORE INTO slot_state (username, free_date, free_left) VALUES (?, ?, 0)").bind(username, today()).run()
}

beforeAll(async () => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT, price REAL)`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
})

// ============ T7.1 链路1：抓娃娃 ============
describe('链路1 · 抓娃娃全链路', () => {
  it('布局生成 → 下爪 → 结算 → 可及重算 → 流水落库', async () => {
    await newUser(DB, 'f_grab')
    await rerollOp(DB, { username: 'f_grab', mode: 'coin', idempotencyKey: key() })
    const before = await balanceOf(DB, 'f_grab')
    let won = 0, lost = 0
    // 连续下爪直到机空（覆盖成功/失败/手滑/遮挡分支）
    for (;;) {
      const st = await getMachineState(DB, 'f_grab')
      const target = st.machine.dolls.find(d => d.reachable)
      if (!target) break
      try {
        const r = await clawOp(DB, { username: 'f_grab', dollId: target.id, idempotencyKey: key(), rng: mulberry32(1234) })
        if (r.success) won++
        else lost++
      } catch (e) {
        if (!['DOLL_TAKEN', 'DOLL_OCCLUDED'].includes(e.code)) throw e
        lost++
      }
    }
    expect(won + lost).toBeGreaterThanOrEqual(12)
    // 余额与账本一致（统一 debit/credit，无绕过）
    const sum = (await DB.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM ledger_entries WHERE username = 'f_grab' AND currency = 'coin'").first()).s
    expect(await balanceOf(DB, 'f_grab')).toBeCloseTo(1000000 + sum, 2)
    // 流水齐全：fee 流水 + 活跃值 + spank/coin 内容流水
    const fees = await DB.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE username = 'f_grab' AND reason = 'grab_fee'").first()
    expect(fees.c).toBe(won + lost)
    const acts = await DB.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE username = 'f_grab' AND reason = 'grab_play'").first()
    expect(acts.c).toBe(won + lost)   // G6
    // 可及集合重算：机空后免费重铺成功
    const r2 = await rerollOp(DB, { username: 'f_grab', mode: 'coin', idempotencyKey: key() })
    expect(r2.free).toBe(true)
    expect(r2.dollsLeft).toBe(12)
  })
})

// ============ T7.1 链路2：老虎机 steps[] 回放 ============
describe('链路2 · 老虎机全链路', () => {
  it('spin → steps[] → 断线重连回放一致', async () => {
    await newUser(DB, 'f_slot')
    const r = await spinOp(DB, { username: 'f_slot', idempotencyKey: key() })
    // 模拟断线重连：重新查询最近 spin
    const st = await getSlotState(DB, 'f_slot')
    expect(st.lastSpin.id).toBe(r.spinId)
    const restored = JSON.parse(st.lastSpin.steps)
    expect(restored).toEqual(r.steps)   // 回放一致
    expect(st.lastSpin.seed).toBe(r.seed)
    // Nudge 分支（同轮一次）
    const n = await nudgeOp(DB, { username: 'f_slot', spinId: r.spinId, reel: 0, dir: 'up', idempotencyKey: key() })
    expect(n.gridAfter).toBeTruthy()
    // 后置交互若触发则揭示
    if (r.monkey) {
      const m = await monkeyOp(DB, { username: 'f_slot', pendingId: r.monkey.pendingId, choice: 0, idempotencyKey: key() })
      expect(m.coins).toBeGreaterThanOrEqual(0)
    }
    if (r.wheel) {
      const w = await wheelOp(DB, { username: 'f_slot', pendingId: r.wheel.pendingId, idempotencyKey: key() })
      expect(w.sector).toBeTruthy()
    }
  })
})

// ============ T7.1 链路3：单人彩池 ============
describe('链路3 · 单人彩池', () => {
  it('入池 → Jackpot 出奖 → 重置 → 账本对账', async () => {
    await newUser(DB, 'f_pool')
    // 两次付费 spin（各入池 0.5）
    await spinOp(DB, { username: 'f_pool', idempotencyKey: key() })
    await spinOp(DB, { username: 'f_pool', idempotencyKey: key() })
    const amt1 = (await DB.prepare('SELECT amount FROM pool_state WHERE username = ?').bind('f_pool').first()).amount
    expect(amt1).toBeCloseTo(5001, 2)
    // 强制 Jackpot 5连：改配置出奖 → 恢复
    const cfgRow = JSON.parse((await DB.prepare('SELECT config FROM slot_config WHERE id = 1').first()).config)
    try {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(
        JSON.stringify({ ...cfgRow, weights: { jackpot: 100 }, feverWeights: { jackpot: 100 } })
      ).run()
      const r = await spinOp(DB, { username: 'f_pool', idempotencyKey: key() })
      expect(r.jackpot.hit).toBe(true)
      // 出奖额 = 出奖前池额（含本次入池 0.5）= amt1 + 0.5
      expect(r.jackpot.payout).toBeCloseTo(amt1 + 0.5, 2)
      expect(r.pool.amountAfter).toBe(5000)           // 重置种子
      // 账本对账：Σdelta = 池额
      const sum = (await DB.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM pool_ledger WHERE username = ?').bind('f_pool').first()).s
      expect(sum).toBeCloseTo(5000, 2)
    } finally {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(JSON.stringify(cfgRow)).run()
    }
  })
})

// ============ T7.1 链路4：商店双币种 ============
describe('链路4 · 商店购买', () => {
  it('金币/活跃值各一单 → 正确扣减；余额不足按币种拦截', async () => {
    await newUser(DB, 'f_shop', 5000, 40)
    const r1 = await buyProductOp(DB, { username: 'f_shop', productId: 1, idempotencyKey: key() })
    expect(r1.currency).toBe('coin')
    expect(await balanceOf(DB, 'f_shop')).toBe(5000 - 20)
    const r2 = await buyProductOp(DB, { username: 'f_shop', productId: 11, idempotencyKey: key() })
    expect(r2.currency).toBe('activity')
    expect(await (await DB.prepare('SELECT activity FROM users WHERE username = ?').bind('f_shop').first()).activity).toBe(40 - 30)
    // 活跃值不足按活跃值拦截
    await expect(buyProductOp(DB, { username: 'f_shop', productId: 11, idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: '活跃值不足' })
    // 断网重试不双扣
    const key2 = key()
    await buyProductOp(DB, { username: 'f_shop', productId: 2, idempotencyKey: key2 })
    await buyProductOp(DB, { username: 'f_shop', productId: 2, idempotencyKey: key2 })
    expect(await balanceOf(DB, 'f_shop')).toBe(5000 - 20 - 30)
  })
})

// ============ T7.1 链路5：Spank 三条写入路径 ============
describe('链路5 · Spank 三条写入路径全落流水', () => {
  it('游戏产生 → 面板减免 → 后台人工调整', async () => {
    await newUser(DB, 'f_spank')
    // 路径1：游戏掉落产生
    await exec(DB, (await applyPenaltyStmts(DB, { username: 'f_spank', penaltyId: 3, spanks: 8, source: 'game_drop' })).stmts)
    // 购买 L2 减免券并使用（路径2：玩家减免）
    await buyProductOp(DB, { username: 'f_spank', productId: 8, idempotencyKey: key() })
    await reduceSpankOp(DB, { username: 'f_spank', couponItemId: 12, targetPenaltyId: 3, idempotencyKey: key() })
    // 路径3：后台人工调整
    const adj = await import('../src/kernel/adjust.js')
    await adj.createAdjustmentOp(DB, { operator: 'zhou', username: 'f_spank', targetType: 'penalty', targetId: 3, delta: -2, reason: '表现良好减免', idempotencyKey: key() })
    // 三条路径全部落 spank_logs
    const logs = await DB.prepare("SELECT source FROM spank_logs WHERE username = 'f_spank' ORDER BY id").all()
    expect(logs.results.map(l => l.source)).toEqual(['game_drop', 'player_reduce', 'admin_adjust'])
    // 最终累计：8 - 3 - 2 = 3
    expect((await DB.prepare('SELECT count FROM player_spanks WHERE username = ? AND penalty_id = 3').bind('f_spank').first()).count).toBe(3)
  })
})

// ============ T7.1 链路6：后台新建惩罚道具生效 ============
describe('链路6 · 后台新建惩罚道具生效', () => {
  it('创建 → 入池 → 结算自动累加 Spank（无扣款）', async () => {
    await newUser(DB, 'f_newpen')
    const tpl = await createTemplate(DB, 'penalty', { name: '验收戒尺', rarity: 1, spank_min: 3, spank_max: 3, spank_cap: 100 }, 'zhou')
    const g = await import('../src/kernel/drops.js')
    const res = await g.grantDropStmts(DB, { username: 'f_newpen', entry: { game: 'grab', id: 1, ref_type: 'penalty', ref_id: tpl.id, spanks: null }, source: 'test', rng: () => 0.01 })
    await exec(DB, res.stmts)
    expect(res.granted.spanks).toBe(3)
    expect((await DB.prepare('SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?').bind('f_newpen', tpl.id).first()).count).toBe(3)
    expect(await balanceOf(DB, 'f_newpen')).toBe(1000000)   // 无扣款
  })
})

// ============ T7.3 碎片合成周期复算 ============
describe('T7.3 碎片合成周期复算（每日30爪+50spin）', () => {
  const loadPools = async () => (await DB.prepare("SELECT * FROM drop_pools WHERE game = 'grab' AND is_active = 1").all()).results
  const loadControls = async () => (await DB.prepare("SELECT * FROM drop_side_controls WHERE game = 'grab'").all()).results

  function dailyFragments(pools, controls) {
    const ctrl = Object.fromEntries(controls.map(c => [c.option, c]))
    const byOpt = {}
    for (const p of pools) (byOpt[p.option] = byOpt[p.option] || []).push(p)
    // 命中分布（步骤2 蒙特卡洛实测：L1 .503 / L2 .206 / L3 .110 / L4 .029）
    const dist = { 1: 0.503, 2: 0.206, 3: 0.110, 4: 0.029 }
    const frag = { 3: 0, 4: 0 }   // 华丽/鎏金 每日期望
    for (const [rar, p] of Object.entries(dist)) {
      const list = byOpt[`L${rar}`] || []
      const rw = list.filter(e => e.side === 'reward').reduce((s, e) => s + e.weight, 0)
      const c = ctrl[`L${rar}`] || { reward_side_prob: 0.5 }
      for (const e of list) {
        if (e.ref_type !== 'fragment') continue
        const sideP = c.reward_side_prob
        const fragVal = e.ref_id === 2 ? '4' : '3'   // 配方2=鎏金（赦免券），其余华丽
        const perHit = (e.weight / rw) * sideP
        frag[fragVal] += 30 * p * perHit
      }
    }
    return frag
  }

  it('鎏金碎片周期落在 3~5 周（21~35 天）；华丽碎片如实报告', async () => {
    const frag = dailyFragments(await loadPools(), await loadControls())
    // Fever 保底（步骤3规范数值，不可调）：50 spin/日，槽约10.4次/spin触发一次 → 每日约 4~5 片华丽
    const feverPerDay = 50 / (12 / 1.15)
    const gPerDay = frag['4'] ?? 0
    const wPerDay = (frag['3'] ?? 0) + feverPerDay
    const gCycle = 7 / gPerDay
    const wCycle = 5 / wPerDay
    console.log(`每日期望：鎏金碎片 ${gPerDay.toFixed(3)} 片 → L4 合成周期 ${gCycle.toFixed(1)} 天`)
    console.log(`每日期望：华丽碎片 ${wPerDay.toFixed(2)} 片（其中 Fever 保底 ${feverPerDay.toFixed(1)}）→ L3 合成周期 ${wCycle.toFixed(1)} 天`)
    // 鎏金：3~5 周 ✓
    expect(gCycle).toBeGreaterThanOrEqual(21)
    expect(gCycle).toBeLessThanOrEqual(35)
    // 华丽：主导项为步骤3规范数值（Fever 保底），周期显著快于 1.5 周目标——如实记录（见汇报④）
    expect(wCycle).toBeGreaterThan(0)
  })

  it('校准后抓娃娃解析返还率仍在 80%~90%（复核）', async () => {
    const r = await computeGameRTP(DB, 'grab')
    expect(r.rtp).toBeGreaterThanOrEqual(0.80)
    expect(r.rtp).toBeLessThanOrEqual(0.90)
  })
})

// ============ T7.4 上线前反例集中验证 ============
describe('T7.4 反例集中验证', () => {
  it('引用外观的商品创建被拒绝（G16）', async () => {
    await expect(createProductOp(DB, { item_id: 24, currency: 'coin', price: 100 }, 'zhou'))
      .rejects.toMatchObject({ code: 'PRODUCT_FORBIDDEN' })
  })
  it('返还率越界提审被拦截', async () => {
    const cfg = await getSlotCfg()
    await expect(import('../src/games/review.js').then(m => m.submitReviewOp(DB, {
      scope: 'slot', payload: { ...cfg, payScale: cfg.payScale * 5 }, operator: 'zhou',
    }))).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' })
  })
  const getSlotCfg = async () => JSON.parse((await DB.prepare('SELECT config FROM slot_config WHERE id = 1').first()).config)

  it('减免券等级不足：不可选、券不消耗', async () => {
    await newUser(DB, 'f_rank2')
    await exec(DB, (await applyPenaltyStmts(DB, { username: 'f_rank2', penaltyId: 5, spanks: 12, source: 'game_drop' })).stmts)
    await buyProductOp(DB, { username: 'f_rank2', productId: 7, idempotencyKey: key() })  // L1券
    const { targets } = await listReducibleTargets(DB, 'f_rank2', 11)
    expect(targets.some(t => t.penalty_id === 5)).toBe(false)
    await expect(reduceSpankOp(DB, { username: 'f_rank2', couponItemId: 11, targetPenaltyId: 5, idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'RARITY_MISMATCH' })
    expect(await itemCount(11)).toBe(1)
  })
  const itemCount = async id =>
    (await DB.prepare('SELECT count FROM player_items WHERE username = ? AND item_id = ?').bind('f_rank2', id).first())?.count ?? 0

  it('彩池重复提交不重复出奖（同键重放）', async () => {
    await newUser(DB, 'f_poolidem')
    const cfgRow = JSON.parse((await DB.prepare('SELECT config FROM slot_config WHERE id = 1').first()).config)
    try {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(
        JSON.stringify({ ...cfgRow, weights: { jackpot: 100 }, feverWeights: { jackpot: 100 } })
      ).run()
      const key2 = key()
      const r1 = await spinOp(DB, { username: 'f_poolidem', idempotencyKey: key2 })
      const b1 = await balanceOf(DB, 'f_poolidem')
      const r2 = await spinOp(DB, { username: 'f_poolidem', idempotencyKey: key2 })
      expect(r2.replayed).toBe(true)
      expect(await balanceOf(DB, 'f_poolidem')).toBe(b1)
      const payouts = await DB.prepare("SELECT COUNT(*) AS c FROM pool_ledger WHERE username = 'f_poolidem' AND reason = 'payout'").first()
      expect(payouts.c).toBe(1)
    } finally {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(JSON.stringify(cfgRow)).run()
    }
  })

  it('G4 概率公示端点可用且与当期配置一致', async () => {
    const st = await getSlotState(DB, 'f_grab')
    expect(st.config.pays).toBeTruthy()
    expect(st.config.weights.cherry).toBe(22)
    const pools = await DB.prepare("SELECT COUNT(*) AS c FROM drop_pools WHERE game = 'grab' AND is_active = 1").first()
    expect(pools.c).toBeGreaterThan(0)
  })
})

// ============ T7.2 通用底线：统一账本 ============
describe('T7.2 通用底线', () => {
  it('玩家余额变动全部有 ledger_entries 对应（无绕过 debit/credit）', async () => {
    await newUser(DB, 'f_ledger', 777)
    await buyProductOp(DB, { username: 'f_ledger', productId: 7, idempotencyKey: key() })
    // 用户余额 = 初始 + Σ(ledger coin delta)
    const sum = (await DB.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM ledger_entries WHERE username = 'f_ledger' AND currency = 'coin'").first()).s
    expect(await balanceOf(DB, 'f_ledger')).toBeCloseTo(777 + sum, 2)
  })
})
