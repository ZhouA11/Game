// 互通内核 · 公共工具与错误码
// 统一响应包（§5）：{ ok, data } 或 { ok:false, code, msg }

export class KernelError extends Error {
  /**
   * @param {string} code 错误码（见 §5 API 与错误码约定）
   * @param {string} msg 中文提示（用户可见文案用简体中文）
   * @param {number} status HTTP 状态码
   */
  constructor(code, msg, status = 400) {
    super(msg)
    this.code = code
    this.status = status
  }
}

const RESP_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
}

export function okResponse(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: RESP_HEADERS,
  })
}

export function errorResponse(error) {
  const isKernel = error instanceof KernelError
  const code = isKernel ? error.code : 'INTERNAL'
  const msg = isKernel ? error.message : (error?.message || '服务器内部错误')
  const status = isKernel ? error.status : 500
  return new Response(JSON.stringify({ ok: false, code, msg }), {
    status,
    headers: RESP_HEADERS,
  })
}

export async function readJson(request) {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? body : {}
  } catch (e) {
    return {}
  }
}

// 幂等键：优先 Header，其次 body（G2 所有写接口要求 idempotency_key）
export function extractIdempotencyKey(request, body) {
  return request.headers.get('Idempotency-Key') || body?.idempotency_key || null
}

// 取整数（带范围钳制）
export function toInt(v, fallback = 0, min = null, max = null) {
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return fallback
  if (min !== null && n < min) return min
  if (max !== null && n > max) return max
  return n
}

// 取数值（货币等），保留两位小数
export function toMoney(v, fallback = 0) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.round(n * 100) / 100
}

// 稀有度合法值
export function isValidRarity(r) {
  return Number.isInteger(r) && r >= 1 && r <= 4
}
