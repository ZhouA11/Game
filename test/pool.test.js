// 步骤4 · 单人彩池 单元测试
// 覆盖 05-步骤4-单人彩池.md §5「本步验收」+ T4.1~T4.8

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'

import { spinOp, getSlotState } from '../src/games/slot.js'
import { getOrCreatePool, getPoolView } from '../src/games/pool.js'

let DB

async function newUser(db, username, balance = 100000) {
  await db.prepare("INSERT INTO users (username, password, role, balance) VALUES (?, 'x', 'player', ?)").bind(username, balance).run()
}
const balanceOf = async (db, u) => (await db.prepare('SELECT balance FROM users WHERE username = ?').bind(u).first())?.balance ?? 0
const poolAmount = async (db, u) => (await db.prepare('SELECT amount FROM pool_state WHERE username = ?').bind(u).first())?.amount ?? 0
// 验收①：任意时刻 Σdelta = 当前池额
const ledgerSum = async (db, u) => {
  const r = await db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM pool_ledger WHERE username = ?').bind(u).first()
  return r.s
}
let keySeq = 0
const nextKey = () => `pool-key-${++keySeq}`

beforeAll(async () => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
})

describe('彩池持有与公示', () => {
  it('新玩家彩池初始化为种子值（5000），种子入账可对账（T4.1/T4.3）', async () => {
    await newUser(DB, 'p_new')
    const pool = await getOrCreatePool(DB, 'p_new')
    expect(pool.amount).toBe(5000)
    expect(await ledgerSum(DB, 'p_new')).toBe(5000)
  })

  it('按玩家维度持久化、互不共享（验收③）', async () => {
    await newUser(DB, 'p_a')
    await newUser(DB, 'p_b')
    await getOrCreatePool(DB, 'p_a')
    await getOrCreatePool(DB, 'p_b')
    // p_a 付费转动入池，p_b 池额不受影响
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    await DB.prepare("INSERT OR IGNORE INTO slot_state (username) VALUES (?)").bind('p_a').run()
    await DB.prepare("UPDATE slot_state SET free_date = ?, free_left = 0 WHERE username = ?").bind(today, 'p_a').run()
    await spinOp(DB, { username: 'p_a', idempotencyKey: nextKey() })
    expect(await poolAmount(DB, 'p_a')).toBeGreaterThan(5000)
    expect(await poolAmount(DB, 'p_b')).toBe(5000)
  })

  it('公示：/slot/state 返回池额、种子与比例（T4.7）', async () => {
    await newUser(DB, 'p_view')
    const st = await getSlotState(DB, 'p_view')
    expect(st.pool).toMatchObject({ amount: 5000, seed: 5000, rate: 5 })
  })
})

describe('入池与出奖', () => {
  it('付费 spin 按 5% 入池；免费转不入池（T4.2）', async () => {
    await newUser(DB, 'p_dep', 10000)
    // 首次 spin = 每日免费转（不入池）
    const r1 = await spinOp(DB, { username: 'p_dep', idempotencyKey: nextKey() })
    expect(r1.freeType).toBe('free_daily')
    expect(r1.pool).toBeNull()
    // 付费 spin 入池 10 × 5% = 0.5（共 1 次付费：第 6 次）
    for (let i = 0; i < 4; i++) await spinOp(DB, { username: 'p_dep', idempotencyKey: nextKey() })
    const r2 = await spinOp(DB, { username: 'p_dep', idempotencyKey: nextKey() })
    expect(r2.freeType).toBe('paid')
    expect(r2.pool.deposit).toBe(0.5)
    expect(await poolAmount(DB, 'p_dep')).toBeCloseTo(5000 + 0.5, 2)
  })

  it('入池幂等：同键重放不重复入池（T4.6）', async () => {
    await newUser(DB, 'p_idem', 10000)
    await setState_free()
    async function setState_free() {
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
      await DB.prepare("INSERT OR IGNORE INTO slot_state (username) VALUES (?)").bind('p_idem').run()
      await DB.prepare("UPDATE slot_state SET free_date = ?, free_left = 0 WHERE username = ?").bind(today, 'p_idem').run()
    }
    const key = nextKey()
    const r1 = await spinOp(DB, { username: 'p_idem', idempotencyKey: key })
    const r2 = await spinOp(DB, { username: 'p_idem', idempotencyKey: key })
    expect(r2.replayed).toBe(true)
    expect(await poolAmount(DB, 'p_idem')).toBeCloseTo(5000 + r1.pool.deposit, 2)
    const rows = await DB.prepare("SELECT COUNT(*) AS c FROM pool_ledger WHERE username = 'p_idem' AND reason = 'deposit'").first()
    expect(rows.c).toBe(1)
  })

  it('Jackpot 5连：池额全额出奖 + 重置种子 + 掉1片碎片（T4.4/T4.5/T4.8）', async () => {
    await newUser(DB, 'p_jack', 100000)
    // 制造池额累积（amount 与 ledger 同步调整，保持对账）
    await getOrCreatePool(DB, 'p_jack')
    await DB.prepare('UPDATE pool_state SET amount = 6321.5 WHERE username = ?').bind('p_jack').run()
    await DB.prepare('INSERT INTO pool_ledger (username, delta, balance_after, reason, ref, idempotency_key) VALUES (?, 1321.5, 6321.5, ?, ?, ?)')
      .bind('p_jack', 'test_adjust', 'adjust', `adjust:p_jack:${nextKey()}`).run()
    const seed = 5000
    const cfgRow = JSON.parse((await DB.prepare('SELECT config FROM slot_config WHERE id = 1').first()).config)
    try {
      // 全 jackpot 符号带 → 每 spin 必出 5 连
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(
        JSON.stringify({ ...cfgRow, weights: { jackpot: 100 }, feverWeights: { jackpot: 100 } })
      ).run()
      const before = await balanceOf(DB, 'p_jack')
      const r = await spinOp(DB, { username: 'p_jack', idempotencyKey: nextKey() })
      expect(r.jackpot.hit).toBe(true)
      expect(r.jackpot.payout).toBe(6321.5)       // 全额出奖（不重 roll）
      expect(await balanceOf(DB, 'p_jack')).toBeCloseTo(before + 6321.5, 2)
      // 重置为种子值
      expect(await poolAmount(DB, 'p_jack')).toBe(seed)
      // 掉落 1 片碎片（记录在 spin.fragments）
      expect(r.fragments.length).toBe(1)
      expect([3, 4]).toContain(r.fragments[0])
    } finally {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(JSON.stringify(cfgRow)).run()
    }
    // 对账
    expect(await ledgerSum(DB, 'p_jack')).toBeCloseTo(await poolAmount(DB, 'p_jack'), 2)
  })

  it('出奖幂等（验收②）：同 spin 重复提交不重复出奖、池额保持种子值（T4.6）', async () => {
    await newUser(DB, 'p_jack2', 100000)
    const cfgRow = JSON.parse((await DB.prepare('SELECT config FROM slot_config WHERE id = 1').first()).config)
    try {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(
        JSON.stringify({ ...cfgRow, weights: { jackpot: 100 }, feverWeights: { jackpot: 100 } })
      ).run()
      const key = nextKey()
      const r1 = await spinOp(DB, { username: 'p_jack2', idempotencyKey: key })
      expect(r1.jackpot.hit).toBe(true)
      const after1 = await balanceOf(DB, 'p_jack2')
      const pool1 = await poolAmount(DB, 'p_jack2')
      // 重复提交同一 spin
      const r2 = await spinOp(DB, { username: 'p_jack2', idempotencyKey: key })
      expect(r2.replayed).toBe(true)
      expect(await balanceOf(DB, 'p_jack2')).toBe(after1)          // 不重复出奖
      expect(await poolAmount(DB, 'p_jack2')).toBe(pool1)          // 池额保持种子值
      // 出奖账本唯一
      const payouts = await DB.prepare("SELECT COUNT(*) AS c FROM pool_ledger WHERE username = 'p_jack2' AND reason = 'payout'").first()
      expect(payouts.c).toBe(1)
      // 对账仍成立
      expect(await ledgerSum(DB, 'p_jack2')).toBeCloseTo(await poolAmount(DB, 'p_jack2'), 2)
    } finally {
      await DB.prepare('UPDATE slot_config SET config = ? WHERE id = 1').bind(JSON.stringify(cfgRow)).run()
    }
  })

  it('彩池账本对账：混合操作序列后 Σdelta = 池额（验收①）', async () => {
    await newUser(DB, 'p_mix', 100000)
    for (let i = 0; i < 8; i++) {
      const r = await spinOp(DB, { username: 'p_mix', idempotencyKey: nextKey() })
      console.log(`spin${i + 1}: ${r.freeType} deposit=${r.pool?.deposit ?? '-'}`)
    }
    const sum = await ledgerSum(DB, 'p_mix')
    const amt = await poolAmount(DB, 'p_mix')
    console.log('sum=', sum, 'amt=', amt)
    expect(sum).toBeCloseTo(amt, 2)
    const view = await getPoolView(DB, 'p_mix')
    expect(view.amount).toBeCloseTo(amt, 2)
  })
})
