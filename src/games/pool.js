// 步骤4 · 单人彩池（G18：彩池按玩家独立持久化，绝不全局共享）
// 入池：每次付费 spin 按费用比例（pool_rate%）划转入池；
// 出奖：Jackpot 5 连时池额全额归该玩家，随后重置回种子值（pool_seed）；
// 幂等：pool_ledger.idempotency_key 唯一约束防重复入池/出奖；
// 对账：任意时刻 Σpool_ledger.delta = pool_state.amount

import { KernelError, toMoney } from '../kernel/util.js'
import { getParam } from '../kernel/templates.js'

export async function getPoolParams(DB) {
  const [rate, seed] = await Promise.all([
    getParam(DB, 'pool_rate', '5'),
    getParam(DB, 'pool_seed', '5000'),
  ])
  return { rate: Number(rate) || 0, seed: toMoney(seed) || 0 }
}

// 读取（并按需初始化）玩家彩池；种子入账使 Σdelta = amount 恒成立
export async function getOrCreatePool(DB, username) {
  const { seed } = await getPoolParams(DB)
  const row = await DB.prepare('SELECT * FROM pool_state WHERE username = ?').bind(username).first()
  if (row) return row
  const r = await DB.prepare(
    'INSERT OR IGNORE INTO pool_state (username, amount) VALUES (?, ?)'
  ).bind(username, seed).run()
  if (r.meta.changes > 0) {
    await DB.prepare(
      "INSERT INTO pool_ledger (username, delta, balance_after, reason, ref, idempotency_key) VALUES (?, ?, ?, 'seed', 'init', ?)"
    ).bind(username, seed, seed, `pool-seed:${username}`).run()
  }
  return await DB.prepare('SELECT * FROM pool_state WHERE username = ?').bind(username).first()
}

/**
 * 入池语句构造器（供 spin 结算 batch 并入；唯一键防重复入池）
 */
export async function poolDepositStmts(DB, { username, amount, ref }) {
  const amt = toMoney(amount)
  if (amt <= 0) return { stmts: [], amount: 0 }
  await getOrCreatePool(DB, username)
  const row = await DB.prepare('SELECT amount FROM pool_state WHERE username = ?').bind(username).first()
  const after = Math.round((Number(row.amount) + amt) * 100) / 100
  const stmts = [
    DB.prepare('UPDATE pool_state SET amount = ?, updated_at = datetime(\'now\') WHERE username = ?').bind(after, username),
    DB.prepare(
      'INSERT INTO pool_ledger (username, delta, balance_after, reason, ref, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(username, amt, after, 'deposit', ref, `pool-deposit:${ref}`),
  ]
  return { stmts, amount: amt, after }
}

/**
 * 出奖语句构造器（Jackpot 5 连：池额全额发放 + 重置种子；唯一键防重复出奖）
 * baseAfter：同 batch 内入池后的池额（避免 build 阶段读到入池前的旧值）；缺省读库
 * 返回 stmts 供 spin 结算 batch 并入；payout = 当前池额（不重 roll，全额发放）
 */
export async function poolPayoutStmts(DB, { username, spinId, baseAfter = null }) {
  const { seed } = await getPoolParams(DB)
  await getOrCreatePool(DB, username)
  let payout
  if (baseAfter !== null && baseAfter !== undefined) {
    payout = toMoney(baseAfter)
  } else {
    const row = await DB.prepare('SELECT amount FROM pool_state WHERE username = ?').bind(username).first()
    payout = toMoney(row.amount)
  }
  if (payout <= 0) return { stmts: [], payout: 0 }

  const stmts = [
    // 出池 + 重置种子
    DB.prepare("UPDATE pool_state SET amount = ?, last_payout = ?, last_payout_spin = ?, updated_at = datetime('now') WHERE username = ?")
      .bind(seed, payout, spinId, username),
    DB.prepare(
      'INSERT INTO pool_ledger (username, delta, balance_after, reason, ref, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(username, -payout, seed, 'payout', `spin:${spinId}`, `pool-payout:${username}:${spinId}`),
    DB.prepare(
      'INSERT INTO pool_ledger (username, delta, balance_after, reason, ref, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(username, seed, seed, 'reseed', `spin:${spinId}`, `pool-reseed:${username}:${spinId}`),
  ]
  return { stmts, payout }
}

// 彩池公示（T4.7：机台与大厅对该玩家实时展示）
export async function getPoolView(DB, username) {
  const { rate, seed } = await getPoolParams(DB)
  const pool = await getOrCreatePool(DB, username)
  return {
    amount: pool.amount,
    seed,
    rate,
    lastPayout: pool.last_payout,
    lastPayoutSpin: pool.last_payout_spin,
  }
}
