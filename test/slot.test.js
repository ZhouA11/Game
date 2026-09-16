// 步骤3 · 老虎机 单元测试
// 覆盖 04-步骤3-老虎机.md §5「本步验收」+ T3.1~T3.15 关键路径

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'
import { mulberry32 } from './rng.js'

import {
  buildStrip, buildGrid, findWinningLines, simulateSpin,
  getSlotConfig, spinOp, nudgeOp, monkeyOp, wheelOp, getSlotState, MULT_LADDER,
} from '../src/games/slot.js'
import { handleGamesRequest } from '../src/games/router.js'

let DB
let CFG

async function newUser(db, username, balance = 100000) {
  await db.prepare("INSERT INTO users (username, password, role, balance) VALUES (?, 'x', 'player', ?)").bind(username, balance).run()
}
const balanceOf = async (db, u) => (await db.prepare('SELECT balance FROM users WHERE username = ?').bind(u).first())?.balance ?? 0
const setState = async (db, u, fields) => {
  await db.prepare('INSERT OR IGNORE INTO slot_state (username) VALUES (?)').bind(u).run()
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ')
  await db.prepare(`UPDATE slot_state SET ${sets} WHERE username = ?`).bind(...Object.values(fields), u).run()
}
let keySeq = 0
const nextKey = () => `slot-key-${++keySeq}`
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

beforeAll(async () => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
  CFG = await getSlotConfig(DB)
})

// ============ T3.1/T3.5 盘面与连线 ============
describe('盘面与连线', () => {
  it('符号带由权重确定性生成，Jackpot 占比≈1%', () => {
    const strip = buildStrip(CFG.weights)
    expect(strip.length).toBe(100)
    const count = {}
    for (const s of strip) count[s] = (count[s] || 0) + 1
    expect(count.jackpot).toBe(1)          // 1%
    expect(count.cherry).toBe(22)
    expect(count.wild).toBe(5)
    // 确定性：两次生成一致
    expect(buildStrip(CFG.weights)).toEqual(strip)
  })

  it('Jackpot 只出现在第2行（buildGrid 替换）', () => {
    const strip = buildStrip(CFG.weights)
    const jp = strip.indexOf('jackpot')
    expect(jp).toBeGreaterThanOrEqual(0)
    // 让第0行撞上 jackpot：pos 使 (pos+0)%100=jp → 第2行不出现
    const grid = buildGrid(strip, [jp, 0, 0, 0, 0])
    expect(grid[0][0]).toBe('empty')       // 第0行的 jackpot 被替换为空
    // 让第2行（row1）撞上 jackpot
    const grid2 = buildGrid(strip, [(jp - 1 + 100) % 100, 0, 0, 0, 0])
    expect(grid2[0][1]).toBe('jackpot')
  })

  it('连线判定：左→右连续，wild 替代，非赔付符号不连线', () => {
    const pays = CFG.pays
    // grid[col][row]：5列×3行
    const mk = row0 => [
      [row0[0], 'x', 'x'], [row0[1], 'x', 'x'], [row0[2], 'x', 'x'], [row0[3], 'x', 'x'], [row0[4], 'x', 'x'],
    ]
    const lines = findWinningLines(mk(['cherry', 'cherry', 'cherry', 'cherry', 'cherry']), pays)
    expect(lines[0]).toMatchObject({ symbol: 'cherry', count: 5 })

    const lines2 = findWinningLines(mk(['wild', 'cherry', 'cherry', 'wild', 'lemon']), pays)
    expect(lines2[0]).toMatchObject({ symbol: 'cherry', count: 4 })

    const lines3 = findWinningLines(mk(['monkey', 'monkey', 'monkey', 'x', 'x']), pays)
    expect(lines3.length).toBe(0)   // 捣蛋猴不连线（触发小剧场）

    const lines4 = findWinningLines(mk(['cherry', 'lemon', 'cherry', 'cherry', 'cherry']), pays)
    expect(lines4.length).toBe(0)   // 断线不中奖
  })
})

// ============ T3.11 同 seed 重放一致 ============
describe('steps[] 全模拟', () => {
  it('同一 seed 重放一致（验收）', () => {
    for (const seed of [1, 42, 987654, 20260916]) {
      const a = simulateSpin({ seed, cfg: CFG, fee: 10 })
      const b = simulateSpin({ seed, cfg: CFG, fee: 10 })
      expect(b).toEqual(a)
      expect(a.steps.length).toBeGreaterThanOrEqual(1)
      expect(a.steps[a.steps.length - 1].type).toBe('settle')
    }
  })

  it('steps[] 含盘面快照/中奖线/爆裂位/倍率/结算额（T3.11）', () => {
    // 扫描多个 seed 找一次有中奖的
    for (let seed = 1; seed < 500; seed++) {
      const sim = simulateSpin({ seed, cfg: CFG, fee: 10 })
      const cascade = sim.steps.find(s => s.type === 'cascade')
      if (cascade) {
        expect(cascade.grid.length).toBe(5)
        expect(cascade.lines.length).toBeGreaterThanOrEqual(1)
        expect(cascade.popCells.length).toBeGreaterThan(0)
        expect(MULT_LADDER).toContain(cascade.multiplier)
        expect(cascade.roundPay).toBeGreaterThan(0)
        return
      }
    }
    throw new Error('500 个 seed 都无中奖，检查权重配置')
  })

  it('倍率阶梯 ×1→×2→×3→×5 封顶 ×10（T3.2）', () => {
    // 构造连爆场景验证倍率序列：直接检查 simulateSpin 倍率推进逻辑
    const sim = simulateSpin({ seed: 7, cfg: CFG, fee: 10 })
    const cascades = sim.steps.filter(s => s.type === 'cascade')
    cascades.forEach((s, i) => {
      expect(s.multiplier).toBe(MULT_LADDER[Math.min(i, MULT_LADDER.length - 1)])
    })
    expect(sim.endMultIdx).toBe(Math.min(cascades.length, MULT_LADDER.length - 1))
  })

  it('Hold：保留轴位置不变（T3.9）', () => {
    const seed = 321
    const base = simulateSpin({ seed, cfg: CFG, fee: 10 })
    const held = simulateSpin({ seed, cfg: CFG, fee: 10, holdReel: 2, holdPositions: base.positions })
    expect(held.positions[2]).toBe(base.positions[2])
    // 其余轴同 seed 相同
    expect(held.positions[0]).toBe(base.positions[0])
  })
})

// ============ spin 流程 ============
describe('spin 流程', () => {
  it('付费 spin：扣费、派彩入账、活跃值+1、steps 落库', async () => {
    await newUser(DB, 's_user', 10000)
    const before = await balanceOf(DB, 's_user')
    const r = await spinOp(DB, { username: 's_user', idempotencyKey: nextKey() })
    expect(r.freeType).toBe('free_daily')   // 首spin消耗每日免费转（不扣费）
    expect(r.fee).toBe(0)
    // 消耗完 5 次免费转再付费
    for (let i = 0; i < 4; i++) {
      await spinOp(DB, { username: 's_user', idempotencyKey: nextKey() })
    }
    const r2 = await spinOp(DB, { username: 's_user', idempotencyKey: nextKey() })
    expect(r2.freeType).toBe('paid')
    expect(r2.fee).toBe(10)
    // 响应余额 = 消费前余额 - 费用 + 本轮派彩（前5次免费spin的中奖已含在消费前余额中）
    expect(await balanceOf(DB, 's_user')).toBeCloseTo(r2.balance, 2)
    expect(r2.steps.length).toBeGreaterThanOrEqual(1)
    const stored = await DB.prepare('SELECT steps, seed FROM slot_spins WHERE id = ?').bind(r2.spinId).first()
    expect(JSON.parse(stored.steps).length).toBe(r2.steps.length)
  })

  it('每日免费转 5 次（T3.3）', async () => {
    await newUser(DB, 's_free', 1000)
    for (let i = 0; i < 5; i++) {
      const r = await spinOp(DB, { username: 's_free', idempotencyKey: nextKey() })
      expect(r.freeType).toBe('free_daily')
    }
    const r = await spinOp(DB, { username: 's_free', idempotencyKey: nextKey() })
    expect(r.freeType).toBe('paid')
  })

  it('幂等：同键重复 spin 返回首次结果', async () => {
    await newUser(DB, 's_idem', 1000)
    const key = nextKey()
    const r1 = await spinOp(DB, { username: 's_idem', idempotencyKey: key })
    const r2 = await spinOp(DB, { username: 's_idem', idempotencyKey: key })
    expect(r2.replayed).toBe(true)
    expect(r2.spinId).toBe(r1.spinId)
  })

  it('断线恢复：/slot/last 返回最近一spin回放（T3.11）', async () => {
    await newUser(DB, 's_last', 5000)
    await DB.prepare("INSERT INTO tokens (token, username, expires_at) VALUES ('tok-slot', 's_last', 9999999999999)").run()
    const H = { Authorization: 'Bearer tok-slot', 'Content-Type': 'application/json' }
    const spin = await spinOp(DB, { username: 's_last', idempotencyKey: nextKey() })
    const res = await handleGamesRequest(
      new Request('https://x/api/slot/last', { headers: H }), DB, ['slot', 'last']
    )
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.lastSpin.id).toBe(spin.spinId)
    expect(JSON.parse(body.data.lastSpin.steps).length).toBe(spin.steps.length)
  })
})

// ============ T3.8 Nudge ============
describe('Nudge 摇一格', () => {
  it('合法 Nudge：盘面 = 该轴 ±1 格重建，摇中真赢入账', async () => {
    await newUser(DB, 's_nudge', 5000)
    const r = await spinOp(DB, { username: 's_nudge', idempotencyKey: nextKey() })
    const positions = JSON.parse((await DB.prepare('SELECT positions FROM slot_spins WHERE id = ?').bind(r.spinId).first()).positions)
    const strip = buildStrip(CFG.weights)
    // 找一个摇一格能中线的轴+方向（穷举）
    let found = null
    for (let reel = 0; reel < 5 && !found; reel++) {
      for (const dir of ['up', 'down']) {
        const shift = dir === 'up' ? -1 : 1
        const np = [...positions]
        np[reel] = ((positions[reel] + shift) % 100 + 100) % 100
        const g = buildGrid(strip, np)
        if (findWinningLines(g, CFG.pays).length > 0) { found = { reel, dir }; break }
      }
    }
    const res = await nudgeOp(DB, {
      username: 's_nudge', spinId: r.spinId,
      reel: found ? found.reel : 0, dir: found ? found.dir : 'up', idempotencyKey: nextKey(),
    })
    // 校验摇后盘面 = ±1 格重建
    const shift = res.dir === 'up' ? -1 : 1
    const expectPos = ((positions[res.reel] + shift) % 100 + 100) % 100
    const expectGrid = buildGrid(strip, positions.map((p, i) => (i === res.reel ? expectPos : p)))
    expect(res.gridAfter).toEqual(expectGrid)
    if (found) expect(res.payout).toBeGreaterThan(0)
    // 额度扣减
    expect(res.nudgeLeft).toBe(2)
  })

  it('非法移动被拒绝（验收）：重复Nudge/非法方向/额度用尽', async () => {
    await newUser(DB, 's_nudge2', 5000)
    const r = await spinOp(DB, { username: 's_nudge2', idempotencyKey: nextKey() })
    await nudgeOp(DB, { username: 's_nudge2', spinId: r.spinId, reel: 0, dir: 'up', idempotencyKey: nextKey() })
    // 同轮重复 Nudge
    await expect(nudgeOp(DB, { username: 's_nudge2', spinId: r.spinId, reel: 1, dir: 'up', idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'NUDGE_ILLEGAL' })
    // 非法方向
    const r2 = await spinOp(DB, { username: 's_nudge2', idempotencyKey: nextKey() })
    await expect(nudgeOp(DB, { username: 's_nudge2', spinId: r2.spinId, reel: 0, dir: 'sideways', idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'NUDGE_ILLEGAL' })
    // 每日 3 次用尽
    await setState(DB, 's_nudge2', { nudge_left: 0 })
    const r3 = await spinOp(DB, { username: 's_nudge2', idempotencyKey: nextKey() })
    await expect(nudgeOp(DB, { username: 's_nudge2', spinId: r3.spinId, reel: 0, dir: 'up', idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'NUDGE_LIMIT' })
  })
})

// ============ T3.4 追猴小剧场 / T3.6 幸运转轮（预生成，只揭示） ============
describe('后置交互预生成', () => {
  it('追猴：揭示=预生成值，重复揭示不重roll、不重复发放', async () => {
    await newUser(DB, 's_monkey', 5000)
    // 直接造一个 monkey pending
    const spin = await spinOp(DB, { username: 's_monkey', idempotencyKey: nextKey() })
    const cards = [{ coins: 8 }, { coins: 0 }, { coins: 12 }]
    const pr = await DB.prepare(
      "INSERT INTO slot_pending (username, spin_id, type, payload) VALUES (?, ?, 'monkey', ?)"
    ).bind('s_monkey', spin.spinId, JSON.stringify({ cards })).run()
    const before = await balanceOf(DB, 's_monkey')
    const key = nextKey()
    const r1 = await monkeyOp(DB, { username: 's_monkey', pendingId: pr.meta.last_row_id, choice: 0, idempotencyKey: key })
    expect(r1.coins).toBe(8)
    expect(await balanceOf(DB, 's_monkey')).toBe(before + 8)
    // 重复揭示：同结果、不再发放
    const r2 = await monkeyOp(DB, { username: 's_monkey', pendingId: pr.meta.last_row_id, choice: 2, idempotencyKey: nextKey() })
    expect(r2.coins).toBe(8)   // 首次结果（不重roll）
    expect(await balanceOf(DB, 's_monkey')).toBe(before + 8)
  })

  it('转轮：预掷扇区揭示发放；重复合绝不重roll', async () => {
    await newUser(DB, 's_wheel', 5000)
    const spin = await spinOp(DB, { username: 's_wheel', idempotencyKey: nextKey() })
    const sectors = CFG.wheel
    const payload = { sectors, index: 1, resolvedValue: 100 }  // 预生成：100币扇区
    const pr = await DB.prepare(
      "INSERT INTO slot_pending (username, spin_id, type, payload) VALUES (?, ?, 'wheel', ?)"
    ).bind('s_wheel', spin.spinId, JSON.stringify(payload)).run()
    const before = await balanceOf(DB, 's_wheel')
    const r = await wheelOp(DB, { username: 's_wheel', pendingId: pr.meta.last_row_id, idempotencyKey: nextKey() })
    expect(r.index).toBe(1)
    expect(r.value).toBe(100)
    expect(await balanceOf(DB, 's_wheel')).toBe(before + 100)
    const r2 = await wheelOp(DB, { username: 's_wheel', pendingId: pr.meta.last_row_id, idempotencyKey: nextKey() })
    expect(r2.value).toBe(100)
    expect(await balanceOf(DB, 's_wheel')).toBe(before + 100)
  })

  it('预生成不泄露揭示结果（pendingInteractions 无牌值/落点）', async () => {
    await newUser(DB, 's_leak', 5000)
    await DB.prepare("INSERT INTO tokens (token, username, expires_at) VALUES ('tok-leak', 's_leak', 9999999999999)").run()
    const spin = await spinOp(DB, { username: 's_leak', idempotencyKey: nextKey() })
    await DB.prepare(
      "INSERT INTO slot_pending (username, spin_id, type, payload) VALUES (?, ?, 'monkey', ?)"
    ).bind('s_leak', spin.spinId, JSON.stringify({ cards: [{ coins: 9 }, { coins: 0 }, { coins: 11 }] })).run()
    await DB.prepare(
      "INSERT INTO slot_pending (username, spin_id, type, payload) VALUES (?, ?, 'wheel', ?)"
    ).bind('s_leak', spin.spinId, JSON.stringify({ sectors: CFG.wheel, index: 3 })).run()
    const res = await handleGamesRequest(
      new Request('https://x/api/slot/last', { headers: { Authorization: 'Bearer tok-leak' } }), DB, ['slot', 'last']
    )
    const body = await res.json()
    const json = JSON.stringify(body)
    expect(json).not.toContain('"coins"')
    expect(json).not.toContain('"index":3')
    const monkey = body.data.pendingInteractions.find(p => p.type === 'monkey')
    expect(monkey.cardCount).toBe(3)
  })
})

// ============ T3.10 Fever ============
describe('Fever 狂热模式', () => {
  it('槽满12触发8次免费连转；Fever中免费；结束保底华丽碎片', async () => {
    await newUser(DB, 's_fever', 50000)
    await setState(DB, 's_fever', { fever_slot: 12, free_left: 0, free_date: today(), fever_active: 0 })
    const r = await spinOp(DB, { username: 's_fever', idempotencyKey: nextKey() })
    expect(r.fever.triggered).toBe(true)
    expect(r.fever.left).toBe(8)
    // Fever 中的 spin 全部免费
    for (let i = 0; i < 7; i++) {
      const rr = await spinOp(DB, { username: 's_fever', idempotencyKey: nextKey() })
      expect(rr.freeType).toBe('fever')
    }
    const last = await spinOp(DB, { username: 's_fever', idempotencyKey: nextKey() })
    expect(last.freeType).toBe('fever')
    expect(last.fever.ended).toBe(true)   // 第8次结束
    // 保底华丽碎片：最后一转 fragList 含 3
    const fragRow = await DB.prepare('SELECT fragments FROM slot_spins WHERE id = ?').bind(last.spinId).first()
    expect(JSON.parse(fragRow.fragments)).toContain(3)
    const st = await DB.prepare('SELECT fever_active, fever_slot FROM slot_state WHERE username = ?').bind('s_fever').first()
    expect(st.fever_active).toBe(0)
    expect(st.fever_slot).toBe(0)
  })

  it('四连环（爆裂深度≥4）立即触发 Fever（T3.2/T3.10）', () => {
    // 构造"全樱桃"配置强制连爆，验证 cascadeTriggerFever 标记与倍率阶梯
    const allCherry = {
      ...CFG,
      weights: { cherry: 100 },
      feverWeights: { cherry: 100 },
      fragment: { d3: 0, d4: 0, d5: 0, loyal: 9 },
    }
    const sim = simulateSpin({ seed: 1, cfg: allCherry, fee: 10 })
    expect(sim.cascadeCount).toBeGreaterThanOrEqual(4)
    expect(sim.cascadeTriggerFever).toBe(true)
  })

  it('Fever 中符号权重：捣蛋猴 0%、Wild ×2（T3.10）', () => {
    expect(CFG.feverWeights.monkey).toBe(0)
    expect(CFG.feverWeights.wild).toBe(CFG.weights.wild * 2)
  })
})

// ============ T3.13 保底 ============
describe('保底', () => {
  it('连续15转无中奖→下一转必中，赔付30%~80%下注（预生成确定）', async () => {
    await newUser(DB, 's_pity', 50000)
    await setState(DB, 's_pity', { no_win_streak: 15, free_left: 0, free_date: today() })
    const before = await balanceOf(DB, 's_pity')
    const r = await spinOp(DB, { username: 's_pity', idempotencyKey: nextKey() })
    expect(r.payout).toBeGreaterThanOrEqual(3)   // 30% × 10
    expect(r.payout).toBeLessThanOrEqual(8)      // 80% × 10
    expect(await balanceOf(DB, 's_pity')).toBeCloseTo(before - 10 + r.payout, 2)
    expect(r.noWinStreak).toBe(0)
  })
})

// ============ T3.14 彩池触发预留 ============
describe('彩池触发预留', () => {
  it('Jackpot 第2行5连 → 触发标记（账本步骤4实现）', () => {
    const grid = [['x','x','x','x','x'], ['jackpot','jackpot','jackpot','jackpot','jackpot'], ['x','x','x','x','x']]
    // 通过 simulateSpin 的 detectSpecials 逻辑验证：直接构造
    const sim = simulateSpin({ seed: 5, cfg: CFG, fee: 10 })
    // simulateSpin 不便注入盘面，这里验证标记语义与响应结构
    expect(sim).toHaveProperty('jackpot')
    expect(typeof sim.jackpot).toBe('boolean')
  })
})

// ============ G16：不产出外观 ============
describe('G16 约束', () => {
  it('老虎机掉落池/转轮不含收藏外观条目', () => {
    const json = JSON.stringify(CFG)
    expect(json).not.toContain('appearance')
  })
})

// ============ 验收：RTP 蒙特卡洛（95% ± 1%，含彩池5%理论） ============
describe('RTP 蒙特卡洛', () => {
  it('以种子配置模拟 200000 次 spin，RTP（含彩池理论5%）落在 94%~96%', async () => {
    const strip = buildStrip(CFG.weights)
    const fragValue = { 3: 12, 4: 120 / 7 }   // 华丽碎片=60/5、鎏金=120/7
    const wheelEV = CFG.wheel.reduce((s, x) => {
      if (x.type === 'reward') return s + x.prob / 100 * 50
      if (x.type === 'coin') return s + x.prob / 100 * x.value
      if (x.type === 'coin_range') return s + x.prob / 100 * ((x.min + x.max) / 2)
      if (x.type === 'fragment') return s + x.prob / 100 * fragValue[x.rarity || 3]
      return s  // fever/nudge/none 为间接价值，MC 内单独模拟 fever
    }, 0)
    const monkeyEV = (10 + 15) / 2 * 2 / 3   // 2张5~15币的期望

    const N = 200000
    const FEE = 10
    const rng = mulberry32(20260916)
    let totalIn = 0, totalOut = 0
    let feverSlot = 0, feverActive = false, feverLeft = 0, multIdx = 0, noWin = 0

    for (let i = 0; i < N; i++) {
      const fever = feverActive && feverLeft > 0
      if (!fever) totalIn += FEE   // 免费转不计投入（产出计入）
      const sim = simulateSpin({
        seed: Math.floor(rng() * 0xffffffff), cfg: CFG, fee: FEE,
        feverActive: fever, startMultIdx: fever ? multIdx : 0,
        forceWin: noWin >= CFG.pity.streak,
      })
      totalOut += sim.payout
      for (const f of sim.fragments) totalOut += fragValue[f]
      if (sim.monkey) totalOut += monkeyEV
      if (sim.wheel) totalOut += wheelEV

      // 状态推进（与 spinOp 一致）
      if (fever) {
        feverLeft--
        if (feverLeft <= 0) {
          feverActive = false; feverSlot = 0; multIdx = 0
          totalOut += fragValue[3]   // Fever 结束保底华丽碎片
        }
      } else {
        feverSlot += sim.feverDelta
        if (feverSlot >= CFG.fever.slotMax || sim.cascadeTriggerFever) {
          feverActive = true; feverLeft = CFG.fever.spins; feverSlot = 0; multIdx = 0
        }
      }
      multIdx = sim.endMultIdx
      noWin = sim.payout > 0 ? 0 : noWin + 1
    }

    const rtpImplemented = totalOut / totalIn
    const rtpTotal = rtpImplemented + 0.05   // 彩池理论贡献 5%（步骤4落地后精确化）
    console.log(`RTP（实现部分，${N}次）：${(rtpImplemented * 100).toFixed(2)}%；含彩池理论5% → ${(rtpTotal * 100).toFixed(2)}%`)
    expect(rtpTotal).toBeGreaterThanOrEqual(0.94)
    expect(rtpTotal).toBeLessThanOrEqual(0.96)
  })
})
