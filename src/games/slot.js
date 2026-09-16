// 步骤3 · 老虎机（T3.1~T3.15）
// 5轴×3行；一次 spin 在服务端完成全部爆裂模拟并返回 steps[]，客户端只回放；
// Nudge/追猴/转轮三个后置端点的分支全部在 spin 时预生成落库，选择后只揭示，不重 roll；
// 复用步骤1内核：统一账本 / grantFragmentStmts / grantRewardStmts / 幂等包装；
// 彩池触发仅做标记预留（账本属步骤4）；不产出收藏外观（G16）

import { KernelError, toInt, toMoney } from '../kernel/util.js'
import { kernelWrite } from '../kernel/idempotency.js'
import { ledgerStmts } from '../kernel/ledger.js'
import { getParam } from '../kernel/templates.js'
import { grantFragmentStmts } from '../kernel/fragments.js'
import { grantRewardStmts } from '../kernel/backpack.js'
import { mulberry32 } from './rng.js'
export const MACHINE = 'slot-1'
const STRIP_LEN = 100
export const MULT_LADDER = [1, 2, 3, 5, 10]      // T3.2 倍率 ×1→×2→×3→×5 封顶 ×10
const MAX_CASCADE = 30

// ---------- Schema 保证（与 migrations/0011_slot.sql 等价，幂等） ----------
let slotSchemaPromise = null
export function ensureSlotSchemaOnce(DB) {
  if (!slotSchemaPromise) {
    slotSchemaPromise = initSlotSchema(DB).catch(error => {
      console.error('Failed to ensure slot schema:', error)
      slotSchemaPromise = null
    })
  }
  return slotSchemaPromise
}

async function initSlotSchema(DB) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS slot_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS slot_state (
      username TEXT PRIMARY KEY,
      fever_slot INTEGER NOT NULL DEFAULT 0,
      fever_active INTEGER NOT NULL DEFAULT 0,
      fever_left INTEGER NOT NULL DEFAULT 0,
      fever_mult_idx INTEGER NOT NULL DEFAULT 0,
      free_date TEXT NOT NULL DEFAULT '',
      free_left INTEGER NOT NULL DEFAULT 0,
      nudge_date TEXT NOT NULL DEFAULT '',
      nudge_left INTEGER NOT NULL DEFAULT 0,
      no_win_streak INTEGER NOT NULL DEFAULT 0,
      hold_active INTEGER NOT NULL DEFAULT 0,
      last_spin_id INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS slot_spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      seed INTEGER NOT NULL,
      free_type TEXT NOT NULL DEFAULT 'paid',
      fee REAL NOT NULL DEFAULT 0,
      hold_reel INTEGER,
      positions TEXT NOT NULL,
      grid TEXT NOT NULL,
      steps TEXT NOT NULL,
      total_payout REAL NOT NULL DEFAULT 0,
      fragments TEXT NOT NULL DEFAULT '[]',
      monkey INTEGER NOT NULL DEFAULT 0,
      wheel INTEGER NOT NULL DEFAULT 0,
      jackpot_hit INTEGER NOT NULL DEFAULT 0,
      nudged INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS slot_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      spin_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      choice TEXT,
      result TEXT,
      idempotency_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_slot_pending_user ON slot_pending(username, status)',
    // 种子配置（G17：步骤6后台可改）
    `INSERT OR IGNORE INTO slot_config (id, config) VALUES (1, '{
      "pays": {"cherry":[1,3,8],"lemon":[1,4,10],"bell":[3,8,20],"diamond":[5,15,45],"wild":[10,10,10]},
      "weights": {"cherry":22,"lemon":20,"bell":16,"diamond":12,"wild":5,"monkey":8,"fortune":4,"jackpot":1,"empty":12},
      "feverWeights": {"cherry":22,"lemon":20,"bell":16,"diamond":12,"wild":10,"monkey":0,"fortune":4,"jackpot":1,"empty":15},
      "payScale": 0.6,
      "wheel": [
        {"type":"reward","label":"现实奖励·中额","value":50,"prob":2},
        {"type":"coin","label":"100币","value":100,"prob":6},
        {"type":"coin_range","label":"金币20~50","min":20,"max":50,"prob":28},
        {"type":"fragment","label":"华丽碎片","rarity":3,"prob":10},
        {"type":"fever","label":"Fever+5格","value":5,"prob":25},
        {"type":"nudge","label":"Nudge×2","value":2,"prob":16},
        {"type":"none","label":"谢谢参与","prob":13}
      ],
      "fragment": {"d3":6,"d4":18,"d5":33,"loyal":9},
      "fever": {"slotMax":12,"spins":8},
      "holdProb": 30,
      "nudgeDaily": 3,
      "freeDaily": 5,
      "pity": {"streak":15,"payMin":30,"payMax":80}
    }')`,
  ]
  await DB.batch(ddl.map(sql => DB.prepare(sql)))
}

// ---------- 符号带（由权重确定性生成；每 spin 落库当时的带供 Nudge 校验） ----------
export function buildStrip(weights) {
  const pool = []
  for (const [sym, w] of Object.entries(weights)) {
    for (let i = 0; i < Math.round(w); i++) pool.push(sym)
  }
  // 固定种子洗牌：任何实例生成同一条带
  const rng = mulberry32(20260916)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, STRIP_LEN)
}

function pickSymbol(rng, weights) {
  const entries = Object.entries(weights)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [sym, w] of entries) {
    r -= w
    if (r < 0) return sym
  }
  return entries[0][0]
}

// 盘面：grid[col][row]；row 1 = 第2行；Jackpot 只出现在第2行（T3.14），其他行替换为空
export function buildGrid(strip, positions) {
  const grid = []
  for (let c = 0; c < 5; c++) {
    const col = []
    for (let r = 0; r < 3; r++) {
      let s = strip[((positions[c] + r) % strip.length + strip.length) % strip.length]
      if (s === 'jackpot' && r !== 1) s = 'empty'
      col.push(s)
    }
    grid.push(col)
  }
  return grid
}

// ---------- 连线判定（T3.1：5轴×3行，左→右） ----------
const NON_PAYING = new Set(['monkey', 'fortune', 'jackpot', 'empty'])

export function findWinningLines(grid, pays) {
  const lines = []
  for (let row = 0; row < 3; row++) {
    const syms = [0, 1, 2, 3, 4].map(c => grid[c][row])
    let base = null
    for (let c = 0; c < 5; c++) {
      if (syms[c] !== 'wild') { base = syms[c]; break }
    }
    if (base === null) base = 'wild'
    if (NON_PAYING.has(base)) continue
    const table = pays[base]
    if (!table) continue
    let count = 0
    for (let c = 0; c < 5; c++) {
      if (syms[c] === base || syms[c] === 'wild') count++
      else break
    }
    if (count >= 3) {
      const pay = table[Math.min(count, 5) - 3]
      if (pay > 0) {
        lines.push({ row, symbol: base, count, pay, cells: Array.from({ length: count }, (_, c) => [c, row]) })
      }
    }
  }
  return lines
}

// 3连特殊触发判定（初始盘面）：捣蛋猴 / Fortune / Jackpot（第2行5连）
function detectSpecials(grid) {
  let monkey = false, wheel = false, jackpot = false
  for (let row = 0; row < 3; row++) {
    if ([0, 1, 2].every(c => grid[c][row] === 'monkey')) monkey = true
    if ([0, 1, 2].every(c => grid[c][row] === 'fortune')) wheel = true
  }
  if ([0, 1, 2, 3, 4].every(c => grid[c][1] === 'jackpot')) jackpot = true
  return { monkey, wheel, jackpot }
}

// ---------- 爆裂下落补位 ----------
function dropAndRefill(grid, popSet, rng, weights) {
  const out = []
  for (let c = 0; c < 5; c++) {
    const remaining = []
    for (let r = 0; r < 3; r++) {
      if (!popSet.has(`${c},${r}`)) remaining.push(grid[c][r])
    }
    const removed = 3 - remaining.length
    const col = []
    for (let r = 0; r < 3; r++) {
      col.push(r < removed ? pickSymbol(rng, weights) : remaining[r - removed])
    }
    out.push(col)
  }
  return out
}

// ---------- T3.11 单次 spin 全模拟（纯函数：同 seed 重放一致） ----------
/**
 * @param {object} opts
 *   seed, cfg, fee, feverActive, startMultIdx, holdReel, holdPositions, forceWin
 * @returns {object} { positions, grid, steps, cascadeCount, payout, fragments,
 *                     monkey, wheel, jackpot, endMultIdx, feverDelta, holdGranted }
 */
export function simulateSpin(opts) {
  const { seed, cfg, fee, feverActive = false, startMultIdx = 0, holdReel = null, holdPositions = null, forceWin = false } = opts
  const rng = mulberry32(seed >>> 0)
  const weights = feverActive ? cfg.feverWeights : cfg.weights   // T3.10：Fever 中猴 0%、Wild×2
  const strip = buildStrip(cfg.weights)

  // 各轴停止位置（Hold：保留指定轴，T3.9）
  const positions = []
  for (let c = 0; c < 5; c++) {
    if (holdReel !== null && c === holdReel && holdPositions) positions.push(holdPositions[c])
    else positions.push(Math.floor(rng() * STRIP_LEN))
  }

  let curGrid = buildGrid(strip, positions)
  const initialGrid = curGrid.map(col => [...col])
  const steps = []
  let payout = 0
  let multIdx = feverActive ? Math.min(startMultIdx, MULT_LADDER.length - 1) : 0
  let cascadeCount = 0
  let cascadeTriggerFever = false
  const fragments = []
  let fragmentDepthCount = 0

  // 连线 + 连环爆裂（T3.2）
  for (let round = 0; round < MAX_CASCADE; round++) {
    const lines = findWinningLines(curGrid, cfg.pays)
    if (lines.length === 0) break
    const mult = MULT_LADDER[Math.min(multIdx, MULT_LADDER.length - 1)]
    const roundPay = lines.reduce((s, l) => s + l.pay, 0) * fee * cfg.payScale * mult
    payout += roundPay
    const popCells = []
    const popSet = new Set()
    for (const l of lines) {
      for (const [c, r] of l.cells) {
        popSet.add(`${c},${r}`)
        popCells.push([c, r])
      }
    }
    steps.push({
      type: 'cascade', depth: round + 1, grid: curGrid.map(col => [...col]),
      lines, multiplier: mult, roundPay, popCells,
    })

    cascadeCount++
    multIdx = Math.min(multIdx + 1, MULT_LADDER.length - 1)

    // T3.7 碎片：≥3 连爆按深度 6% / 18% / 33%，华丽 : 鎏金 = 9 : 1
    const depth = round + 1
    if (depth >= 3) {
      fragmentDepthCount++
      const rate = depth === 3 ? cfg.fragment.d3 : depth === 4 ? cfg.fragment.d4 : cfg.fragment.d5
      if (rng() * 100 < rate) {
        fragments.push(rng() * 100 < cfg.fragment.loyal ? 3 : 4)  // 华丽3 : 鎏金4 = 9 : 1
      }
    }
    // T3.2/T3.10：四连环（爆裂深度≥4）立即触发 Fever
    if (depth >= 4) cascadeTriggerFever = true

    curGrid = dropAndRefill(curGrid, popSet, rng, weights)
  }
  // 末轮盘面（无中奖）作为最后一步快照，便于客户端展示停轮
  steps.push({ type: 'settle', grid: curGrid.map(col => [...col]) })

  const specials = detectSpecials(initialGrid)

  // T3.13 保底：forceWin 且无中奖 → 赔付 30%~80% 下注（spin 时预生成确定）
  let pityApplied = false
  if (forceWin && payout === 0 && cascadeCount === 0) {
    const amount = toMoney(fee * (cfg.pity.payMin + rng() * (cfg.pity.payMax - cfg.pity.payMin)) / 100)
    payout = amount
    pityApplied = true
    steps.push({ type: 'pity', grid: curGrid.map(col => [...col]), amount })
  }

  // T3.9 Hold：中奖后 30% 概率获得下轮保留指定 1 轴的权利
  const holdGranted = payout > 0 && rng() * 100 < cfg.holdProb

  return {
    positions, strip, initialGrid, steps,
    cascadeCount, payout: toMoney(payout), fragments,
    monkey: specials.monkey, wheel: specials.wheel, jackpot: specials.jackpot,
    endMultIdx: multIdx,
    feverDelta: 1 + cascadeCount,   // T3.10：每次 spin +1、每次爆裂连击额外 +1
    cascadeTriggerFever, holdGranted, pityApplied,
  }
}

// ---------- 配置与状态 ----------
export async function getSlotConfig(DB) {
  const row = await DB.prepare('SELECT config FROM slot_config WHERE id = 1').first()
  if (!row) throw new KernelError('INTERNAL', '老虎机配置缺失', 500)
  return JSON.parse(row.config)
}

async function getOrCreateState(DB, username) {
  const row = await DB.prepare('SELECT * FROM slot_state WHERE username = ?').bind(username).first()
  if (row) return row
  await DB.prepare('INSERT OR IGNORE INTO slot_state (username) VALUES (?)').bind(username).run()
  return await DB.prepare('SELECT * FROM slot_state WHERE username = ?').bind(username).first()
}

// 每日免费转（T3.3：每日登录送 5 次）与每日 Nudge 重置
function rollDailyReset(state, cfg) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const updates = {}
  if (state.free_date !== today) { updates.free_date = today; updates.free_left = cfg.freeDaily }
  if (state.nudge_date !== today) { updates.nudge_date = today; updates.nudge_left = cfg.nudgeDaily }
  return { today, updates }
}

// ---------- spin（T3.3/T3.11/T3.12/T3.13/T3.14） ----------
export async function spinOp(DB, { username, holdReel = null, idempotencyKey = null }) {
  // G2 幂等预检
  if (idempotencyKey) {
    const prev = await DB.prepare('SELECT response FROM idempotency_records WHERE idempotency_key = ?').bind(idempotencyKey).first()
    if (prev) {
      let first = {}
      try { first = JSON.parse(prev.response) || {} } catch (e) {}
      return { ...first, replayed: true }
    }
  }

  const cfg = await getSlotConfig(DB)
  const fee = toMoney(await getParam(DB, 'play_cost_coin', '10'))
  const state = await getOrCreateState(DB, username)
  const { today, updates: dailyUpdates } = rollDailyReset(state, cfg)

  // Hold 校验（T3.9）：必须拥有权利且轴合法
  let useHold = null
  if (holdReel !== null && holdReel !== undefined) {
    const reel = toInt(holdReel, -1, 0, 4)
    if (reel < 0) throw new KernelError('INVALID_PARAM', '保留轴不正确')
    if (!state.hold_active) throw new KernelError('HOLD_NOT_AVAILABLE', '当前没有保留轴的权利')
    let last = null
    if (state.last_spin_id) {
      last = await DB.prepare('SELECT positions, grid FROM slot_spins WHERE id = ? AND username = ?')
        .bind(state.last_spin_id, username).first()
    }
    if (!last) throw new KernelError('HOLD_NOT_AVAILABLE', '没有可保留的上轮盘面')
    useHold = { reel, positions: JSON.parse(last.positions) }
  }

  // 费用与免费转（T3.3）：Fever 连转 > 每日免费转 > 付费（每日重置当日生效）
  const effFreeLeft = dailyUpdates.free_date ? cfg.freeDaily : state.free_left
  let freeType = 'paid'
  if (state.fever_active && state.fever_left > 0) freeType = 'fever'
  else if (effFreeLeft > 0) freeType = 'free_daily'
  const actualFee = freeType === 'paid' ? fee : 0

  // 保底（T3.13）：连续 15 转无中奖 → 下一转必中
  const forceWin = state.no_win_streak >= cfg.pity.streak

  // 全模拟（同 seed 重放一致）
  const seed = Math.floor(Math.random() * 0xffffffff)
  const sim = simulateSpin({
    seed, cfg, fee,
    feverActive: freeType === 'fever',
    startMultIdx: freeType === 'fever' ? state.fever_mult_idx : 0,
    holdReel: useHold ? useHold.reel : null,
    holdPositions: useHold ? useHold.positions : null,
    forceWin,
  })

  // —— 结算（单 batch 原子） ——
  const stmts = []

  // 余额预读（响应中的余额为解析计算，避免依赖 batch 后读取）
  const userRow = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()
  let balanceAfter = userRow ? Number(userRow.balance) || 0 : 0
  balanceAfter = Math.round((balanceAfter - actualFee + sim.payout) * 100) / 100

  // 扣费
  if (actualFee > 0) {
    const { stmts: feeStmts } = await ledgerStmts(DB, {
      username, currency: 'coin', delta: -actualFee, reason: 'slot_fee',
      refType: 'slot', refId: 'spin',
      assetLog: { action: 'balance', title: '老虎机转动', detail: `-${actualFee}` },
    })
    stmts.push(...feeStmts)
  }

  // G6：每次有效 spin +1 活跃值
  const { stmts: actStmts } = await ledgerStmts(DB, {
    username, currency: 'activity', delta: 1, reason: 'slot_play',
    refType: 'slot', refId: 'spin',
  })
  stmts.push(...actStmts)

  // 中奖派彩
  if (sim.payout > 0) {
    const { stmts: payStmts } = await ledgerStmts(DB, {
      username, currency: 'coin', delta: sim.payout, reason: 'slot_win',
      refType: 'slot', refId: 'spin',
      assetLog: { action: 'balance', title: '老虎机中奖', detail: `+${sim.payout}` },
    })
    stmts.push(...payStmts)
  }

  // 碎片掉落（T3.7 / Fever 结束保底华丽碎片）
  const fragList = [...sim.fragments]
  const feverWillEnd = freeType === 'fever' && state.fever_left - 1 <= 0
  if (feverWillEnd) fragList.push(3)   // T3.10：Fever 结束保底 1 片华丽碎片
  for (const rarity of fragList) {
    // 华丽/鎏金碎片各有种子配方（rarity3→消除券·华丽 recipe, rarity4→赦免券·鎏金 recipe）
    const recipe = await DB.prepare(
      `SELECT r.id FROM fragment_recipes r
       LEFT JOIN item_templates i ON r.target_type = 'item' AND i.id = r.target_id
       WHERE r.is_active = 1 AND r.target_type = 'item' AND i.rarity = ?
       ORDER BY r.id LIMIT 1`
    ).bind(rarity).first()
    if (!recipe) throw new KernelError('INTERNAL', `缺少 ${rarity} 级碎片配方`, 500)
    const { stmts: fs } = await grantFragmentStmts(DB, { username, recipeId: recipe.id, quantity: 1 })
    stmts.push(...fs)
  }

  // spin 记录落库（steps[] 全模拟 + seed 可重放 + strip/positions 供 Nudge 校验）
  const spinResult = await DB.prepare(
    `INSERT INTO slot_spins (username, seed, free_type, fee, hold_reel, positions, grid, steps,
      total_payout, fragments, monkey, wheel, jackpot_hit, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    username, seed, freeType, actualFee,
    useHold ? useHold.reel : null,
    JSON.stringify(sim.positions), JSON.stringify(sim.initialGrid), JSON.stringify(sim.steps),
    sim.payout, JSON.stringify(fragList),
    sim.monkey ? 1 : 0, sim.wheel ? 1 : 0, sim.jackpot ? 1 : 0,
    idempotencyKey,
  ).run()
  const spinId = spinResult.meta.last_row_id

  // 后置交互预生成（T3.12：全部分支 spin 时预生成落库）
  // 注意：响应与 pending 查询不提前泄露揭示结果（牌面值/落点扇区），选择后由揭示端点返回
  let monkeyPending = null
  let wheelPending = null
  if (sim.monkey) {
    // T3.4 追猴小剧场：3 张牌，2 张返 5~15 币、1 张空手（预生成 + 洗牌）
    const cards = [{ coins: Math.round(5 + Math.random() * 10) }, { coins: Math.round(5 + Math.random() * 10) }, { coins: 0 }]
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[cards[i], cards[j]] = [cards[j], cards[i]]
    }
    const pr = await DB.prepare(
      "INSERT INTO slot_pending (username, spin_id, type, payload) VALUES (?, ?, 'monkey', ?)"
    ).bind(username, spinId, JSON.stringify({ cards })).run()
    monkeyPending = { id: pr.meta.last_row_id, cardCount: cards.length }
  }
  if (sim.wheel) {
    // T3.6 幸运转轮：按 §3.2 概率预掷最终扇区（含 coin_range 具体值预生成）
    const sectors = cfg.wheel
    const total = sectors.reduce((s, x) => s + x.prob, 0)
    let r = Math.random() * total
    let index = 0
    for (let i = 0; i < sectors.length; i++) {
      r -= sectors[i].prob
      if (r < 0) { index = i; break }
    }
    const payload = { sectors, index }
    if (sectors[index].type === 'coin_range') {
      payload.resolvedValue = Math.round(sectors[index].min + Math.random() * (sectors[index].max - sectors[index].min))
    }
    const prRun = await DB.prepare(
      "INSERT INTO slot_pending (username, spin_id, type, payload) VALUES (?, ?, 'wheel', ?)"
    ).bind(username, spinId, JSON.stringify(payload)).run()
    wheelPending = { id: prRun.meta.last_row_id, sectorCount: sectors.length }
  }

  // Fever 槽与状态推进（T3.10）
  let feverSlot = state.fever_slot
  let feverActive = !!state.fever_active
  let feverLeft = state.fever_left
  let feverJustTriggered = false
  let feverEnded = false
  let multIdx = sim.endMultIdx
  if (feverActive) {
    // Fever 期间倍率不重置（跨 spin 延续），槽不累积
    feverLeft = state.fever_left - 1
    if (feverLeft <= 0) {
      feverActive = false; feverLeft = 0; feverSlot = 0; multIdx = 0; feverEnded = true
    }
  } else {
    feverSlot = state.fever_slot + sim.feverDelta
    const trigger = feverSlot >= cfg.fever.slotMax || sim.cascadeTriggerFever
    if (trigger) {
      feverActive = true; feverLeft = cfg.fever.spins; feverSlot = 0; multIdx = 0
      feverJustTriggered = true
    }
  }

  // Hold 权利（T3.9）：本spin授予则置1；本spin消耗则清零
  const holdActive = sim.holdGranted ? 1 : (useHold ? 0 : state.hold_active)

  // 无中奖连败（T3.13 保底计数）：有产出的 spin（含后置奖励前的直赢）清零
  const newNoWin = sim.payout > 0 ? 0 : state.no_win_streak + 1

  const stateStmt = DB.prepare(
    `UPDATE slot_state SET fever_slot = ?, fever_active = ?, fever_left = ?, fever_mult_idx = ?,
      nudge_left = ?, no_win_streak = ?, hold_active = ?, last_spin_id = ?, updated_at = datetime('now')
     WHERE username = ?`
  ).bind(
    feverSlot, feverActive ? 1 : 0, feverLeft, multIdx,
    dailyUpdates.nudge_date ? cfg.nudgeDaily : state.nudge_left,
    newNoWin, holdActive, spinId, username,
  )
  stmts.push(stateStmt)
  if (dailyUpdates.free_date || dailyUpdates.nudge_date) {
    stmts.push(DB.prepare(
      "UPDATE slot_state SET free_date = ?, free_left = ?, nudge_date = ?, nudge_left = ? WHERE username = ?"
    ).bind(
      dailyUpdates.free_date || state.free_date,
      dailyUpdates.free_date ? cfg.freeDaily : state.free_left,
      dailyUpdates.nudge_date || state.nudge_date,
      dailyUpdates.nudge_date ? cfg.nudgeDaily : state.nudge_left,
      username,
    ))
  }
  // 本 spin 消耗的免费/付费额度
  if (freeType === 'fever') {
    // fever_left 已在 stateStmt 中推进
  } else if (freeType === 'free_daily') {
    stmts.push(DB.prepare("UPDATE slot_state SET free_left = free_left - 1 WHERE username = ?").bind(username))
  }

  // 幂等记录（响应预构建）
  const response = {
    action: 'slot_spin', spinId, seed, freeType, fee: actualFee,
    grid: sim.initialGrid, steps: sim.steps,
    payout: sim.payout, balance: balanceAfter,
    fragments: fragList,
    monkey: sim.monkey ? { pendingId: monkeyPending?.id, cardCount: monkeyPending?.cardCount } : null,
    wheel: sim.wheel ? { pendingId: wheelPending?.id, sectorCount: wheelPending?.sectorCount } : null,
    jackpot: sim.jackpot ? { hit: true, poolLedger: 'reserved-step4' } : null,   // T3.14 彩池触发预留
    fever: { active: feverActive, triggered: feverJustTriggered, ended: feverEnded, slot: feverSlot, left: feverLeft },
    hold: { granted: !!sim.holdGranted, used: !!useHold },
    noWinStreak: newNoWin,
    pityApplied: sim.pityApplied,
  }
  stmts.push(DB.prepare(
    'INSERT INTO idempotency_records (idempotency_key, endpoint, username, response) VALUES (?, ?, ?, ?)'
  ).bind(idempotencyKey, 'slot_spin', username, JSON.stringify(response)))

  await DB.batch(stmts)
  return response
}

// ---------- T3.8 Nudge（每日3次；服务端用符号带校验 ±1 格；摇对真赢） ----------
export async function nudgeOp(DB, { username, spinId, reel, dir, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'slot_nudge', username },
    async () => {
      if (!['up', 'down'].includes(dir)) throw new KernelError('NUDGE_ILLEGAL', 'Nudge 方向不正确')
      const reelIdx = toInt(reel, -1, 0, 4)
      if (reelIdx < 0) throw new KernelError('NUDGE_ILLEGAL', 'Nudge 轴不正确')

      const cfg = await getSlotConfig(DB)
      const state = await getOrCreateState(DB, username)
      const { today, updates: dailyUpdates } = rollDailyReset(state, cfg)
      const left = dailyUpdates.nudge_date ? cfg.nudgeDaily : state.nudge_left
      if (left <= 0) throw new KernelError('NUDGE_LIMIT', '今日 Nudge 次数已用完')

      const spin = await DB.prepare(
        'SELECT * FROM slot_spins WHERE id = ? AND username = ?'
      ).bind(spinId, username).first()
      if (!spin) throw new KernelError('NOT_FOUND', '转动记录不存在', 404)
      if (spin.nudged) throw new KernelError('NUDGE_ILLEGAL', '该轮已使用过 Nudge')

      const positions = JSON.parse(spin.positions)
      const fee = toMoney(await getParam(DB, 'play_cost_coin', '10'))
      const pays = cfg.pays

      // 服务端校验：摇后盘面 = 摇前该轴 ±1 格的合法结果（按符号带重建，无重 roll）
      const shift = dir === 'up' ? -1 : 1
      const newPositions = [...positions]
      newPositions[reelIdx] = ((positions[reelIdx] + shift) % STRIP_LEN + STRIP_LEN) % STRIP_LEN
      const stripArr = buildStrip(cfg.weights)
      const newGrid = buildGrid(stripArr, newPositions)
      const lines = findWinningLines(newGrid, pays)
      const payout = toMoney(lines.reduce((s, l) => s + l.pay, 0) * fee * cfg.payScale)

      const stmts = []
      if (payout > 0) {
        const { stmts: payStmts, balance } = await ledgerStmts(DB, {
          username, currency: 'coin', delta: payout, reason: 'slot_nudge_win',
          refType: 'slot', refId: `nudge:${spinId}`,
          assetLog: { action: 'balance', title: 'Nudge 摇中', detail: `+${payout}` },
        })
        stmts.push(...payStmts)
      }

      stmts.push(DB.prepare('UPDATE slot_spins SET nudged = 1 WHERE id = ?').bind(spinId))
      stmts.push(DB.prepare(
        "INSERT INTO slot_pending (username, spin_id, type, payload, status, choice, result) VALUES (?, ?, 'nudge', ?, 'resolved', ?, ?)"
      ).bind(username, spinId,
        JSON.stringify({ gridBefore: JSON.parse(spin.grid), gridAfter: newGrid, reel: reelIdx, dir }),
        JSON.stringify(dir), JSON.stringify({ lines, payout })))
      stmts.push(DB.prepare(
        "UPDATE slot_state SET nudge_left = ?, nudge_date = ?, updated_at = datetime('now') WHERE username = ?"
      ).bind(left - 1, dailyUpdates.nudge_date || state.nudge_date, username))

      const response = {
        action: 'slot_nudge', spinId, reel: reelIdx, dir,
        gridAfter: newGrid, lines, payout,
        nudgeLeft: left - 1,
      }
      return { response, stmts }
    }
  )
}

// ---------- T3.4 追猴翻牌揭示（预生成，只揭示不重 roll） ----------
export function monkeyOp(DB, { username, pendingId, choice, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'slot_monkey', username },
    async () => {
      const p = await DB.prepare(
        "SELECT * FROM slot_pending WHERE id = ? AND username = ? AND type = 'monkey'"
      ).bind(pendingId, username).first()
      if (!p) throw new KernelError('NOT_FOUND', '追猴小剧场不存在', 404)
      if (p.status !== 'pending') {
        return { response: JSON.parse(p.result || '{}'), stmts: [] }
      }
      const idx = toInt(choice, -1, 0, 2)
      if (idx < 0) throw new KernelError('INVALID_PARAM', '请选择一张牌')
      const { cards } = JSON.parse(p.payload)
      const won = cards[idx].coins

      const stmts = []
      let balanceAfter = null
      if (won > 0) {
        const { stmts: payStmts, balance } = await ledgerStmts(DB, {
          username, currency: 'coin', delta: won, reason: 'slot_monkey',
          refType: 'slot', refId: `monkey:${pendingId}`,
          assetLog: { action: 'balance', title: '追猴小剧场', detail: `+${won}` },
        })
        stmts.push(...payStmts)
        balanceAfter = balance
      }
      stmts.push(DB.prepare(
        "UPDATE slot_pending SET status = 'resolved', choice = ?, result = ? WHERE id = ? AND status = 'pending'"
      ).bind(JSON.stringify(idx), JSON.stringify({ action: 'slot_monkey', chosen: idx, coins: won, cards }), pendingId))

      const response = { action: 'slot_monkey', chosen: idx, coins: won, cards, balance: balanceAfter }
      return { response, stmts }
    }
  )
}

// ---------- T3.6 幸运转轮揭示（预生成，只揭示不重 roll） ----------
export function wheelOp(DB, { username, pendingId, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'slot_wheel', username },
    async () => {
      const p = await DB.prepare(
        "SELECT * FROM slot_pending WHERE id = ? AND username = ? AND type = 'wheel'"
      ).bind(pendingId, username).first()
      if (!p) throw new KernelError('NOT_FOUND', '幸运转轮不存在', 404)
      if (p.status !== 'pending') {
        return { response: JSON.parse(p.result || '{}'), stmts: [] }
      }
      const payload = JSON.parse(p.payload)
      const sector = payload.sectors[payload.index]
      const value = payload.resolvedValue ?? sector.value ?? 0

      const stmts = []
      let extra = {}
      if (sector.type === 'coin') {
        const { stmts: payStmts, balance } = await ledgerStmts(DB, {
          username, currency: 'coin', delta: value, reason: 'slot_wheel',
          refType: 'slot', refId: `wheel:${pendingId}`,
          assetLog: { action: 'balance', title: '幸运转轮', detail: `+${value}` },
        })
        stmts.push(...payStmts)
        extra = { balance }
      } else if (sector.type === 'reward') {
        // 现实奖励·中额：入奖励背包（G8：仅游戏产出）
        const tpl = await DB.prepare(
          'SELECT id FROM reward_templates WHERE is_active = 1 AND value <= ? ORDER BY value DESC LIMIT 1'
        ).bind(value || 50).first()
        if (tpl) {
          const { stmts: rs } = await grantRewardStmts(DB, { username, rewardId: tpl.id, quantity: 1, source: 'slot_wheel' })
          stmts.push(...rs)
        }
      } else if (sector.type === 'fragment') {
        const recipe = await DB.prepare(
          `SELECT r.id FROM fragment_recipes r
           LEFT JOIN item_templates i ON r.target_type = 'item' AND i.id = r.target_id
           WHERE r.is_active = 1 AND r.target_type = 'item' AND i.rarity = ?
           ORDER BY r.id LIMIT 1`
        ).bind(sector.rarity || 3).first()
        if (recipe) {
          const { stmts: fs } = await grantFragmentStmts(DB, { username, recipeId: recipe.id, quantity: 1 })
          stmts.push(...fs)
        }
      } else if (sector.type === 'fever') {
        // Fever 槽 +N 格（T3.6 转轮奖励）；满则触发 8 连转
        const cfg = await getSlotConfig(DB)
        const state = await getOrCreateState(DB, username)
        if (!state.fever_active) {
          let slot = state.fever_slot + (value || 5)
          if (slot >= cfg.fever.slotMax) {
            stmts.push(DB.prepare(
              "UPDATE slot_state SET fever_slot = 0, fever_active = 1, fever_left = ?, fever_mult_idx = 0, updated_at = datetime('now') WHERE username = ?"
            ).bind(cfg.fever.spins, username))
            extra = { feverTriggered: true }
          } else {
            stmts.push(DB.prepare(
              "UPDATE slot_state SET fever_slot = ?, updated_at = datetime('now') WHERE username = ?"
            ).bind(slot, username))
            extra = { feverSlot: slot }
          }
        }
      } else if (sector.type === 'nudge') {
        // Nudge×2：当日额度 +2
        const state = await getOrCreateState(DB, username)
        const { today } = rollDailyReset(state, await getSlotConfig(DB))
        stmts.push(DB.prepare(
          "UPDATE slot_state SET nudge_date = ?, nudge_left = nudge_left + ?, updated_at = datetime('now') WHERE username = ?"
        ).bind(today, value || 2, username))
        extra = { nudgeAdded: value || 2 }
      }

      stmts.push(DB.prepare(
        "UPDATE slot_pending SET status = 'resolved', choice = ?, result = ? WHERE id = ? AND status = 'pending'"
      ).bind(JSON.stringify(payload.index), JSON.stringify({ action: 'slot_wheel', sector, value, ...extra }), pendingId))

      const response = { action: 'slot_wheel', index: payload.index, sector, value, ...extra }
      return { response, stmts }
    }
  )
}

// ---------- 状态与回放 ----------
export async function getSlotState(DB, username) {
  const cfg = await getSlotConfig(DB)
  const state = await getOrCreateState(DB, username)
  rollDailyReset(state, cfg)
  // 公示（G4/G17）：权重、赔率（含 payScale 换算后）、转轮概率；不公开符号带
  const fee = toMoney(await getParam(DB, 'play_cost_coin', '10'))
  const u = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()
  const last = state.last_spin_id
    ? await DB.prepare(
        'SELECT id, seed, free_type, fee, grid, steps, total_payout, fragments, monkey, wheel, jackpot_hit, created_at FROM slot_spins WHERE id = ? AND username = ?'
      ).bind(state.last_spin_id, username).first()
    : null
  const pendings = await DB.prepare(
    "SELECT id, spin_id, type, payload FROM slot_pending WHERE username = ? AND status = 'pending' ORDER BY id DESC LIMIT 5"
  ).bind(username).all()
  return {
    config: {
      weights: cfg.weights, pays: cfg.pays, payScale: cfg.payScale, wheel: cfg.wheel,
      fragment: cfg.fragment, fever: cfg.fever, holdProb: cfg.holdProb,
      nudgeDaily: cfg.nudgeDaily, freeDaily: cfg.freeDaily, pity: cfg.pity,
    },
    fee,
    state: {
      feverSlot: state.fever_slot, feverActive: !!state.fever_active, feverLeft: state.fever_left,
      freeLeft: state.free_date === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
        ? state.free_left : cfg.freeDaily,
      nudgeLeft: state.nudge_date === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
        ? state.nudge_left : cfg.nudgeDaily,
      noWinStreak: state.no_win_streak,
      holdActive: !!state.hold_active,
    },
    balance: u ? u.balance : 0,
    lastSpin: last,
    // 预生成待揭示交互：不泄露揭示结果（牌面值/落点扇区）
    pendingInteractions: (pendings.results || []).map(p => {
      const payload = JSON.parse(p.payload)
      if (p.type === 'monkey') return { id: p.id, spinId: p.spin_id, type: p.type, cardCount: payload.cards.length }
      if (p.type === 'wheel') return { id: p.id, spinId: p.spin_id, type: p.type, sectorCount: payload.sectors.length }
      return { id: p.id, spinId: p.spin_id, type: p.type, payload }
    }),
  }
}
