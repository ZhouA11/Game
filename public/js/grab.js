// 鎏金抓娃娃 · 前端逻辑（步骤2）
// 服务端权威：布局/可及/成功率/结算全部来自 /api/grab/*，前端只做演出

let grabState = null
let selectedDollId = null
let lensHints = {}        // dollId -> 模糊文案（透视镜结果）
let busy = false

const $ = id => document.getElementById(id)

function randKey() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `k${Date.now()}${Math.random()}`
}

async function grabApi(path, body) {
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
async function loadGrab() {
  bindEvents()
  loadPoolInfo()
  await refresh()
}

function bindEvents() {
  $('clawBtn').addEventListener('click', doClaw)
  $('rerollBtn').addEventListener('click', () => doReroll('coin'))
  $('lensBtn').addEventListener('click', doReveal)
  $('resultBtn').addEventListener('click', hideResult)
  $('zoomRange').addEventListener('input', e => {
    $('zoomVal').textContent = `${e.target.value}%`
    $('machineStage').style.transform = `scale(${e.target.value / 100})`
  })
  $('resetZoom').addEventListener('click', () => {
    $('zoomRange').value = 100
    $('zoomVal').textContent = '100%'
    $('machineStage').style.transform = 'scale(1)'
  })
}

// ---------- 数据刷新 ----------
async function refresh() {
  try {
    grabState = await grabApi('/grab/state')
  } catch (e) {
    toast('加载失败：' + e.message)
    return
  }
  renderMachine()
  renderPanel()
  updateBalance(grabState.balance)
}

function renderMachine() {
  const stage = $('machineStage')
  // 保留爪子节点，清掉娃娃与气泡
  stage.querySelectorAll('.doll, .lens-bubble').forEach(el => el.remove())

  const dolls = (grabState.machine.dolls || []).slice().sort((a, b) => b.z - a.z)
  for (const d of dolls) {
    const el = document.createElement('div')
    el.className = `doll r${d.rarity} ${d.reachable ? 'reachable' : 'occluded'} ${d.id === selectedDollId ? 'selected' : ''}`
    el.style.left = `${d.x}%`
    el.style.top = `${d.y}%`
    el.style.width = `${d.size * 2}%`
    el.style.height = `${d.size * 2}%`
    el.style.zIndex = 10 + (3 - d.z) + (d.id === selectedDollId ? 60 : 0)
    el.dataset.id = d.id
    el.innerHTML = `
      <div class="doll-shadow"></div>
      <div class="doll-glyph"></div>
      <div class="doll-body">${d.rarity >= 4 ? '👑' : d.rarity === 3 ? '🦄' : d.rarity === 2 ? '🐷' : '🧸'}</div>`
    if (d.reachable) {
      el.addEventListener('click', () => selectDoll(d.id))
    }
    stage.appendChild(el)

    if (lensHints[d.id]) {
      const bubble = document.createElement('div')
      bubble.className = 'lens-bubble'
      bubble.style.left = `${d.x}%`
      bubble.style.top = `${d.y}%`
      bubble.textContent = lensHints[d.id]
      stage.appendChild(bubble)
    }
  }
}

function renderPanel() {
  const p = grabState.player
  $('luckFill').style.width = `${Math.min(100, p.luck)}%`
  $('luckText').textContent = `${p.luck} / ${p.luckMax}`
  const pity = $('pityHint')
  if (p.penaltyStreak >= 3) {
    pity.textContent = `⚡ 惩罚保底已就绪（连败 ${p.penaltyStreak} 次）：下一次抓中必出奖励！`
    pity.className = 'pity-hint hot'
  } else if (p.penaltyStreak > 0) {
    pity.textContent = `惩罚连败 ${p.penaltyStreak} 次，再连 ${3 - p.penaltyStreak} 次触发必出奖励`
    pity.className = 'pity-hint'
  } else {
    pity.textContent = p.luck >= p.luckMax ? '🌟 幸运值已满！重铺必出 L3+ 娃娃' : ''
    pity.className = 'pity-hint'
  }
  $('rerollCount').textContent = `${p.rerollCount} / ${p.rerollLimit}`
  $('failStreak').textContent = p.failStreak
  $('rerollCost').textContent = `${p.rerollCost} 金币 / 换机券`
  $('dollsLeft').textContent = grabState.machine.dollsLeft
  $('clawBtn').textContent = `🪝 下爪（-${p.playCost} 金币）`
  $('rerollBtn').textContent = p.needsReroll ? '♻️ 免费重铺' : '♻️ 重铺'

  // 选中态校验（重铺后旧选中失效）
  if (selectedDollId && !grabState.machine.dolls.some(d => d.id === selectedDollId && d.reachable)) {
    selectedDollId = null
  }
  updateActionButtons()
}

function updateActionButtons() {
  const p = grabState.player
  const selected = grabState.machine.dolls.find(d => d.id === selectedDollId)
  $('clawBtn').disabled = busy || !selected
  $('lensBtn').disabled = busy || !selected
  $('rerollBtn').disabled = busy
  $('selectedInfo').innerHTML = selected
    ? `已选中 <b>${rarityName(selected.rarity)}</b> 娃娃${selected.occluded ? '' : '（可抓）'}`
    : '点击机器中发亮的娃娃选中它'
}

function rarityName(r) {
  return { 1: '普通', 2: '精致', 3: '华丽', 4: '鎏金' }[r] || `L${r}`
}

// ---------- 交互 ----------
function selectDoll(id) {
  if (busy) return
  selectedDollId = id
  renderMachine()
  updateActionButtons()
}

async function doClaw() {
  if (busy || !selectedDollId) return
  busy = true
  updateActionButtons()
  const arm = $('clawArm')
  const stage = $('machineStage')
  const target = grabState.machine.dolls.find(d => d.id === selectedDollId)
  arm.style.left = `${target ? target.x : 50}%`
  arm.classList.add('grabbing')
  arm.style.top = `${(target ? target.y : 50) - 6}%`

  try {
    const r = await grabApi('/grab/claw', { doll_id: selectedDollId, idempotency_key: randKey() })
    await sleep(650)
    arm.style.top = '-12%'
    await sleep(400)
    arm.classList.remove('grabbing')
    showResult(r)
    selectedDollId = null
    await refresh()
  } catch (e) {
    arm.style.top = '-12%'
    arm.classList.remove('grabbing')
    toast(codeText(e))
    if (e.code === 'DOLL_TAKEN' || e.code === 'DOLL_NOT_FOUND' || e.code === 'DOLL_OCCLUDED') {
      selectedDollId = null
      await refresh()
    }
  } finally {
    busy = false
    updateActionButtons()
  }
}

async function doReroll(mode) {
  if (busy) return
  const p = grabState.player
  if (!p.needsReroll && mode === 'coin' && !confirm(`花费 ${p.rerollCost} 金币重新铺场？`)) return
  busy = true
  updateActionButtons()
  try {
    const r = await grabApi('/grab/reroll', { mode, idempotency_key: randKey() })
    lensHints = {}
    selectedDollId = null
    if (r.luckInserted) toast('🌟 幸运值保底触发：本次重铺刷出了 L3+ 娃娃！')
    else if (r.free) toast('机内已空，本次重铺免费')
    await refresh()
  } catch (e) {
    toast(codeText(e))
  } finally {
    busy = false
    updateActionButtons()
  }
}

async function doReveal() {
  if (busy || !selectedDollId) return
  busy = true
  updateActionButtons()
  try {
    const r = await grabApi('/grab/reveal', { doll_id: selectedDollId, idempotency_key: randKey() })
    lensHints[r.dollId] = r.hint
    renderMachine()
    toast(r.hint)
  } catch (e) {
    toast(codeText(e))
  } finally {
    busy = false
    updateActionButtons()
  }
}

// ---------- 结果展示 ----------
function showResult(r) {
  const mask = $('resultMask')
  const box = $('resultBox')
  box.className = 'result-box' + (r.success ? '' : ' lose')
  $('resultTags').innerHTML = ''

  if (r.success) {
    $('resultEmoji').textContent = r.handSlip ? '🤲' : '🎉'
    $('resultTitle').textContent = r.handSlip ? '手滑 bonus！' : '抓中啦！'
    const c = r.content || {}
    const detail = []
    if (c.type === 'coin') { $('resultEmoji').textContent = '🪙'; detail.push(`获得 <b style="color:#ffd700">${c.amount}</b> 金币！`) }
    else if (c.type === 'item') { $('resultEmoji').textContent = '🎁'; detail.push(`道具 <b>「${c.name}」</b> 已入背包`) }
    else if (c.type === 'reward') { $('resultEmoji').textContent = '🎟️'; detail.push(`现实奖励 <b>「${c.name}」</b> 已入奖励背包，请安排核销！`) }
    else if (c.type === 'penalty') { $('resultEmoji').textContent = '😵'; detail.push(`惩罚娃娃 <b>「${c.name}」</b>：+${c.applied} Spank……`) }
    else if (c.type === 'fragment') { $('resultEmoji').textContent = '🧩'; detail.push('碎片 +1！去个人面板看看合成进度吧') }
    $('resultDetail').innerHTML = detail.join('<br>')
    if (r.handSlip) $('resultTags').innerHTML += '<span class="result-tag">🤲 手滑 bonus · 免费开娃</span>'
    if (r.pityUsed) $('resultTags').innerHTML += '<span class="result-tag">⚡ 惩罚保底 · 必出奖励</span>'
    if (c.rarity >= 3) $('resultTags').innerHTML += `<span class="result-tag pink">${rarityName(c.rarity)}稀有度</span>`
  } else {
    $('resultEmoji').textContent = '😅'
    $('resultTitle').textContent = '抓空了……'
    $('resultDetail').innerHTML = '娃娃还在机里，下次一定！<br><span style="font-size:13px;opacity:.8">幸运值 +1，继续加油</span>'
  }
  mask.classList.add('show')
}

function hideResult() {
  $('resultMask').classList.remove('show')
}

// ---------- 概率公示（G4） ----------
async function loadPoolInfo() {
  try {
    const cfg = await grabApi('/grab/config')
    const names = { 1: '普通', 2: '精致', 3: '华丽', 4: '鎏金' }
    const byOpt = {}
    for (const e of cfg.pools || []) {
      if (!e.is_active) continue
      byOpt[e.option] = byOpt[e.option] || []
      byOpt[e.option].push(e)
    }
    let html = ''
    for (const opt of ['L1', 'L2', 'L3', 'L4']) {
      const list = byOpt[opt] || []
      if (!list.length) continue
      const total = list.reduce((s, e) => s + e.weight, 0)
      const ctrl = cfg.controls[opt]
      const items = list.map(e => {
        const pct = ((e.weight / total) * (e.side === 'reward' ? ctrl.reward_side_prob : ctrl.penalty_side_prob) * 100).toFixed(1)
        const label = e.ref_type === 'coin' ? `金币${e.amount}`
          : e.ref_type === 'fragment' ? '碎片'
          : e.ref_type === 'penalty' ? '惩罚'
          : e.ref_name || '内容'
        return `<span class="pool-entry ${e.side === 'penalty' ? 'pen' : ''}">${label} ${pct}%</span>`
      }).join('')
      html += `<div class="pool-block"><div class="pool-name">${opt} · ${names[opt]}池（奖励侧 ${(ctrl.reward_side_prob * 100).toFixed(0)}%）</div><div class="pool-entries">${items}</div></div>`
    }
    $('poolList').innerHTML = html || '掉落池尚未配置'
  } catch (e) {
    $('poolList').textContent = '公示加载失败'
  }
}

// ---------- 工具 ----------
function codeText(e) {
  const map = {
    INSUFFICIENT_BALANCE: '金币不足，无法下爪',
    DOLL_OCCLUDED: '这个娃娃被压住了，先抓开上面的吧',
    DOLL_TAKEN: '手慢了，这个娃娃刚被抓走',
    DOLL_NOT_FOUND: '娃娃不存在或已被抓走',
    REROLL_LIMIT_REACHED: '今日主动重铺次数已用完',
    ITEM_NOT_OWNED: '没有可用的道具（透视镜/换机券）',
  }
  return map[e.code] || e.message || '操作失败'
}

function toast(msg) {
  const t = $('grabToast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 2600)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
