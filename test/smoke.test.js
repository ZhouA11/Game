// 端到端冒烟测试：通过真实 Worker 入口（src/index.js fetch）验证旧路由不受影响、内核路由联通
import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createTestDB, applyMigrations } from './d1-adapter.js'
import worker from '../src/index.js'

let DB
const env = {}
const call = (path, init) => worker.fetch(new Request(`https://test.local${path}`, init), env, {})

async function json(res) {
  return { status: res.status, body: await res.json() }
}

beforeAll(() => {
  DB = createTestDB()
  DB.exec(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL,
    description TEXT, image TEXT, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`)
  applyMigrations(DB, fileURLToPath(new URL('../migrations', import.meta.url)))
  env.game_database = DB
})

describe('Worker 端到端', () => {
  it('旧接口 /api/test 正常', async () => {
    const { status, body } = await json(await call('/api/test'))
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
  })

  it('旧接口登录注册不受内核影响', async () => {
    const reg = await json(await call('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_user', password: 'pwd123' }),
    }))
    expect(reg.body.success).toBe(true)
    const login = await json(await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_user', password: 'pwd123' }),
    }))
    expect(login.body.success).toBe(true)
    // 带登录态查询个人资产（旧路由）
    const assets = await json(await call('/api/user/assets', {
      headers: { Authorization: `Bearer ${login.body.token}` },
    }))
    expect(assets.body.success).toBe(true)
  })

  it('内核公示接口（G4）', async () => {
    const { body } = await json(await call('/api/kernel/public/config?game=wheel'))
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.rarity)).toBe(true)
    expect(body.data.rarity.map(r => r.name)).toEqual(['普通', '精致', '华丽', '鎏金'])
  })

  it('内核玩家接口：Spank 面板 / 背包 / 碎片 / 流水', async () => {
    const login = await json(await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_user', password: 'pwd123' }),
    }))
    const token = login.body.token
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const spanks = await json(await call('/api/kernel/me/spanks', { headers: H }))
    expect(spanks.body.ok).toBe(true)
    expect(spanks.body.data.penalties.length).toBeGreaterThanOrEqual(5)

    const bag = await json(await call('/api/kernel/me/reward-bag', { headers: H }))
    expect(bag.body.ok).toBe(true)

    const frags = await json(await call('/api/kernel/me/fragments', { headers: H }))
    expect(frags.body.ok).toBe(true)
    expect(frags.body.data.fragments.length).toBeGreaterThanOrEqual(3)

    const ledger = await json(await call('/api/kernel/me/ledger', { headers: H }))
    expect(ledger.body.ok).toBe(true)
  })

  it('内核运营接口：管理员登录后读配置、创建模板（含审计）', async () => {
    const login = await json(await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'zhou', password: 'Asd123**' }),
    }))
    expect(login.body.success).toBe(true)
    const H = { Authorization: `Bearer ${login.body.token}`, 'Content-Type': 'application/json' }

    const rarity = await json(await call('/api/admin/kernel/rarity', { headers: H }))
    expect(rarity.body.ok).toBe(true)

    const created = await json(await call('/api/admin/kernel/templates/penalty', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '冒烟拍', rarity: 1, spank_min: 1, spank_max: 2, spank_cap: 50 }),
    }))
    expect(created.body.ok).toBe(true)
    expect(created.body.data.name).toBe('冒烟拍')

    // 幂等的人工调整：两次同键只生效一次
    const key = 'smoke-adj-1'
    const a1 = await json(await call('/api/admin/kernel/adjustments', {
      method: 'POST', headers: { ...H, 'Idempotency-Key': key },
      body: JSON.stringify({ username: 'smoke_user', target_type: 'coin', delta: 88, reason: '冒烟测试发放' }),
    }))
    expect(a1.body.ok).toBe(true)
    expect(a1.body.data.status).toBe('applied')
    const a2 = await json(await call('/api/admin/kernel/adjustments', {
      method: 'POST', headers: { ...H, 'Idempotency-Key': key },
      body: JSON.stringify({ username: 'smoke_user', target_type: 'coin', delta: 88, reason: '冒烟测试发放' }),
    }))
    expect(a2.body.data.replayed).toBe(true)

    const userLogin = await json(await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_user', password: 'pwd123' }),
    }))
    const ledger = await json(await call('/api/kernel/me/ledger', {
      headers: { Authorization: `Bearer ${userLogin.body.token}` },
    }))
    const coinEntries = ledger.body.data.list.filter(e => e.reason === 'admin_adjust')
    expect(coinEntries.length).toBe(1) // 幂等：只有一条
    expect(coinEntries[0].delta).toBe(88)
  })

  it('未知接口仍返回 404', async () => {
    const { status } = await json(await call('/api/not-exist'))
    expect(status).toBe(404)
  })
})
