// 步骤2 · 抓娃娃 单元测试
// 覆盖 03-步骤2-抓娃娃.md §5「本步验收」全部分支 + T2.1~T2.14 关键路径

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'
import { mulberry32 } from './rng.js'

import {
  generateLayoutGeometry, getMachineState, clawOp, rerollOp, revealOp,
  decorate, ensureGrabSchemaOnce,
} from '../src/games/grab.js'
import { handleGamesRequest } from '../src/games/router.js'

let DB

async function newUser(db, username, balance = 10000) {
  await db.prepare("INSERT INTO users (username, password, role, balance) VALUES (?, 'x', 'player', ?)").bind(username, balance).run()
}
async function giveItem(db, username, itemId, count = 1) {
  await db.prepare('INSERT INTO player_items (username, item_id, count) VALUES (?, ?, ?) ON CONFLICT(username, item_id) DO UPDATE SET count = count + ?')
    .bind(username, itemId, count, count).run()
}
// 清空机台后免费重铺，保证每个用例拿到独立布局（机内抓空 → 免费，不计数）
async function freshLayout(db, username) {
  await db.prepare("UPDATE grab_dolls SET status = 'taken' WHERE machine_id = 'grab-1' AND status = 'in_machine'").run()
  await db.prepare("UPDATE grab_machines SET dolls_left = 0 WHERE id = 'grab-1'").run()
  return rerollOp(DB, { username, mode: 'coin', idempotencyKey: nextKey() })
}
const balanceOf = async (db, u) => (await db.prepare('SELECT balance FROM users WHERE username = ?').bind(u).first())?.balance ?? 0
const activityOf = async (db, u) => (await db.prepare('SELECT activity FROM users WHERE username = ?').bind(u).first())?.activity ?? 0
const inMachineDolls = async (db) => (await db.prepare("SELECT * FROM grab_dolls WHERE machine_id = 'grab-1' AND status = 'in_machine' ORDER BY id").all()).results || []
async function setLuck(db, u, v) {
  await db.prepare("INSERT OR IGNORE INTO player_game_state (username, game) VALUES (?, 'grab')").bind(u).run()
  await db.prepare("UPDATE player_game_state SET luck = ? WHERE username = ? AND game = 'grab'").bind(v, u).run()
}
async function setPenaltyStreak(db, u, v) {
  await db.prepare("INSERT OR IGNORE INTO player_game_state (username, game) VALUES (?, 'grab')").bind(u).run()
  await db.prepare("UPDATE player_game_state SET penalty_streak = ? WHERE username = ? AND game = 'grab'").bind(v, u).run()
}
async function setRerollCount(db, u, date, cnt) {
  await db.prepare("INSERT OR IGNORE INTO player_game_state (username, game) VALUES (?, 'grab')").bind(u).run()
  await db.prepare("UPDATE player_game_state SET reroll_date = ?, reroll_count = ? WHERE username = ? AND game = 'grab'").bind(date, cnt, u).run()
}
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

let keySeq = 0
const nextKey = () => `test-key-${++keySeq}`

beforeAll(async () => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
  await ensureGrabSchemaOnce(DB)
})

// ============ T2.1/T2.2/T2.3 布局生成 ============
describe('随机堆叠布局', () => {
  it('任意布局、任意时刻可抓娃娃 ≥ 2 且无遮挡死锁（100次随机布局）', () => {
    for (let i = 0; i < 100; i++) {
      const dolls = generateLayoutGeometry(mulberry32(i * 7919 + 13))
      const remaining = dolls.map(d => ({ ...d, status: 'in_machine' }))
      decorate(remaining)
      // 逐个抓走可及娃娃：机内剩余 ≥4 时可抓 ≥2；任意时刻可抓 ≥1（无死锁）
      for (;;) {
        const inMachine = remaining.filter(d => d.status === 'in_machine')
        if (inMachine.length === 0) break
        const reach = inMachine.filter(d => d.reachable)
        expect(reach.length).toBeGreaterThanOrEqual(1) // 无死锁
        if (inMachine.length >= 4) {
          expect(reach.length).toBeGreaterThanOrEqual(2)
        }
        if (reach.length === 0) break
        reach[0].status = 'taken'
        decorate(remaining)
      }
    }
  })

  it('稀有度越高体积越小（平均半径单调递减）', () => {
    const sizeSum = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const count = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (let i = 0; i < 60; i++) {
      for (const d of generateLayoutGeometry(mulberry32(i * 104729 + 7))) {
        sizeSum[d.rarity] += d.size
        count[d.rarity]++
      }
    }
    const avg = r => sizeSum[r] / count[r]
    expect(avg(1)).toBeGreaterThan(avg(2))
    expect(avg(2)).toBeGreaterThan(avg(3))
    expect(avg(3)).toBeGreaterThan(avg(4))
  })

  it('稀有度越高位置越深（平均层级单调递增，L4 最深）', () => {
    const zSum = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const count = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (let i = 0; i < 60; i++) {
      for (const d of generateLayoutGeometry(mulberry32(i * 15485863 + 3))) {
        zSum[d.rarity] += d.z
        count[d.rarity]++
      }
    }
    const avg = r => zSum[r] / count[r]
    expect(avg(4)).toBeGreaterThan(avg(1))
    expect(avg(3)).toBeGreaterThanOrEqual(avg(2))
    expect(avg(2)).toBeGreaterThanOrEqual(avg(1))
  })
})

// ============ 铺场 / 预生成 / 重铺 ============
describe('铺场与内容预生成', () => {
  it('机内抓空免费重铺（不计入上限），内容铺场时预生成落库', async () => {
    await newUser(DB, 'g_layout')
    const r = await rerollOp(DB, { username: 'g_layout', mode: 'coin', idempotencyKey: nextKey() })
    expect(r.free).toBe(true)
    expect(r.cost).toBe(0)
    expect(r.dollsLeft).toBe(12)
    expect(await balanceOf(DB, 'g_layout')).toBe(10000) // 未扣费
    const dolls = await inMachineDolls(DB)
    expect(dolls.length).toBe(12)
    for (const d of dolls) {
      expect(['coin', 'item', 'reward', 'penalty', 'fragment']).toContain(d.ref_type)
      // 保底内容必为奖励侧（预生成）
      expect(d.pity_ref_type).not.toBe('penalty')
      expect(d.pity_ref_type).toBeTruthy()
    }
    // 重铺计数未增加（免费不计入上限）
    const st = await DB.prepare("SELECT reroll_count FROM player_game_state WHERE username = 'g_layout'").first()
    expect(st.reroll_count).toBe(0)
  })

  it('付费重铺：扣30币并计入每日上限；上限50拦截；换机券可替代', async () => {
    await newUser(DB, 'g_reroll')
    await freshLayout(DB, 'g_reroll')
    // 抓空机台（全部设为 taken）→ 再付费重铺
    await DB.prepare("UPDATE grab_dolls SET status = 'taken' WHERE machine_id = 'grab-1' AND status = 'in_machine'").run()
    // 先手动造一台有娃娃的机器
    await DB.prepare("UPDATE grab_machines SET dolls_left = 3 WHERE id = 'grab-1'").run()
    for (let i = 0; i < 3; i++) {
      await DB.prepare(
        "INSERT INTO grab_dolls (machine_id, rarity, size, x, y, z, ref_type, ref_id, amount, pity_ref_type, pity_ref_id, pity_amount) VALUES ('grab-1', 1, 12, 30, 30, 0, 'coin', NULL, 5, 'coin', NULL, 5)"
      ).run()
    }
    const r1 = await rerollOp(DB, { username: 'g_reroll', mode: 'coin', idempotencyKey: nextKey() })
    expect(r1.free).toBe(false)
    expect(r1.cost).toBe(30)
    expect(await balanceOf(DB, 'g_reroll')).toBe(10000 - 30)
    expect(r1.rerollCount).toBe(1)

    // 上限拦截
    await setRerollCount(DB, 'g_reroll', today(), 50)
    await expect(rerollOp(DB, { username: 'g_reroll', mode: 'coin', idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'REROLL_LIMIT_REACHED' })

    // 换机券重铺（同样受限）——清空机台后免费重铺不受限
    await setRerollCount(DB, 'g_reroll', today(), 50)
    await DB.prepare("UPDATE grab_dolls SET status = 'taken' WHERE machine_id = 'grab-1' AND status = 'in_machine'").run()
    const r2 = await rerollOp(DB, { username: 'g_reroll', mode: 'coupon', idempotencyKey: nextKey() })
    expect(r2.free).toBe(true) // 机内抓空 → 免费

    await newUser(DB, 'g_coupon')
    await freshLayout(DB, 'g_coupon')
    await DB.prepare("UPDATE grab_dolls SET status = 'taken' WHERE machine_id = 'grab-1' AND status = 'in_machine'").run()
    for (let i = 0; i < 2; i++) {
      await DB.prepare(
        "INSERT INTO grab_dolls (machine_id, rarity, size, x, y, z, ref_type, ref_id, amount, pity_ref_type, pity_ref_id, pity_amount) VALUES ('grab-1', 1, 12, 30, 30, 0, 'coin', NULL, 5, 'coin', NULL, 5)"
      ).run()
    }
    await giveItem(DB, 'g_coupon', 4, 2) // 换机券x2
    const r3 = await rerollOp(DB, { username: 'g_coupon', mode: 'coupon', idempotencyKey: nextKey() })
    expect(r3.cost).toBe(0)
    expect(await balanceOf(DB, 'g_coupon')).toBe(10000)
    const coupons = await DB.prepare("SELECT count FROM player_items WHERE username = 'g_coupon' AND item_id = 4").first()
    expect(coupons.count).toBe(1) // 消耗一张
  })
})

// ============ T2.12 下爪结算链 ============
describe('下爪结算链', () => {
  it('成功抓中：扣费→预生成内容发放→移走娃娃→可及重算→流水完整', async () => {
    await newUser(DB, 'g_claw', 1000)
    await freshLayout(DB, 'g_claw')
    const decorated = decorate((await inMachineDolls(DB)).map(d => ({ ...d, status: 'in_machine' })))
    const target = decorated.find(d => d.reachable && d.ref_type === 'coin')
    const targetId = target.id
    expect(targetId).toBeTruthy()

    // rng：roll1=0.01（L1 成功率0.9 → 成功）
    const before = await balanceOf(DB, 'g_claw')
    const r = await clawOp(DB, { username: 'g_claw', dollId: targetId, idempotencyKey: nextKey(), rng: mulberry32(1) })
    if (!r.success) throw new Error('期望成功，实际失败：' + JSON.stringify(r))
    expect(r.content.type).toBe('coin')
    expect(r.content.amount).toBe(target.amount)
    expect(await balanceOf(DB, 'g_claw')).toBe(before - 10 + target.amount)
    expect(await activityOf(DB, 'g_claw')).toBe(1) // G6 活跃值+1
    // 娃娃被移走
    const after = await inMachineDolls(DB)
    expect(after.find(d => d.id === targetId)).toBeUndefined()
    // 流水
    const grab = await DB.prepare("SELECT * FROM grab_grabs WHERE username = 'g_claw' AND success = 1").first()
    expect(grab).toMatchObject({ doll_id: targetId, fee: 10, ref_type: 'coin' })
    const ledger = await DB.prepare("SELECT reason FROM ledger_entries WHERE username = 'g_claw' AND reason = 'grab_fee'").first()
    expect(ledger).toBeTruthy()
  })

  it('抓取失败：娃娃保留原位、仅损失费用、连败+1', async () => {
    await newUser(DB, 'g_fail', 1000)
    await freshLayout(DB, 'g_fail')
    const dolls = await inMachineDolls(DB)
    const reachable = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).filter(d => d.reachable)
    const target = reachable.find(d => d.rarity === 1)
    const before = await balanceOf(DB, 'g_fail')
    // rng：roll1=0.95（>0.9 失败），roll2=0.99（>0.3 无手滑）
    let n = 0
    const rng = () => (n++ === 0 ? 0.95 : 0.99)
    const r = await clawOp(DB, { username: 'g_fail', dollId: target.id, idempotencyKey: nextKey(), rng })
    expect(r.success).toBe(false)
    expect(r.handSlip).toBe(false)
    expect(await balanceOf(DB, 'g_fail')).toBe(before - 10)
    expect((await inMachineDolls(DB)).find(d => d.id === target.id)).toBeTruthy() // 原位保留
    const st = await DB.prepare("SELECT fail_streak, luck FROM player_game_state WHERE username = 'g_fail'").first()
    expect(st.fail_streak).toBe(1)
    expect(st.luck).toBeGreaterThan(0) // 幸运值+1（含失败）
  })

  it('T2.6 手滑 bonus：失败时30%概率娃娃被带落、免费开娃', async () => {
    await newUser(DB, 'g_slip', 1000)
    await freshLayout(DB, 'g_slip')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).filter(d => d.reachable).find(d => d.rarity === 1)
    const before = await balanceOf(DB, 'g_slip')
    // rng：roll1=0.95（失败），roll2=0.01（<0.3 手滑）
    let n = 0
    const rng = () => (n++ === 0 ? 0.95 : 0.01)
    const r = await clawOp(DB, { username: 'g_slip', dollId: target.id, idempotencyKey: nextKey(), rng })
    expect(r.success).toBe(true)
    expect(r.handSlip).toBe(true)
    expect(r.content).toBeTruthy() // 免费开娃：内容已发放
    // 仅本次下爪费用；若开的是金币娃娃则加上内容
    expect(await balanceOf(DB, 'g_slip')).toBe(before - 10 + (r.content.type === 'coin' ? r.content.amount : 0))
    expect((await inMachineDolls(DB)).find(d => d.id === target.id)).toBeUndefined()
  })

  it('被遮挡的娃娃不可抓（服务端权威判定）', async () => {
    await newUser(DB, 'g_occ', 1000)
    await freshLayout(DB, 'g_occ')
    const decorated = decorate((await inMachineDolls(DB)).map(d => ({ ...d, status: 'in_machine' })))
    const pressed = decorated.find(d => !d.reachable)
    if (!pressed) throw new Error('本布局没有被遮挡的娃娃，用例需调整')
    await expect(clawOp(DB, { username: 'g_occ', dollId: pressed.id, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'DOLL_OCCLUDED' })
  })

  it('余额不足时拒绝下爪且娃娃不被抢占', async () => {
    await newUser(DB, 'g_poor', 5)
    await freshLayout(DB, 'g_poor')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).find(d => d.reachable)
    await expect(clawOp(DB, { username: 'g_poor', dollId: target.id, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    expect((await DB.prepare("SELECT status FROM grab_dolls WHERE id = ?").bind(target.id).first()).status).toBe('in_machine')
  })

  it('并发 10 请求无双抓：同一娃娃仅一个赢家、仅扣一次费', async () => {
    await newUser(DB, 'g_race', 10000)
    await freshLayout(DB, 'g_race')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).find(d => d.reachable && d.rarity === 1)
    const before = await balanceOf(DB, 'g_race')

    // 并发 10 个下爪（不同幂等键，模拟 10 个并发请求）
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        clawOp(DB, { username: 'g_race', dollId: target.id, idempotencyKey: `race-${Date.now()}-${i}`, rng: mulberry32(1000 + i) })
          .then(r => ({ ok: true, r }))
          .catch(e => ({ ok: false, code: e.code }))
      )
    )
    const wins = results.filter(x => x.ok && x.r.success)
    const losses = results.filter(x => !x.ok)
    expect(wins.length).toBeLessThanOrEqual(1) // 无双抓
    // 被抢占拒绝的请求不扣费：余额变动 = -10（赢家一次）+ 中奖内容
    const delta = (await balanceOf(DB, 'g_race')) - before
    if (wins.length === 1 && wins[0].r.content?.type === 'coin') {
      expect(delta).toBe(-10 + wins[0].r.content.amount)
    } else if (wins.length === 1) {
      expect(delta).toBe(-10)
    } else {
      // 全部输：要么有人成功抓走（wins=1），要么全部 DOLL_TAKEN/OCCLUDED
      expect(losses.length).toBe(10)
      expect(delta).toBe(0)
    }
    // 该娃娃只被结算一次
    const grabs = await DB.prepare('SELECT COUNT(*) AS c FROM grab_grabs WHERE doll_id = ? AND success = 1').bind(target.id).first()
    expect(grabs.c).toBeLessThanOrEqual(1)
  })

  it('幂等：同键重复下爪返回首次结果', async () => {
    await newUser(DB, 'g_idem', 1000)
    await freshLayout(DB, 'g_idem')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).find(d => d.reachable)
    const key = nextKey()
    const r1 = await clawOp(DB, { username: 'g_idem', dollId: target.id, idempotencyKey: key, rng: mulberry32(7) })
    const r2 = await clawOp(DB, { username: 'g_idem', dollId: target.id, idempotencyKey: key, rng: mulberry32(7) })
    expect(r2.replayed).toBe(true)
    expect(r2.balance).toBe(r1.balance)
  })
})

// ============ T2.10 保底与幸运值 ============
describe('保底与防挫败', () => {
  it('惩罚连败3次后下一次必出奖励（跨机位，用铺场预生成的保底内容）', async () => {
    await newUser(DB, 'g_pity', 10000)
    await setPenaltyStreak(DB, 'g_pity', 3)
    await freshLayout(DB, 'g_pity')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).find(d => d.reachable)
    if (!target) throw new Error('本布局没有可抓的娃娃，用例需调整')
    // 无论抓中什么娃娃，保底机制都强制发放铺场时预生成的奖励侧内容（不掷骰）
    const r = await clawOp(DB, { username: 'g_pity', dollId: target.id, idempotencyKey: nextKey(), rng: mulberry32(2) })
    if (r.success) {
      expect(r.pityUsed).toBe(true)
      expect(r.content.type).not.toBe('penalty')
      const st = await DB.prepare("SELECT penalty_streak FROM player_game_state WHERE username = 'g_pity'").first()
      expect(st.penalty_streak).toBe(0) // 出奖励清零
    }
  })

  it('铺场时所有娃娃的保底内容均非惩罚', async () => {
    await freshLayout(DB, 'g_pity2')
    const bad = await DB.prepare("SELECT COUNT(*) AS c FROM grab_dolls WHERE machine_id = 'grab-1' AND status = 'in_machine' AND (pity_ref_type = 'penalty' OR pity_ref_type IS NULL)").first()
    expect(bad.c).toBe(0)
  })

  it('幸运值满100：下次重铺在表层可及位置放入L3+娃娃并清零', async () => {
    await newUser(DB, 'g_luck', 10000)
    await freshLayout(DB, 'g_luck')
    await setLuck(DB, 'g_luck', 100)
    const r = await rerollOp(DB, { username: 'g_luck', mode: 'coin', idempotencyKey: nextKey() })
    expect(r.luckInserted).toBe(true)
    expect(r.dollsLeft).toBe(13)
    const lucky = await DB.prepare(
      "SELECT rarity, z FROM grab_dolls WHERE machine_id = 'grab-1' AND status = 'in_machine' AND rarity >= 3 AND z = 0"
    ).all()
    expect(lucky.results.length).toBeGreaterThanOrEqual(1)
    const st = await DB.prepare("SELECT luck FROM player_game_state WHERE username = 'g_luck'").first()
    expect(st.luck).toBe(0)
  })
})

// ============ T2.14 透视镜 ============
describe('透视镜（不泄露精确内容）', () => {
  it('未被遮挡：返回好/中/差模糊文案，不泄露内容字段', async () => {
    await newUser(DB, 'g_lens', 10000)
    await giveItem(DB, 'g_lens', 2, 3)
    await freshLayout(DB, 'g_lens')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).find(d => d.reachable)
    const r = await revealOp(DB, { username: 'g_lens', dollId: target.id, idempotencyKey: nextKey() })
    expect(['好', '中', '差']).toContain(r.tier)
    expect(r.occluded).toBe(false)
    const json = JSON.stringify(r)
    expect(json).not.toContain('ref_type')
    expect(json).not.toContain('spanks')
    expect(json).not.toContain('amount')
    // 内容不泄露：响应不含娃娃的真实内容引用
    expect(r.content).toBeUndefined()
    expect(r.ref_type).toBeUndefined()
    const lens = await DB.prepare("SELECT count FROM player_items WHERE username = 'g_lens' AND item_id = 2").first()
    expect(lens.count).toBe(2) // 消耗一张
  })

  it('被遮挡：提示更含糊（固定模糊文案，无档位）', async () => {
    await newUser(DB, 'g_lens2', 10000)
    await giveItem(DB, 'g_lens2', 2, 1)
    await freshLayout(DB, 'g_lens2')
    const decorated = decorate((await inMachineDolls(DB)).map(d => ({ ...d, status: 'in_machine' })))
    const pressed = decorated.find(d => !d.reachable)
    if (!pressed) throw new Error('本布局没有被遮挡的娃娃，用例需调整')
    const r = await revealOp(DB, { username: 'g_lens2', dollId: pressed.id, idempotencyKey: nextKey() })
    expect(r.occluded).toBe(true)
    expect(r.tier).toBeNull()
    expect(r.hint).toContain('缝隙')
  })

  it('没有透视镜时报错', async () => {
    await newUser(DB, 'g_nolens', 10000)
    await freshLayout(DB, 'g_nolens')
    const dolls = await inMachineDolls(DB)
    const target = decorate(dolls.map(d => ({ ...d, status: 'in_machine' }))).find(d => d.reachable)
    await expect(revealOp(DB, { username: 'g_nolens', dollId: target.id, idempotencyKey: nextKey() }))
      .rejects.toMatchObject({ code: 'ITEM_NOT_OWNED' })
  })
})

// ============ T2.9 收藏外观（G16） ============
describe('收藏外观产出约束', () => {
  it('各池均含外观条目，且限定外观只在高稀有度池', async () => {
    const pools = (await DB.prepare("SELECT option, ref_id FROM drop_pools WHERE game = 'grab' AND ref_type = 'item' AND ref_id IN (21,22,23,24,25)").all()).results
    const byOpt = Object.fromEntries(pools.map(p => [p.ref_id, p.option]))
    expect(byOpt[21]).toBe('L1')
    expect(byOpt[22]).toBe('L2')
    expect(byOpt[23]).toBe('L3')
    expect(byOpt[24]).toBe('L4')
    expect(byOpt[25]).toBe('L4')
    // 外观道具不可上架商城（G16：shop 只在步骤5实现，这里校验模板属性）
    for (const id of [21, 22, 23, 24, 25]) {
      const t = await DB.prepare('SELECT category FROM item_templates WHERE id = ?').bind(id).first()
      expect(t.category).toBe('appearance')
    }
  })
})

// ============ 路由冒烟 ============
describe('抓娃娃路由', () => {
  it('未登录访问返回 401', async () => {
    const res = await handleGamesRequest(
      new Request('https://x/api/grab/state'),
      DB, ['grab', 'state']
    )
    expect(res.status).toBe(401)
  })

  it('登录后可查机器状态与公示配置', async () => {
    await newUser(DB, 'g_route', 1000)
    await DB.prepare("INSERT INTO tokens (token, username, expires_at) VALUES ('tok-grab', 'g_route', 9999999999999)").run()
    const H = { Authorization: 'Bearer tok-grab' }
    const state = await handleGamesRequest(new Request('https://x/api/grab/state', { headers: H }), DB, ['grab', 'state'])
    const stateBody = await state.json()
    expect(stateBody.ok).toBe(true)
    expect(stateBody.data.machine.area).toBe(100)
    const cfg = await handleGamesRequest(new Request('https://x/api/grab/config'), DB, ['grab', 'config'])
    const cfgBody = await cfg.json()
    expect(cfgBody.ok).toBe(true)
    expect(cfgBody.data.baseRates[1]).toBeCloseTo(0.9)
    // 缺幂等键
    const noKey = await handleGamesRequest(new Request('https://x/api/grab/claw', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ doll_id: 1 }),
    }), DB, ['grab', 'claw'])
    expect((await noKey.json()).code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })
})

// ============ 验收：蒙特卡洛整机返还率（以种子配置，确定性种子） ============
describe('蒙特卡洛整机返还率', () => {
  it('以种子配置模拟 30000 次下爪，整机返还率落在 80%~90%', async () => {
    // 读取种子配置（与线上一致）
    const pools = (await DB.prepare("SELECT * FROM drop_pools WHERE game = 'grab' AND is_active = 1").all()).results
    const controls = {}
    for (const opt of ['L1', 'L2', 'L3', 'L4']) {
      const c = await DB.prepare('SELECT reward_side_prob, penalty_side_prob FROM drop_side_controls WHERE game = ? AND option = ?').bind('grab', opt).first()
      controls[opt] = c || { reward_side_prob: 0.5, penalty_side_prob: 0.5 }
    }
    const items = Object.fromEntries((await DB.prepare('SELECT id, price, rarity, category FROM item_templates').all()).results.map(r => [r.id, r]))
    const rewards = Object.fromEntries((await DB.prepare('SELECT id, value FROM reward_templates').all()).results.map(r => [r.id, r]))
    const recipes = Object.fromEntries((await DB.prepare('SELECT id, target_type, target_id, pieces_required FROM fragment_recipes').all()).results.map(r => [r.id, r]))
    const penalties = Object.fromEntries((await DB.prepare('SELECT id, spank_min, spank_max FROM penalty_templates').all()).results.map(r => [r.id, r]))
    const stock = {}
    for (const [, rw] of Object.entries(rewards)) stock[rw.id] = undefined
    const rewardStock = {}
    for (const id of Object.keys(rewards)) rewardStock[id] = (await DB.prepare('SELECT stock FROM reward_templates WHERE id = ?').bind(id).first()).stock

    // 价值折算：金币=面额；道具=price；奖励=value；碎片=目标折算价值/所需片数；惩罚=0（G11 不结算）
    const fragmentValue = rid => {
      const r = recipes[rid]
      if (!r) return 0
      const base = r.target_type === 'item' ? (items[r.target_id]?.price || 0) : (rewards[r.target_id]?.value || 0)
      return base / (r.pieces_required || 1)
    }
    const valueOf = e => {
      if (!e) return 0
      if (e.ref_type === 'coin') return e.amount || 0
      if (e.ref_type === 'item') return items[e.ref_id]?.price || 0
      if (e.ref_type === 'reward') return rewards[e.ref_id]?.value || 0
      if (e.ref_type === 'fragment') return fragmentValue(e.ref_id)
      return 0 // penalty
    }

    // 池内存模型（与 rollDrop 语义一致：总控概率落侧 + 权重抽取 + 0库存跳过）
    const drawFromPool = (option, rng, forPity = false) => {
      let list = pools.filter(p => p.option === option)
      if (forPity) list = list.filter(p => p.ref_type !== 'penalty')
      const usable = list.filter(p => !(p.ref_type === 'reward' && rewardStock[p.ref_id] === 0))
      if (usable.length === 0) return null
      const c = controls[option]
      const rw = Math.max(0, c.reward_side_prob), pw = Math.max(0, c.penalty_side_prob)
      let side
      if (rw <= 0 && pw <= 0) side = rng() < 0.5 ? 'reward' : 'penalty'
      else side = rng() < rw / (rw + pw) ? 'reward' : 'penalty'
      let sideList = usable.filter(p => p.side === side)
      if (sideList.length === 0) {
        side = side === 'reward' ? 'penalty' : 'reward'
        sideList = usable.filter(p => p.side === side)
      }
      if (sideList.length === 0) return null
      const total = sideList.reduce((s, p) => s + p.weight, 0)
      let r = rng() * total
      for (const p of sideList) {
        r -= p.weight
        if (r < 0) return p
      }
      return sideList[sideList.length - 1]
    }

    const BASE_RATES = { 1: 0.9, 2: 0.75, 3: 0.55, 4: 0.4 }
    const N = 30000
    const FEE = 10
    const rng = mulberry32(20260916)
    let totalIn = 0
    let totalOut = 0
    let penaltyStreak = 0
    let luck = 0
    let dolls = []
    const rarityGrabbed = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const valueByPool = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const countByPool = { 1: 0, 2: 0, 3: 0, 4: 0 }

    const newLayout = () => {
      const luckRarity = luck >= 100 ? (rng() < 0.75 ? 3 : 4) : null
      if (luckRarity) luck = 0
      const geo = generateLayoutGeometry(rng, { luckRarity })
      dolls = geo.map(g => {
        const option = 'L' + g.rarity
        const regular = drawFromPool(option, rng)
        const pity = drawFromPool(option, rng, true)
        if (regular?.ref_type === 'reward' && rewardStock[regular.ref_id] > 0) rewardStock[regular.ref_id]--
        return { ...g, status: 'in_machine', content: regular, pity }
      })
    }

    for (let i = 0; i < N; i++) {
      totalIn += FEE
      if (dolls.length === 0) newLayout()
      // 可及集合实时重算（直接在原对象上装饰）
      decorate(dolls)
      let reachable = dolls.filter(d => d.reachable)
      if (reachable.length === 0) { newLayout(); decorate(dolls); reachable = dolls.filter(d => d.reachable) }
      // 玩家策略：随机抓一个可及娃娃
      const target = reachable[Math.floor(rng() * reachable.length)]
      const rate = Math.min(0.95, BASE_RATES[target.rarity])
      const success = rng() < rate
      const handSlip = !success && rng() < 0.3
      luck = Math.min(100, luck + 1)
      if (success || handSlip) {
        const pityUsed = penaltyStreak >= 3
        const content = pityUsed && target.pity ? target.pity : target.content
        const v = valueOf(content)
        totalOut += v
        rarityGrabbed[target.rarity]++
        valueByPool[target.rarity] += v
        countByPool[target.rarity]++
        penaltyStreak = content && content.ref_type === 'penalty' ? penaltyStreak + 1 : 0
        // 移走娃娃并重算可及集合
        target.status = 'taken'
        dolls = dolls.filter(d => d !== target)
      }
      // 未抓走：娃娃保留
    }

    const rtp = totalOut / totalIn
    const grabbed = Object.entries(rarityGrabbed).map(([r, c]) => `L${r}:${c}次/均值${countByPool[r] ? (valueByPool[r] / countByPool[r]).toFixed(1) : '-'}币`).join('，')
    console.log(`蒙特卡洛（${N}次下爪）：投入 ${totalIn}，产出 ${Math.round(totalOut)}，整机返还率 ${(rtp * 100).toFixed(2)}%`)
    console.log(`  抓中分布：${grabbed}`)
    expect(rtp).toBeGreaterThanOrEqual(0.80)
    expect(rtp).toBeLessThanOrEqual(0.90)
  })
})
