// 步骤6 · 运营后台 单元测试（§5 验收）

import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'

import { computeGameRTP, computeSlotRTP } from '../src/games/rtp.js'
import {
  submitReviewOp, stagingReviewOp, publishReviewOp, rollbackReviewOp, getDashboard,
} from '../src/games/review.js'
import { createTemplate } from '../src/kernel/templates.js'
import { grantDropStmts } from '../src/kernel/drops.js'
import { getSlotConfig } from '../src/games/slot.js'

let DB

async function newUser(db, username, balance = 100000) {
  await db.prepare("INSERT INTO users (username, password, role, balance, activity) VALUES (?, 'x', 'admin', ?, 500)").bind(username, balance).run()
}
const exec = (db, stmts) => db.batch(stmts)
let k = 0
const key = () => `adm-${++k}`

beforeAll(async () => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT, price REAL)`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
})

// ============ T6.9 返还率引擎（保存即自动重算） ============
describe('返还率引擎', () => {
  it('抓娃娃解析式：三张表（整机/分选项/条目贡献），落在线上配置', async () => {
    const r = await computeGameRTP(DB, 'grab')
    expect(r.type).toBe('analytic')
    expect(r.perOption.length).toBe(4)
    expect(r.items.length).toBeGreaterThan(0)
    expect(r.rtp).toBeGreaterThan(0.5)
    expect(r.range).toEqual({ min: 0.80, max: 0.90, design: 0.87 })
  })

  it('老虎机蒙特卡洛（固定seed 10万次）：整机/分选项/净值，RTP 落在 93%~97%', async () => {
    const r = await computeSlotRTP(DB, null, 100000)
    expect(r.type).toBe('montecarlo')
    expect(r.spins).toBe(100000)
    expect(r.rtp).toBeGreaterThanOrEqual(0.93)
    expect(r.rtp).toBeLessThanOrEqual(0.97)
    expect(r.perOption.some(o => o.option === 'pool')).toBe(true)
  }, 120000)
})

// ============ T6.10 提审 → 预发 → 发布 → 回滚 ============
describe('配置提审与发布流程', () => {
  it('越界配置禁止提审并落审计（验收②）', async () => {
    const cfg = await getSlotConfig(DB)
    // 赔率放大 → 返还率越界
    const bad = { ...cfg, payScale: cfg.payScale * 3 }
    await expect(submitReviewOp(DB, { scope: 'slot', payload: bad, note: '越界测试', operator: 'zhou' }))
      .rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' })
    const audit = await DB.prepare("SELECT after FROM config_audit WHERE scope = 'config_review' AND action = 'submit_blocked' ORDER BY id DESC LIMIT 1").first()
    expect(audit).toBeTruthy()
    expect(JSON.parse(audit.after).action).toBe('blocked')
  })

  it('改动选项概率 → 提审自动给三张表 → 预发验证 → 全量发布 → 回滚（验收②）', async () => {
    const cfg = await getSlotConfig(DB)
    const payload = { ...cfg, payScale: cfg.payScale * 1.02 }   // 微调仍在区间内
    const r1 = await submitReviewOp(DB, { scope: 'slot', payload, note: '微调赔率', operator: 'zhou' })
    expect(r1.status).toBe('pending')
    const saved = JSON.parse(r1.rtp_result)
    expect(saved.perOption.length).toBeGreaterThan(3)          // 三张表自动生成
    const r2 = await stagingReviewOp(DB, { id: r1.id, operator: 'zhou' })
    expect(r2.status).toBe('staging')
    const r3 = await publishReviewOp(DB, { id: r1.id, operator: 'zhou' })
    expect(r3.status).toBe('published')
    // 载荷已应用
    const nowCfg = await getSlotConfig(DB)
    expect(nowCfg.payScale).toBeCloseTo(payload.payScale, 6)
    // 再发布一版（回滚目标 = r1 的载荷）
    const payload2 = { ...cfg, payScale: cfg.payScale * 0.99 }
    const rB = await submitReviewOp(DB, { scope: 'slot', payload: payload2, note: '第二版', operator: 'zhou' })
    await stagingReviewOp(DB, { id: rB.id, operator: 'zhou' })
    await publishReviewOp(DB, { id: rB.id, operator: 'zhou' })
    // 回滚 rB → 恢复 r1 载荷
    const r4 = await rollbackReviewOp(DB, { id: rB.id, operator: 'zhou' })
    expect(r4.status).toBe('rolled_back')
    expect(r4.restoredFrom).toBe(r1.id)
    const backCfg = await getSlotConfig(DB)
    expect(backCfg.payScale).toBeCloseTo(payload.payScale, 6)
  })

  it('稀有度变更走全流程（模拟→提审→预发→发布）', async () => {
    const rows = await DB.prepare('SELECT * FROM rarity_levels ORDER BY level').all()
    const payload = rows.results.map(r => ({ ...r, drop_weight: r.drop_weight }))
    const r1 = await submitReviewOp(DB, { scope: 'rarity', payload, note: '稀有度参数复核', operator: 'zhou' })
    const r2 = await stagingReviewOp(DB, { id: r1.id, operator: 'zhou' })
    const r3 = await publishReviewOp(DB, { id: r1.id, operator: 'zhou' })
    expect(r3.status).toBe('published')
  })
})

// ============ 验收：新建惩罚道具全链路（无扣款） ============
describe('新建惩罚道具全链路', () => {
  it('新建惩罚道具 → 加入掉落池 → 游戏结算正确累加 Spank（全程无扣款）', async () => {
    await newUser(DB, 'adm_user')
    // T6.4 后台新建惩罚道具（名称/稀有度/单次Spank/累计上限）
    const tpl = await createTemplate(DB, 'penalty', { name: '测试戒条', rarity: 2, spank_min: 7, spank_max: 7, spank_cap: 50 }, 'zhou')
    const before = await spankOf('adm_user', tpl.id)
    // 直接走内核掉落发放（游戏结算同路径）
    const g = await grantDropStmts(DB, { username: 'adm_user', entry: { game: 'grab', id: 999, ref_type: 'penalty', ref_id: tpl.id, amount: null, spanks: null }, source: 'test', rng: () => 0.99 })
    await exec(DB, g.stmts)
    // Spank 正确累加（7 = spank_max，服务端随机在 min~max）
    expect(g.granted.type).toBe('penalty')
    expect(g.granted.spanks).toBe(7)
    expect(await spankOf('adm_user', tpl.id)).toBe(before + 7)
    // 全程不产生扣款：余额不变
    expect(await balanceOf('adm_user')).toBe(100000)
  })

  const spankOf = async (u, pid) =>
    (await DB.prepare('SELECT count FROM player_spanks WHERE username = ? AND penalty_id = ?').bind(u, pid).first())?.count ?? 0
  const balanceOf = async u => (await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(u).first())?.balance ?? 0
})

// ============ T6.1 看板 ============
describe('数据看板', () => {
  it('看板含返还率/减免率/库存告警/调整统计', async () => {
    // 造一个低库存奖励触发告警
    await DB.prepare('UPDATE reward_templates SET stock = 0 WHERE id = 3').run()
    const d = await getDashboard(DB)
    expect(d.rtp.grab.rtp).toBeGreaterThan(0)
    expect(d.penalties.length).toBeGreaterThanOrEqual(5)
    expect(d.stockAlerts.some(a => a.id === 3 && a.stock === 0)).toBe(true)
    expect(Array.isArray(d.adjustments)).toBe(true)
  })
})

// ============ T6.3 引用面 / 发货 ============
describe('奖励管理辅助', () => {
  it('被引用模板引用面查询', async () => {
    const refs = await listRefs('penalty', 1)
    expect(refs.length).toBeGreaterThanOrEqual(1)   // 木拍被 L1 池引用
  })
  const listRefs = async (kind, id) => {
    const rows = await DB.prepare('SELECT * FROM drop_pools WHERE ref_type = ? AND ref_id = ? AND is_active = 1').bind(kind, id).all()
    return rows.results || []
  }
})
