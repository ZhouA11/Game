const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

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
  const path = url.pathname.split('/').filter(Boolean).slice(1)
  const DB = env.game_database

  await ensureDefaultAdmin(DB)
  await ensureTables(DB)

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
    }
    
    if (path[0] === 'admin' && path[1] === 'user' && path[2] === 'balance') {
      return handleUpdateUserBalance(request, DB, path[3])
    }
    
    if (path[0] === 'admin' && path[1] === 'user' && path[2] === 'password' && path[3] === 'reset') {
      return handleResetPassword(request, DB, path[4])
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
    if (path[0] === 'messages' && request.method === 'POST') {
      return handleCreateMessage(request, DB)
    }
    // 管理员删除留言
    if (path[0] === 'admin' && path[1] === 'messages' && path[2] && request.method === 'DELETE') {
      return handleDeleteMessage(request, DB, path[2])
    }

    // === 用户自己的资产信息 ===
    if (path[0] === 'user' && path[1] === 'assets') {
      return handleGetUserAssets(request, DB)
    }

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

async function hashPassword(password) {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function ensureDefaultAdmin(DB) {
  try {
    const existing = await DB.prepare('SELECT id FROM users WHERE username = ?').bind('zhou').first()
    if (!existing) {
      const hashedPassword = await hashPassword('Asd123**')
      await DB.prepare(
        'INSERT INTO users (username, password, role, balance) VALUES (?, ?, ?, ?)'
      ).bind('zhou', hashedPassword, 'admin', 999999).run()
    }
  } catch (error) {
    console.error('Failed to ensure default admin:', error)
    // 不抛出错误，允许其他 API 继续工作
  }
}

async function ensureTables(DB) {
  try {
    await DB.prepare(
      'CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, image TEXT, created_by TEXT, is_pinned INTEGER DEFAULT 0, is_displayed INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)'
    ).run()
    await DB.prepare(
      'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, content TEXT NOT NULL, image TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)'
    ).run()
    // 兼容旧表：尝试添加新列（表已存在时忽略错误）
    try { await DB.prepare('ALTER TABLE announcements ADD COLUMN image TEXT').run() } catch(e) {}
    try { await DB.prepare('ALTER TABLE announcements ADD COLUMN is_pinned INTEGER DEFAULT 0').run() } catch(e) {}
    try { await DB.prepare('ALTER TABLE announcements ADD COLUMN is_displayed INTEGER DEFAULT 0').run() } catch(e) {}
    try { await DB.prepare('ALTER TABLE messages ADD COLUMN image TEXT').run() } catch(e) {}
    try { await DB.prepare('ALTER TABLE loan_config ADD COLUMN bank_open INTEGER DEFAULT 1').run() } catch(e) {}
  } catch (error) {
    console.error('Failed to ensure tables:', error)
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
  
  const result = await DB.prepare(
    'INSERT INTO rewards (username, name, value, description) VALUES (?, ?, ?, ?)'
  ).bind(reward.username, reward.name, reward.value, reward.description || '').run()

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
    'UPDATE rewards SET name = ?, value = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(reward.name, reward.value, reward.description || '', id).run()

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
  
  const result = await DB.prepare(
    'INSERT INTO penalties (username, name, amount, description) VALUES (?, ?, ?, ?)'
  ).bind(penalty.username, penalty.name, penalty.amount, penalty.description || '').run()

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
    'UPDATE penalties SET name = ?, amount = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(penalty.name, penalty.amount, penalty.description || '', id).run()

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
    return new Response(JSON.stringify({ error: '余额不足' }), {
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
  return new Response(JSON.stringify({ success: true, data: messages.results || [] }), {
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
  return new Response(JSON.stringify({ success: true, message: '留言已删除' }), {
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

async function handleGetUsers(DB) {
  const users = await DB.prepare('SELECT username, role, balance, created_at FROM users ORDER BY created_at DESC').all()
  return new Response(JSON.stringify({ success: true, data: users.results || [] }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

async function handleUpdateUserBalance(request, DB, username) {
  const { balance } = await request.json()
  
  const existing = await DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (!existing) {
    return new Response(JSON.stringify({ error: '用户不存在' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = ?, updated_at = datetime(\'now\') WHERE username = ?')
    .bind(balance, username).run()

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
    return new Response(JSON.stringify({ error: '余额不足' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  await DB.prepare('UPDATE users SET balance = balance - ? WHERE username = ?').bind(totalPrice, username).run()
  await DB.prepare(
    'INSERT INTO redemptions (username, reward_type_id, reward_name, price, quantity) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, reward.id, reward.name, reward.price, quantity).run()

  // 将兑换的奖励添加到用户的奖励资产中
  for (let i = 0; i < quantity; i++) {
    await DB.prepare(
      'INSERT INTO rewards (username, name, value, description) VALUES (?, ?, ?, ?)'
    ).bind(username, reward.name, reward.price, reward.description || '从商店兑换').run()
  }

  const updatedUser = await DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first()

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
    return new Response(JSON.stringify({ error: '余额不足' }), {
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

  return new Response(JSON.stringify({ success: true, message: `成功消除惩罚 ${penalty.name} x${quantity}`, balance: updatedUser.balance }), {
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

  // 放款到用户余额
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
    return new Response(JSON.stringify({ error: '余额不足' }), {
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
  const token = request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) {
    return {
      error: true,
      response: new Response(JSON.stringify({ error: '未授权' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  }

  const tokenData = await DB.prepare(
    'SELECT username, expires_at FROM tokens WHERE token = ?'
  ).bind(token).first()

  if (!tokenData || tokenData.expires_at < Date.now()) {
    return {
      error: true,
      response: new Response(JSON.stringify({ error: '无效的token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  }

  const user = await DB.prepare('SELECT username, role FROM users WHERE username = ?').bind(tokenData.username).first()
  if (!user) {
    return {
      error: true,
      response: new Response(JSON.stringify({ error: '用户不存在' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
  }

  return { username: user.username, role: user.role }
}

async function handleStatic(request, env) {
  const url = new URL(request.url)
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await env.__STATIC_CONTENT.fetch(request)
    if (html.ok) return html
  }

  return new Response('Not Found', { status: 404 })
}