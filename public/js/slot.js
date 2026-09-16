// 鎏金老虎机 · 前端逻辑（步骤3）
// 服务端权威：盘面/爆裂/倍率/结算全部来自 /api/slot/spin 的 steps[]，前端只按序回放

const SYM_GLYPH = {
  cherry: '🍒', lemon: '🍋', bell: '🔔', diamond: '💎', wild: '🃏',
  monkey: '🐒', fortune: '🎰', jackpot: '👑', empty: '',
}
const SYM_NAME = { cherry: '樱桃', lemon: '柠檬', bell: '铃铛', diamond: '钻石', wild: 'Wild' }

let slotState = null
let lastResult = null
let busy = false
let holdReel = null
let lastSpinId = null

const $ = id => document.getElementById(id)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function randKey() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `k${Date.now()}${Math.random()}`
}

async function slotApi(path, body) {
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

// ---------- 入口 ----------
async function loadSlot() {
  bindEvents()
  await refresh()
  // 断线恢复：有待处理交互则弹出
  if (slotState.pendingInteractions?.length) {
    for (const p of slotState.pendingInteractions) {
      if (p.type === 'monkey') showMonkey(p.id, null)
      if (p.type === 'wheel') showWheel(p.id)
    }
  }
}

function bindEvents() {
  $('spinBtn').addEventListener('click', doSpin)
  $('monkeyCloseBtn').addEventListener('click', () => $('monkeyMask').classList.remove('show'))
  $('wheelCloseBtn').addEventListener('click', () => $('wheelMask').classList.remove('show'))
  document.querySelectorAll('.hold-btn').forEach(b => b.addEventListener('click', () => {
    if (busy) return
    const reel = parseInt(b.dataset.reel)
    holdReel = holdReel === reel ? null : reel
    document.querySelectorAll('.hold-btn').forEach(x => x.classList.toggle('on', parseInt(x.dataset.reel) === holdReel))
  }))
  document.querySelectorAll('.nudge-btn').forEach(b => b.addEventListener('click', () => doNudgeMenu(parseInt(b.dataset.reel))))
}

// ---------- 数据刷新 ----------
async function refresh() {
  try {
    slotState = await slotApi('/slot/state')
  } catch (e) {
    toast('加载失败：' + e.message)
    return
  }
  renderPanel()
  renderPayTable()
  // 恢复上一轮盘面
  if (slotState.lastSpin) {
    const grid = JSON.parse(slotState.lastSpin.grid)
    renderGrid(grid)
    lastSpinId = slotState.lastSpin.id
    $('nudgeRow').classList.add('show')
  } else {
    renderGrid(emptyGrid())
  }
  updateBalance(slotState.balance)
}

function emptyGrid() {
  return Array.from({ length: 5 }, () => ['', '', ''])
}

function renderPanel() {
  const st = slotState.state
  const cfg = slotState.config
  // 彩池公示（T4.7）
  if (slotState.pool) {
    $('poolAmount').textContent = Math.round(slotState.pool.amount).toLocaleString('zh-CN')
    $('poolRate').textContent = `${slotState.pool.rate}%（每次付费转动）`
    $('poolLast').textContent = slotState.pool.lastPayout ? `${slotState.pool.lastPayout} 币` : '—'
  }
  // Fever 槽
  const bar = $('feverBar')
  bar.innerHTML = ''
  for (let i = 0; i < cfg.fever.slotMax; i++) {
    const cell = document.createElement('i')
    if (st.feverActive || i < st.feverSlot) cell.className = 'on'
    bar.appendChild(cell)
  }
  $('feverText').textContent = st.feverActive ? `Fever ×${st.feverLeft}连转` : `${st.feverSlot} / ${cfg.fever.slotMax}`
  $('feverHint').textContent = st.feverActive
    ? '狂热中：捣蛋猴绝迹、Wild 双倍、倍率不重置！'
    : st.noWinStreak >= cfg.pity.streak - 3 ? `🛟 保底临近：已连续 ${st.noWinStreak} 转未中`
    : ''
  $('slotMachine').classList.toggle('fever-on', st.feverActive)
  $('feverBanner').classList.toggle('show', st.feverActive)
  // 数值
  $('freeLeft').textContent = st.freeLeft
  $('nudgeLeft').textContent = st.nudgeLeft
  $('noWin').textContent = st.noWinStreak
  $('feeText').textContent = `${slotState.fee} 金币`
  $('spinBtn').disabled = busy
  $('spinBtn').textContent = st.feverActive
    ? `🔥 Fever 连转（剩 ${st.feverLeft} 次）`
    : st.freeLeft > 0 ? `🎰 免费转（剩 ${st.freeLeft} 次）` : `🎰 转 动（-${slotState.fee} 金币）`
  // Hold
  $('holdRow').classList.toggle('show', st.holdActive && !busy)
  // Nudge
  $('nudgeLabel').textContent = `Arrow Nudge（今日剩 ${st.nudgeLeft} 次）：`
}

function renderGrid(grid, opts = {}) {
  const stage = $('slotStage')
  stage.innerHTML = ''
  const winSet = new Set((opts.winCells || []).map(([c, r]) => `${c},${r}`))
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 3; r++) {
      const cell = document.createElement('div')
      const sym = grid[c]?.[r] ?? ''
      cell.className = 'slot-cell' + (sym === 'jackpot' ? ' jackpot-cell' : '')
      if (winSet.has(`${c},${r}`)) cell.className += ' win'
      if (opts.pop && winSet.has(`${c},${r}`)) cell.className += ' pop'
      if (opts.drop) cell.className += ' drop-in'
      if (opts.spinning) cell.className += ' spinning'
      cell.textContent = SYM_GLYPH[sym] || ''
      stage.appendChild(cell)
    }
  }
}

// ---------- 转动与 steps[] 回放 ----------
async function doSpin() {
  if (busy) return
  busy = true
  renderPanel()
  renderGrid(emptyGrid(), { spinning: true })
  try {
    const body = { idempotency_key: randKey() }
    if (holdReel !== null && slotState.state.holdActive) body.hold_reel = holdReel
    const r = await slotApi('/slot/spin', body)
    holdReel = null
    document.querySelectorAll('.hold-btn').forEach(x => x.classList.remove('on'))
    await replaySteps(r)
    lastResult = r
    lastSpinId = r.spinId
    updateBalance(r.balance)
    await refresh()
    // 后置交互
    if (r.monkey) showMonkey(r.monkey.pendingId, null)
    if (r.wheel) showWheel(r.wheel.pendingId)
    if (r.jackpot) toast(`👑 JACKPOT 大奖！彩池 ${r.jackpot.payout} 币全额归你！`)
    if (r.fever.triggered) toast('🔥 Fever 狂热模式开启：8 次免费连转！')
    if (r.fever.ended) toast('🔥 Fever 结束，保底华丽碎片已入包')
    if (r.hold.granted) toast('🔒 获得下轮保留 1 轴的权利！')
  } catch (e) {
    toast(e.message || '转动失败')
    await refresh()
  } finally {
    busy = false
    renderPanel()
  }
}

async function replaySteps(r) {
  const steps = r.steps || []
  // 初始盘面（滚动定格）
  renderGrid(r.grid, { drop: true })
  await sleep(500)
  for (const step of steps) {
    if (step.type === 'cascade') {
      // 高亮中奖线
      const winCells = step.lines.flatMap(l => l.cells)
      renderGrid(step.grid, { winCells })
      await sleep(750)
      // 爆裂
      renderGrid(step.grid, { winCells, pop: true })
      await sleep(420)
      toast(`💥 ${step.lines.length} 连线 ×${step.multiplier} → +${step.roundPay}`)
    } else if (step.type === 'settle') {
      renderGrid(step.grid, { drop: true })
      await sleep(300)
    } else if (step.type === 'pity') {
      renderGrid(step.grid, { drop: true })
      toast(`🛟 保底补中 +${step.amount}`)
      await sleep(400)
    }
  }
}

// ---------- Nudge ----------
async function doNudgeMenu(reel) {
  if (busy || !lastSpinId) return
  const dir = confirm(`轴 ${reel + 1}：确定=向上摇一格，取消=向下摇一格？`) ? 'up' : 'down'
  busy = true
  try {
    const r = await slotApi('/slot/nudge', { spin_id: lastSpinId, reel, dir, idempotency_key: randKey() })
    renderGrid(r.gridAfter, { drop: true })
    await sleep(400)
    if (r.payout > 0) {
      toast(`🎯 Nudge 摇中 +${r.payout}！`)
      const winCells = r.lines.flatMap(l => l.cells)
      renderGrid(r.gridAfter, { winCells })
    } else {
      toast('😮‍💨 没摇中……')
    }
    await refresh()
  } catch (e) {
    toast(e.message)
    await refresh()
  } finally {
    busy = false
    renderPanel()
  }
}

// ---------- 追猴小剧场 ----------
function showMonkey(pendingId, _cards) {
  const wrap = $('monkeyCards')
  wrap.innerHTML = ''
  for (let i = 0; i < 3; i++) {
    const btn = document.createElement('button')
    btn.className = 'monkey-card'
    btn.innerHTML = '<div class="card-inner"><div class="card-back">🐒<br>牌' + (i + 1) + '</div><div class="card-face"></div></div>'
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('flipped') || busy) return
      busy = true
      try {
        const r = await slotApi('/slot/monkey', { pending_id: pendingId, choice: i, idempotency_key: randKey() })
        // 翻开所有牌（揭示预生成结果）
        const faces = wrap.querySelectorAll('.card-face')
        r.cards.forEach((c, idx) => {
          const f = faces[idx]
          f.textContent = c.coins > 0 ? `+${c.coins}` : '💨'
          if (c.coins === 0) f.classList.add('empty')
        })
        btn.classList.add('flipped')
        faces[i].parentElement.classList.add('flipped')
        if (r.coins > 0) toast(`🐒 猴子还你 ${r.coins} 币！`)
        else toast('💨 空手而归……')
        if (r.balance !== null && r.balance !== undefined) updateBalance(r.balance)
        await refresh()
        $('monkeyCloseBtn').style.display = 'inline-block'
      } catch (e) {
        toast(e.message)
      } finally {
        busy = false
      }
    })
    wrap.appendChild(btn)
  }
  $('monkeyCloseBtn').style.display = 'none'
  $('monkeyMask').classList.add('show')
}

// ---------- 幸运转轮 ----------
function showWheel(pendingId) {
  const disc = $('wheelDisc')
  const label = $('wheelLabel')
  const names = slotState.config.wheel.map(w => w.label)
  label.innerHTML = names.map((n, i) => {
    const ang = (i / names.length) * 360 + 180 / names.length
    return `<span style="position:absolute;transform:rotate(${ang}deg) translateY(-88px)">${n}</span>`
  }).join('')
  disc.style.transition = 'none'
  disc.style.transform = 'rotate(0deg)'
  $('wheelResult').innerHTML = ''
  $('wheelCloseBtn').style.display = 'none'
  $('wheelMask').classList.add('show')

  // 停轮揭示（预生成结果在服务端，点按后揭示）
  setTimeout(async () => {
    try {
      busy = true
      const r = await slotApi('/slot/wheel', { pending_id: pendingId, idempotency_key: randKey() })
      const perDeg = 360 / slotState.config.wheel.length
      const targetDeg = 360 * 5 + (360 - r.index * perDeg - perDeg / 2)
      disc.classList.add('spinning')
      disc.style.transform = `rotate(${targetDeg}deg)`
      await sleep(3300)
      $('wheelResult').innerHTML = `<b style="color:#ffd700">${r.sector.label}</b>`
      if (r.feverTriggered) toast('🔥 Fever 狂热模式开启！')
      if (r.balance !== undefined && r.balance !== null) updateBalance(r.balance)
      await refresh()
      busy = false
      $('wheelCloseBtn').style.display = 'inline-block'
    } catch (e) {
      toast(e.message)
      busy = false
    }
  }, 600)
}

// ---------- 概率公示（G4） ----------
function renderPayTable() {
  const cfg = slotState.config
  const unit = cfg.payScale * slotState.fee
  const rows = Object.entries(cfg.pays).map(([sym, p]) => {
    const name = SYM_NAME[sym] || sym
    const fmt = v => (v > 0 ? (v * unit).toFixed(1) : '—')
    return `<div class="stat-line"><span>${SYM_GLYPH[sym]} ${name}</span><b>${fmt(p[0])} / ${fmt(p[1])} / ${fmt(p[2])} 币</b></div>`
  }).join('')
  $('payTable').innerHTML = rows + `<div class="stat-line"><span style="font-size:12px;opacity:.7">3连 / 4连 / 5连（含爆裂倍率）</span></div>`
  $('wheelTable').innerHTML = cfg.wheel.map(w =>
    `<div class="stat-line"><span>${w.label}</span><b>${w.prob}%</b></div>`
  ).join('')
}

// ---------- 工具 ----------
function toast(msg) {
  const t = $('grabToast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 2600)
}
