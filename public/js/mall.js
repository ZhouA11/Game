// 鎏金商城 · 前端（步骤5：只卖道具；公告条；详情弹窗；购买幂等）

const SYM = { cherry: '🍒', lemon: '🍋', bell: '🔔', diamond: '💎', wild: '🃏' }
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

let products = []
let selected = null

async function loadMall() {
  await refresh()
  bindDetail()
}

async function refresh() {
  const [ov, list] = await Promise.all([
    api('/kernel/me/overview'),
    api('/mall/products'),
  ])
  products = list.products
  $('coinBalance').textContent = Math.round(ov.balance).toLocaleString('zh-CN')
  $('actBalance').textContent = Math.round(ov.activity).toLocaleString('zh-CN')
  updateBalance(ov.balance)
  renderGroup('gameProducts', products.filter(p => p.category === 'game'))
  renderGroup('clearProducts', products.filter(p => p.category === 'clear'))
}

function renderGroup(elId, list) {
  const el = $(elId)
  el.innerHTML = ''
  if (!list.length) {
    el.innerHTML = '<div class="stat-line">暂无在售商品</div>'
    return
  }
  for (const p of list) {
    const card = document.createElement('div')
    card.className = 'product-card'
    card.style.setProperty('--r-c', null)
    card.className += ` r${p.rarity}`
    const meta = p.category === 'clear'
      ? `<span>券面 −${p.reduceValue} Spank</span><span>限购 ${p.dailyLimit ?? '∞'}/日</span>`
      : `<span>${p.scope === 'grab' ? '抓娃娃' : p.scope === 'slot' ? '老虎机' : '通用'}</span><span>限购 ${p.dailyLimit ?? '∞'}/日</span>`
    card.innerHTML = `
      <span class="p-rarity r${p.rarity}">${RARITY[p.rarity]}</span>
      <div class="p-icon">${p.category === 'clear' ? '🛡️' : '🎮'}</div>
      <div class="p-name">${p.name}</div>
      <div class="p-desc">${p.description || ''}</div>
      <div class="p-meta">${meta}</div>
      <div class="p-price">${p.price} <small>${p.currency === 'coin' ? '金币' : '活跃值'}</small></div>`
    card.addEventListener('click', () => openDetail(p))
    el.appendChild(card)
  }
}

function openDetail(p) {
  selected = p
  $('detailEmoji').textContent = p.category === 'clear' ? '🛡️' : '🎮'
  $('detailName').textContent = `${p.name}（${RARITY[p.rarity]}）`
  const cur = p.currency === 'coin' ? '金币' : '活跃值'
  let body = `<p>📦 效果：${p.description || '—'}</p>`
  if (p.category === 'game') {
    body += `<p>⚙️ 触发方式：${p.auto_mount ? '自动挂载——满足条件时自动生效并消耗' : '在对应游戏中手动使用'}</p>
             <p>🎯 作用域：${p.scope === 'grab' ? '抓娃娃机' : p.scope === 'slot' ? '老虎机' : '全部游戏'}</p>`
  } else {
    body += `<p>🛡️ 固定减免量：<b style="color:#ffd700">−${p.reduceValue} Spank</b>（目标自选）</p>
             <p>🎯 可作用的惩罚道具稀有度：L1 ~ L${p.maxTargetRarity}</p>
             <p>⚠️ 若目标剩余 Spank 少于减免量，将减免至 0，<b>余量作废</b></p>
             <p>🚫 不可自动挂载，须在个人面板手动选择目标使用</p>`
  }
  body += `<p>💰 退款政策：道具一经购买，不退不换</p>
           <p>🏷️ 价格：${p.price} ${cur}（限购 ${p.dailyLimit ?? '∞'}/日）</p>`
  $('detailBody').innerHTML = body
  $('buyBtn').textContent = `购买（-${p.price} ${cur}）`
  $('detailMask').classList.add('show')
}

function bindDetail() {
  $('detailClose').addEventListener('click', () => $('detailMask').classList.remove('show'))
  $('buyBtn').addEventListener('click', async () => {
    if (!selected) return
    try {
      $('buyBtn').disabled = true
      const r = await api('/mall/buy', { product_id: selected.id, idempotency_key: randKey() })
      $('detailMask').classList.remove('show')
      toast(`✅ 已购买「${r.name}」`)
      await refresh()
      if (selected.category === 'clear') {
        // T5.6：存在可选目标时给「立即使用」入口
        toast('🛡️ 减免券已入包，去个人面板立即使用 →', true)
      }
    } catch (e) {
      toast(e.message || '购买失败')
    } finally {
      $('buyBtn').disabled = false
    }
  })
}

function toast(msg, gotoPanel = false) {
  const t = $('grabToast')
  t.innerHTML = gotoPanel ? `${msg} <a href="panel.html#penalty" style="color:#4deeea">立即使用</a>` : msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 3200)
}
