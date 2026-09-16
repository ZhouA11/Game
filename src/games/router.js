// 小游戏路由（步骤2：抓娃娃；步骤3：老虎机；步骤4：单人彩池 将陆续挂载于此）
// 路径：/api/grab/*（抓娃娃），path 为解码后的路径段数组（不含 /api）

import { KernelError, okResponse, errorResponse, readJson, extractIdempotencyKey, toInt } from '../kernel/util.js'
import { requireAuth } from '../kernel/auth.js'
import {
  ensureGrabSchemaOnce, getMachineState, clawOp, rerollOp, revealOp, getGrabConfig,
} from './grab.js'

function requireIdempotencyKey(request, body) {
  const key = extractIdempotencyKey(request, body)
  if (!key) throw new KernelError('IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键 idempotency_key')
  return key
}

async function handleGrab(request, DB, path) {
  const method = request.method

  // G4 概率公示（公开）
  if (path[0] === 'config' && method === 'GET') {
    return okResponse(await getGrabConfig(DB))
  }

  const auth = await requireAuth(request, DB)

  // 机器布局与可及集合查询
  if (path[0] === 'state' && method === 'GET') {
    return okResponse(await getMachineState(DB, auth.username))
  }

  // 下爪
  if (path[0] === 'claw' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await clawOp(DB, {
      username: auth.username,
      dollId: toInt(body.doll_id, 0, 1, 1e12),
      idempotencyKey: key,
    }))
  }

  // 重铺机位（mode: coin 金币 / coupon 换机券；机内抓空时自动免费）
  if (path[0] === 'reroll' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await rerollOp(DB, {
      username: auth.username,
      mode: body.mode === 'coupon' ? 'coupon' : 'coin',
      idempotencyKey: key,
    }))
  }

  // 透视镜（手动使用，模糊文案）
  if (path[0] === 'reveal' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await revealOp(DB, {
      username: auth.username,
      dollId: toInt(body.doll_id, 0, 1, 1e12),
      idempotencyKey: key,
    }))
  }

  throw new KernelError('NOT_FOUND', '接口不存在', 404)
}

// 游戏入口：返回 null 表示不归游戏路由处理
export async function handleGamesRequest(request, DB, path) {
  if (path[0] === 'grab') {
    await ensureGrabSchemaOnce(DB)
    try {
      return await handleGrab(request, DB, path.slice(1))
    } catch (error) {
      if (error instanceof KernelError) return errorResponse(error)
      throw error
    }
  }
  return null
}
