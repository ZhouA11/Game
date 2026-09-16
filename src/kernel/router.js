// 互通内核 · 路由（§5 API 约定）
// 玩家端：/api/kernel/*
// 运营端：/api/admin/kernel/*
// 概率公示（公开）：/api/kernel/public/config

import { KernelError, okResponse, errorResponse, readJson, extractIdempotencyKey, toInt } from './util.js'
import { requireAuth, requireAdmin } from './auth.js'
import { ensureKernelSchemaOnce } from './schema.js'
import { listLedger } from './ledger.js'
import { reduceSpankOp, listSpanks, listReducibleTargets } from './spank.js'
import { resolveEvent, setAutoMount, MOUNT_EVENTS, ITEM_ACTIONS } from './resolver.js'
import { listRewardBag, redeemRewardOp } from './backpack.js'
import { synthesizeFragmentOp, listFragments } from './fragments.js'
import {
  listRarity, updateRarity, listParams, updateParams, auditStmt,
  createTemplate, updateTemplate, disableTemplate, deleteTemplate, listTemplates,
} from './templates.js'
import {
  listDropPools, createDropEntry, updateDropEntry, deleteDropEntry,
  getSideControls, setSideControls, rollDrop, grantDropStmts,
} from './drops.js'
import {
  createAdjustmentOp, approveAdjustment, rejectAdjustment, listAdjustments,
} from './adjust.js'

function requireIdempotencyKey(request, body) {
  const key = extractIdempotencyKey(request, body)
  if (!key) throw new KernelError('IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键 idempotency_key')
  return key
}

// ---------------- 玩家端 ----------------
async function handlePlayerKernel(request, DB, path) {
  const method = request.method

  // 公示（G4）：当期掉落池与总控概率、稀有度参数（公开可读）
  if (path[0] === 'public' && path[1] === 'config' && method === 'GET') {
    const game = new URL(request.url).searchParams.get('game') || ''
    const option = new URL(request.url).searchParams.get('option') || 'default'
    const pools = await listDropPools(DB, game || null)
    const controls = game ? await getSideControls(DB, game, option) : null
    const rarity = await listRarity(DB)
    return okResponse({ game, option, pools, controls, rarity, mountEvents: MOUNT_EVENTS, itemActions: ITEM_ACTIONS })
  }

  const auth = await requireAuth(request, DB)
  const username = auth.username

  // 资产总览（个人面板四区之首）
  if (path[0] === 'me' && path[1] === 'overview' && method === 'GET') {
    const u = await DB.prepare('SELECT balance, activity FROM users WHERE username = ?').bind(username).first()
    const frag = await DB.prepare(
      'SELECT COALESCE(SUM(count), 0) AS c FROM player_fragments WHERE username = ?'
    ).bind(username).first()
    const items = await DB.prepare(
      'SELECT COALESCE(SUM(count), 0) AS c FROM player_items WHERE username = ?'
    ).bind(username).first()
    return okResponse({
      balance: u ? u.balance : 0,
      activity: u ? u.activity : 0,
      fragmentCount: frag?.c || 0,
      itemCount: items?.c || 0,
    })
  }

  // 道具库存 + 自动挂载开关
  if (path[0] === 'me' && path[1] === 'inventory' && method === 'GET') {
    const rows = await DB.prepare(
      `SELECT p.item_id, p.count, p.auto_mount, t.name, t.rarity, t.category, t.action,
              t.action_value, t.scope, t.auto_mount AS default_auto, t.description, t.image
       FROM player_items p JOIN item_templates t ON t.id = p.item_id
       WHERE p.username = ? AND p.count > 0
       ORDER BY t.category, t.id`
    ).bind(username).all()
    return okResponse({ items: rows.results || [] })
  }
  if (path[0] === 'me' && path[1] === 'inventory' && path[3] === 'mount' && method === 'PUT') {
    const body = await readJson(request)
    const mode = ['default', 'on', 'off'].includes(body.mode) ? body.mode : 'default'
    const result = await setAutoMount(DB, username, toInt(path[2], 0, 1, 1e12), mode)
    return okResponse(result)
  }

  // Spank 面板 / 减免
  if (path[0] === 'me' && path[1] === 'spanks' && method === 'GET') {
    return okResponse(await listSpanks(DB, username))
  }
  if (path[0] === 'me' && path[1] === 'reducible-targets' && method === 'GET') {
    const couponItemId = toInt(new URL(request.url).searchParams.get('coupon_item_id'), 0, 1, 1e12)
    return okResponse(await listReducibleTargets(DB, username, couponItemId))
  }
  if (path[0] === 'me' && path[1] === 'reduce-spank' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    const result = await reduceSpankOp(DB, {
      username,
      couponItemId: toInt(body.coupon_item_id, 0, 1, 1e12),
      targetPenaltyId: toInt(body.target_penalty_id, 0, 1, 1e12),
      idempotencyKey: key,
    })
    return okResponse(result)
  }

  // 奖励背包 / 核销
  if (path[0] === 'me' && path[1] === 'reward-bag' && method === 'GET') {
    return okResponse({ bag: await listRewardBag(DB, username) })
  }
  if (path[0] === 'me' && path[1] === 'reward-bag' && path[3] === 'redeem' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    const result = await redeemRewardOp(DB, {
      username, rewardId: toInt(path[2], 0, 1, 1e12), idempotencyKey: key,
    })
    return okResponse(result)
  }

  // 碎片 / 合成
  if (path[0] === 'me' && path[1] === 'fragments' && method === 'GET') {
    return okResponse({ fragments: await listFragments(DB, username) })
  }
  if (path[0] === 'me' && path[1] === 'fragments' && path[2] === 'synthesize' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    const result = await synthesizeFragmentOp(DB, {
      username, recipeId: toInt(body.recipe_id, 0, 1, 1e12), idempotencyKey: key,
    })
    return okResponse(result)
  }

  // 统一流水（游标分页）
  if (path[0] === 'me' && path[1] === 'ledger' && method === 'GET') {
    const sp = new URL(request.url).searchParams
    const cursor = toInt(sp.get('cursor'), 0, 0, 1e15)
    const limit = toInt(sp.get('limit'), 20, 1, 100)
    return okResponse(await listLedger(DB, username, { cursor, limit }))
  }

  throw new KernelError('NOT_FOUND', '接口不存在', 404)
}

// ---------------- 运营端 ----------------
async function handleAdminKernel(request, DB, path) {
  const method = request.method
  const admin = await requireAdmin(request, DB)

  // 稀有度主轴
  if (path[0] === 'rarity' && method === 'GET') {
    return okResponse({ rarity: await listRarity(DB) })
  }
  if (path[0] === 'rarity' && path[1] && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(request)
    return okResponse(await updateRarity(DB, toInt(path[1], 0, 1, 4), body, admin.username))
  }

  // 全局参数
  if (path[0] === 'params' && method === 'GET') {
    return okResponse({ params: await listParams(DB) })
  }
  if (path[0] === 'params' && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(request)
    return okResponse({ params: await updateParams(DB, body, admin.username) })
  }

  // 三类模板库
  if (path[0] === 'templates' && path[1]) {
    const kind = path[1]
    if (!path[2] && method === 'GET') {
      return okResponse({ templates: await listTemplates(DB, kind) })
    }
    if (!path[2] && method === 'POST') {
      const body = await readJson(request)
      return okResponse(await createTemplate(DB, kind, body, admin.username))
    }
    if (path[2] && method === 'PUT') {
      const body = await readJson(request)
      return okResponse(await updateTemplate(DB, kind, toInt(path[2], 0, 1, 1e12), body, admin.username))
    }
    if (path[2] && path[3] === 'disable' && (method === 'POST' || method === 'PUT')) {
      return okResponse(await disableTemplate(DB, kind, toInt(path[2], 0, 1, 1e12), admin.username))
    }
    if (path[2] && method === 'DELETE') {
      return okResponse(await deleteTemplate(DB, kind, toInt(path[2], 0, 1, 1e12), admin.username))
    }
  }

  // 掉落池
  if (path[0] === 'drop-pools' && method === 'GET') {
    const game = new URL(request.url).searchParams.get('game')
    return okResponse({ pools: await listDropPools(DB, game) })
  }
  if (path[0] === 'drop-pools' && method === 'POST') {
    const body = await readJson(request)
    return okResponse(await createDropEntry(DB, body, admin.username))
  }
  if (path[0] === 'drop-pools' && path[1] && method === 'PUT') {
    const body = await readJson(request)
    return okResponse(await updateDropEntry(DB, toInt(path[1], 0, 1, 1e12), body, admin.username))
  }
  if (path[0] === 'drop-pools' && path[1] && method === 'DELETE') {
    return okResponse(await deleteDropEntry(DB, toInt(path[1], 0, 1, 1e12), admin.username))
  }

  // 总控概率
  if (path[0] === 'drop-controls' && method === 'GET') {
    const sp = new URL(request.url).searchParams
    const game = sp.get('game') || ''
    const option = sp.get('option') || 'default'
    if (!game) throw new KernelError('INVALID_PARAM', '缺少 game 参数')
    return okResponse(await getSideControls(DB, game, option))
  }
  if (path[0] === 'drop-controls' && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(request)
    if (!body.game) throw new KernelError('INVALID_PARAM', '缺少 game 参数')
    return okResponse(await setSideControls(
      DB, String(body.game), String(body.option || 'default'),
      body.reward_side_prob, body.penalty_side_prob, admin.username
    ))
  }

  // 碎片配方
  if (path[0] === 'fragment-recipes' && method === 'GET') {
    const rows = await DB.prepare(
      `SELECT r.*, COALESCE(i.name, rw.name, '') AS target_name,
              COALESCE(i.rarity, rw.rarity) AS target_rarity
       FROM fragment_recipes r
       LEFT JOIN item_templates i ON r.target_type = 'item' AND i.id = r.target_id
       LEFT JOIN reward_templates rw ON r.target_type = 'reward' AND rw.id = r.target_id
       ORDER BY r.id`
    ).all()
    return okResponse({ recipes: rows.results || [] })
  }
  if (path[0] === 'fragment-recipes' && method === 'POST') {
    const body = await readJson(request)
    const targetType = body.target_type === 'reward' ? 'reward' : body.target_type === 'item' ? 'item' : null
    if (!targetType) throw new KernelError('INVALID_PARAM', 'target_type 只能是 item 或 reward')
    const targetId = toInt(body.target_id, 0, 1, 1e12)
    const table = targetType === 'item' ? 'item_templates' : 'reward_templates'
    const target = await DB.prepare('SELECT id, rarity, is_active FROM ' + table + ' WHERE id = ?').bind(targetId).first()
    if (!target || !target.is_active) throw new KernelError('NOT_FOUND', '合成目标不存在或已停用', 404)
    const required = target.rarity === 3 ? 5 : target.rarity === 4 ? 7 : null
    if (!required) throw new KernelError('INVALID_PARAM', '仅L3/L4目标可配置碎片合成')
    const result = await DB.prepare(
      `INSERT INTO fragment_recipes (target_type, target_id, pieces_required) VALUES (?, ?, ?)
       ON CONFLICT(target_type, target_id) DO UPDATE SET pieces_required = excluded.pieces_required, is_active = 1`
    ).bind(targetType, targetId, required).run()
    const recipe = await DB.prepare('SELECT * FROM fragment_recipes WHERE id = ?').bind(result.meta.last_row_id).first()
    await auditStmt(DB, { scope: 'fragment_recipe', action: 'upsert', targetId: recipe.id, before: null, after: recipe, operator: admin.username }).run()
    return okResponse(recipe)
  }
  if (path[0] === 'fragment-recipes' && path[1] && method === 'DELETE') {
    const id = toInt(path[1], 0, 1, 1e12)
    const before = await DB.prepare('SELECT * FROM fragment_recipes WHERE id = ?').bind(id).first()
    if (!before) throw new KernelError('NOT_FOUND', '配方不存在', 404)
    await DB.batch([
      DB.prepare('UPDATE fragment_recipes SET is_active = 0 WHERE id = ?').bind(id),
      DB.prepare(
        "INSERT INTO config_audit (scope, action, target_id, before, after, operator) VALUES ('fragment_recipe', 'disable', ?, ?, ?, ?)"
      ).bind(id, JSON.stringify(before), JSON.stringify({ ...before, is_active: 0 }), admin.username),
    ])
    return okResponse({ disabled: true })
  }

  // 人工调整（四类）
  if (path[0] === 'adjustments' && method === 'GET') {
    const sp = new URL(request.url).searchParams
    return okResponse({
      adjustments: await listAdjustments(DB, {
        username: sp.get('username'), status: sp.get('status'), limit: toInt(sp.get('limit'), 50, 1, 200),
      }),
    })
  }
  if (path[0] === 'adjustments' && method === 'POST') {
    const body = await readJson(request)
    const key = requireIdempotencyKey(request, body)
    const result = await createAdjustmentOp(DB, {
      operator: admin.username,
      username: String(body.username || ''),
      targetType: String(body.target_type || ''),
      targetId: body.target_id ? toInt(body.target_id, 0, 1, 1e12) : null,
      delta: body.delta,
      reason: body.reason,
      idempotencyKey: key,
    })
    return okResponse(result)
  }
  if (path[0] === 'adjustments' && path[2] === 'approve' && method === 'POST') {
    return okResponse(await approveAdjustment(DB, toInt(path[1], 0, 1, 1e12), admin.username))
  }
  if (path[0] === 'adjustments' && path[2] === 'reject' && method === 'POST') {
    return okResponse(await rejectAdjustment(DB, toInt(path[1], 0, 1, 1e12), admin.username))
  }

  // 审计与配置版本查询（G5/G3）
  if (path[0] === 'audit' && method === 'GET') {
    const sp = new URL(request.url).searchParams
    const limit = toInt(sp.get('limit'), 50, 1, 200)
    const rows = await DB.prepare('SELECT * FROM config_audit ORDER BY id DESC LIMIT ?').bind(limit).all()
    return okResponse({ audit: rows.results || [] })
  }
  if (path[0] === 'config-versions' && method === 'GET') {
    const rows = await DB.prepare('SELECT id, scope, version, status, created_by, created_at FROM config_versions ORDER BY id DESC LIMIT 50').all()
    return okResponse({ versions: rows.results || [] })
  }

  // 内核自检/演示端点：模拟一次结算链挂载（仅用于联通验证，正式游戏在步骤2~4接入）
  if (path[0] === 'debug' && path[1] === 'resolve' && method === 'POST') {
    const body = await readJson(request)
    const result = await resolveEvent(DB, {
      username: String(body.username || admin.username),
      game: String(body.game || 'debug'),
      event: String(body.event || 'grab.before'),
      scope: ['all', 'grab', 'slot'].includes(body.scope) ? body.scope : 'all',
    })
    return okResponse(result)
  }

  throw new KernelError('NOT_FOUND', '接口不存在', 404)
}

// 内核入口：path 为解码后的路径段数组（不含 /api），返回 null 表示不归内核处理
export async function handleKernelRequest(request, DB, path) {
  if (path[0] === 'kernel') {
    await ensureKernelSchemaOnce(DB)
    try {
      return await handlePlayerKernel(request, DB, path.slice(1))
    } catch (error) {
      if (error instanceof KernelError) return errorResponse(error)
      throw error
    }
  }
  if (path[0] === 'admin' && path[1] === 'kernel') {
    await ensureKernelSchemaOnce(DB)
    try {
      return await handleAdminKernel(request, DB, path.slice(2))
    } catch (error) {
      if (error instanceof KernelError) return errorResponse(error)
      throw error
    }
  }
  return null
}
