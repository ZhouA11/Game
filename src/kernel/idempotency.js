// 互通内核 · 幂等包装（G2：所有写接口要求 idempotency_key，重复提交返回首次结果）

/**
 * 幂等写操作执行器。
 * build() 负责读校验并返回 { response, stmts }；幂等记录与业务语句同 batch 提交，
 * 任一语句失败整体回滚（D1 batch 为原子事务）。
 *
 * @param {object} DB D1 绑定
 * @param {{key: string|null, endpoint: string, username: string}} meta
 * @param {() => Promise<{response: object, stmts: object[]}>} build
 * @returns {Promise<object>} response（重放时附带 replayed: true）
 */
export async function kernelWrite(DB, meta, build) {
  const { key, endpoint = '', username = '' } = meta
  if (key) {
    const prev = await DB.prepare(
      'SELECT response FROM idempotency_records WHERE idempotency_key = ?'
    ).bind(key).first()
    if (prev) {
      let first = {}
      try { first = JSON.parse(prev.response) || {} } catch (e) {}
      return { ...first, replayed: true }
    }
  }

  const { response, stmts } = await build()

  if (key) {
    stmts.push(DB.prepare(
      'INSERT INTO idempotency_records (idempotency_key, endpoint, username, response) VALUES (?, ?, ?, ?)'
    ).bind(key, endpoint, username, JSON.stringify(response)))
  }

  await DB.batch(stmts)
  return response
}
