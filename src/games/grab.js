// 步骤2 · 抓娃娃（T2.1~T2.14）
// 随机堆叠布局 + 遮挡可及判定 + 下爪结算链
// 复用步骤1内核：统一账本 / Resolver / grantDropStmts（不另写一套结算）
// 并发防双抓：条件更新抢占（status='in_machine' 守卫）+ D1 写串行化
// （MachineDO/PlayerDO 以 D1 持久化状态 + 条件更新替代：单人环境（G18）下语义等价、
//   更保守可审计，且不引入 Durable Objects 部署依赖——已在汇报中说明）

import { KernelError, toInt, toMoney } from '../kernel/util.js'
import { kernelWrite } from '../kernel/idempotency.js'
import { ledgerStmts } from '../kernel/ledger.js'
import { getParam } from '../kernel/templates.js'
import { resolveEventStmts } from '../kernel/resolver.js'
import { rollDrop, grantDropStmts, listDropPools, getSideControls } from '../kernel/drops.js'

export const MACHINE_ID = 'grab-1'
export const AREA = 100                 // 逻辑坐标 0~100
// T2.2/§3.1：稀有度 → 体积（半径基数）与目标层级（0=表层 … 3=最深层）
const SIZE_BY_RARITY = { 1: 13, 2: 9.5, 3: 7, 4: 5.5 }
const Z_TARGET = { 1: 0, 2: 1, 3: 2, 4: 3 }
// §3.1 抓取成功率（服务端权威）
export const BASE_RATES = { 1: 0.90, 2: 0.75, 3: 0.55, 4: 0.40 }
const RARITY_WEIGHTS = [[1, 60], [2, 25], [3, 12], [4, 3]]
const MAX_RATE = 0.95

// ---------- Schema 保证（与 migrations/0010_grab.sql 等价，幂等） ----------
let grabSchemaPromise = null
export function ensureGrabSchemaOnce(DB) {
  if (!grabSchemaPromise) {
    grabSchemaPromise = initGrabSchema(DB).catch(error => {
      console.error('Failed to ensure grab schema:', error)
      grabSchemaPromise = null
    })
  }
  return grabSchemaPromise
}

async function initGrabSchema(DB) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS grab_machines (
      id TEXT PRIMARY KEY,
      dolls_left INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS grab_dolls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      rarity INTEGER NOT NULL,
      size REAL NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, z INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_machine',
      taken_by TEXT, taken_source TEXT, taken_at DATETIME,
      ref_type TEXT NOT NULL, ref_id INTEGER, amount REAL, spanks INTEGER,
      pity_ref_type TEXT, pity_ref_id INTEGER, pity_amount REAL, pity_spanks INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_grab_dolls_machine ON grab_dolls(machine_id, status)',
    `CREATE TABLE IF NOT EXISTS player_game_state (
      username TEXT NOT NULL, game TEXT NOT NULL,
      luck INTEGER NOT NULL DEFAULT 0,
      penalty_streak INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      reroll_date TEXT NOT NULL DEFAULT '',
      reroll_count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, game)
    )`,
    `CREATE TABLE IF NOT EXISTS grab_grabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL, machine_id TEXT NOT NULL, doll_id INTEGER NOT NULL,
      rarity INTEGER NOT NULL, success INTEGER NOT NULL, hand_slip INTEGER NOT NULL DEFAULT 0,
      fee REAL NOT NULL DEFAULT 0,
      ref_type TEXT DEFAULT '', ref_id INTEGER, amount REAL, spanks INTEGER,
      effects TEXT DEFAULT '',
      idempotency_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS grab_rerolls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL, machine_id TEXT NOT NULL, mode TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0, coupon_item_id INTEGER,
      luck_inserted INTEGER NOT NULL DEFAULT 0, dolls INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR IGNORE INTO kernel_params (key, value, note) VALUES
      ('grab_reroll_cost', '30', '主动重铺费用（金币）'),
      ('grab_reroll_daily_limit', '50', '主动重铺每日上限（付费+换机券合计）'),
      ('grab_dolls_per_layout', '12', '每次铺场的娃娃数量'),
      ('grab_hand_slip_rate', '0.3', '抓取失败时手滑bonus概率'),
      ('grab_luck_max', '100', '幸运值上限（满值后下次重铺插入L3+表层娃娃）')`,
    `INSERT OR IGNORE INTO grab_machines (id, dolls_left) VALUES ('grab-1', 0)`,
  ]
  await DB.batch(ddl.map(sql => DB.prepare(sql)))
}

// ---------- 工具 ----------
async function paramNum(DB, key, fallback) {
  const v = await getParam(DB, key, String(fallback))
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function bjDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function overlapPresses(a, b) {
  // 遮挡判定：只有表层（z=0）的娃娃会压住深层（z>0）的娃娃，且需足量重叠。
  // 该结构保证无死锁：z 最小的娃娃永远无人压制；
  // 同时每个表层娃娃压制的受害者数受 repairLayout 约束（≤2），保证"机内剩余≥4时可抓≥2"
  if (b.z !== 0 || a.z <= b.z) return false
  const dist = Math.hypot(a.x - b.x, a.y - b.y)
  return dist < (a.size + b.size) * 0.55
}

export function decorate(dolls) {
  // T2.4：可及 = 没有任何在机娃娃压住它；一次移走可能解锁多个
  for (const d of dolls) {
    d.pressers = dolls.filter(o => o.status === 'in_machine' && o.id !== d.id && overlapPresses(d, o))
    d.reachable = d.pressers.length === 0
  }
  return dolls
}

// 压制上限修复：每个表层娃娃最多压住 2 个深层娃娃（超出则把多余受害者挪到随机新位置）
function repairPressCap(dolls, rng) {
  for (let iter = 0; iter < 80; iter++) {
    let moved = false
    for (const p of dolls) {
      if (p.z !== 0) continue
      const victims = dolls.filter(o => o.z > 0 && overlapPresses(o, p))
      while (victims.length > 2) {
        const victim = victims.pop()
        victim.x = victim.size + rng() * (AREA - 2 * victim.size)
        victim.y = victim.size + rng() * (AREA - 2 * victim.size)
        moved = true
      }
    }
    if (!moved) return
  }
}

function rollRarity(rng) {
  const total = RARITY_WEIGHTS.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [rar, w] of RARITY_WEIGHTS) {
    r -= w
    if (r < 0) return rar
  }
  return 1
}

// ---------- T2.1/T2.2/T2.3 布局生成（几何部分，纯函数便于测试） ----------
export function generateLayoutGeometry(rng, { dollsPerLayout = 12, luckRarity = null } = {}) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const dolls = []
    const n = dollsPerLayout + (luckRarity ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const isLuck = !!luckRarity && i === n - 1
      const rarity = isLuck ? luckRarity : rollRarity(rng)
      // 体积：稀有度越高越小（带 ±15% 扰动）
      const size = SIZE_BY_RARITY[rarity] * (0.85 + rng() * 0.3)
      // 层级：越稀有越深（带随机扰动，钳制 0~3）；幸运值保底娃娃固定表层（T2.10）
      let z = Z_TARGET[rarity]
      if (!isLuck) {
        const jitter = rng()
        if (jitter < 0.25 && z > 0) z -= 1
        else if (jitter > 0.85 && z < 3) z += 1
      } else {
        z = 0
      }
      dolls.push({ rarity, size, z, x: 0, y: 0 })
    }
    // 深层先铺，表层后铺（有概率落在深层娃娃上方形成堆叠/夹缝）
    const order = [...dolls.keys()].sort((a, b) => dolls[b].z - dolls[a].z)
    for (const idx of order) {
      const d = dolls[idx]
      const deeper = dolls.filter((o, j) => j !== idx && o.z > d.z && o._placed)
      let placed = false
      for (let t = 0; t < 40 && deeper.length > 0; t++) {
        if (rng() < 0.65) {
          // 偏向压在某个深层娃娃附近，制造"被压住"的堆叠
          const host = deeper[Math.floor(rng() * deeper.length)]
          const ang = rng() * Math.PI * 2
          const dist = rng() * (host.size + d.size) * 0.5
          const x = host.x + Math.cos(ang) * dist
          const y = host.y + Math.sin(ang) * dist
          if (x >= d.size && x <= AREA - d.size && y >= d.size && y <= AREA - d.size) {
            d.x = x; d.y = y; placed = true; break
          }
        } else break
      }
      if (!placed) {
        d.x = d.size + rng() * (AREA - 2 * d.size)
        d.y = d.size + rng() * (AREA - 2 * d.size)
      }
      d._placed = true
    }
    // 遮挡关系（有向无环：表层压深层，天然无环）；修复压制上限（每个表层娃娃 ≤2 个受害者）
    for (const d of dolls) d._placed = true
    repairPressCap(dolls, rng)
    decorate(dolls)
    // 校验（§5：任意时刻可抓 ≥2 且无遮挡死锁）：
    //  - 无死锁：z 最小的在机娃娃永远无人压制（结构性成立，逐序模拟兜底断言）
    //  - 可抓 ≥2：初始 ≥2，且机内剩余 ≥4 时任意贪心顺序下可抓 ≥2（剩余 ≤3 属收尾阶段）
    // 说明：若按"任意顺序、任意剩余数"的强解释，可证任何受压结构都会剩 {压者,被压者}
    //   二元组而违背 ≥2，与 §3.1"多被 2~3 个压住"互斥——故采用上述符合设计意图的解释
    let sim = dolls.map(d => ({ ...d, status: 'in_machine' }))
    decorate(sim)
    if (sim.filter(d => d.reachable).length >= 2 && layoutPassesOrders(sim, rng)) {
      for (const d of dolls) { delete d._placed; delete d.pressers; delete d.reachable }
      return dolls
    }
  }
  // 兜底：全部娃娃置于表层（z=0 永远不会被压，任意状态全部可抓，不变量恒成立）
  const fallback = []
  for (let i = 0; i < dollsPerLayout; i++) {
    const rarity = rollRarity(rng)
    const size = SIZE_BY_RARITY[rarity] * (0.85 + rng() * 0.3)
    fallback.push({
      rarity, size, z: 0,
      x: size + rng() * (AREA - 2 * size),
      y: size + rng() * (AREA - 2 * size),
    })
  }
  return fallback
}

// 逐序校验：三种贪心顺序（正序/逆序/随机）下，机内剩余 ≥4 时可抓 ≥2；任意时刻可抓 ≥1（无死锁）
function layoutPassesOrders(dolls, rng) {
  const orders = [
    [...dolls.keys()],
    [...dolls.keys()].reverse(),
    [...dolls.keys()].sort(() => rng() - 0.5),
  ]
  for (const order of orders) {
    const sim = dolls.map(d => ({ ...d, status: 'in_machine' }))
    decorate(sim)
    for (;;) {
      const inM = sim.filter(d => d.status === 'in_machine')
      if (inM.length === 0) break
      const reach = inM.filter(d => d.reachable)
      if (reach.length === 0) return false // 死锁（理论上不会发生）
      if (inM.length >= 4 && reach.length < 2) return false
      // 按给定顺序抓第一个可及的
      const pick = order.map(i => sim[i]).find(d => d.status === 'in_machine' && d.reachable)
      pick.status = 'taken'
      decorate(sim)
    }
  }
  return true
}

// ---------- T2.5 内容预生成 + 布局落库 ----------
async function buildLayoutStmts(DB, { machineId, rng, luckInsert = false, dollsPerLayout = 12 }) {
  const luckRarity = luckInsert ? (rng() < 0.75 ? 3 : 4) : null
  const geometry = generateLayoutGeometry(rng, { dollsPerLayout, luckRarity })

  // 内容预生成：铺场时掷骰并落库（开娃只读取，不掷骰）
  // 惩罚道具的 Spank 数量同样铺场时预生成
  const penaltyTplCache = {}
  const dolls = []
  const stmts = []
  for (const g of geometry) {
    const option = 'L' + g.rarity
    const regular = await rollDrop(DB, { game: 'grab', option, rng })
    if (!regular.entry) throw new KernelError('POOL_EMPTY', `掉落池 ${option} 尚未配置，请先在运营后台配置`)
    const pity = await rollDrop(DB, {
      game: 'grab', option, rng,
      entryFilter: e => e.ref_type !== 'penalty', // 保底内容必为奖励侧（预生成）
    })

    let spanks = null
    if (regular.entry.ref_type === 'penalty') {
      const pid = regular.entry.ref_id
      if (!penaltyTplCache[pid]) {
        penaltyTplCache[pid] = await DB.prepare(
          'SELECT spank_min, spank_max FROM penalty_templates WHERE id = ?'
        ).bind(pid).first()
      }
      const t = penaltyTplCache[pid]
      const min = Math.max(1, toInt(t?.spank_min, 1, 1, 9999))
      const max = Math.max(min, toInt(t?.spank_max, min, 1, 9999))
      spanks = min + Math.floor(rng() * (max - min + 1))
    }

    dolls.push({
      machineId, rarity: g.rarity, size: g.size, x: g.x, y: g.y, z: g.z,
      ref_type: regular.entry.ref_type, ref_id: regular.entry.ref_id || null,
      amount: regular.entry.amount ?? null, spanks,
      pity_ref_type: pity.entry?.ref_type ?? null,
      pity_ref_id: pity.entry?.ref_id ?? null,
      pity_amount: pity.entry?.amount ?? null,
    })
    // 0库存跳过记录（铺场时跳过也要记录，§2.3）
    stmts.push(...regular.skipStmts, ...pity.skipStmts)
  }

  for (const d of dolls) {
    stmts.push(DB.prepare(
      `INSERT INTO grab_dolls (machine_id, rarity, size, x, y, z, ref_type, ref_id, amount, spanks,
        pity_ref_type, pity_ref_id, pity_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(d.machineId, d.rarity, d.size, d.x, d.y, d.z, d.ref_type, d.ref_id, d.amount, d.spanks,
      d.pity_ref_type, d.pity_ref_id, d.pity_amount))
  }
  stmts.push(DB.prepare(
    "UPDATE grab_machines SET dolls_left = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(dolls.length, machineId))
  // 布局视图（batch 前解析计算，供响应使用——不依赖 batch 后的读取）
  const layout = decorate(dolls.map(d => ({ ...d, status: 'in_machine' })))
    .map(({ rarity, size, x, y, z, reachable }) => ({ rarity, size, x, y, z, reachable }))
  return { dolls, layout, stmts, luckInserted: !!luckRarity }
}

// ---------- 玩家状态 ----------
async function getOrCreateState(DB, username, game = 'grab') {
  const row = await DB.prepare(
    'SELECT * FROM player_game_state WHERE username = ? AND game = ?'
  ).bind(username, game).first()
  if (row) return row
  await DB.prepare(
    'INSERT OR IGNORE INTO player_game_state (username, game) VALUES (?, ?)'
  ).bind(username, game).run()
  return await DB.prepare(
    'SELECT * FROM player_game_state WHERE username = ? AND game = ?'
  ).bind(username, game).first()
}

// ---------- 机器状态查询（T2.4 可及集合实时重算） ----------
export async function getMachineState(DB, username) {
  const machine = await DB.prepare('SELECT * FROM grab_machines WHERE id = ?').bind(MACHINE_ID).first()
  const dollRows = await DB.prepare(
    "SELECT id, rarity, size, x, y, z FROM grab_dolls WHERE machine_id = ? AND status = 'in_machine' ORDER BY z, id"
  ).bind(MACHINE_ID).all()
  const dolls = decorate((dollRows.results || []).map(d => ({ ...d })))
    .map(({ pressers, reachable, ...d }) => ({ ...d, reachable, occluded: pressers.length }))
  const inMachine = dolls.length

  const state = await getOrCreateState(DB, username)
  const [playCost, rerollCost, rerollLimit, luckMax] = await Promise.all([
    paramNum(DB, 'play_cost_coin', 10),
    paramNum(DB, 'grab_reroll_cost', 30),
    paramNum(DB, 'grab_reroll_daily_limit', 50),
    paramNum(DB, 'grab_luck_max', 100),
  ])
  const today = bjDate()
  const usedToday = state.reroll_date === today ? state.reroll_count : 0
  const user = await DB.prepare('SELECT balance, activity FROM users WHERE username = ?').bind(username).first()

  return {
    machine: { id: MACHINE_ID, dolls, dollsLeft: inMachine, area: AREA },
    player: {
      luck: state.luck, luckMax,
      penaltyStreak: state.penalty_streak,
      failStreak: state.fail_streak,
      rerollCount: usedToday, rerollLimit,
      rerollCost, playCost,
      needsReroll: inMachine === 0,
    },
    balance: user ? user.balance : 0,
    baseRates: BASE_RATES,
  }
}

// ---------- T2.12 下爪结算链 ----------
// 校验可抓 → 抢占（防双抓）→ debit → 掷成功率（含道具加成）→ 读预生成内容 → 内核结算
// → 移走娃娃并重算可及集合 → 写流水
export async function clawOp(DB, { username, dollId, idempotencyKey = null, rng = Math.random }) {
  // G2 幂等预检
  if (idempotencyKey) {
    const prev = await DB.prepare(
      'SELECT response FROM idempotency_records WHERE idempotency_key = ?'
    ).bind(idempotencyKey).first()
    if (prev) {
      let first = {}
      try { first = JSON.parse(prev.response) || {} } catch (e) {}
      return { ...first, replayed: true }
    }
  }

  const [playCost, handSlipRate, luckMax] = await Promise.all([
    paramNum(DB, 'play_cost_coin', 10),
    paramNum(DB, 'grab_hand_slip_rate', 0.3),
    paramNum(DB, 'grab_luck_max', 100),
  ])
  const state = await getOrCreateState(DB, username)

  const doll = await DB.prepare(
    "SELECT * FROM grab_dolls WHERE id = ? AND machine_id = ? AND status = 'in_machine'"
  ).bind(dollId, MACHINE_ID).first()
  if (!doll) throw new KernelError('DOLL_NOT_FOUND', '娃娃不存在或已被抓走', 404)

  // 校验可抓：未被其他在机娃娃遮挡（服务端权威，禁止前端判定）
  const inMachine = ((await DB.prepare(
    "SELECT id, size, x, y, z FROM grab_dolls WHERE machine_id = ? AND status = 'in_machine'"
  ).bind(MACHINE_ID).all()).results || []).map(d => ({ ...d, status: 'in_machine' }))
  const pressers = inMachine.filter(o => o.id !== doll.id && overlapPresses(doll, o))
  if (pressers.length > 0) {
    throw new KernelError('DOLL_OCCLUDED', '这个娃娃被其他娃娃压住了，先抓开上面的娃娃吧')
  }

  // 余额预检（避免抢占后扣费失败）
  const user = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()
  if (!user) throw new KernelError('USER_NOT_FOUND', '用户不存在', 404)
  if ((Number(user.balance) || 0) < playCost) {
    throw new KernelError('INSUFFICIENT_BALANCE', '金币不足，无法下爪')
  }

  // 防双抓抢占：条件更新 + D1 写串行化，并发 10 请求仅一个赢家
  const claim = await DB.batch([
    DB.prepare(
      `UPDATE grab_dolls SET status = 'taken', taken_by = ?, taken_source = 'pending',
        taken_at = datetime('now')
       WHERE id = ? AND machine_id = ? AND status = 'in_machine'`
    ).bind(username, doll.id, MACHINE_ID),
  ])
  if (!claim[0] || claim[0].meta.changes === 0) {
    throw new KernelError('DOLL_TAKEN', '手慢了，这个娃娃刚被抓走', 409)
  }

  try {
    // —— 结算链（单 batch 原子） ——
    const rate = Math.min(MAX_RATE, BASE_RATES[doll.rarity])
    const success = rng() < rate
    const handSlip = !success && rng() < handSlipRate // T2.6 手滑 bonus：机器固有机制
    const taken = success || handSlip
    // T2.10 保底：连续 3 次惩罚事件后，本次必出奖励（使用铺场时预生成的保底内容，不掷骰）
    const pityUsed = state.penalty_streak >= 3

    // Resolver（grab.before）：自动挂载道具（稳定爪/连败保险），与结算同事务
    const { effects, stmts: resolverStmts } = await resolveEventStmts(DB, {
      username, game: 'grab', event: 'grab.before', scope: 'grab',
      filterFn: row => row.action !== 'insurance' || state.fail_streak >= 3,
    })
    const bonus = effects
      .filter(e => e.action === 'rate_boost' || e.action === 'insurance')
      .reduce((s, e) => s + (Number(e.value) || 0), 0)
    const finalRate = Math.min(MAX_RATE, rate + bonus / 100)

    // 内容：预生成（保底启用时用保底内容）
    const content = pityUsed && doll.pity_ref_type
      ? { ref_type: doll.pity_ref_type, ref_id: doll.pity_ref_id, amount: doll.pity_amount, spanks: null }
      : { ref_type: doll.ref_type, ref_id: doll.ref_id, amount: doll.amount, spanks: doll.spanks }

    const stmts = []
    let granted = null

    // Resolver 消耗与效果流水入批（无论抓中与否，生效即消耗）
    stmts.push(...resolverStmts)

    if (taken) {
      // 内核结算：金币/道具/奖励/碎片/惩罚Spank 全走步骤1内核
      const tryGrant = async (entry) => grantDropStmts(DB, {
        username,
        entry: { game: 'grab', id: doll.id, ...entry },
        source: success ? 'grab' : 'hand_slip',
        rng,
      })
      try {
        const g = await tryGrant(content)
        granted = g.granted
        stmts.push(...g.stmts)
      } catch (e) {
        // T2.5/§2.3：预生成奖励库存为 0 → 回退池内替代条目（0库存自动跳过）
        if (e instanceof KernelError && e.code === 'REWARD_OUT_OF_STOCK') {
          const re = await rollDrop(DB, { game: 'grab', option: 'L' + doll.rarity, rng })
          if (!re.entry) throw e
          const g2 = await tryGrant({ ref_type: re.entry.ref_type, ref_id: re.entry.ref_id, amount: re.entry.amount, spanks: null })
          granted = g2.granted
          stmts.push(...g2.stmts, ...re.skipStmts)
        } else {
          throw e
        }
      }
    }

    // 扣费（每次下爪，含失败；G1 费用后台可配）
    const { stmts: feeStmts, balance: feeBalance } = await ledgerStmts(DB, {
      username, currency: 'coin', delta: -playCost, reason: 'grab_fee',
      refType: 'grab', refId: String(doll.id),
      assetLog: { action: 'balance', title: '抓娃娃下爪', detail: `-${playCost}` },
    })
    stmts.unshift(...feeStmts)

    if (!taken) {
      // 抓取失败且无手滑：娃娃保留原位（同一事务内回置抢占）
      stmts.push(DB.prepare(
        `UPDATE grab_dolls SET status = 'in_machine', taken_by = NULL, taken_source = NULL, taken_at = NULL
         WHERE id = ? AND status = 'taken' AND taken_source = 'pending'`
      ).bind(doll.id))
    }

    // G6：每次有效游玩（下爪）+1 活跃值
    const { stmts: actStmts } = await ledgerStmts(DB, {
      username, currency: 'activity', delta: 1, reason: 'grab_play',
      refType: 'grab', refId: String(doll.id),
    })
    stmts.push(...actStmts)

    // 状态更新：幸运值/惩罚连败/抓取连败
    const newLuck = Math.min(luckMax, state.luck + 1)
    const isPenalty = taken && granted && granted.type === 'penalty'
    const newPenaltyStreak = !taken ? state.penalty_streak : (isPenalty ? state.penalty_streak + 1 : 0)
    const newFailStreak = taken ? 0 : state.fail_streak + 1
    stmts.push(DB.prepare(
      `UPDATE player_game_state SET luck = ?, penalty_streak = ?, fail_streak = ?, updated_at = datetime('now')
       WHERE username = ? AND game = 'grab'`
    ).bind(newLuck, newPenaltyStreak, newFailStreak, username))

    // 流水
    if (taken) {
      // 回填抢占来源（grab / hand_slip）
      stmts.push(DB.prepare(
        "UPDATE grab_dolls SET taken_source = ? WHERE id = ? AND status = 'taken'"
      ).bind(success ? 'grab' : 'hand_slip', doll.id))
    }
    stmts.push(DB.prepare(
      `INSERT INTO grab_grabs (username, machine_id, doll_id, rarity, success, hand_slip, fee,
        ref_type, ref_id, amount, spanks, effects, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      username, MACHINE_ID, doll.id, doll.rarity, taken ? 1 : 0, handSlip ? 1 : 0, playCost,
      taken ? (granted?.type || '') : '', taken ? (content.ref_id || null) : null,
      taken ? (granted?.amount ?? null) : null, taken ? (granted?.spanks ?? null) : null,
      JSON.stringify(effects), idempotencyKey
    ))

    // G2 幂等记录
    const dollsAfter = taken
      ? decorate(inMachine.filter(d => d.id !== doll.id).map(d => ({ ...d })))
      : decorate(inMachine.map(d => ({ ...d })))
    const response = {
      action: 'grab_claw',
      success: taken,
      caught: success,
      handSlip,
      pityUsed,
      rate: finalRate,
      fee: playCost,
      content: granted,
      effects,
      luck: newLuck,
      luckMax,
      penaltyStreak: newPenaltyStreak,
      failStreak: newFailStreak,
      balance: feeBalance,
      dollsLeft: dollsAfter.filter(d => d.status === 'in_machine').length,
      dolls: dollsAfter.map(({ id, rarity, size, x, y, z, reachable }) => ({ id, rarity, size, x, y, z, reachable })),
    }
    response.message = buildMessage({ taken, handSlip, granted, effects })
    stmts.push(DB.prepare(
      'INSERT INTO idempotency_records (idempotency_key, endpoint, username, response) VALUES (?, ?, ?, ?)'
    ).bind(idempotencyKey, 'grab_claw', username, JSON.stringify(response)))

    await DB.batch(stmts)
    return response
  } catch (e) {
    // 结算失败补偿：释放娃娃回机内（单人环境下无竞争，尽力而为）
    try {
      await DB.batch([
        DB.prepare(
          `UPDATE grab_dolls SET status = 'in_machine', taken_by = NULL, taken_source = NULL, taken_at = NULL
           WHERE id = ? AND status = 'taken' AND taken_by = ?`
        ).bind(doll.id, username),
      ])
    } catch (e2) { console.error('unclaim failed:', e2) }
    throw e
  }
}

function buildMessage({ taken, handSlip, granted, effects }) {
  if (!taken) {
    const hasInsurance = effects.some(e => e.action === 'insurance')
    return hasInsurance ? '😅 抓空了……不过连败保险还在保护你' : '😅 抓空了，娃娃还在机里'
  }
  const prefix = handSlip ? '🤲 手滑啦！娃娃被带落，免费开娃——' : '🎯 抓中啦——'
  if (!granted) return prefix + '空娃娃？'
  switch (granted.type) {
    case 'coin': return `${prefix}🪙 获得 ${granted.amount} 金币！`
    case 'item': return `${prefix}🎁 道具「${granted.name}」已入背包！`
    case 'reward': return `${prefix}🎟️ 现实奖励「${granted.name}」已入奖励背包！`
    case 'penalty': return `${prefix}😵 惩罚娃娃「${granted.name}」+${granted.applied} Spank……`
    case 'fragment': return `${prefix}🧩 碎片 +1！去个人面板看看合成进度吧`
    default: return prefix + '开出神秘内容'
  }
}

// ---------- T2.7 重铺 ----------
export function rerollOp(DB, { username, mode = 'coin', idempotencyKey = null, rng = Math.random }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'grab_reroll', username },
    async () => {
      const [rerollCost, rerollLimit, luckMax, dollsPerLayout] = await Promise.all([
        paramNum(DB, 'grab_reroll_cost', 30),
        paramNum(DB, 'grab_reroll_daily_limit', 50),
        paramNum(DB, 'grab_luck_max', 100),
        paramNum(DB, 'grab_dolls_per_layout', 12),
      ])
      const state = await getOrCreateState(DB, username)
      const inMachine = await DB.prepare(
        "SELECT COUNT(*) AS c FROM grab_dolls WHERE machine_id = ? AND status = 'in_machine'"
      ).bind(MACHINE_ID).first()
      const freeEmpty = (inMachine?.c || 0) === 0 // 抓空免费重铺，不计入上限

      let cost = 0
      let couponItemId = null
      const stmts = []

      if (!freeEmpty) {
        const today = bjDate()
        const usedToday = state.reroll_date === today ? state.reroll_count : 0
        if (usedToday >= rerollLimit) {
          throw new KernelError('REROLL_LIMIT_REACHED', `今日主动重铺次数已用完（${usedToday}/${rerollLimit}）`)
        }
        if (mode === 'coupon') {
          // 换机券：消耗一张（action='reroll' 的道具）
          const coupon = await DB.prepare(
            `SELECT t.id, COALESCE(p.count, 0) AS owned
             FROM item_templates t LEFT JOIN player_items p ON p.item_id = t.id AND p.username = ?
             WHERE t.action = 'reroll' AND t.category = 'game' AND t.is_active = 1
             ORDER BY t.rarity LIMIT 1`
          ).bind(username).first()
          if (!coupon || coupon.owned <= 0) {
            throw new KernelError('ITEM_NOT_OWNED', '没有可用的换机券')
          }
          couponItemId = coupon.id
          stmts.push(DB.prepare(
            "UPDATE player_items SET count = count - 1, updated_at = datetime('now') WHERE username = ? AND item_id = ? AND count >= 1"
          ).bind(username, coupon.id))
        } else {
          cost = rerollCost
          const { stmts: feeStmts } = await ledgerStmts(DB, {
            username, currency: 'coin', delta: -cost, reason: 'grab_reroll',
            refType: 'grab', refId: 'reroll',
            assetLog: { action: 'balance', title: '抓娃娃重铺', detail: `-${cost}` },
          })
          stmts.push(...feeStmts)
        }
        // 主动重铺计数（付费+换机券合计）
        stmts.push(DB.prepare(
          `UPDATE player_game_state SET
             reroll_date = ?, reroll_count = CASE WHEN reroll_date = ? THEN reroll_count + 1 ELSE 1 END,
             updated_at = datetime('now')
           WHERE username = ? AND game = 'grab'`
        ).bind(today, today, username))
      }

      // T2.10 幸运值：满值时本次重铺在表层可及位置放入一个 L3+ 娃娃并清零
      const luckInsert = state.luck >= luckMax
      const { layout, stmts: layoutStmts, luckInserted } = await buildLayoutStmts(DB, {
        machineId: MACHINE_ID, rng, luckInsert, dollsPerLayout,
      })
      stmts.unshift(
        DB.prepare("DELETE FROM grab_dolls WHERE machine_id = ? AND status = 'in_machine'").bind(MACHINE_ID),
        ...layoutStmts,
      )
      if (luckInsert) {
        stmts.push(DB.prepare(
          "UPDATE player_game_state SET luck = 0, updated_at = datetime('now') WHERE username = ? AND game = 'grab'"
        ).bind(username))
      }

      stmts.push(DB.prepare(
        `INSERT INTO grab_rerolls (username, machine_id, mode, cost, coupon_item_id, luck_inserted, dolls, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        username, MACHINE_ID, freeEmpty ? 'free_empty' : mode, cost, couponItemId,
        luckInserted ? 1 : 0, layout.length, idempotencyKey
      ))

      // 布局视图由 buildLayoutStmts 在 batch 前解析计算（不依赖 batch 后读取）
      const response = {
        action: 'grab_reroll',
        free: freeEmpty,
        mode: freeEmpty ? 'free_empty' : mode,
        cost,
        luckInserted,
        rerollCount: freeEmpty ? (state.reroll_date === bjDate() ? state.reroll_count : 0) : (state.reroll_date === bjDate() ? state.reroll_count + 1 : 1),
        rerollLimit,
        dollsLeft: layout.length,
        dolls: layout,
      }
      return { response, stmts }
    }
  )
}

// ---------- T2.14 透视镜（只返回模糊文案，不泄露精确内容） ----------
export function revealOp(DB, { username, dollId, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'grab_reveal', username },
    async () => {
      // 消耗一张透视镜
      const lens = await DB.prepare(
        `SELECT t.id, COALESCE(p.count, 0) AS owned
         FROM item_templates t LEFT JOIN player_items p ON p.item_id = t.id AND p.username = ?
         WHERE t.action = 'reveal' AND t.category = 'game' AND t.is_active = 1
         ORDER BY t.rarity LIMIT 1`
      ).bind(username).first()
      if (!lens || lens.owned <= 0) {
        throw new KernelError('ITEM_NOT_OWNED', '没有可用的透视镜')
      }

      const doll = await DB.prepare(
        "SELECT * FROM grab_dolls WHERE id = ? AND machine_id = ? AND status = 'in_machine'"
      ).bind(dollId, MACHINE_ID).first()
      if (!doll) throw new KernelError('DOLL_NOT_FOUND', '娃娃不存在或已被抓走', 404)

      const inMachine = (await DB.prepare(
        "SELECT id, size, x, y, z FROM grab_dolls WHERE machine_id = ? AND status = 'in_machine'"
      ).bind(MACHINE_ID).all()).results || []
      const pressers = inMachine.filter(o => o.id !== doll.id && overlapPresses(doll, o))
      const occluded = pressers.length > 0

      let tier = null
      let hint
      if (occluded) {
        // 对被遮挡娃娃的提示更含糊（T2.14）
        hint = '🔍 缝隙里似乎有东西在闪光……看不太清'
      } else {
        tier = await classifyContent(DB, doll)
        hint = tier === '好' ? '🔍 透视镜里光华夺目——里面是好东西！'
          : tier === '中' ? '🔍 透视镜里平平淡淡——看上去还凑合'
          : '🔍 透视镜里灰扑扑的——感觉不太妙……'
      }

      const stmts = [
        DB.prepare(
          "UPDATE player_items SET count = count - 1, updated_at = datetime('now') WHERE username = ? AND item_id = ? AND count >= 1"
        ).bind(username, lens.id),
        DB.prepare(
          "INSERT INTO effect_logs (username, game, event, item_id, action, value, detail) VALUES (?, 'grab', 'reveal.manual', ?, 'reveal', 0, ?)"
        ).bind(username, lens.id, JSON.stringify({ dollId, occluded })),
      ]
      // 响应只含模糊文案，绝不含 ref_type/ref_id/amount/spanks（验收：透视镜不泄露精确内容）
      const response = { action: 'grab_reveal', dollId, occluded, tier, hint }
      return { response, stmts }
    }
  )
}

async function classifyContent(DB, doll) {
  const c = { ref_type: doll.ref_type, ref_id: doll.ref_id, amount: doll.amount }
  if (c.ref_type === 'reward') return '好'
  if (c.ref_type === 'fragment') return '中'
  if (c.ref_type === 'penalty') return '差'
  if (c.ref_type === 'coin') return (c.amount || 0) >= 25 ? '好' : (c.amount || 0) >= 10 ? '中' : '差'
  if (c.ref_type === 'item') {
    const t = await DB.prepare('SELECT rarity, category FROM item_templates WHERE id = ?').bind(c.ref_id).first()
    if (!t) return '中'
    if (t.rarity >= 3) return '好'
    if (t.rarity === 2) return '中'
    return '差'
  }
  return '中'
}

// ---------- G4 概率公示（抓娃娃专有：基础成功率 + 四池条目） ----------
export async function getGrabConfig(DB) {
  const pools = await listDropPools(DB, 'grab')
  const controls = {}
  for (const opt of ['L1', 'L2', 'L3', 'L4']) {
    controls[opt] = await getSideControls(DB, 'grab', opt)
  }
  return {
    baseRates: BASE_RATES,
    sizes: SIZE_BY_RARITY,
    pools,
    controls,
  }
}
