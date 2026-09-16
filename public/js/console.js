// 运营后台 · 前端（步骤6 八模块）
const $ = id => document.getElementById(id)
const pct = v => (v * 100).toFixed(2) + '%'

async function api(path, body, method) {
  const token = localStorage.getItem('token')
  const res = await fetch(`/api${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    const err = new Error(data.msg || data.error || '请求失败')
    err.code = data.code
    throw err
  }
  return data.data
}
const put = (path, payload) => api(path, payload, 'PUT')
const del = (path) => api(path, undefined, 'DELETE')

function toast(msg) {
  const t = $('grabToast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 3000)
}

async function loadConsole() {
  document.querySelectorAll('.panel-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(x => x.classList.remove('active'))
    t.classList.add('active')
    document.querySelectorAll('.tab-page').forEach(p => p.style.display = 'none')
    $(`tab-${t.dataset.tab}`).style.display = 'block'
    loadTab(t.dataset.tab)
  }))
  $('npCreate').addEventListener('click', createProduct)
  $('penCreate').addEventListener('click', createPenalty)
  $('adjSubmit').addEventListener('click', submitAdjust)
  $('rtpCalc').addEventListener('click', calcRtp)
  $('bagRefresh').addEventListener('click', loadBags)
  loadTab('dash')
}

function loadTab(tab) {
  if (tab === 'dash') loadDashboard()
  if (tab === 'shop') loadShop()
  if (tab === 'reward') { loadRewards(); loadBags() }
  if (tab === 'penalty') loadPenalties()
  if (tab === 'adjust') loadAdjust()
  if (tab === 'rtp') { calcRtp(); loadReviews() }
  if (tab === 'rarity') loadRarity()
  if (tab === 'audit') loadAudit()
}

// ---------- 看板 ----------
async function loadDashboard() {
  const d = await api('/admin/kernel/dashboard')
  $('dGrab').textContent = pct(d.rtp.grab.rtp)
  $('dSlot').textContent = pct(d.rtp.slot.rtp)
  $('dPending').textContent = d.pendingAdjustments
  $('dSkip').textContent = d.dropSkipCount
  $('dPenalties').innerHTML = d.penalties.map(p =>
    `<div class="stat-line"><span>L${p.rarity} ${p.name}</span><b>累计 ${p.applied} · 减免 ${p.reduced} · 减免率 ${p.reduceRate}%</b></div>`).join('')
  $('dStock').innerHTML = d.stockAlerts.map(a =>
    `<div class="stat-line"><span>${a.name}</span><b style="color:${a.stock === 0 ? '#ff6b81' : '#ffd700'}">${a.stock === 0 ? '已空（掉落自动跳过）' : `仅剩 ${a.stock}`}</b></div>`).join('')
    || '<div class="stat-line">库存健康</div>'
  $('dSynth').textContent = d.fragments.synthCount
  $('dFrag').textContent = d.fragments.held
  $('dAdjust').innerHTML = d.adjustments.map(a =>
    `<div class="stat-line"><span>${a.operator} · ${a.target_type}</span><b>${a.count} 次 / 总量 ${a.total_amount}</b></div>`).join('') || '<div class="stat-line">暂无调整记录</div>'
}

// ---------- 商品 ----------
async function loadShop() {
  const { products } = await api('/mall/admin/products')
  $('shopList').innerHTML = products.map(p => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">#${p.id} ${p.name} <span class="p-rarity r${p.rarity}" style="position:static">L${p.rarity}</span></div>
        <div class="i-sub">${p.category} · ${p.currency === 'coin' ? '金币' : '活跃值'} ${p.price} 币 · 限购 ${p.daily_limit ?? '默认'}/日 · ${p.is_active ? '在售' : '已下架'}</div>
      </div>
      <button class="mini-btn" data-toggle="${p.id}" data-active="${p.is_active}">${p.is_active ? '下架' : '上架'}</button>
    </div>`).join('')
  $('shopList').querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    try {
      await put(`/mall/admin/products/${b.dataset.toggle}`, { is_active: b.dataset.active === '1' ? 0 : 1 })
      toast('✅ 已更新')
      loadShop()
    } catch (e) { toast(e.message) }
  }))
}

async function createProduct() {
  try {
    await api('/mall/admin/products', {
      item_id: +$('npItem').value, currency: $('npCurrency').value,
      price: +$('npPrice').value, daily_limit: $('npLimit').value === '' ? null : +$('npLimit').value,
    })
    toast('✅ 商品已上架')
    loadShop()
  } catch (e) { toast(e.message) }
}

// ---------- 奖励 ----------
async function loadRewards() {
  const { templates } = await api('/admin/kernel/templates/reward')
  $('rewardList').innerHTML = templates.map(t => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">#${t.id} ${t.name} <span class="p-rarity r${t.rarity}" style="position:static">L${t.rarity}</span></div>
        <div class="i-sub">库存 ${t.stock < 0 ? '∞' : t.stock} · 折算价值 ${t.value} 币 · ${t.is_active ? '启用' : '停用'}</div>
      </div>
      <button class="mini-btn" data-stock="${t.id}" data-cur="${t.stock}">补货+10</button>
    </div>`).join('')
  $('rewardList').querySelectorAll('[data-stock]').forEach(b => b.addEventListener('click', async () => {
    try {
      await put(`/admin/kernel/templates/reward/${b.dataset.stock}`, { stock: +b.dataset.cur < 0 ? -1 : +b.dataset.cur + 10 })
      toast('✅ 已补货')
      loadRewards()
    } catch (e) { toast(e.message) }
  }))
}

async function loadBags() {
  const { bags } = await api(`/admin/kernel/reward-bags?username=${encodeURIComponent($('bagUser').value.trim())}`)
  $('bagList').innerHTML = bags.map(b => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">${b.username} · ${b.name}</div>
        <div class="i-sub">${b.status === 'pending' ? '待核销' : '已发货'} ×${b.quantity}</div>
      </div>
      ${b.status === 'pending' ? `<button class="mini-btn primary" data-deliver="${b.username}|${b.reward_id}">标记发货</button>` : ''}
    </div>`).join('') || '<div class="stat-line">暂无记录</div>'
  $('bagList').querySelectorAll('[data-deliver]').forEach(b => b.addEventListener('click', async () => {
    const [username, reward_id] = b.dataset.deliver.split('|')
    try {
      await api('/admin/kernel/reward-bags/deliver', { username, reward_id: +reward_id })
      toast('📦 已标记发货')
      loadBags()
    } catch (e) { toast(e.message) }
  }))
}

// ---------- 惩罚 ----------
async function loadPenalties() {
  const { templates } = await api('/admin/kernel/templates/penalty')
  const params = await api('/admin/kernel/params')
  const unit = (params.params.find(p => p.key === 'reduce_unit_price') || {}).value
  $('unitPrice').textContent = unit
  $('penList').innerHTML = templates.map(t => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">#${t.id} ${t.name} <span class="p-rarity r${t.rarity}" style="position:static">L${t.rarity}</span></div>
        <div class="i-sub">单次 Spank ${t.spank_min}~${t.spank_max} · 累计上限 ${t.spank_cap} · ${t.is_active ? '启用' : '停用'}</div>
      </div>
      <button class="mini-btn" data-dis="${t.id}">${t.is_active ? '停用' : '启用'}</button>
    </div>`).join('')
  $('penList').querySelectorAll('[data-dis]').forEach(b => b.addEventListener('click', async () => {
    try {
      const id = b.dataset.dis
      const t = templates.find(x => String(x.id) === id)
      await put(`/admin/kernel/templates/penalty/${id}`, { is_active: t.is_active ? 0 : 1 })
      toast('✅ 已更新')
      loadPenalties()
    } catch (e) { toast(e.message) }
  }))
}

async function createPenalty() {
  try {
    await api('/admin/kernel/templates/penalty', {
      name: $('npName').value, rarity: +$('npRarity').value,
      spank_min: +$('npMin').value, spank_max: +$('npMax').value, spank_cap: 200,
    })
    toast('✅ 惩罚道具已创建（提审生效后进入掉落配置即可在结算中累加 Spank）')
    loadPenalties()
  } catch (e) { toast(e.message) }
}

// ---------- 玩家调整 ----------
async function loadAdjust() {
  const { adjustments } = await api('/admin/kernel/adjustments?limit=20')
  $('adjPending').textContent = adjustments.filter(a => a.status === 'pending').length
  $('adjList').innerHTML = adjustments.map(a => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">${a.username} · ${a.target_type}${a.target_id ? '#' + a.target_id : ''} ${a.delta >= 0 ? '+' : ''}${a.delta}</div>
        <div class="i-sub">${a.reason} · 操作人 ${a.requested_by} · ${a.status === 'pending' ? '⏳ 待审批' : a.status === 'applied' ? '已生效' : '已驳回'}</div>
      </div>
      ${a.status === 'pending' ? `
        <button class="mini-btn primary" data-approve="${a.id}">批准</button>
        <button class="mini-btn" data-reject="${a.id}">驳回</button>` : ''}
    </div>`).join('')
  $('adjList').querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/admin/kernel/adjustments/${b.dataset.approve}/approve`, {}); toast('✅ 已批准生效'); loadAdjust() }
    catch (e) { toast(e.message) }
  }))
  $('adjList').querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/admin/kernel/adjustments/${b.dataset.reject}/reject`, {}); toast('已驳回'); loadAdjust() }
    catch (e) { toast(e.message) }
  }))
}

async function submitAdjust() {
  try {
    const r = await api('/admin/kernel/adjustments', {
      username: $('adjUser').value.trim(), target_type: $('adjType').value,
      target_id: $('adjTarget').value ? +$('adjTarget').value : null,
      delta: +$('adjDelta').value, reason: $('adjReason').value.trim(),
      idempotency_key: (crypto.randomUUID ? crypto.randomUUID() : `adj${Date.now()}`),
    })
    toast(r.status === 'pending' ? '⏳ 超阈值：已登记待管理员审批' : '✅ 调整已生效')
    loadAdjust()
  } catch (e) { toast(e.message) }
}

// ---------- 概率与返还率 ----------
async function calcRtp() {
  const game = $('rtpGame').value
  try {
    const r = await api(`/admin/kernel/rtp?game=${game}`)
    const inRange = r.rtp >= r.range.min && r.rtp <= r.range.max
    $('rtpResult').innerHTML = `
      <div class="overview-grid">
        <div class="overview-card"><div class="o-num" style="color:${inRange ? '#7dd87d' : '#ff6b81'}">${pct(r.rtp)}</div><div class="o-label">整机返还率（目标 ${pct(r.range.min)}~${pct(r.range.max)}）</div></div>
        <div class="overview-card"><div class="o-num">${pct(r.net)}</div><div class="o-label">奖惩净值（参考）</div></div>
      </div>
      <div style="margin-top:10px">${r.perOption.map(o => `<div class="stat-line"><span>${o.option}</span><b>${pct(o.contribution)}</b></div>`).join('')}</div>`
  } catch (e) { toast(e.message) }
}

async function loadReviews() {
  const { reviews } = await api('/admin/kernel/reviews?limit=20')
  $('reviewList').innerHTML = reviews.map(r => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">#${r.id} ${r.scope} · ${r.note || '（无备注）'}</div>
        <div class="i-sub">${r.created_by} · 状态：${r.status}</div>
      </div>
      ${r.status === 'pending' ? `<button class="mini-btn" data-rev="${r.id}" data-act="staging">预发验证</button>` : ''}
      ${r.status === 'staging' ? `<button class="mini-btn primary" data-rev="${r.id}" data-act="publish">全量发布</button>` : ''}
      ${r.status === 'published' ? `<button class="mini-btn" data-rev="${r.id}" data-act="rollback">回滚</button>` : ''}
    </div>`).join('')
  $('reviewList').querySelectorAll('[data-rev]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/admin/kernel/reviews/${b.dataset.rev}/${b.dataset.act}`, {})
      toast('✅ 操作完成')
      loadReviews()
    } catch (e) { toast(e.message) }
  }))
}

// ---------- 稀有度 ----------
async function loadRarity() {
  const { rarity } = await api('/admin/kernel/rarity')
  $('rarityList').innerHTML = rarity.map(r => `
    <div class="inv-item">
      <div class="i-main">
        <div class="i-name">L${r.level} ${r.name}</div>
        <div class="i-sub">铺场权重 ${r.field_weight} · 定价带 ${r.price_min}~${r.price_max} · 掉落权重 ${r.drop_weight}%</div>
      </div>
    </div>`).join('') + `<div class="stat-line" style="margin-top:8px"><span>修改稀有度参数请走「概率与返还率」的提审发布流程（改后自动重算返还率，越界拦截）</span></div>`
}

// ---------- 审计 ----------
async function loadAudit() {
  const { audit } = await api('/admin/kernel/audit?limit=50')
  $('auditList').innerHTML = audit.map(a => `
    <div class="stat-line" style="align-items:flex-start">
      <span style="flex:1">${a.created_at} · <b style="color:#ffd700">${a.scope}/${a.action}</b> · 操作人 ${a.operator || '-'} · 对象 ${a.target_id || '-'}</span>
    </div>`).join('') || '<div class="stat-line">暂无审计记录</div>'
}
