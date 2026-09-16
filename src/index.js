const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
}

import { hashPassword, requireAuth } from './kernel/auth.js'
import { handleKernelRequest } from './kernel/router.js'
import { handleGamesRequest } from './games/router.js'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (url.pathname.startsWith('/api')) {
      return handleAPI(request, env, ctx)
    }

    return new Response('API Only - Use Cloudflare Pages for frontend', { status: 200 })
  }
}

async function handleAPI(request, env, ctx) {
  const url = new URL(request.url)
  // 解码路径段，支持中文用户名（url.pathname 返回百分号编码）
  const path = url.pathname.split('/').filter(Boolean).slice(1).map(s => {
    try { return decodeURIComponent(s) } catch (e) { return s }
  })
  const DB = env.game_database

  await ensureSchemaOnce(DB)

  try {
    // 测试端点
    if (path[0] === 'test') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        db: DB ? 'connected' : 'not connected',
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (path[0] === 'auth' && path[1] === 'register') {
      return handleRegister(request, DB)
    }
    
    if (path[0] === 'auth' && path[1] === 'login') {
      return handleLogin(request, DB)
    }
    
    if (path[0] === 'user' && path[1] === 'profile') {
      return handleGetProfile(request, DB)
    }
    
    if (path[0] === 'user' && path[1] === 'update') {
      return handleUpdateProfile(request, DB)
    }
    
    if (path[0] === 'admin' && path[1] === 'products') {
      if (request.method === 'GET') return handleGetProducts(DB)
      if (request.method === 'POST') return handleCreateProduct(request, DB)
      if (request.method === 'PUT') return handleUpdateProduct(request, DB)
      if (request.method === 'DELETE') return handleDeleteProduct(request, DB)
    }
    
    if (path[0] === 'admin' && path[1] === 'assets') {
      if (request.method === 'GET') {
        const username = path[2] || null
        return handleGetAssets(DB, username)
      }
      if (request.method === 'POST') return handleCreateAsset(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdateAsset(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeleteAsset(request, DB, path[2])
    }
    
    if (path[0] === 'admin' && path[1] === 'debts') {
      if (request.method === 'GET') {
        const username = path[2] || null
        return handleGetDebts(DB, username)
      }
      if (request.method === 'POST') return handleCreateDebt(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdateDebt(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeleteDebt(request, DB, path[2])
    }
    
    if (path[0] === 'admin' && path[1] === 'items') {
      if (request.method === 'GET') {
        const username = path[2] || null
        return handleGetItems(DB, username)
      }
      if (request.method === 'POST') return handleCreateItem(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdateItem(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeleteItem(request, DB, path[2])
    }
    
    if (path[0] === 'admin' && path[1] === 'rewards') {
      if (request.method === 'GET') {
        const username = path[2] || null
        return handleGetRewards(DB, username)
      }
      if (request.method === 'POST') return handleCreateReward(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdateReward(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeleteReward(request, DB, path[2])
    }
    
    if (path[0] === 'admin' && path[1] === 'penalties') {
      if (request.method === 'GET') {
        const username = path[2] || null
        return handleGetPenalties(DB, username)
      }
      if (request.method === 'POST') return handleCreatePenalty(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdatePenalty(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeletePenalty(request, DB, path[2])
    }
    
    // 奖励类型管理（管理员定义的可兑换奖励）
    if (path[0] === 'admin' && path[1] === 'reward-types') {
      if (request.method === 'GET') {
        return handleGetRewardTypes(DB)
      }
      if (request.method === 'POST') return handleCreateRewardType(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdateRewardType(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeleteRewardType(request, DB, path[2])
    }
    
    // 惩罚类型管理（管理员定义的可消除惩罚）
    if (path[0] === 'admin' && path[1] === 'penalty-types') {
      if (request.method === 'GET') {
        return handleGetPenaltyTypes(DB)
      }
      if (request.method === 'POST') return handleCreatePenaltyType(request, DB)
      if (path[2] && request.method === 'PUT') return handleUpdatePenaltyType(request, DB, path[2])
      if (path[2] && request.method === 'DELETE') return handleDeletePenaltyType(request, DB, path[2])
    }
    
    if (path[0] === 'products' && path[1] === 'list') {
      return handleGetProducts(DB)
    }
    
    if (path[0] === 'products' && path[1] === 'purchase') {
      return handlePurchase(request, DB)
    }
    
    if (path[0] === 'user' && path[1] === 'balance') {
      return handleGetBalance(request, DB)
    }
    
    if (path[0] === 'admin' && path[1] === 'users') {
      if (request.method === 'GET') return handleGetUsers(DB)
      if (request.method === 'DELETE' && path[2]) return handleDeleteUser(request, DB, path[2])
      if (request.method === 'PUT' && path[2]) return handleUpdateUserBalance(request, DB, path[2])
    }
    
    if (path[0] === 'admin' && path[1] === 'user' && path[2] === 'balance') {
      return handleUpdateUserBalance(request, DB, path[3])
    }
    
    if (path[0] === 'admin' && path[1] === 'user' && path[2] === 'password' && path[3] === 'reset') {
      return handleResetPassword(request, DB, path[4])
    }

    // 管理员重置用户转盘次数
    if (path[0] === 'admin' && path[1] === 'wheel' && path[2] === 'spin' && path[3] === 'reset' && request.method === 'POST') {
      return handleAdminWheelReset(request, DB, path[4])
    }

    // 管理员按用户设置转盘次数（奖励/惩罚分开）
    if (path[0] === 'admin' && path[1] === 'user' && path[2] === 'wheel' && path[3] === 'limits' && path[4]) {
      if (request.method === 'GET') return handleGetUserWheelLimits(request, DB, path[4])
      if (request.method === 'PUT' || request.method === 'POST') return handleUpdateUserWheelLimits(request, DB, path[4])
    }
    
    // === 商店系统 ===
    // 获取上架的奖励（玩家可见）
    if (path[0] === 'shop' && path[1] === 'rewards') {
      return handleGetShopRewards(DB)
    }
    // 兑换奖励
    if (path[0] === 'shop' && path[1] === 'redeem-reward') {
      return handleRedeemReward(request, DB)
    }
    // 获取上架的惩罚（玩家可见）
    if (path[0] === 'shop' && path[1] === 'penalties') {
      return handleGetShopPenalties(DB)
    }
    // 消除惩罚
    if (path[0] === 'shop' && path[1] === 'pay-penalty') {
      return handlePayPenalty(request, DB)
    }
    
    // === 银行/贷款系统 ===
    // 获取银行状态
    if (path[0] === 'bank' && path[1] === 'status') {
      return handleGetBankStatus(DB)
    }
    // 管理员切换银行状态
    if (path[0] === 'admin' && path[1] === 'bank' && path[2] === 'toggle') {
      return handleToggleBankStatus(request, DB)
    }
    // 获取贷款配置
    if (path[0] === 'loans' && path[1] === 'config') {
      if (request.method === 'GET') return handleGetLoanConfig(DB)
      if (request.method === 'PUT') return handleUpdateLoanConfig(request, DB)
    }
    // 申请贷款
    if (path[0] === 'loans' && path[1] === 'apply') {
      return handleApplyLoan(request, DB)
    }
    // 获取用户贷款列表
    if (path[0] === 'loans' && path[1] === 'list') {
      return handleGetLoans(request, DB)
    }
    // 获取所有贷款（管理员）
    if (path[0] === 'loans' && path[1] === 'all') {
      return handleGetAllLoans(DB)
    }
    // 还款
    if (path[0] === 'loans' && path[1] === 'repay') {
      return handleRepayLoan(request, DB)
    }
    // 结清贷款（管理员）
    if (path[0] === 'loans' && path[1] === 'settle') {
      return handleSettleLoan(request, DB)
    }

    // === 转盘系统 ===
    // 获取转盘配置（所有用户可见）
    if (path[0] === 'wheel' && path[1] === 'config' && request.method === 'GET') {
      return handleGetWheelConfig(request, DB)
    }
    // 保存转盘配置（管理员）
    if (path[0] === 'wheel' && path[1] === 'config' && request.method === 'PUT') {
      return handleUpdateWheelConfig(request, DB)
    }
    // 转动转盘
    if (path[0] === 'wheel' && path[1] === 'spin') {
      return handleWheelSpin(request, DB)
    }
    // 转盘历史记录
    if (path[0] === 'wheel' && path[1] === 'history') {
      return handleGetWheelHistory(DB)
    }

    // === 公告栏（所有用户可见） ===
    if (path[0] === 'announcements' && request.method === 'GET') {
      return handleGetAnnouncements(DB)
    }
    if (path[0] === 'admin' && path[1] === 'announcements' && request.method === 'POST') {
      return handleCreateAnnouncement(request, DB)
    }
    if (path[0] === 'admin' && path[1] === 'announcements' && path[2] && request.method === 'DELETE') {
      return handleDeleteAnnouncement(request, DB, path[2])
    }
    // 公告管理：置顶/显示切换
    if (path[0] === 'admin' && path[1] === 'announcements' && path[2] && request.method === 'PUT') {
      return handleUpdateAnnouncement(request, DB, path[2])
    }

    // === 留言板 ===
    if (path[0] === 'messages' && request.method === 'GET') {
      return handleGetMessages(DB)
    }
    // 留言评论：发表评论（必须放在通用 POST /messages 之前，否则会被当作新留言）
    if (path[0] === 'messages' && path[1] && path[2] === 'comments' && request.method === 'POST') {
      return handleCreateComment(request, DB, path[1])
    }
    if (path[0] === 'messages' && request.method === 'POST') {
      return handleCreateMessage(request, DB)
    }
    // 管理员删除留言
    if (path[0] === 'admin' && path[1] === 'messages' && path[2] && request.method === 'DELETE') {
      return handleDeleteMessage(request, DB, path[2])
    }
    // 留言评论：删除评论（作者本人或管理员）
    if (path[0] === 'comments' && path[1] && request.method === 'DELETE') {
      return handleDeleteComment(request, DB, path[1])
    }

    // === 用户自己的资产信息 ===
    if (path[0] === 'user' && path[1] === 'assets') {
      return handleGetUserAssets(request, DB)
    }

    // 我的资产变更记录
    if (path[0] === 'user' && path[1] === 'asset-logs') {
      return handleGetAssetLogs(request, DB)
    }

    // === 互通内核（步骤1：内容数据模型 + 结算内核 + 通用事务） ===
    const kernelResponse = await handleKernelRequest(request, DB, path)
    if (kernelResponse) return kernelResponse

    // === 小游戏（步骤2：抓娃娃） ===
    const gamesResponse = await handleGamesRequest(request, DB, path)
    if (gamesResponse) return gamesResponse

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error('API Error:', error)
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}

// hashPassword / authenticate 已迁移至 src/kernel/auth.js（供内核路由与旧路由共用）

// Schema 初始化：每个 Worker 实例只执行一次（此前每个请求都执行 25+ 条 D1 语句，导致接口延迟 2~4s）
let schemaInitPromise = null
function ensureSchemaOnce(DB) {
  if (!schemaInitPromise) {
    schemaInitPromise = initSchema(DB).catch(error => {
      console.error('Failed to ensure schema:', error)
      schemaInitPromise = null // 失败后允许下次请求重试
    })
  }
  return schemaInitPromise
}

async function initSchema(DB) {
  // 建表语句用 batch 一次往返执行
  const ddl = [
    'CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, image TEXT, created_by TEXT, is_pinned INTEGER DEFAULT 0, is_displayed INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, content TEXT NOT NULL, image TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE IF NOT EXISTS message_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
    "CREATE TABLE IF NOT EXISTS wheel_config (wheel_type TEXT PRIMARY KEY, items TEXT NOT NULL DEFAULT '[]', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    'CREATE TABLE IF NOT EXISTS wheel_spins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, wheel_type TEXT NOT NULL, item_type TEXT NOT NULL, item_name TEXT, amount REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE IF NOT EXISTS wheel_settings (id INTEGER PRIMARY KEY CHECK (id = 1), spin_limit_per_user INTEGER NOT NULL DEFAULT 0)',
    'INSERT OR IGNORE INTO wheel_settings (id, spin_limit_per_user) VALUES (1, 0)',
    'CREATE TABLE IF NOT EXISTS wheel_spin_resets (username TEXT NOT NULL, wheel_type TEXT NOT NULL, reset_offset INTEGER NOT NULL DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (username, wheel_type))',
    'CREATE TABLE IF NOT EXISTS user_wheel_limits (username TEXT PRIMARY KEY, reward_limit INTEGER, penalty_limit INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
    "CREATE TABLE IF NOT EXISTS asset_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL, detail TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
    'CREATE INDEX IF NOT EXISTS idx_asset_logs_user ON asset_logs(username, created_at)'
  ]
  await DB.batch(ddl.map(sql => DB.prepare(sql)))

  // 兼容旧表：补充新列（已存在时报错，直接忽略）；并行执行减少等待
  const alters = [
    'ALTER TABLE announcements ADD COLUMN image TEXT',
    'ALTER TABLE announcements ADD COLUMN is_pinned INTEGER DEFAULT 0',
    'ALTER TABLE announcements ADD COLUMN is_displayed INTEGER DEFAULT 0',
    'ALTER TABLE messages ADD COLUMN image TEXT',
    'ALTER TABLE rewards ADD COLUMN quantity INTEGER DEFAULT 1',
    'ALTER TABLE penalties ADD COLUMN quantity INTEGER DEFAULT 1',
    'ALTER TABLE loan_config ADD COLUMN bank_open INTEGER DEFAULT 1',
    'ALTER TABLE reward_types ADD COLUMN shop_enabled INTEGER DEFAULT 0',
    'ALTER TABLE penalty_types ADD COLUMN shop_enabled INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN shop_enabled INTEGER DEFAULT 0'
  ]
  await Promise.allSettled(alters.map(sql => DB.prepare(sql).run()))

  // 确保默认管理员存在
  const existing = await DB.prepare('SELECT id FROM users WHERE username = ?').bind('zhou').first()
  if (!existing) {
    const hashedPassword = await hashPassword('Asd123**')
    await DB.prepare(
      'INSERT INTO users (username, password, role, balance) VALUES (?, ?, ?, ?)'
    ).bind('zhou', hashedPassword, 'admin', 999999).run()
  }
}

// 银行状态管理
async function handleGetBankStatus(DB) {
  const config = await DB.prepare('SELECT bank_open FROM loan_config ORDER BY id DESC LIMIT 1').first()
  const bankOpen = config ? config.bank_open : 1
  return new Response(JSON.stringify({ success: true, bank_open: bankOpen === 1 }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleToggleBankStatus(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  if (authResult.role !== 'admin') {
    return new Response(JSON.stringify({ error: '仅管理员可操作' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const { bank_open } = await request.json()
  const existing = await DB.prepare('SELECT id FROM loan_config ORDER BY id DESC LIMIT 1').first()
  if (existing) {
    await DB.prepare('UPDATE loan_config SET bank_open = ? WHERE id = ?').bind(bank_open ? 1 : 0, existing.id).run()
  } else {
    await DB.prepare('INSERT INTO loan_config (bank_open) VALUES (?)').bind(bank_open ? 1 : 0).run()
  }

  return new Response(JSON.stringify({ success: true, bank_open: bank_open ? true : false }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleRegister(request, DB) {
  const { username, password, role = 'player' } = await request.json()
  
  if (!username || !password) {
    return new Response(JSON.stringify({ error: '用户名和密码不能为空' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const existing = await DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (existing) {
    return new Response(JSON.stringify({ error: '用户名已存在' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const hashedPassword = await hashPassword(password)
  await DB.prepare(
    'INSERT INTO users (username, password, role, balance) VALUES (?, ?, ?, ?)'
  ).bind(username, hashedPassword, role === 'admin' ? 'admin' : 'player', 0).run()

  const token = btoa(encodeURIComponent(`${username}:${Date.now()}:${Math.random()}`))
  const expiresAt = Date.now() + 86400 * 7 * 1000
  await DB.prepare(
    'INSERT INTO tokens (token, username, expires_at) VALUES (?, ?, ?)'
  ).bind(token, username, expiresAt).run()

  return new Response(JSON.stringify({
    success: true,
    token,
    user: { username, role: role === 'admin' ? 'admin' : 'player', balance: 0 }
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleLogin(request, DB) {
  const { username, password } = await request.json()
  
  if (!username || !password) {
    return new Response(JSON.stringify({ error: '用户名和密码不能为空' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const user = await DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first()
  if (!user) {
    return new Response(JSON.stringify({ error: '用户名或密码错误' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const hashedPassword = await hashPassword(password)
  if (user.password !== hashedPassword) {
    return new Response(JSON.stringify({ error: '用户名或密码错误' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const token = btoa(encodeURIComponent(`${username}:${Date.now()}:${Math.random()}`))
  const expiresAt = Date.now() + 86400 * 7 * 1000
  await DB.prepare(
    'INSERT INTO tokens (token, username, expires_at) VALUES (?, ?, ?)'
  ).bind(token, username, expiresAt).run()

  return new Response(JSON.stringify({
    success: true,
    token,
    user: { username: user.username, role: user.role, balance: user.balance }
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleGetProfile(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response

  const { username } = authResult
  const user = await DB.prepare('SELECT username, role, balance, created_at FROM users WHERE username = ?').bind(username).first()
  
  if (!user) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const purchases = await DB.prepare(
    'SELECT product_name as productName, price, purchased_at as purchasedAt FROM purchases WHERE username = ? ORDER BY purchased_at DESC'
  ).bind(username).all()

  return new Response(JSON.stringify({
    ...user,
    purchases: purchases.results || []
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateProfile(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response

  const { username } = authResult
  const updates = await request.json()

  if (updates.password) {
    const hashedPassword = await hashPassword(updates.password)
    await DB.prepare('UPDATE users SET password = ?, updated_at = datetime(\'now\') WHERE username = ?')
      .bind(hashedPassword, username).run()
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleGetAssets(DB, username) {
  let query = 'SELECT * FROM assets'
  let params = []
  
  if (username) {
    query += ' WHERE username = ?'
    params.push(username)
  }
  
  query += ' ORDER BY created_at DESC'
  
  const assets = await DB.prepare(query).bind(...params).all()
  return new Response(JSON.stringify({ success: true, data: assets.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateAsset(request, DB) {
  const asset = await request.json()
  
  const result = await DB.prepare(
    'INSERT INTO assets (username, name, value, description) VALUES (?, ?, ?, ?)'
  ).bind(asset.username, asset.name, asset.value, asset.description || '').run()

  const newAsset = await DB.prepare('SELECT * FROM assets WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newAsset }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateAsset(request, DB, id) {
  const { name, value, description } = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM assets WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '资产不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE assets SET name = ?, value = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(name, value, description || '', id).run()

  const updated = await DB.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteAsset(request, DB, id) {
  await DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleGetDebts(DB, username) {
  let query = 'SELECT * FROM debts'
  let params = []
  
  if (username) {
    query += ' WHERE username = ?'
    params.push(username)
  }
  
  query += ' ORDER BY created_at DESC'
  
  const debts = await DB.prepare(query).bind(...params).all()
  return new Response(JSON.stringify({ success: true, data: debts.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateDebt(request, DB) {
  const debt = await request.json()
  
  const result = await DB.prepare(
    'INSERT INTO debts (username, name, amount, description) VALUES (?, ?, ?, ?)'
  ).bind(debt.username, debt.name, debt.amount, debt.description || '').run()

  const newDebt = await DB.prepare('SELECT * FROM debts WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newDebt }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateDebt(request, DB, id) {
  const { name, amount, description } = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM debts WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '负债不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE debts SET name = ?, amount = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(name, amount, description || '', id).run()

  const updated = await DB.prepare('SELECT * FROM debts WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteDebt(request, DB, id) {
  await DB.prepare('DELETE FROM debts WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 物品管理
async function handleGetItems(DB, username) {
  let query = 'SELECT * FROM items'
  let params = []
  
  if (username) {
    query += ' WHERE username = ?'
    params.push(username)
  }
  
  query += ' ORDER BY created_at DESC'
  
  const items = await DB.prepare(query).bind(...params).all()
  return new Response(JSON.stringify({ success: true, data: items.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateItem(request, DB) {
  const item = await request.json()
  
  const result = await DB.prepare(
    'INSERT INTO items (username, name, value, description) VALUES (?, ?, ?, ?)'
  ).bind(item.username, item.name, item.value, item.description || '').run()

  const newItem = await DB.prepare('SELECT * FROM items WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newItem }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateItem(request, DB, id) {
  const item = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM items WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '物品不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE items SET name = ?, value = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(item.name, item.value, item.description || '', id).run()

  const updated = await DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteItem(request, DB, id) {
  await DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 奖励管理
async function handleGetRewards(DB, username) {
  let query = 'SELECT * FROM rewards'
  let params = []
  
  if (username) {
    query += ' WHERE username = ?'
    params.push(username)
  }
  
  query += ' ORDER BY created_at DESC'
  
  const rewards = await DB.prepare(query).bind(...params).all()
  return new Response(JSON.stringify({ success: true, data: rewards.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateReward(request, DB) {
  const reward = await request.json()
  const quantity = Math.max(1, parseInt(reward.quantity) || 1)

  // 同类项合并：同一用户同名奖励累加数量和价值
  const existing = await DB.prepare(
    'SELECT id FROM rewards WHERE username = ? AND name = ?'
  ).bind(reward.username, reward.name).first()
  if (existing) {
    await DB.prepare(
      "UPDATE rewards SET quantity = quantity + ?, value = value + ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(quantity, parseFloat(reward.value) || 0, existing.id).run()
    const merged = await DB.prepare('SELECT * FROM rewards WHERE id = ?').bind(existing.id).first()
    await logAssetChange(DB, reward.username, 'reward', `管理员添加奖励：${reward.name}`, `x${quantity}`)
    return new Response(JSON.stringify({ success: true, data: merged }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const result = await DB.prepare(
    'INSERT INTO rewards (username, name, value, description, quantity) VALUES (?, ?, ?, ?, ?)'
  ).bind(reward.username, reward.name, reward.value, reward.description || '', quantity).run()

  await logAssetChange(DB, reward.username, 'reward', `管理员添加奖励：${reward.name}`, `x${quantity}`)

  const newReward = await DB.prepare('SELECT * FROM rewards WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newReward }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateReward(request, DB, id) {
  const reward = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM rewards WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '奖励不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    "UPDATE rewards SET name = ?, value = ?, description = ?, quantity = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(reward.name, reward.value, reward.description || '', Math.max(1, parseInt(reward.quantity) || 1), id).run()

  const updated = await DB.prepare('SELECT * FROM rewards WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteReward(request, DB, id) {
  await DB.prepare('DELETE FROM rewards WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 惩罚管理
async function handleGetPenalties(DB, username) {
  let query = 'SELECT * FROM penalties'
  let params = []
  
  if (username) {
    query += ' WHERE username = ?'
    params.push(username)
  }
  
  query += ' ORDER BY created_at DESC'
  
  const penalties = await DB.prepare(query).bind(...params).all()
  return new Response(JSON.stringify({ success: true, data: penalties.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreatePenalty(request, DB) {
  const penalty = await request.json()
  const quantity = Math.max(1, parseInt(penalty.quantity) || 1)

  // 同类项合并：同一用户同名惩罚累加数量和金额
  const existing = await DB.prepare(
    'SELECT id FROM penalties WHERE username = ? AND name = ?'
  ).bind(penalty.username, penalty.name).first()
  if (existing) {
    await DB.prepare(
      "UPDATE penalties SET quantity = quantity + ?, amount = amount + ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(quantity, parseFloat(penalty.amount) || 0, existing.id).run()
    const merged = await DB.prepare('SELECT * FROM penalties WHERE id = ?').bind(existing.id).first()
    await logAssetChange(DB, penalty.username, 'penalty', `管理员添加惩罚：${penalty.name}`, `x${quantity}`)
    return new Response(JSON.stringify({ success: true, data: merged }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const result = await DB.prepare(
    'INSERT INTO penalties (username, name, amount, description, quantity) VALUES (?, ?, ?, ?, ?)'
  ).bind(penalty.username, penalty.name, penalty.amount, penalty.description || '', quantity).run()

  await logAssetChange(DB, penalty.username, 'penalty', `管理员添加惩罚：${penalty.name}`, `x${quantity}`)

  const newPenalty = await DB.prepare('SELECT * FROM penalties WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newPenalty }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdatePenalty(request, DB, id) {
  const penalty = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM penalties WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '惩罚不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    "UPDATE penalties SET name = ?, amount = ?, description = ?, quantity = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(penalty.name, penalty.amount, penalty.description || '', Math.max(1, parseInt(penalty.quantity) || 1), id).run()

  const updated = await DB.prepare('SELECT * FROM penalties WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeletePenalty(request, DB, id) {
  await DB.prepare('DELETE FROM penalties WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 奖励类型管理
async function handleGetRewardTypes(DB) {
  const rewardTypes = await DB.prepare('SELECT * FROM reward_types ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: rewardTypes.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateRewardType(request, DB) {
  const { name, price, description, image, shop_enabled } = await request.json()
  
  const result = await DB.prepare(
    'INSERT INTO reward_types (name, price, description, image, shop_enabled) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, price, description || '', image || '', shop_enabled ? 1 : 0).run()

  const newRewardType = await DB.prepare('SELECT * FROM reward_types WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newRewardType }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateRewardType(request, DB, id) {
  const { name, price, description, image, shop_enabled } = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM reward_types WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '奖励类型不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE reward_types SET name = ?, price = ?, description = ?, image = ?, shop_enabled = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(name, price, description || '', image || '', shop_enabled !== undefined ? (shop_enabled ? 1 : 0) : 0, id).run()

  const updated = await DB.prepare('SELECT * FROM reward_types WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteRewardType(request, DB, id) {
  await DB.prepare('DELETE FROM reward_types WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 惩罚类型管理
async function handleGetPenaltyTypes(DB) {
  const penaltyTypes = await DB.prepare('SELECT * FROM penalty_types ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: penaltyTypes.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreatePenaltyType(request, DB) {
  const { name, price, description, image, shop_enabled } = await request.json()
  
  const result = await DB.prepare(
    'INSERT INTO penalty_types (name, price, description, image, shop_enabled) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, price, description || '', image || '', shop_enabled ? 1 : 0).run()

  const newPenaltyType = await DB.prepare('SELECT * FROM penalty_types WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newPenaltyType }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdatePenaltyType(request, DB, id) {
  const { name, price, description, image, shop_enabled } = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM penalty_types WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '惩罚类型不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE penalty_types SET name = ?, price = ?, description = ?, image = ?, shop_enabled = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(name, price, description || '', image || '', shop_enabled !== undefined ? (shop_enabled ? 1 : 0) : 0, id).run()

  const updated = await DB.prepare('SELECT * FROM penalty_types WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeletePenaltyType(request, DB, id) {
  await DB.prepare('DELETE FROM penalty_types WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleGetProducts(DB) {
  const products = await DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: products.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateProduct(request, DB) {
  const product = await request.json()
  
  const result = await DB.prepare(
    'INSERT INTO products (name, price, description, image) VALUES (?, ?, ?, ?)'
  ).bind(product.name, product.price, product.description || '', product.image || '').run()

  const newProduct = await DB.prepare('SELECT * FROM products WHERE id = ?').bind(result.meta.last_row_id).first()

  return new Response(JSON.stringify({ success: true, data: newProduct }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateProduct(request, DB) {
  const { id, name, price, description, image } = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '商品不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE products SET name = ?, price = ?, description = ?, image = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(name, price, description || '', image || '', id).run()

  const updated = await DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first()

  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteProduct(request, DB) {
  const { id } = await request.json()
  
  await DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run()

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handlePurchase(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response

  const { username } = authResult
  const { productId } = await request.json()

  const user = await DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first()
  const product = await DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first()

  if (!product) {
    return new Response(JSON.stringify({ error: '商品不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (user.balance < product.price) {
    return new Response(JSON.stringify({ error: '筹码不足' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = balance - ? WHERE username = ?')
    .bind(product.price, username).run()

  await DB.prepare(
    'INSERT INTO purchases (username, product_id, product_name, price) VALUES (?, ?, ?, ?)'
  ).bind(username, product.id, product.name, product.price).run()

  const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

  return new Response(JSON.stringify({
    success: true,
    message: '购买成功',
    balance: updatedUser.balance
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleGetBalance(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response

  const { username } = authResult
  const user = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

  return new Response(JSON.stringify({
    success: true,
    balance: user.balance
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// === 公告栏 ===
async function handleGetAnnouncements(DB) {
  const announcements = await DB.prepare('SELECT * FROM announcements ORDER BY is_pinned DESC, is_displayed DESC, created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: announcements.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateAnnouncement(request, DB) {
  const { title, content, image } = await request.json()
  if (!title) {
    return new Response(JSON.stringify({ error: '公告标题不能为空' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const result = await DB.prepare(
    'INSERT INTO announcements (title, content, image, created_by) VALUES (?, ?, ?, ?)'
  ).bind(title, content || '', image || '', 'admin').run()
  const newAnnouncement = await DB.prepare('SELECT * FROM announcements WHERE id = ?').bind(result.meta.last_row_id).first()
  return new Response(JSON.stringify({ success: true, data: newAnnouncement }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteAnnouncement(request, DB, id) {
  await DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run()
  return new Response(JSON.stringify({ success: true, message: '公告已删除' }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateAnnouncement(request, DB, id) {
  const { is_pinned, is_displayed } = await request.json()
  if (is_pinned !== undefined) {
    await DB.prepare('UPDATE announcements SET is_pinned = ? WHERE id = ?').bind(is_pinned ? 1 : 0, id).run()
  }
  if (is_displayed !== undefined) {
    await DB.prepare('UPDATE announcements SET is_displayed = ? WHERE id = ?').bind(is_displayed ? 1 : 0, id).run()
  }
  const updated = await DB.prepare('SELECT * FROM announcements WHERE id = ?').bind(id).first()
  return new Response(JSON.stringify({ success: true, data: updated }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// === 留言板 ===
async function handleGetMessages(DB) {
  const messages = await DB.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100').all()
  const list = messages.results || []
  let commentsByMessage = {}
  if (list.length > 0) {
    const placeholders = list.map(() => '?').join(',')
    const comments = await DB.prepare(
      `SELECT * FROM message_comments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...list.map(m => m.id)).all()
    for (const c of comments.results || []) {
      if (!commentsByMessage[c.message_id]) commentsByMessage[c.message_id] = []
      commentsByMessage[c.message_id].push(c)
    }
  }
  const data = list.map(m => ({ ...m, comments: commentsByMessage[m.id] || [] }))
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleCreateMessage(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { content, image } = await request.json()
  if (!content || content.trim() === '') {
    return new Response(JSON.stringify({ error: '留言内容不能为空' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const result = await DB.prepare(
    'INSERT INTO messages (username, content, image) VALUES (?, ?, ?)'
  ).bind(username, content.trim(), image || '').run()
  const newMessage = await DB.prepare('SELECT * FROM messages WHERE id = ?').bind(result.meta.last_row_id).first()
  return new Response(JSON.stringify({ success: true, data: newMessage }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteMessage(request, DB, id) {
  await DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run()
  // 留言删除后同时清掉它的评论
  await DB.prepare('DELETE FROM message_comments WHERE message_id = ?').bind(id).run()
  return new Response(JSON.stringify({ success: true, message: '留言已删除' }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// === 留言评论 ===
async function handleCreateComment(request, DB, messageId) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { content } = await request.json()
  if (!content || content.trim() === '') {
    return new Response(JSON.stringify({ error: '评论内容不能为空' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const message = await DB.prepare('SELECT id FROM messages WHERE id = ?').bind(messageId).first()
  if (!message) {
    return new Response(JSON.stringify({ error: '留言不存在' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const result = await DB.prepare(
    'INSERT INTO message_comments (message_id, username, content) VALUES (?, ?, ?)'
  ).bind(messageId, username, content.trim()).run()
  const newComment = await DB.prepare('SELECT * FROM message_comments WHERE id = ?').bind(result.meta.last_row_id).first()
  return new Response(JSON.stringify({ success: true, data: newComment }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteComment(request, DB, id) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username, role } = authResult
  const comment = await DB.prepare('SELECT * FROM message_comments WHERE id = ?').bind(id).first()
  if (!comment) {
    return new Response(JSON.stringify({ error: '评论不存在' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  if (comment.username !== username && role !== 'admin') {
    return new Response(JSON.stringify({ error: '只能删除自己的评论' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  await DB.prepare('DELETE FROM message_comments WHERE id = ?').bind(id).run()
  return new Response(JSON.stringify({ success: true, message: '评论已删除' }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// === 用户自己的资产信息 ===
async function handleGetUserAssets(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  
  const user = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()
  const debts = await DB.prepare('SELECT * FROM debts WHERE username = ? ORDER BY created_at DESC').bind(username).all()
  const rewards = await DB.prepare('SELECT * FROM rewards WHERE username = ? ORDER BY created_at DESC').bind(username).all()
  const penalties = await DB.prepare('SELECT * FROM penalties WHERE username = ? ORDER BY created_at DESC').bind(username).all()

  return new Response(JSON.stringify({
    success: true,
    data: {
      balance: user ? user.balance : 0,
      debts: debts.results || [],
      rewards: rewards.results || [],
      penalties: penalties.results || []
    }
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 记录资产变更日志（失败不影响主流程）
async function logAssetChange(DB, username, action, title, detail) {
  try {
    await DB.prepare('INSERT INTO asset_logs (username, action, title, detail) VALUES (?, ?, ?, ?)')
      .bind(username, action, title, detail || '').run()
  } catch (e) {
    console.error('logAssetChange failed:', e)
  }
}

// 获取当前用户的资产变更记录（最近100条）
async function handleGetAssetLogs(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const logs = await DB.prepare(
    'SELECT id, action, title, detail, created_at FROM asset_logs WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT 100'
  ).bind(authResult.username).all()
  return new Response(JSON.stringify({ success: true, data: logs.results || [] }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleGetUsers(DB) {
  const users = await DB.prepare('SELECT username, role, balance, created_at FROM users ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: users.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateUserBalance(request, DB, username) {
  const { balance } = await request.json()

  const existing = await DB.prepare('SELECT id, balance FROM users WHERE username = ?').bind(username).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = ?, updated_at = datetime(\'now\') WHERE username = ?')
    .bind(balance, username).run()

  // 资产变更记录
  const oldBalance = existing.balance || 0
  const delta = balance - oldBalance
  await logAssetChange(DB, username, 'balance', '管理员调整筹码',
    `${oldBalance} → ${balance}（${delta >= 0 ? '+' : ''}${delta}）`)

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleDeleteUser(request, DB, username) {
  if (username === 'admin') {
    return new Response(JSON.stringify({ error: '不能删除管理员账号' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  
  const existing = await DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // 删除用户相关数据
  await DB.prepare('DELETE FROM tokens WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM items WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM rewards WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM debts WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM penalties WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM purchases WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM loans WHERE username = ?').bind(username).run()
  await DB.prepare('DELETE FROM users WHERE username = ?').bind(username).run()

  return new Response(JSON.stringify({ success: true, message: '用户已删除' }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleResetPassword(request, DB, username) {
  if (!username) {
    return new Response(JSON.stringify({ error: '用户名不能为空' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  
  const existing = await DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const { newPassword } = await request.json()
  if (!newPassword || newPassword.length < 6) {
    return new Response(JSON.stringify({ error: '密码长度不能少于6位' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const hashedPassword = await hashPassword(newPassword)
  await DB.prepare('UPDATE users SET password = ?, updated_at = datetime(\'now\') WHERE username = ?')
    .bind(hashedPassword, username).run()

  return new Response(JSON.stringify({ success: true, message: '密码已重置' }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// ==================== 商店系统 ====================

// 获取上架的奖励（商店可见）
async function handleGetShopRewards(DB) {
  const rewards = await DB.prepare('SELECT * FROM reward_types WHERE shop_enabled = 1 ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: rewards.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 兑换奖励
async function handleRedeemReward(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { rewardId, quantity = 1 } = await request.json()

  const reward = await DB.prepare('SELECT * FROM reward_types WHERE id = ? AND shop_enabled = 1').bind(rewardId).first()
  if (!reward) {
    return new Response(JSON.stringify({ error: '奖励不存在或未上架' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const totalPrice = reward.price * quantity
  const user = await DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first()
  if (user.balance < totalPrice) {
    return new Response(JSON.stringify({ error: '筹码不足' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = balance - ? WHERE username = ?').bind(totalPrice, username).run()
  await DB.prepare(
    'INSERT INTO redemptions (username, reward_type_id, reward_name, price, quantity) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, reward.id, reward.name, reward.price, quantity).run()

  // 将兑换的奖励合并到用户的奖励资产中（同类项累加数量）
  const existingReward = await DB.prepare(
    'SELECT id FROM rewards WHERE username = ? AND name = ?'
  ).bind(username, reward.name).first()
  if (existingReward) {
    await DB.prepare(
      "UPDATE rewards SET quantity = quantity + ?, value = value + ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(quantity, reward.price * quantity, existingReward.id).run()
  } else {
    await DB.prepare(
      'INSERT INTO rewards (username, name, value, description, quantity) VALUES (?, ?, ?, ?, ?)'
    ).bind(username, reward.name, reward.price * quantity, '从商店兑换', quantity).run()
  }

  const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

  // 资产变更记录
  await logAssetChange(DB, username, 'balance', '商店兑换奖励', `-${totalPrice}（${reward.name} x${quantity}）`)
  await logAssetChange(DB, username, 'reward', `商店兑换奖励：${reward.name}`, `x${quantity}`)

  return new Response(JSON.stringify({ success: true, message: `成功兑换 ${reward.name} x${quantity}`, balance: updatedUser.balance }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 获取上架的惩罚（玩家可见）
async function handleGetShopPenalties(DB) {
  const penalties = await DB.prepare('SELECT * FROM penalty_types WHERE shop_enabled = 1 ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: penalties.results || [] }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 消除惩罚
async function handlePayPenalty(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { penaltyId, quantity = 1 } = await request.json()

  const penalty = await DB.prepare('SELECT * FROM penalty_types WHERE id = ? AND shop_enabled = 1').bind(penaltyId).first()
  if (!penalty) {
    return new Response(JSON.stringify({ error: '惩罚不存在或未上架' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const totalPrice = penalty.price * quantity
  const user = await DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first()
  if (user.balance < totalPrice) {
    return new Response(JSON.stringify({ error: '筹码不足' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = balance - ? WHERE username = ?').bind(totalPrice, username).run()
  await DB.prepare(
    'INSERT INTO penalty_payments (username, penalty_type_id, penalty_name, price, quantity) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, penalty.id, penalty.name, penalty.price, quantity).run()

  // 从用户的惩罚列表中减少对应的惩罚
  const userPenalties = await DB.prepare('SELECT * FROM penalties WHERE username = ? AND amount > 0 ORDER BY created_at ASC').bind(username).all()
  let remainingToPay = totalPrice
  for (const userPenalty of (userPenalties.results || [])) {
    if (remainingToPay <= 0) break
    if (userPenalty.amount <= remainingToPay) {
      remainingToPay -= userPenalty.amount
      await DB.prepare('DELETE FROM penalties WHERE id = ?').bind(userPenalty.id).run()
    } else {
      const newAmount = Math.round((userPenalty.amount - remainingToPay) * 100) / 100
      await DB.prepare('UPDATE penalties SET amount = ? WHERE id = ?').bind(newAmount, userPenalty.id).run()
      remainingToPay = 0
    }
  }

  const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

  // 资产变更记录
  await logAssetChange(DB, username, 'balance', '消除惩罚', `-${totalPrice}（${penalty.name} x${quantity}）`)

  return new Response(JSON.stringify({ success: true, message: `成功消除惩罚 ${penalty.name} x${quantity}`, balance: updatedUser.balance }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// ==================== 转盘系统 ====================

// 校验并规范化转盘配置项
function normalizeWheelItems(items, wheelType) {
  if (!Array.isArray(items)) return null
  const result = []
  for (const item of items) {
    // 允许在奖励转盘中混入惩罚项目（反之亦然）；type 非法时回退到转盘类型
    let type = item.type
    if (type !== 'chip' && type !== 'reward' && type !== 'penalty') type = wheelType
    // count 即权重：决定中奖概率与转盘上所占面积（格子数）
    const count = Math.max(1, Math.min(99, parseInt(item.count) || 1))
    if (type === 'chip') {
      const amount = Number(item.amount)
      if (isNaN(amount) || amount <= 0) return null
      result.push({ type: 'chip', amount, count })
    } else {
      const refId = parseInt(item.refId)
      const name = (item.name || '').toString().trim()
      if (!refId || !name) return null
      const resultItem = { type, refId, name, count }
      // 惩罚项目不再定义数量 N：数量由“数量小转盘”单独转出
      result.push(resultItem)
    }
  }
  return result
}

// 校验并规范化“数量小转盘”配置项（惩罚数量由该转盘转出）
function normalizeQuantityItems(items) {
  if (!Array.isArray(items)) return null
  const result = []
  for (const item of items) {
    const times = parseInt(item.times)
    if (isNaN(times) || times <= 0) return null
    const count = Math.max(1, Math.min(99, parseInt(item.count) || 1))
    result.push({ times: Math.min(999, times), count })
  }
  return result
}

// 统计用户每个转盘的有效已用次数（扣除管理员重置偏移）
async function getWheelUsedSpins(DB, username) {
  const counts = { reward: 0, penalty: 0 }
  const rows = await DB.prepare('SELECT wheel_type, COUNT(*) AS c FROM wheel_spins WHERE username = ? GROUP BY wheel_type').bind(username).all()
  for (const row of rows.results || []) {
    if (row.wheel_type === 'reward') counts.reward = row.c
    if (row.wheel_type === 'penalty') counts.penalty = row.c
  }
  const resets = await DB.prepare('SELECT wheel_type, reset_offset FROM wheel_spin_resets WHERE username = ?').bind(username).all()
  for (const row of resets.results || []) {
    if (row.wheel_type === 'reward' || row.wheel_type === 'penalty') {
      counts[row.wheel_type] = Math.max(0, counts[row.wheel_type] - (row.reset_offset || 0))
    }
  }
  return counts
}

// 获取转盘次数限制：按用户定义优先，未定义(NULL)则跟随全局设置；0 = 不限
async function getWheelLimits(DB, username) {
  const settingsRow = await DB.prepare('SELECT spin_limit_per_user FROM wheel_settings WHERE id = 1').first()
  const globalLimit = settingsRow ? (settingsRow.spin_limit_per_user || 0) : 0
  const limits = { reward: globalLimit, penalty: globalLimit }
  if (username) {
    const row = await DB.prepare('SELECT reward_limit, penalty_limit FROM user_wheel_limits WHERE username = ?').bind(username).first()
    if (row) {
      if (row.reward_limit !== null && row.reward_limit !== undefined) limits.reward = row.reward_limit
      if (row.penalty_limit !== null && row.penalty_limit !== undefined) limits.penalty = row.penalty_limit
    }
  }
  return limits
}

// 获取转盘配置（所有用户可见）；带登录态时附带当前用户已用次数
async function handleGetWheelConfig(request, DB) {
  const rows = await DB.prepare('SELECT wheel_type, items FROM wheel_config').all()
  const config = { reward: [], penalty: [], penaltyQuantity: [] }
  for (const row of rows.results || []) {
    try {
      const parsed = JSON.parse(row.items)
      if (Array.isArray(parsed)) {
        if (row.wheel_type === 'penalty_quantity') config.penaltyQuantity = parsed
        else config[row.wheel_type] = parsed
      }
    } catch (e) {}
  }
  const settingsRow = await DB.prepare('SELECT spin_limit_per_user FROM wheel_settings WHERE id = 1').first()
  const spinLimitPerUser = settingsRow ? (settingsRow.spin_limit_per_user || 0) : 0

  let usedSpins = null
  let spinLimits = { reward: spinLimitPerUser, penalty: spinLimitPerUser }
  const authResult = await authenticate(request, DB)
  if (!authResult.error) {
    // 每个转盘单独计数（含重置偏移）；次数限制按用户定义优先
    usedSpins = await getWheelUsedSpins(DB, authResult.username)
    spinLimits = await getWheelLimits(DB, authResult.username)
  }

  return new Response(JSON.stringify({ success: true, data: { reward: config.reward, penalty: config.penalty, penaltyQuantity: config.penaltyQuantity, spinLimitPerUser, spinLimits, usedSpins } }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 保存转盘配置（管理员）
async function handleUpdateWheelConfig(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  if (authResult.role !== 'admin') {
    return new Response(JSON.stringify({ error: '仅管理员可操作' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const { reward, penalty, penaltyQuantity, spinLimitPerUser } = await request.json()
  const rewardItems = normalizeWheelItems(reward, 'reward')
  const penaltyItems = normalizeWheelItems(penalty, 'penalty')
  const quantityItems = normalizeQuantityItems(penaltyQuantity)
  if (rewardItems === null || penaltyItems === null || quantityItems === null) {
    return new Response(JSON.stringify({ error: '转盘配置格式不正确' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  for (const [wheelType, items] of [['reward', rewardItems], ['penalty', penaltyItems], ['penalty_quantity', quantityItems]]) {
    const existing = await DB.prepare('SELECT wheel_type FROM wheel_config WHERE wheel_type = ?').bind(wheelType).first()
    if (existing) {
      await DB.prepare("UPDATE wheel_config SET items = ?, updated_at = datetime('now') WHERE wheel_type = ?")
        .bind(JSON.stringify(items), wheelType).run()
    } else {
      await DB.prepare('INSERT INTO wheel_config (wheel_type, items) VALUES (?, ?)')
        .bind(wheelType, JSON.stringify(items)).run()
    }
  }

  // 保存每用户可转次数（0 = 不限）
  let savedLimit = 0
  if (spinLimitPerUser !== undefined) {
    savedLimit = Math.max(0, Math.min(999999, parseInt(spinLimitPerUser) || 0))
    const existingSetting = await DB.prepare('SELECT id FROM wheel_settings WHERE id = 1').first()
    if (existingSetting) {
      await DB.prepare('UPDATE wheel_settings SET spin_limit_per_user = ? WHERE id = 1').bind(savedLimit).run()
    } else {
      await DB.prepare('INSERT INTO wheel_settings (id, spin_limit_per_user) VALUES (1, ?)').bind(savedLimit).run()
    }
  } else {
    const settingsRow = await DB.prepare('SELECT spin_limit_per_user FROM wheel_settings WHERE id = 1').first()
    savedLimit = settingsRow ? (settingsRow.spin_limit_per_user || 0) : 0
  }

  return new Response(JSON.stringify({ success: true, data: { reward: rewardItems, penalty: penaltyItems, penaltyQuantity: quantityItems, spinLimitPerUser: savedLimit } }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 转动转盘：服务端随机决定结果并生效
async function handleWheelSpin(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { wheelType } = await request.json()

  if (wheelType !== 'reward' && wheelType !== 'penalty') {
    return new Response(JSON.stringify({ error: '转盘类型不正确' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // 检查可转次数：按用户定义优先，未定义跟随全局（0 = 不限，两个转盘分开计数）
  const limits = await getWheelLimits(DB, username)
  const spinLimit = limits[wheelType] || 0
  let usedSpins = 0
  if (spinLimit > 0) {
    usedSpins = (await getWheelUsedSpins(DB, username))[wheelType] || 0
    if (usedSpins >= spinLimit) {
      return new Response(JSON.stringify({ error: `该转盘次数已用完（${usedSpins}/${spinLimit}）` }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  }

  const configRow = await DB.prepare('SELECT items FROM wheel_config WHERE wheel_type = ?').bind(wheelType).first()
  let items = []
  try { items = JSON.parse(configRow?.items) || [] } catch (e) {}
  if (!Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ error: '转盘尚未配置' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // 按权重展开成格子：权重同时决定中奖概率与转盘面积
  const segments = []
  for (const item of items) {
    const count = Math.max(1, parseInt(item.count) || 1)
    for (let i = 0; i < count; i++) segments.push(item)
  }

  const index = Math.floor(Math.random() * segments.length)
  const item = segments[index]

  let message = ''
  let balance = null
  let image = null
  let quantityWheelResult = null // 惩罚命中时：数量小转盘的服务端结果

  if (item.type === 'chip') {
    if (wheelType === 'reward') {
      await DB.prepare('UPDATE users SET balance = balance + ? WHERE username = ?').bind(item.amount, username).run()
      message = `🎉 恭喜获得 ${item.amount} 筹码！`
    } else {
      await DB.prepare('UPDATE users SET balance = balance - ? WHERE username = ?').bind(item.amount, username).run()
      message = `😖 惩罚：扣除 ${item.amount} 筹码`
    }
    const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()
    balance = updatedUser.balance
    // 资产变更记录
    await logAssetChange(DB, username, 'balance', item.amount > 0 ? '转盘获得筹码' : '转盘扣除筹码',
      `${item.amount > 0 ? '+' : ''}${item.amount}`)
  } else {
    // 效果按项目类型生效（奖励转盘中混入的惩罚项目同样生效）
    const table = item.type === 'reward' ? 'reward_types' : 'penalty_types'
    const typeRow = await DB.prepare(`SELECT name, price, image FROM ${table} WHERE id = ?`).bind(item.refId).first()
    const name = typeRow ? typeRow.name : item.name
    image = typeRow ? (typeRow.image || null) : null
    if (item.type === 'reward') {
      // 奖励直接添加到用户奖励资产（同名合并数量）
      const quantity = 1
      const existingReward = await DB.prepare(
        'SELECT id FROM rewards WHERE username = ? AND name = ?'
      ).bind(username, name).first()
      if (existingReward) {
        await DB.prepare(
          "UPDATE rewards SET quantity = quantity + ?, value = value + ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(quantity, typeRow ? typeRow.price : 0, existingReward.id).run()
      } else {
        await DB.prepare(
          'INSERT INTO rewards (username, name, value, description, quantity) VALUES (?, ?, ?, ?, ?)'
        ).bind(username, name, typeRow ? typeRow.price : 0, '', quantity).run()
      }
      message = `🎉 恭喜获得奖励：${name}！`
      await logAssetChange(DB, username, 'reward', `转盘获得奖励：${name}`,
        quantity > 1 ? `x${quantity}` : '')
    } else {
      // 惩罚数量由“数量小转盘”决定：服务端随机转出（未配置则回退旧配置的 times，再退 1）
      const qtyRow = await DB.prepare("SELECT items FROM wheel_config WHERE wheel_type = 'penalty_quantity'").first()
      let qtyItems = []
      try { qtyItems = JSON.parse(qtyRow?.items) || [] } catch (e) {}
      const qtySegments = []
      for (const q of (Array.isArray(qtyItems) ? qtyItems : [])) {
        const c = Math.max(1, parseInt(q.count) || 1)
        for (let i = 0; i < c; i++) qtySegments.push(q)
      }
      let quantity = 1
      let qtyIndex = -1
      if (qtySegments.length > 0) {
        qtyIndex = Math.floor(Math.random() * qtySegments.length)
        quantity = Math.max(1, parseInt(qtySegments[qtyIndex].times) || 1)
      } else if (item.times && item.times > 0) {
        quantity = item.times // 兼容旧配置：数量小转盘未配置时沿用惩罚项目原定义
      }
      const timesSuffix = quantity > 1 ? ` ${quantity}下` : ''
      // 惩罚直接添加到用户惩罚记录（同名合并数量）
      const existingPenalty = await DB.prepare(
        'SELECT id FROM penalties WHERE username = ? AND name = ?'
      ).bind(username, name).first()
      if (existingPenalty) {
        await DB.prepare(
          "UPDATE penalties SET quantity = quantity + ?, amount = amount + ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(quantity, typeRow ? typeRow.price : 0, existingPenalty.id).run()
      } else {
        await DB.prepare(
          'INSERT INTO penalties (username, name, amount, description, quantity) VALUES (?, ?, ?, ?, ?)'
        ).bind(username, name, typeRow ? typeRow.price : 0, '', quantity).run()
      }
      message = `😖 惩罚：${name}${timesSuffix}`
      await logAssetChange(DB, username, 'penalty', `转盘增加惩罚：${name}`,
        quantity > 1 ? `x${quantity}` : '')
      if (qtyIndex >= 0) quantityWheelResult = { index: qtyIndex, quantity, items: qtyItems }
    }
  }

  await DB.prepare(
    'INSERT INTO wheel_spins (username, wheel_type, item_type, item_name, amount) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    username, wheelType, item.type,
    item.type === 'chip' ? `${item.amount} 筹码` : `${item.name}${item.type === 'penalty' && quantityWheelResult ? ` ${quantityWheelResult.quantity}下` : ''}`,
    item.type === 'chip' ? item.amount : null
  ).run()

  const remaining = spinLimit > 0 ? Math.max(0, spinLimit - usedSpins - 1) : null

  return new Response(JSON.stringify({
    success: true,
    index,
    item: item.type === 'chip' ? { type: 'chip', name: `${item.amount} 筹码`, amount: item.amount } : { type: item.type, name: item.name },
    message,
    balance,
    image,
    remaining,
    quantityWheel: quantityWheelResult
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 获取转盘历史记录（最近20条，所有用户可见）
async function handleGetWheelHistory(DB) {
  const spins = await DB.prepare(
    'SELECT id, username, wheel_type, item_type, item_name, amount, created_at FROM wheel_spins ORDER BY created_at DESC, id DESC LIMIT 20'
  ).all()
  return new Response(JSON.stringify({ success: true, data: spins.results || [] }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 管理员重置用户转盘次数：将当前已用次数记为偏移，统计时跳过
async function handleAdminWheelReset(request, DB, username) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  if (authResult.role !== 'admin') {
    return new Response(JSON.stringify({ error: '仅管理员可操作' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  if (!username) {
    return new Response(JSON.stringify({ error: '缺少用户名' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const user = await DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first()
  if (!user) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const { wheelType } = await request.json().catch(() => ({}))
  const targets = wheelType === 'reward' || wheelType === 'penalty' ? [wheelType] : ['reward', 'penalty']

  for (const type of targets) {
    const countRow = await DB.prepare('SELECT COUNT(*) AS c FROM wheel_spins WHERE username = ? AND wheel_type = ?').bind(username, type).first()
    const offset = countRow ? countRow.c : 0
    const existing = await DB.prepare('SELECT username FROM wheel_spin_resets WHERE username = ? AND wheel_type = ?').bind(username, type).first()
    if (existing) {
      await DB.prepare("UPDATE wheel_spin_resets SET reset_offset = ?, updated_at = datetime('now') WHERE username = ? AND wheel_type = ?")
        .bind(offset, username, type).run()
    } else {
      await DB.prepare('INSERT INTO wheel_spin_resets (username, wheel_type, reset_offset) VALUES (?, ?, ?)')
        .bind(username, type, offset).run()
    }
  }

  return new Response(JSON.stringify({ success: true, message: `已重置用户「${username}」的转盘次数` }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 获取按用户定义的转盘次数（NULL = 跟随全局）
async function handleGetUserWheelLimits(request, DB, username) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  if (authResult.role !== 'admin') {
    return new Response(JSON.stringify({ error: '仅管理员可操作' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  const row = await DB.prepare('SELECT reward_limit, penalty_limit FROM user_wheel_limits WHERE username = ?').bind(username).first()
  return new Response(JSON.stringify({
    success: true,
    data: {
      reward: row ? row.reward_limit : null,
      penalty: row ? row.penalty_limit : null
    }
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 设置按用户定义的转盘次数（null = 跟随全局，0 = 不限）
async function handleUpdateUserWheelLimits(request, DB, username) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  if (authResult.role !== 'admin') {
    return new Response(JSON.stringify({ error: '仅管理员可操作' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const user = await DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first()
  if (!user) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const { reward, penalty } = await request.json()
  // 空值 = 跟随全局设置；数字 = 具体次数（0 = 不限）
  const toLimit = v => (v === null || v === undefined || v === '')
    ? null
    : Math.max(0, Math.min(999999, parseInt(v) || 0))
  const rewardLimit = toLimit(reward)
  const penaltyLimit = toLimit(penalty)

  const existing = await DB.prepare('SELECT username FROM user_wheel_limits WHERE username = ?').bind(username).first()
  if (existing) {
    await DB.prepare("UPDATE user_wheel_limits SET reward_limit = ?, penalty_limit = ?, updated_at = datetime('now') WHERE username = ?")
      .bind(rewardLimit, penaltyLimit, username).run()
  } else {
    await DB.prepare('INSERT INTO user_wheel_limits (username, reward_limit, penalty_limit) VALUES (?, ?, ?)')
      .bind(username, rewardLimit, penaltyLimit).run()
  }

  return new Response(JSON.stringify({
    success: true,
    data: { reward: rewardLimit, penalty: penaltyLimit },
    message: `已保存用户「${username}」的转盘次数设置`
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// ==================== 银行/贷款系统 ====================

// 获取贷款配置
async function handleGetLoanConfig(DB) {
  const config = await DB.prepare('SELECT * FROM loan_config ORDER BY id DESC LIMIT 1').first()
  return new Response(JSON.stringify({ success: true, data: config || {} }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 更新贷款配置（管理员）
async function handleUpdateLoanConfig(request, DB) {
  const { max_amount, max_term_days, interest_rate, daily_penalty_rate } = await request.json()

  const existing = await DB.prepare('SELECT id FROM loan_config ORDER BY id DESC LIMIT 1').first()
  if (existing) {
    await DB.prepare(
      'UPDATE loan_config SET max_amount = ?, max_term_days = ?, interest_rate = ?, daily_penalty_rate = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(max_amount, max_term_days, interest_rate, daily_penalty_rate, existing.id).run()
  } else {
    await DB.prepare(
      'INSERT INTO loan_config (max_amount, max_term_days, interest_rate, daily_penalty_rate) VALUES (?, ?, ?, ?)'
    ).bind(max_amount, max_term_days, interest_rate, daily_penalty_rate).run()
  }

  const config = await DB.prepare('SELECT * FROM loan_config ORDER BY id DESC LIMIT 1').first()
  return new Response(JSON.stringify({ success: true, data: config }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 计算贷款应还总额
function calculateLoanRepayment(amount, interestRate, termDays) {
  return Math.round(amount * (1 + interestRate / 100 * termDays / 30) * 100) / 100
}

// 申请贷款
async function handleApplyLoan(request, DB) {
  // 检查银行状态
  const bankCfg = await DB.prepare('SELECT bank_open FROM loan_config ORDER BY id DESC LIMIT 1').first()
  if (bankCfg && bankCfg.bank_open === 0) {
    return new Response(JSON.stringify({ error: '银行目前已关闭，无法申请贷款' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { amount, termDays } = await request.json()

  const config = await DB.prepare('SELECT * FROM loan_config ORDER BY id DESC LIMIT 1').first()
  if (!config) {
    return new Response(JSON.stringify({ error: '贷款系统尚未配置' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (amount > config.max_amount) {
    return new Response(JSON.stringify({ error: `贷款金额不能超过 ¥${config.max_amount}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (termDays > config.max_term_days) {
    return new Response(JSON.stringify({ error: `贷款期限不能超过 ${config.max_term_days} 天` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (termDays < 1) {
    return new Response(JSON.stringify({ error: '贷款期限至少为1天' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const interestRate = config.interest_rate
  const totalRepay = calculateLoanRepayment(amount, interestRate, termDays)

  // 创建贷款记录
  const dueDate = new Date()
  dueDate.setDate(dueDate.getDate() + termDays)
  const dueDateStr = dueDate.toISOString().split('T')[0]

  const result = await DB.prepare(
    'INSERT INTO loans (username, amount, interest_rate, term_days, total_repay, remaining, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(username, amount, interestRate, termDays, totalRepay, totalRepay, dueDateStr).run()

  // 放款到用户筹码
  await DB.prepare('UPDATE users SET balance = balance + ? WHERE username = ?').bind(amount, username).run()

  const loan = await DB.prepare('SELECT * FROM loans WHERE id = ?').bind(result.meta.last_row_id).first()
  const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

  return new Response(JSON.stringify({ success: true, message: '贷款成功', data: loan, balance: updatedUser.balance }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 获取用户贷款列表
async function handleGetLoans(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult

  const loans = await DB.prepare('SELECT * FROM loans WHERE username = ? ORDER BY created_at DESC').bind(username).all()

  // 计算逾期状态
  const now = new Date()
  const processedLoans = (loans.results || []).map(loan => {
    const dueDate = new Date(loan.due_date)
    const isOverdue = now > dueDate && loan.status === 'active'
    return { ...loan, is_overdue: isOverdue }
  })

  return new Response(JSON.stringify({ success: true, data: processedLoans }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 获取所有贷款（管理员）
async function handleGetAllLoans(DB) {
  const loans = await DB.prepare('SELECT loans.*, users.balance FROM loans LEFT JOIN users ON loans.username = users.username ORDER BY loans.created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: loans.results || [] }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 还款
async function handleRepayLoan(request, DB) {
  const authResult = await authenticate(request, DB)
  if (authResult.error) return authResult.response
  const { username } = authResult
  const { loanId, amount } = await request.json()

  const loan = await DB.prepare('SELECT * FROM loans WHERE id = ? AND username = ?').bind(loanId, username).first()
  if (!loan) {
    return new Response(JSON.stringify({ error: '贷款记录不存在' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (loan.status !== 'active') {
    return new Response(JSON.stringify({ error: '该贷款已结清' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const repayAmount = amount || loan.remaining
  if (repayAmount > loan.remaining) {
    return new Response(JSON.stringify({ error: `还款金额不能超过剩余欠款 ¥${loan.remaining}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const user = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()
  if (user.balance < repayAmount) {
    return new Response(JSON.stringify({ error: '筹码不足' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = balance - ? WHERE username = ?').bind(repayAmount, username).run()
  const newRemaining = Math.round((loan.remaining - repayAmount) * 100) / 100

  if (newRemaining <= 0) {
    await DB.prepare(
      'UPDATE loans SET remaining = 0, status = ?, repaid_at = datetime(\'now\') WHERE id = ?'
    ).bind('repaid', loanId).run()
  } else {
    await DB.prepare('UPDATE loans SET remaining = ? WHERE id = ?').bind(newRemaining, loanId).run()
  }

  const updatedLoan = await DB.prepare('SELECT * FROM loans WHERE id = ?').bind(loanId).first()
  const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

  const isFullyRepaid = newRemaining <= 0
  return new Response(JSON.stringify({
    success: true,
    message: isFullyRepaid ? '贷款已全部还清' : `已还款 ¥${repayAmount}，剩余 ¥${newRemaining}`,
    data: updatedLoan,
    balance: updatedUser.balance
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// 结清贷款（管理员强制结清）
async function handleSettleLoan(request, DB) {
  const { loanId } = await request.json()

  const loan = await DB.prepare('SELECT * FROM loans WHERE id = ?').bind(loanId).first()
  if (!loan) {
    return new Response(JSON.stringify({ error: '贷款记录不存在' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare(
    'UPDATE loans SET remaining = 0, status = ?, repaid_at = datetime(\'now\') WHERE id = ?'
  ).bind('settled', loanId).run()

  return new Response(JSON.stringify({ success: true, message: '贷款已强制结清' }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function authenticate(request, DB) {
  try {
    return await requireAuth(request, DB)
  } catch (error) {
    return {
      error: true,
      response: new Response(JSON.stringify({ error: error.message || '未授权' }), {
        status: error.status || 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  }
}

async function handleStatic(request, env) {
  const url = new URL(request.url)
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await env.__STATIC_CONTENT.fetch(request)
    if (html.ok) return html
  }

  return new Response('Not Found', { status: 404 })
}