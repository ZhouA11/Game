// 个人面板四区 · 前端（步骤5）
// 区一资产 / 区二奖励+碎片 / 区三道具 / 区四惩罚（减免券转化入口）

const RARITY = { 1: '普通', 2: '精致', 3: '华丽', 4: '鎏金' }
const $ = id => document.getElementById(id)
const randKey = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : `k${Date.now()}${Math.random()}`

async function api(path, body) {
  const token = localStorage.getItem('token')
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
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

let me = null
let spankData = null

async function loadPanel() {
  bindTabs()
  $('targetClose').addEventListener('click', () => $('targetMask').classList.remove('show'))
  await refresh()
}

function bindTabs() {
  document.querySelectorAll('.panel-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(x => x.classList.remove('active'))
    t.classList.add('active')
    document.querySelectorAll('.tab-page').forEach(p => p.style.display = 'none')
    $(`tab-${t.dataset.tab}`).style.display = 'block'
  }))
  // 支持 #penalty 锚点直达（商城「立即使用」入口）
  if (location.hash === '#penalty') {
    document.querySelector('[data-tab="penalty"]')?.click()
  }
}

async function refresh() {
  me = await api('/kernel/me/overview')
  $('ovCoin').textContent = Math.round(me.balance).toLocaleString('zh-CN')
  $('ovAct').textContent = Math.round(me.activity).toLocaleString('zh-CN')
  $('ovItems').textContent = me.itemCount
  $('ovFrag').textContent = me.fragmentCount
  updateBalance(me.balance)
  await Promise.all([loadLedger(), loadBag(), loadFragments(), loadInventory(), loadSpanks()])
}

// ---------- 区一：流水 ----------
async function loadLedger() {
  const data = await api('/kernel/me/ledger?limit=10')
  const el = $('ledgerList')
  el.innerHTML = (data.list || []).map(e => {
    const cur = e.currency === 'coin' ? '金币' : '活跃值'
    const color = e.delta >= 0 ? '#7dd87d' : '#ff6b81'
    return `<div class="stat-line"><span>${e.created_at} · ${e.reason}</span><b style="color:${color}">${e.delta >= 0 ? '+' : ''}${e.delta} ${cur}</b></div>`
  }).join('') || '<div class="stat-line">暂无流水</div>'
}

// ---------- 区二：奖励背包 + 碎片 ----------
async function loadBag() {
  const bag = await api('/kernel/me/reward-bag')
  const el = $('bagList')
  el.innerHTML = (bag.bag || []).map(b => `
    <div class="inv-item">
      <span class="i-icon">🎟️</span>
      <div class="i-main">
        <div class="i-name">${b.name} <span class="p-rarity r${b.rarity}" style="position:static">${RARITY[b.rarity]}</span></div>
        <div class="i-sub">${b.description || '现实奖励'} · 数量 ×${b.quantity}</div>
      </div>
      <button class="mini-btn primary" data-redeem="${b.reward_id}">✔ 核销</button>
    </div>`).join('') || '<div class="stat-line">背包空空——现实奖励只能通过游戏获得</div>'
  el.querySelectorAll('[data-redeem]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/kernel/me/reward-bag/${b.dataset.redeem}/redeem`, { idempotency_key: randKey() })
      toast('✔ 核销成功，请领取你的现实奖励！')
      await refresh()
    } catch (e) { toast(e.message) }
  }))
}

async function loadFragments() {
  const data = await api('/kernel/me/fragments')
  const el = $('fragList')
  el.innerHTML = (data.fragments || []).map(f => {
    const pct = Math.min(100, (f.owned / f.pieces_required) * 100)
    const ready = f.owned >= f.pieces_required
    return `
    <div class="frag-row">
      <span class="i-icon">🧩</span>
      <div style="flex:1">
        <div class="i-name">${f.target_name} <span style="font-size:12px;color:rgba(255,244,214,.6)">（${RARITY[f.target_rarity]} · 需 ${f.pieces_required} 片）</span></div>
        <div class="frag-bar" style="margin-top:6px"><div style="width:${pct}%"></div></div>
      </div>
      <span class="i-count">${f.owned}/${f.pieces_required}</span>
      <button class="mini-btn ${ready ? 'primary' : ''}" data-synth="${f.recipe_id}" ${ready ? '' : 'disabled'}>合成</button>
    </div>`
  }).join('')
  el.querySelectorAll('[data-synth]').forEach(b => b.addEventListener('click', async () => {
    try {
      const r = await api('/kernel/me/fragments/synthesize', { recipe_id: parseInt(b.dataset.synth), idempotency_key: randKey() })
      toast(`🎉 合成成功：「${r.targetName}」已入包！`)
      await refresh()
    } catch (e) { toast(e.message) }
  }))
}

// ---------- 区三：道具（游戏类含外观 / 减免类） ----------
async function loadInventory() {
  const inv = await api('/kernel/me/inventory')
  const items = inv.items || []
  const game = items.filter(i => i.category === 'game')
  const appearance = items.filter(i => i.category === 'appearance')
  const clear = items.filter(i => i.category === 'clear')

  const gameEl = $('gameItems')
  gameEl.innerHTML = game.map(i => invRow(i, true)).join('') + appearance.map(i => invRow(i, false, true)).join('')
    || '<div class="stat-line">暂无道具——去鎏金商城逛逛</div>'
  gameEl.querySelectorAll('[data-mount]').forEach(sw => sw.addEventListener('click', async () => {
    const itemId = sw.dataset.mount
    const cur = sw.dataset.mode
    const mode = cur === 'on' ? 'off' : 'on'
    try {
      await api(`/kernel/me/inventory/${itemId}/mount`, { mode })
      toast(mode === 'on' ? '✅ 已开启自动挂载' : '⛔ 已关闭自动挂载')
      await loadInventory()
    } catch (e) { toast(e.message) }
  }))

  const clearEl = $('clearItems')
  clearEl.innerHTML = clear.map(i => `
    <div class="inv-item">
      <span class="i-icon">🛡️</span>
      <div class="i-main">
        <div class="i-name">${i.name} <span class="p-rarity r${i.rarity}" style="position:static">${RARITY[i.rarity]}</span></div>
        <div class="i-sub">固定减免 ${Math.round(i.action_value)} Spank · 可作用 L1~L${i.rarity} · 手动使用</div>
      </div>
      <span class="i-count">×${i.count}</span>
      <button class="mini-btn primary" data-use="${i.id}">使用</button>
    </div>`).join('') || '<div class="stat-line">暂无减免券——去鎏金商城购买</div>'
  clearEl.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => openCouponPicker(parseInt(b.dataset.use))))
}

function invRow(i, withMount, isAppearance = false) {
  const effOn = (i.auto_mount === null || i.auto_mount === undefined) ? !!i.default_auto : !!i.auto_mount
  return `
  <div class="inv-item">
    <span class="i-icon">${isAppearance ? '🖼️' : '🎮'}</span>
    <div class="i-main">
      <div class="i-name">${i.name} <span class="p-rarity r${i.rarity}" style="position:static">${RARITY[i.rarity]}</span></div>
      <div class="i-sub">${i.description || ''}${isAppearance ? ' · 收藏外观（纯展示）' : ''}</div>
    </div>
    <span class="i-count">×${i.count}</span>
    ${withMount ? `<span class="switch ${effOn ? 'on' : ''}" data-mount="${i.item_id}" data-mode="${effOn ? 'on' : 'off'}" title="自动挂载开关"></span>` : ''}
  </div>`
}

// ---------- 区四：惩罚（转化入口） ----------
async function loadSpanks() {
  spankData = await api('/kernel/me/spanks')
  const el = $('penList')
  const coupons = spankData.coupons || []
  el.innerHTML = (spankData.penalties || []).map(p => {
    const usable = coupons.filter(c => c.owned > 0 && c.rarity >= p.rarity)
      .sort((a, b) => a.rarity - b.rarity)   // 优先展示低等级券
    const hasAny = spankData.coupons.some(c => c.rarity >= p.rarity)
    return `
    <div class="pen-item">
      <span class="i-icon">😈</span>
      <div class="i-main">
        <div class="i-name">${p.name} <span class="p-rarity r${p.rarity}" style="position:static">L${p.rarity} ${RARITY[p.rarity]}</span></div>
        <div class="i-sub">累计上限 ${p.spank_cap} · 惩罚不自动结算</div>
      </div>
      <span class="pen-count">${p.count}</span>
      <button class="mini-btn ${usable.length ? 'primary' : ''}" data-pen="${p.penalty_id}" data-rarity="${p.rarity}">使用减免券</button>
    </div>`
  }).join('')
  el.querySelectorAll('[data-pen]').forEach(b => b.addEventListener('click', () => openCouponPickerForPenalty(parseInt(b.dataset.pen), parseInt(b.dataset.rarity))))
}

// 惩罚区入口：先选券（只列等级≥惩罚稀有度，低等级优先）
function openCouponPickerForPenalty(penaltyId, rarity) {
  const coupons = (spankData.coupons || []).filter(c => c.owned > 0 && c.rarity >= rarity)
    .sort((a, b) => a.rarity - b.rarity)
  if (!coupons.length) {
    const anyFit = (spankData.coupons || []).some(c => c.rarity >= rarity)
    toast(anyFit ? '该道具暂无可减免的 Spank' : `没有可用的 L${rarity}+ 减免券，去鎏金商城购买 →`)
    return
  }
  showTargetPicker(coupons[0].id, coupons[0])
}

// 道具区入口：先选券，再列目标
async function openCouponPicker(couponItemId) {
  const inv = await api('/kernel/me/inventory')
  const coupon = (inv.items || []).find(i => i.item_id === couponItemId)
  if (!coupon) return
  showTargetPicker(couponItemId, coupon)
}

async function showTargetPicker(couponItemId, coupon) {
  $('targetTitle').textContent = `${coupon.name}（L${coupon.rarity}）· 选择减免目标`
  const data = await api(`/kernel/me/reducible-targets?coupon_item_id=${couponItemId}`)
  const list = $('targetList')
  list.innerHTML = (data.targets || []).map(t => `
    <div class="target-row" data-target="${t.penalty_id}">
      <span>😈 <b>${t.name}</b></span>
      <span class="p-rarity r${t.rarity}" style="position:static">L${t.rarity}</span>
      <span style="flex:1"></span>
      <span style="color:#ff6b81;font-weight:bold">${t.count} Spank</span>
      <span style="font-size:12px;color:rgba(255,244,214,.7)">−${Math.round(data.coupon.action_value)}（不足作废）</span>
    </div>`).join('') || '<div class="stat-line">当前没有可减免的惩罚道具</div>'
  list.querySelectorAll('[data-target]').forEach(row => row.addEventListener('click', async () => {
    try {
      const r = await api('/kernel/me/reduce-spank', {
        coupon_item_id: couponItemId,
        target_penalty_id: parseInt(row.dataset.target),
        idempotency_key: randKey(),
      })
      $('targetMask').classList.remove('show')
      toast(r.voided > 0 ? `🛡️ 减免 ${r.applied} Spank（余量 ${r.voided} 作废）` : `🛡️ 减免 ${r.applied} Spank！`)
      await refresh()
    } catch (e) { toast(e.message) }
  }))
  // T5.6：稀有度超限的目标置灰并提示（列出但禁点）
  const higher = (spankData?.penalties || []).filter(p => p.rarity > coupon.rarity && p.count > 0)
  for (const p of higher) {
    list.innerHTML += `
      <div class="target-row disabled">
        <span>😈 <b>${p.name}</b></span>
        <span class="p-rarity r${p.rarity}" style="position:static">L${p.rarity}</span>
        <span style="flex:1"></span>
        <span style="font-size:12px;color:#ffb3c6">需要 L${p.rarity} 及以上减免券</span>
      </div>`
  }
  $('targetMask').classList.add('show')
}

// ---------- 工具 ----------
function toast(msg) {
  const t = $('grabToast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 3000)
}
