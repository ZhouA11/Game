// 互通内核 · 统一账本（G5/G12/G15）
// 资产仅两种：coin=金币（users.balance，沿用旧字段，不丢用户数据）、activity=活跃值（users.activity）
// 任何模块不得绕过本模块改 users.balance / users.activity

import { KernelError, toMoney } from './util.js'

export const CURRENCIES = ['coin', 'activity']

function currencyName(currency) {
  return currency === 'coin' ? '金币' : '活跃值'
}

function assertCurrency(currency) {
  if (!CURRENCIES.includes(currency)) {
    throw new KernelError('INVALID_PARAM', '货币类型不正确')
  }
}

/**
 * 构造资产变动语句（供调用方并入同一 batch 事务）。
 * 扣款语句带余额守卫：余额不足时 update/流水/前端日志三语句同为 no-op，状态保持一致。
 *
 * @returns {Promise<{stmts: object[], balance: number, delta: number}>}
 */
export async function ledgerStmts(DB, opts) {
  const {
    username, currency, delta,
    reason, refType = '', refId = '', idempotencyKey = null,
    createdBy = 'system', allowNegative = false, assetLog = null,
  } = opts
  assertCurrency(currency)
  const d = toMoney(delta)
  if (d === 0) throw new KernelError('INVALID_PARAM', '资产变动量不能为0')

  const col = currency === 'coin' ? 'balance' : 'activity'
  const user = await DB.prepare(`SELECT username, ${col} AS cur FROM users WHERE username = ?`)
    .bind(username).first()
  if (!user) throw new KernelError('USER_NOT_FOUND', '用户不存在')

  const cur = Number(user.cur) || 0
  const after = Math.round((cur + d) * 100) / 100
  if (after < 0 && !allowNegative) {
    throw new KernelError('INSUFFICIENT_BALANCE', `${currencyName(currency)}不足`)
  }

  const stmts = []
  if (d > 0) {
    stmts.push(DB.prepare(
      `UPDATE users SET ${col} = ${col} + ?, updated_at = datetime('now') WHERE username = ?`
    ).bind(d, username))
    stmts.push(DB.prepare(
      'INSERT INTO ledger_entries (username, currency, delta, balance_after, reason, ref_type, ref_id, idempotency_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, currency, d, after, reason, refType, String(refId), idempotencyKey, createdBy))
  } else {
    // 扣款：三语句共用余额守卫，任一未生效则全部 no-op
    const amount = -d
    stmts.push(DB.prepare(
      `UPDATE users SET ${col} = ${col} - ?, updated_at = datetime('now') WHERE username = ? AND ${col} >= ?`
    ).bind(amount, username, amount))
    stmts.push(DB.prepare(
      `INSERT INTO ledger_entries (username, currency, delta, balance_after, reason, ref_type, ref_id, idempotency_key, created_by)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE username = ? AND ${col} >= ?)`
    ).bind(username, currency, d, after, reason, refType, String(refId), idempotencyKey, createdBy, username, amount))
  }
  if (assetLog) {
    if (d < 0 && !allowNegative) {
      stmts.push(DB.prepare(
        `INSERT INTO asset_logs (username, action, title, detail)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE username = ? AND ${col} >= ?)`
      ).bind(username, assetLog.action, assetLog.title, assetLog.detail || '', username, -d))
    } else {
      stmts.push(DB.prepare(
        'INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)'
      ).bind(username, assetLog.action, assetLog.title, assetLog.detail || ''))
    }
  }

  return { stmts, balance: after, delta: d }
}

/**
 * 校验 batch 执行结果：扣款守卫未生效时抛出（此时整批已一致地 no-op）。
 * @param {object[]} batchResults DB.batch 的返回值
 * @param {number} ledgerStmtIndex ledger 插入语句在 batch 中的下标
 */
export function assertLedgerApplied(batchResults, ledgerStmtIndex) {
  const r = batchResults[ledgerStmtIndex]
  if (!r || !r.meta || r.meta.changes === 0) {
    throw new KernelError('INSUFFICIENT_BALANCE', '余额不足，变动未生效')
  }
}

/**
 * 独立执行一次资产变动（自带事务）。
 */
export async function applyLedger(DB, opts) {
  const { stmts, balance, delta } = await ledgerStmts(DB, opts)
  const results = await DB.batch(stmts)
  // 流水插入语句下标：d<0 且有 assetLog 时为 1（assetLog 在 2），否则为 1
  const ledgerIndex = delta < 0 && !opts.allowNegative ? 1 : 1
  if (delta < 0 && !opts.allowNegative) {
    assertLedgerApplied(results, ledgerIndex)
  }
  return { currency: opts.currency, delta, balance }
}

/**
 * 统一流水查询（游标分页，§5 玩家端）
 */
export async function listLedger(DB, username, { cursor = 0, limit = 20 } = {}) {
  const lim = Math.max(1, Math.min(100, limit))
  const rows = cursor > 0
    ? await DB.prepare(
        'SELECT id, currency, delta, balance_after, reason, ref_type, ref_id, created_at FROM ledger_entries WHERE username = ? AND id < ? ORDER BY id DESC LIMIT ?'
      ).bind(username, cursor, lim + 1).all()
    : await DB.prepare(
        'SELECT id, currency, delta, balance_after, reason, ref_type, ref_id, created_at FROM ledger_entries WHERE username = ? ORDER BY id DESC LIMIT ?'
      ).bind(username, lim + 1).all()
  const list = rows.results || []
  const hasMore = list.length > lim
  const page = hasMore ? list.slice(0, lim) : list
  return { list: page, nextCursor: hasMore ? page[page.length - 1].id : null }
}
