// 小游戏路由（步骤2：抓娃娃；步骤3：老虎机；步骤4：单人彩池 将陆续挂载于此）
// 路径：/api/grab/*（抓娃娃），path 为解码后的路径段数组（不含 /api）

import { KernelError, okResponse, errorResponse, readJson, extractIdempotencyKey, toInt } from '../kernel/util.js'
import { requireAuth, requireAdmin } from '../kernel/auth.js'
import {
  ensureGrabSchemaOnce, getMachineState, clawOp, rerollOp, revealOp, getGrabConfig,
} from './grab.js'
import {
  ensureSlotSchemaOnce, getSlotState, spinOp, nudgeOp, monkeyOp, wheelOp,
} from './slot.js'
import {
  ensureShopSchemaOnce, listShopProducts, buyProductOp, createProductOp, updateProductOp,
} from './shop.js'

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
  if (path[0] === 'slot') {
    await ensureSlotSchemaOnce(DB)
    try {
      return await handleSlot(request, DB, path.slice(1))
    } catch (error) {
      if (error instanceof KernelError) return errorResponse(error)
      throw error
    }
  }
  if (path[0] === 'mall') {
    await ensureShopSchemaOnce(DB)
    try {
      return await handleMall(request, DB, path.slice(1))
    } catch (error) {
      if (error instanceof KernelError) return errorResponse(error)
      throw error
    }
  }
  return null
}

// ---------------- 商店（步骤5：只卖道具） ----------------
async function handleMall(request, DB, path) {
  const method = request.method

  // 管理端（上架/改价；步骤6接UI）
  if (path[0] === 'admin' && path[1] === 'products') {
    const admin = await requireAdmin(request, DB)
    if (method === 'POST') {
      const body = await readJson(request)
      return okResponse(await createProductOp(DB, body, admin.username))
    }
    if (path[2] && method === 'PUT') {
      const body = await readJson(request)
      return okResponse(await updateProductOp(DB, toInt(path[2], 0, 1, 1e12), body, admin.username))
    }
  }

  const auth = await requireAuth(request, DB)

  // 商品列表（玩家端）
  if (path[0] === 'products' && method === 'GET') {
    return okResponse({ products: await listShopProducts(DB) })
  }
  // 购买（幂等）
  if (path[0] === 'buy' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await buyProductOp(DB, {
      username: auth.username,
      productId: toInt(body.product_id, 0, 1, 1e12),
      idempotencyKey: key,
    }))
  }

  throw new KernelError('NOT_FOUND', '接口不存在', 404)
}

// ---------------- 老虎机（步骤3） ----------------
async function handleSlot(request, DB, path) {
  const method = request.method
  const auth = await requireAuth(request, DB)

  // 状态 + 公示（G4/G17）+ 最近一spin（断线恢复）
  if (path[0] === 'state' && method === 'GET') {
    return okResponse(await getSlotState(DB, auth.username))
  }
  if (path[0] === 'last' && method === 'GET') {
    const st = await getSlotState(DB, auth.username)
    return okResponse({ lastSpin: st.lastSpin, pendingInteractions: st.pendingInteractions })
  }

  // 转动（T3.11 全模拟）
  if (path[0] === 'spin' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await spinOp(DB, {
      username: auth.username,
      holdReel: body.hold_reel !== undefined && body.hold_reel !== null ? toInt(body.hold_reel, -1, 0, 4) : null,
      idempotencyKey: key,
    }))
  }

  // T3.8 Nudge 摇一格
  if (path[0] === 'nudge' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await nudgeOp(DB, {
      username: auth.username,
      spinId: toInt(body.spin_id, 0, 1, 1e12),
      reel: toInt(body.reel, -1, 0, 4),
      dir: body.dir,
      idempotencyKey: key,
    }))
  }

  // T3.4 追猴翻牌揭示
  if (path[0] === 'monkey' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await monkeyOp(DB, {
      username: auth.username,
      pendingId: toInt(body.pending_id, 0, 1, 1e12),
      choice: body.choice,
      idempotencyKey: key,
    }))
  }

  // T3.6 幸运转轮揭示
  if (path[0] === 'wheel' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    return okResponse(await wheelOp(DB, {
      username: auth.username,
      pendingId: toInt(body.pending_id, 0, 1, 1e12),
      idempotencyKey: key,
    }))
  }

  throw new KernelError('NOT_FOUND', '接口不存在', 404)
}
