// 互通内核 · 鉴权（从 src/index.js 迁移为共享模块，供旧路由与内核路由共用）

import { KernelError } from './util.js'

export async function hashPassword(password) {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// 校验 Bearer token，返回 { username, role }；失败抛 KernelError
export async function requireAuth(request, DB) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) throw new KernelError('UNAUTHORIZED', '未授权', 401)

  const tokenData = await DB.prepare(
    'SELECT username, expires_at FROM tokens WHERE token = ?'
  ).bind(token).first()

  if (!tokenData || tokenData.expires_at < Date.now()) {
    throw new KernelError('UNAUTHORIZED', '无效的token', 401)
  }

  const user = await DB.prepare('SELECT username, role FROM users WHERE username = ?')
    .bind(tokenData.username).first()
  if (!user) throw new KernelError('UNAUTHORIZED', '用户不存在', 401)

  return { username: user.username, role: user.role }
}

// 要求管理员角色
export async function requireAdmin(request, DB) {
  const auth = await requireAuth(request, DB)
  if (auth.role !== 'admin') {
    throw new KernelError('FORBIDDEN', '仅管理员可操作', 403)
  }
  return auth
}
