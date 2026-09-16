// 转盘系统：游戏页转盘 + 数量小转盘 + 转盘配置（自 index.html 拆分）
        // ==================== 转盘系统 ====================
        const WHEEL_COLORS = ['#e74c3c', '#8e44ad', '#2980b9', '#16a085', '#f39c12', '#d35400', '#27ae60', '#2c3e50', '#c0392b', '#7f8c8d']
        let wheelConfig = { reward: [], penalty: [], penaltyQuantity: [] }
        let wheelMode = 'reward'
        let wheelRotation = 0
        let wheelSpinning = false
        let wheelAdminTab = 'reward'
        let wheelAdminDraft = { reward: [], penalty: [], penaltyQuantity: [] }

        let wheelBtnBound = false
        // 转盘次数信息：limit 全局默认；limits 按当前登录用户的奖励/惩罚分别生效（0 = 不限）；used 按转盘分开计数
        let wheelSpinInfo = { limit: 0, limits: { reward: 0, penalty: 0 }, used: { reward: 0, penalty: 0 } }

        // 取当前转盘生效的次数限制：按用户定义优先，否则用全局值
        function getWheelLimit(mode) {
            const m = mode || wheelMode
            const perUser = wheelSpinInfo.limits && wheelSpinInfo.limits[m]
            if (typeof perUser === 'number') return perUser
            return wheelSpinInfo.limit || 0
        }

        function getWheelUsed(mode) {
            const used = wheelSpinInfo.used
            if (used && typeof used === 'object') return used[mode || wheelMode] || 0
            return 0
        }

        function renderWheelSpinsLeft() {
            const el = document.getElementById('wheelSpinsLeft')
            if (!el) return
            if (!localStorage.getItem('token')) {
                el.style.display = 'none'
                return
            }
            el.style.display = 'block'
            const limit = getWheelLimit()
            if (limit <= 0) {
                el.textContent = '🎡 剩余次数：不限'
            } else {
                const left = Math.max(0, limit - getWheelUsed())
                el.textContent = `🎡 剩余次数：${left} / ${limit}`
                el.style.color = left <= 0 ? '#ff6b6b' : '#ffd700'
            }
        }

        async function initWheelPage() {
            if (!wheelBtnBound) {
                bindWheelSpinButton()
                renderWheelLights()
                window.addEventListener('resize', renderWheelLights)
                // 初始化音效开关图标（按上次保存的偏好）
                const sndBtn = document.getElementById('wheelSoundBtn')
                if (sndBtn) sndBtn.textContent = wheelSoundOn ? '🔊' : '🔇'
                wheelBtnBound = true
            }
            await loadWheelConfig()
            setWheelMode(wheelMode || 'reward')
            loadWheelHistory()
            if (currentUser && currentUser.role === 'admin') {
                // 管理后台需要奖励/惩罚类型数据来填充下拉框
                await loadAdminTypesForWheel()
                setWheelAdminTab(wheelAdminTab || 'reward')
            }
        }

        async function loadWheelConfig() {
            try {
                const headers = {}
                const token = localStorage.getItem('token')
                if (token) headers['Authorization'] = `Bearer ${token}`
                const res = await fetch(`${API_BASE}/wheel/config`, { headers })
                const data = await res.json()
                if (data.success && data.data) {
                    wheelConfig = {
                        reward: Array.isArray(data.data.reward) ? data.data.reward : [],
                        penalty: Array.isArray(data.data.penalty) ? data.data.penalty : [],
                        penaltyQuantity: Array.isArray(data.data.penaltyQuantity) ? data.data.penaltyQuantity : []
                    }
                    if (typeof data.data.spinLimitPerUser === 'number') {
                        wheelSpinInfo.limit = data.data.spinLimitPerUser
                    }
                    if (data.data.spinLimits && typeof data.data.spinLimits === 'object') {
                        wheelSpinInfo.limits = {
                            reward: typeof data.data.spinLimits.reward === 'number' ? data.data.spinLimits.reward : wheelSpinInfo.limit,
                            penalty: typeof data.data.spinLimits.penalty === 'number' ? data.data.spinLimits.penalty : wheelSpinInfo.limit
                        }
                    }
                    if (data.data.usedSpins && typeof data.data.usedSpins === 'object') {
                        wheelSpinInfo.used = {
                            reward: data.data.usedSpins.reward || 0,
                            penalty: data.data.usedSpins.penalty || 0
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to load wheel config:', error)
            }
            renderWheelSpinsLeft()
        }

        function getWheelSegments(mode) {
            const segments = []
            for (const item of (wheelConfig[mode] || [])) {
                const count = Math.max(1, parseInt(item.count) || 1)
                for (let i = 0; i < count; i++) segments.push(item)
            }
            return segments
        }

        function getWheelItemLabel(item, mode) {
            if (item.type === 'chip') {
                return `${mode === 'reward' ? '+' : '-'}${item.amount} 筹码`
            }
            // 数量由“数量小转盘”转出，主转盘惩罚项只显示名称
            // 奖励转盘中混入的惩罚项目加标记
            if (item.type === 'penalty' && mode === 'reward') return `😖 ${item.name || ''}`
            return `${item.name || ''}`
        }

        function openWheelOverlay(mode) {
            document.getElementById('wheelOverlay').classList.add('active')
            renderWheelLights()
            setWheelMode(mode || wheelMode || 'reward')
            loadWheelHistory()
        }

        function closeWheelOverlay() {
            if (wheelSpinning) return
            dismissWheelResult()
            const qtyModal = document.getElementById('qtyWheelModal')
            if (qtyModal) qtyModal.classList.remove('show')
            document.getElementById('wheelOverlay').classList.remove('active')
        }

        function setWheelMode(mode) {
            if (wheelSpinning) return
            wheelMode = mode
            const rewardBtn = document.getElementById('wheelModeRewardBtn')
            const penaltyBtn = document.getElementById('wheelModePenaltyBtn')
            const title = document.getElementById('wheelOverlayTitle')
            if (rewardBtn) rewardBtn.classList.toggle('active-reward', mode === 'reward')
            if (penaltyBtn) penaltyBtn.classList.toggle('active-penalty', mode === 'penalty')
            if (title) title.textContent = mode === 'reward' ? '🎁 奖励转盘' : '✖ 惩罚转盘'
            renderWheelSpinsLeft()
            renderWheel()
        }

        // 同步更新转盘角度（缓存 DOM 引用，避免每帧查询）
        const _wheelEls = { disc: null, blur: null, pointer: null }
        function getWheelEl(key, id) {
            if (!_wheelEls[key]) _wheelEls[key] = document.getElementById(id)
            return _wheelEls[key]
        }
        function setWheelRotation(angle) {
            const disc = getWheelEl('disc', 'wheelDisc')
            if (disc) disc.style.transform = `rotate(${angle}deg)`
        }

        // === 转盘音效（Web Audio，格间咔哒声 + 结果音效） ===
        let wheelAudioCtx = null
        let wheelSoundOn = localStorage.getItem('wheelSound') !== 'off'
        let _lastTickAt = 0

        function ensureWheelAudio() {
            if (!wheelAudioCtx) {
                try { wheelAudioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch (e) {}
            }
            if (wheelAudioCtx && wheelAudioCtx.state === 'suspended') wheelAudioCtx.resume()
        }

        function toggleWheelSound() {
            wheelSoundOn = !wheelSoundOn
            localStorage.setItem('wheelSound', wheelSoundOn ? 'on' : 'off')
            const btn = document.getElementById('wheelSoundBtn')
            if (btn) btn.textContent = wheelSoundOn ? '🔊' : '🔇'
            if (wheelSoundOn) ensureWheelAudio()
        }

        // 格间咔哒声：音量/音高随转速变化，限流避免高速时爆音
        function playWheelTick(speed) {
            if (!wheelSoundOn || !wheelAudioCtx) return
            const now = wheelAudioCtx.currentTime
            if (now - _lastTickAt < 0.026) return
            _lastTickAt = now
            try {
                const o = wheelAudioCtx.createOscillator()
                const g = wheelAudioCtx.createGain()
                o.type = 'square'
                o.frequency.value = 1500 + Math.min(900, speed * 0.35)
                g.gain.setValueAtTime(Math.min(0.08, 0.03 + speed / 26000), now)
                g.gain.exponentialRampToValueAtTime(0.0001, now + 0.045)
                o.connect(g).connect(wheelAudioCtx.destination)
                o.start(now)
                o.stop(now + 0.05)
            } catch (e) {}
        }

        // 结果音效：奖励上行琶音 / 惩罚下行低音
        function playWheelJingle(win) {
            if (!wheelSoundOn || !wheelAudioCtx) return
            try {
                const notes = win ? [523.25, 659.25, 783.99] : [329.63, 246.94]
                const t0 = wheelAudioCtx.currentTime
                notes.forEach((f, i) => {
                    const o = wheelAudioCtx.createOscillator()
                    const g = wheelAudioCtx.createGain()
                    o.type = win ? 'triangle' : 'sawtooth'
                    o.frequency.value = f
                    const st = t0 + i * 0.11
                    g.gain.setValueAtTime(0.001, st)
                    g.gain.exponentialRampToValueAtTime(0.12, st + 0.02)
                    g.gain.exponentialRampToValueAtTime(0.0001, st + 0.32)
                    o.connect(g).connect(wheelAudioCtx.destination)
                    o.start(st)
                    o.stop(st + 0.35)
                })
            } catch (e) {}
        }

        // 指针拨动效果：跨过格子边界时拨片被“打”一下
        function kickWheelPointer() {
            const p = getWheelEl('pointer', 'wheelPointer')
            if (!p) return
            p.classList.add('kick')
            clearTimeout(kickWheelPointer._t)
            kickWheelPointer._t = setTimeout(() => p.classList.remove('kick'), 70)
        }

        // 高速动态模糊强度
        function setWheelSpeedFx(speed) {
            const blur = getWheelEl('blur', 'wheelSpeedBlur')
            if (blur) blur.style.opacity = Math.max(0, Math.min(0.45, (speed - 650) / 2400))
        }

        function renderWheelLights() {
            const lights = document.getElementById('wheelLights')
            const wrap = document.getElementById('wheelWrap')
            if (!lights || !wrap || !wrap.offsetWidth) return // 隐藏时跳过，避免算出错误半径
            // 灯泡中心半径随转盘实际尺寸自适应（外圈边缘内缩 4px）
            const r = Math.round(wrap.offsetWidth / 2 + 18)
            if (lights.dataset.r === String(r)) return
            lights.dataset.r = String(r)
            let html = ''
            for (let i = 0; i < 16; i++) {
                html += `<i style="transform: translate(-50%, -50%) rotate(${i * 22.5}deg) translateY(${-r}px); animation-delay: ${(i % 2) * 0.6}s;"></i>`
            }
            lights.innerHTML = html
        }

        function renderWheel() {
            const bg = document.getElementById('wheelBg')
            const labels = document.getElementById('wheelLabels')
            const emptyTip = document.getElementById('wheelEmptyTip')
            if (!bg || !labels) return

            const segments = getWheelSegments(wheelMode)
            // 复位旋转角度与滑块位置
            wheelRotation = 0
            setWheelRotation(0)

            if (segments.length === 0) {
                bg.style.background = 'conic-gradient(#2c3e50 0deg 360deg)'
                labels.innerHTML = ''
                if (emptyTip) emptyTip.style.display = 'block'
                return
            }

            if (emptyTip) emptyTip.style.display = 'none'

            const unitAngle = 360 / segments.length
            const stops = []
            let labelHtml = ''
            // 相邻同色问题：按索引分配调色板颜色
            let colorIdx = 0
            let prevKey = null
            segments.forEach((item, i) => {
                const key = item.type + (item.refId || '') + (item.amount || '')
                if (key !== prevKey) colorIdx++
                prevKey = key
                const color = WHEEL_COLORS[colorIdx % WHEEL_COLORS.length]
                const start = i * unitAngle
                const end = (i + 1) * unitAngle
                stops.push(`${color} ${start}deg ${end}deg`)
            })
            bg.style.background = `conic-gradient(${stops.join(', ')})`

            // 每个配置项显示一个标签：沿半径辐射状排布（从中心向外阅读），
            // 自适应字号——文字放不下先缩小字号，缩小到 9px 仍放不下才省略号截断
            const items = wheelConfig[wheelMode] || []
            const LABEL_R0 = 48    // 文字起始半径（避开中心圆钮）
            const LABEL_AVAIL = 96 // 可用径向长度（内沿半径 - 起始半径 - 余量）
            let unitCursor = 0
            items.forEach(item => {
                const count = Math.max(1, parseInt(item.count) || 1)
                const centerAngle = (unitCursor + count / 2) * unitAngle
                const label = getWheelItemLabel(item, wheelMode)
                let units = 0
                for (const ch of label) units += ch.codePointAt(0) > 255 ? 1 : 0.58
                const fs = Math.max(9, Math.min(13, LABEL_AVAIL / Math.max(units, 1)))
                labelHtml += `<div class="wheel-label" style="transform: rotate(${centerAngle}deg) rotate(-90deg) translateX(${LABEL_R0}px) translateY(-50%); font-size: ${fs}px; max-width: ${LABEL_AVAIL}px;">${label}</div>`
                unitCursor += count
            })
            labels.innerHTML = labelHtml
        }

        // === 按钮蓄力转动 ===
        const CHARGE_MAX_MS = 1500 // 蓄力到满档所需时长
        let wheelCharge = null

        function bindWheelSpinButton() {
            const btn = document.getElementById('wheelSpinBtn')
            if (!btn || btn.dataset.bound) return
            btn.dataset.bound = '1'
            btn.addEventListener('pointerdown', e => {
                if (wheelSpinning || wheelCharge) return
                if (getWheelSegments(wheelMode).length === 0) {
                    alert('转盘尚未配置，请联系管理员')
                    return
                }
                const token = localStorage.getItem('token')
                if (!token) { alert('请先登录'); return }
                // 本地预检次数（按当前转盘分开计数，服务端仍会强制校验）
                const spinLimit = getWheelLimit(wheelMode)
                if (spinLimit > 0 && getWheelUsed(wheelMode) >= spinLimit) {
                    alert(`该转盘次数已用完（${getWheelUsed(wheelMode)}/${spinLimit}）`)
                    return
                }
                e.preventDefault()
                try { btn.setPointerCapture(e.pointerId) } catch (err) {}
                ensureWheelAudio()
                dismissWheelResult()
                // 开始蓄力：颜色随力度从金黄渐变到红，光晕与尺寸逐渐增强
                wheelCharge = { t0: performance.now(), level: 0 }
                applyChargeStyle(btn, 0)
                btn.textContent = '蓄力中…'
                const frame = () => {
                    if (!wheelCharge) return
                    wheelCharge.level = Math.min(1, (performance.now() - wheelCharge.t0) / CHARGE_MAX_MS)
                    applyChargeStyle(btn, wheelCharge.level)
                    requestAnimationFrame(frame)
                }
                requestAnimationFrame(frame)
            })
            const release = () => {
                if (!wheelCharge) return
                const level = Math.max(0.05, wheelCharge.level)
                wheelCharge = null
                btn.disabled = true
                btn.textContent = '转动中…'
                // 蓄力越久：初速越快（260→2600 度/秒）、收尾越久（等效拖动角度 40→1080）
                const releaseVel = 260 + level * (2600 - 260)
                const dragAngle = 40 + level * (1080 - 40)
                startSpinSequence(dragAngle, releaseVel)
            }
            btn.addEventListener('pointerup', release)
            btn.addEventListener('pointercancel', release)
        }

        // 蓄力视觉反馈：色相 48(金黄) → 0(红)，光晕与放大随力度增强
        function applyChargeStyle(btn, level) {
            const hue = 48 - 48 * level
            const light = 58 - 16 * level
            btn.style.background = `radial-gradient(circle at 35% 30%, hsl(${hue}, 100%, ${Math.min(88, light + 26)}%), hsl(${hue}, 95%, ${light}%) 55%, hsl(${hue}, 90%, ${Math.max(18, light - 30)}%) 100%)`
            btn.style.boxShadow = `0 0 ${12 + 26 * level}px hsla(${hue}, 100%, 55%, ${0.45 + 0.45 * level})`
            btn.style.transform = `scale(${1 + 0.07 * level})`
        }

        // 转动结束后恢复按钮可用
        function resetSpinButton() {
            const btn = document.getElementById('wheelSpinBtn')
            if (!btn) return
            btn.disabled = false
            btn.textContent = '按住蓄力'
            btn.style.background = ''
            btn.style.boxShadow = ''
            btn.style.transform = ''
        }

        // 跨过格子边界时的趣味反馈（音效 + 慢速时指针拨动）
        function onWheelBoundary(speed) {
            playWheelTick(speed)
            if (speed < 750) kickWheelPointer()
        }

        // 松手后按蓄力决定的速度惯性衰减（转速越来越慢，无需等待接口返回）
        // 接口返回后等到转盘接近目标格时，以与当前速度无缝衔接的 easeOutQuart 精确停入目标格
        // 全程速度单调不增；蓄力越久收尾越久，轻按则很快停下
        async function startSpinSequence(dragAngle, releaseVel) {
            if (wheelSpinning) return
            wheelSpinning = true
            dismissWheelResult()
            const token = localStorage.getItem('token')

            const MIN_SPEED = 260 // 惯性速度下限（度/秒）——低于拖动速度时不“自动加速”
            const MAX_SPEED = 2600
            let curSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, releaseVel || MIN_SPEED))
            let result = null
            let spinError = null
            fetch(`${API_BASE}/wheel/spin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ wheelType: wheelMode })
            }).then(r => r.json()).then(d => { result = d }).catch(e => { spinError = e })

            // 期望收尾时长（秒）：轻拖约 1.1s，拖得越长收尾越久（最多约 2.6s）
            const wantSec = 1.1 + Math.min(1.5, dragAngle / 720)
            const t0 = performance.now()
            let last = t0
            let phase2 = null
            let phase3 = null // 落定回弹（悬念感）
            const segs = getWheelSegments(wheelMode).length
            let lastB = segs > 1 ? Math.floor((((wheelRotation % 360) + 360) % 360) / (360 / segs)) : -1
            function frame(now) {
                const dt = Math.min(0.05, (now - last) / 1000)
                last = now
                const mod = ((wheelRotation % 360) + 360) % 360
                if (segs > 1) {
                    const b = Math.floor(mod / (360 / segs))
                    if (b !== lastB) {
                        lastB = b
                        onWheelBoundary(curSpeed || 0)
                    }
                }
                if (phase3) {
                    // 阶段3：落定回弹（阻尼摆动，营造悬念后弹出结果）
                    const t = (now - phase3.t0) / phase3.dur
                    if (t >= 1) {
                        wheelRotation = phase3.center
                        setWheelRotation(wheelRotation)
                        setWheelSpeedFx(0)
                        finishWheelSpin(result)
                        return
                    }
                    wheelRotation = phase3.center + Math.sin(t * Math.PI * 4) * Math.exp(-3.2 * t) * 1.6
                    setWheelRotation(wheelRotation)
                } else if (!phase2) {
                    // 阶段1：惯性指数衰减（衰减到下限后保持），同时等待结果
                    curSpeed = Math.max(MIN_SPEED, curSpeed * Math.exp(-1.4 * dt))
                    wheelRotation += curSpeed * dt
                    setWheelRotation(wheelRotation)
                    setWheelSpeedFx(curSpeed)
                    if (result) {
                        if (!result.success) {
                            wheelSpinning = false
                            setWheelSpeedFx(0)
                            resetSpinButton()
                            alert(result.error || '转盘转动失败')
                            return
                        }
                        const unitAngle = 360 / segs
                        const slotCenter = (result.index + 0.5) * unitAngle
                        const currentMod = ((wheelRotation % 360) + 360) % 360
                        const finalMod = ((360 - slotCenter) % 360 + 360) % 360
                        const align = ((finalMod - currentMod) % 360 + 360) % 360
                        // easeOutQuart 初速度 = 4×距离/时长（距离:度、时长:秒）
                        // 令收尾初速度 = 当前速度，则时长 = 4×距离/curSpeed
                        const wantDist = curSpeed * wantSec / 4 // 期望收尾弧长（度）
                        const n = Math.round((wantDist - align) / 360) // 需要的额外整圈数
                        if (n >= 1 || align <= wantDist) {
                            let distance = align + Math.max(0, n) * 360
                            if (distance < 45) {
                                // 距离过短会急停：能多转一圈且不拖太久就加一圈，否则等下一圈再收尾
                                if (4 * (distance + 360) / curSpeed <= wantSec + 0.5) distance += 360
                                else distance = 0
                            }
                            if (distance > 0) {
                                phase2 = {
                                    start: wheelRotation,
                                    end: wheelRotation + distance,
                                    t0: now,
                                    duration: 4000 * distance / curSpeed // 毫秒（4×距离/速度 的结果单位是秒）
                                }
                            }
                        }
                        // 否则继续阶段1旋转，等更接近目标格时再收尾（最多再转一圈）
                    } else if (spinError) {
                        wheelSpinning = false
                        setWheelSpeedFx(0)
                        resetSpinButton()
                        alert('转盘转动失败：' + spinError.message)
                        return
                    } else if (now - t0 > 8000) {
                        wheelSpinning = false
                        setWheelSpeedFx(0)
                        resetSpinButton()
                        alert('转盘响应超时，请重试')
                        return
                    }
                } else {
                    // 阶段2：easeOutQuart 惯量衰减，停在目标格子（速度单调递减）
                    const t = Math.min(1, (now - phase2.t0) / phase2.duration)
                    const ease = 1 - Math.pow(1 - t, 4)
                    wheelRotation = phase2.start + (phase2.end - phase2.start) * ease
                    setWheelRotation(wheelRotation)
                    // 瞬时速度 = 4×剩余距离系数×总距离/时长
                    curSpeed = 4 * Math.pow(1 - t, 3) * (phase2.end - phase2.start) / (phase2.duration / 1000)
                    setWheelSpeedFx(curSpeed)
                    if (t >= 1) {
                        // 进入落定回弹，随后弹出结果
                        phase3 = { center: phase2.end, t0: now, dur: 420 }
                        const wrap = document.getElementById('wheelWrap')
                        if (wrap) {
                            wrap.classList.remove('land'); void wrap.offsetWidth; wrap.classList.add('land')
                        }
                    }
                }
                requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
        }

        function finishWheelSpin(data) {
            // 惩罚判定按项目类型（奖励转盘中混入的惩罚项目也走惩罚表现）
            const itemType = (data.item && data.item.type) || ''
            const isPenaltyResult = itemType === 'penalty' || (itemType === 'chip' && wheelMode === 'penalty')

            if (typeof data.balance === 'number') {
                const user = JSON.parse(localStorage.getItem('user') || '{}')
                user.balance = data.balance
                localStorage.setItem('user', JSON.stringify(user))
                updateBalance(data.balance)
            }
            // 更新剩余次数（按当前转盘分开计数）
            const spinLimit = getWheelLimit(wheelMode)
            if (typeof data.remaining === 'number') {
                wheelSpinInfo.used[wheelMode] = Math.max(0, spinLimit - data.remaining)
            } else if (spinLimit > 0) {
                wheelSpinInfo.used[wheelMode] = getWheelUsed(wheelMode) + 1
            }
            renderWheelSpinsLeft()
            loadWheelHistory()

            const done = () => {
                showWheelResultFx(data, isPenaltyResult)
                wheelSpinning = false
                resetSpinButton()
            }
            // 转到惩罚且服务端返回了数量小转盘结果：先弹小转盘转出数量，再显示最终结果
            if (isPenaltyResult && data.quantityWheel && Array.isArray(data.quantityWheel.items) && data.quantityWheel.items.length > 0) {
                openQuantityWheel(data.quantityWheel, done)
            } else {
                done()
            }
        }

        function showWheelResultFx(data, isPenaltyResult) {
            if (isPenaltyResult) {
                // 惩罚：转盘震动 + 红光闪烁
                const wrap = document.getElementById('wheelWrap')
                wrap.classList.remove('wheel-shake'); void wrap.offsetWidth; wrap.classList.add('wheel-shake')
                const flash = document.getElementById('wheelFlash')
                flash.classList.remove('show'); void flash.offsetWidth; flash.classList.add('show')
            } else {
                burstConfetti()
            }
            // 悬浮结果弹窗（有图则显示图片，否则显示表情图标）
            const popup = document.getElementById('wheelResultPopup')
            const img = document.getElementById('wheelPopupImage')
            const icon = document.getElementById('wheelPopupIcon')
            if (data.image && img) {
                img.src = data.image
                img.style.display = 'block'
                if (icon) icon.style.display = 'none'
            } else {
                if (img) { img.style.display = 'none'; img.removeAttribute('src') }
                if (icon) { icon.style.display = 'block'; icon.textContent = isPenaltyResult ? '😖' : '🎉' }
            }
            document.getElementById('wheelPopupText').textContent = data.message || `结果：${data.item?.name || ''}`
            popup.classList.toggle('penalty', isPenaltyResult)
            popup.classList.remove('show'); void popup.offsetWidth; popup.classList.add('show')
            // 结果音效：奖励上行 / 惩罚下行
            playWheelJingle(!isPenaltyResult)
        }

        function dismissWheelResult() {
            const popup = document.getElementById('wheelResultPopup')
            if (popup) popup.classList.remove('show')
        }

        // === 数量小转盘：转到惩罚后弹出，转出惩罚数量（服务端已随机指定档位） ===
        function openQuantityWheel(qw, onDone) {
            const modal = document.getElementById('qtyWheelModal')
            const bg = document.getElementById('qtyWheelBg')
            const labels = document.getElementById('qtyWheelLabels')
            const disc = document.getElementById('qtyWheelDisc')
            if (!modal || !bg || !labels || !disc) { onDone(); return }
            // 按权重展开数量档（与服务端同一展开顺序）
            const segs = []
            for (const q of qw.items) {
                const c = Math.max(1, parseInt(q.count) || 1)
                for (let i = 0; i < c; i++) segs.push(Math.max(1, parseInt(q.times) || 1))
            }
            const total = segs.length
            if (!total) { onDone(); return }
            const unit = 360 / total
            let grad = '', lbls = ''
            segs.forEach((t, i) => {
                const start = i * unit
                const mid = start + unit / 2
                grad += `${i % 2 ? '#b71c1c' : '#e53935'} ${start}deg ${start + unit}deg, `
                lbls += `<span style="transform: translate(-50%, -50%) rotate(${mid}deg) translateY(-85px) rotate(${-mid}deg);">${t}下</span>`
            })
            bg.style.background = `conic-gradient(from 0deg, ${grad.slice(0, -2)})`
            labels.innerHTML = lbls
            // 从 0 开始，转到服务端指定档位正对顶部指针（额外整圈增强旋转感）
            disc.style.transition = 'none'
            disc.style.transform = 'rotate(0deg)'
            modal.classList.add('show')
            const target = 360 * 5 + (360 - ((qw.index % total) + 0.5) * unit)
            requestAnimationFrame(() => requestAnimationFrame(() => {
                disc.style.transition = 'transform 2.8s cubic-bezier(0.15, 0.85, 0.12, 1)'
                disc.style.transform = `rotate(${target}deg)`
            }))
            setTimeout(() => {
                modal.classList.remove('show')
                onDone()
            }, 2950)
        }

        function burstConfetti() {
            const overlay = document.getElementById('wheelOverlay')
            const colors = ['#ffd700', '#ff6b6b', '#4ecdc4', '#a78bfa', '#f9a825', '#69f0ae', '#ff8a65']
            for (let i = 0; i < 60; i++) {
                const piece = document.createElement('div')
                piece.className = 'confetti-piece'
                piece.style.left = Math.random() * 100 + 'vw'
                piece.style.background = colors[i % colors.length]
                piece.style.setProperty('--cx', (Math.random() * 160 - 80) + 'px')
                piece.style.setProperty('--cr', (Math.random() * 720 - 360) + 'deg')
                piece.style.animationDuration = (1.2 + Math.random() * 1.4) + 's'
                piece.style.animationDelay = (Math.random() * 0.3) + 's'
                overlay.appendChild(piece)
                setTimeout(() => piece.remove(), 3200)
            }
        }

        // === 转盘历史记录（默认只显示最近3条，其余折叠） ===
        let wheelHistoryData = []
        let wheelHistoryExpanded = false

        async function loadWheelHistory() {
            try {
                const res = await fetch(`${API_BASE}/wheel/history`)
                const data = await res.json()
                if (data.success) wheelHistoryData = data.data || []
            } catch (error) {
                console.error('Failed to load wheel history:', error)
            }
            renderWheelHistory()
        }

        function renderWheelHistory() {
            const container = document.getElementById('wheelHistoryList')
            const toggle = document.getElementById('wheelHistoryToggle')
            if (!container) return
            if (!wheelHistoryData.length) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 12px;">暂无记录</p>'
                if (toggle) toggle.textContent = ''
                return
            }
            const shown = wheelHistoryExpanded ? wheelHistoryData : wheelHistoryData.slice(0, 3)
            container.innerHTML = shown.map(spin => {
                const wheelName = spin.wheel_type === 'reward' ? '奖励转盘' : '惩罚转盘'
                const wheelColor = spin.wheel_type === 'reward' ? '#28a745' : '#ff4444'
                const resultColor = spin.item_type === 'chip'
                    ? (spin.wheel_type === 'reward' ? '#28a745' : '#ff6b6b')
                    : '#ffd700'
                return `
                    <div class="item-card">
                        <div class="item-info">
                            <div class="item-name" style="color: ${resultColor}; font-size: 14px;">${spin.item_name}</div>
                            <div class="item-desc">${spin.username} · <span style="color: ${wheelColor};">${wheelName}</span></div>
                        </div>
                        <div class="item-actions" style="color: #aaa; font-size: 12px; white-space: nowrap;">${toBeijingTime(spin.created_at)}</div>
                    </div>
                `
            }).join('')
            if (toggle) {
                toggle.textContent = wheelHistoryData.length > 3
                    ? (wheelHistoryExpanded ? `收起 ▲` : `展开全部(${wheelHistoryData.length}) ▼`)
                    : ''
            }
        }

        function toggleWheelHistory() {
            wheelHistoryExpanded = !wheelHistoryExpanded
            renderWheelHistory()
        }

        function toggleWheelAdmin() {
            const body = document.getElementById('wheelAdminBody')
            const toggle = document.getElementById('wheelAdminToggle')
            if (!body) return
            const show = body.style.display === 'none'
            body.style.display = show ? 'block' : 'none'
            if (toggle) toggle.textContent = show ? '收起 ▲' : '展开 ▼'
        }

        // === 转盘配置（管理员） ===
        function setWheelAdminTab(tab) {
            wheelAdminTab = tab
            wheelAdminDraft = {
                reward: JSON.parse(JSON.stringify(wheelConfig.reward || [])),
                penalty: JSON.parse(JSON.stringify(wheelConfig.penalty || [])),
                penaltyQuantity: JSON.parse(JSON.stringify(wheelConfig.penaltyQuantity || []))
            }
            const tabBtns = { reward: 'wheelAdminRewardTab', penalty: 'wheelAdminPenaltyTab', penaltyQuantity: 'wheelAdminQtyTab' }
            for (const [key, id] of Object.entries(tabBtns)) {
                const el = document.getElementById(id)
                if (el) el.style.opacity = key === tab ? '1' : '0.5'
            }
            const limitInput = document.getElementById('wheelAdminSpinLimit')
            if (limitInput) limitInput.value = wheelSpinInfo.limit || 0
            renderWheelAdminItems()
        }

        function renderWheelAdminItems() {
            const container = document.getElementById('wheelAdminItems')
            if (!container) return
            const addBtn = document.getElementById('btnAddWheelItem')
            if (addBtn) addBtn.textContent = wheelAdminTab === 'penaltyQuantity' ? '＋ 添加数量档' : '＋ 添加项目'
            // 数量小转盘页签：每行定义一档惩罚数量与权重
            if (wheelAdminTab === 'penaltyQuantity') {
                const items = wheelAdminDraft.penaltyQuantity || []
                if (items.length === 0) {
                    container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 12px;">暂无数量档位，请点击“添加数量档”</p>'
                    return
                }
                container.innerHTML = items.map((item, i) => `
                    <div class="wheel-item-row">
                        <label style="color: #ddd; font-size: 13px; white-space: nowrap;">数量</label>
                        <input type="number" min="1" max="999" value="${item.times ?? ''}" onchange="updateWheelItem(${i}, 'times', this.value)" style="width: 90px;" title="转出后记入惩罚数量 N">
                        <label style="color: #aaa; font-size: 13px;">权重</label>
                        <input type="number" min="1" max="99" value="${item.count || 1}" onchange="updateWheelItem(${i}, 'count', this.value)" style="width: 70px;" title="决定该数量的概率与小转盘面积">
                        <button class="btn btn-danger" onclick="removeWheelItem(${i})">删除</button>
                    </div>
                `).join('')
                return
            }
            const items = wheelAdminDraft[wheelAdminTab]
            if (items.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 12px;">暂无项目，请点击"添加项目"</p>'
                return
            }
            container.innerHTML = items.map((item, i) => {
                const typeOptions = wheelAdminTab === 'reward'
                    ? `<option value="reward" ${item.type === 'reward' ? 'selected' : ''}>管理后台奖励</option>
                       <option value="chip" ${item.type === 'chip' ? 'selected' : ''}>筹码奖励</option>
                       <option value="penalty" ${item.type === 'penalty' ? 'selected' : ''}>管理后台惩罚</option>`
                    : `<option value="penalty" ${item.type === 'penalty' ? 'selected' : ''}>管理后台惩罚</option>
                       <option value="chip" ${item.type === 'chip' ? 'selected' : ''}>筹码惩罚</option>`
                // 混排时按项目类型选择数据源（奖励转盘中的惩罚项目用惩罚列表）
                const sourceList = item.type === 'penalty' ? adminPenalties : adminRewards
                let valueControl
                if (item.type === 'chip') {
                    valueControl = `<input type="number" min="1" placeholder="筹码数量" value="${item.amount ?? ''}" onchange="updateWheelItem(${i}, 'amount', this.value)" style="width: 110px;">`
                } else {
                    valueControl = `<select onchange="updateWheelItem(${i}, 'refId', this.value)">
                        <option value="">请选择${item.type === 'penalty' ? '惩罚' : '奖励'}</option>
                        ${sourceList.map(t => `<option value="${t.id}" ${item.refId == t.id ? 'selected' : ''}>${t.name}（¥${t.price}）</option>`).join('')}
                    </select>`
                }
                return `
                    <div class="wheel-item-row">
                        <select onchange="updateWheelItem(${i}, 'type', this.value)">
                            ${typeOptions}
                        </select>
                        ${valueControl}
                        <label style="color: #aaa; font-size: 13px;">权重</label>
                        <input type="number" min="1" max="99" value="${item.count || 1}" onchange="updateWheelItem(${i}, 'count', this.value)" style="width: 70px;" title="决定中奖概率与转盘面积">
                        <button class="btn btn-danger" onclick="removeWheelItem(${i})">删除</button>
                    </div>
                `
            }).join('')
        }

        function updateWheelItem(index, field, value) {
            const item = wheelAdminDraft[wheelAdminTab][index]
            if (!item) return
            if (field === 'type') {
                if (item.type !== value) {
                    item.type = value
                    // 切换类型后原引用失效，重置待重新选择
                    item.refId = null
                    item.name = ''
                    item.times = null
                }
            } else if (field === 'amount') {
                item.amount = value === '' ? null : parseFloat(value)
            } else if (field === 'times') {
                item.times = value === '' ? null : Math.max(1, Math.min(999, parseInt(value) || 1))
            } else if (field === 'refId') {
                item.refId = value === '' ? null : parseInt(value)
                const source = item.type === 'penalty' ? adminPenalties : adminRewards
                const found = source.find(t => t.id == value)
                item.name = found ? found.name : ''
            } else if (field === 'count') {
                item.count = Math.max(1, Math.min(99, parseInt(value) || 1))
            }
            renderWheelAdminItems()
        }

        function addWheelItem() {
            // 数量小转盘页签：默认添加一档数量
            if (wheelAdminTab === 'penaltyQuantity') {
                const qtyItems = wheelAdminDraft.penaltyQuantity
                if (qtyItems.length >= 20) {
                    alert('最多添加 20 个数量档位')
                    return
                }
                qtyItems.push({ times: 10, count: 1 })
                renderWheelAdminItems()
                return
            }
            const items = wheelAdminDraft[wheelAdminTab]
            if (items.length >= 20) {
                alert('最多添加 20 个项目')
                return
            }
            // 默认添加一个筹码项目
            items.push({ type: 'chip', amount: 100, count: 1 })
            renderWheelAdminItems()
        }

        function removeWheelItem(index) {
            const target = wheelAdminTab === 'penaltyQuantity' ? wheelAdminDraft.penaltyQuantity : wheelAdminDraft[wheelAdminTab]
            target.splice(index, 1)
            renderWheelAdminItems()
        }

        async function saveWheelConfig() {
            const btn = document.getElementById('btnSaveWheelConfig')
            if (btn.disabled) return
            const items = wheelAdminDraft[wheelAdminTab]
            for (const item of items) {
                if (wheelAdminTab === 'penaltyQuantity') {
                    if (!item.times || item.times <= 0) {
                        alert('每个数量档位的数量必须是大于 0 的整数')
                        return
                    }
                    continue
                }
                if (item.type === 'chip') {
                    if (isNaN(item.amount) || item.amount <= 0) {
                        alert('筹码项目的数量必须是大于 0 的数字')
                        return
                    }
                } else if (!item.refId || !item.name) {
                    alert('请为每个项目选择对应的' + (wheelAdminTab === 'reward' ? '奖励' : '惩罚'))
                    return
                }
            }
            lockBtn(btn)
            const token = localStorage.getItem('token')
            const limitInput = document.getElementById('wheelAdminSpinLimit')
            const spinLimitPerUser = limitInput ? Math.max(0, parseInt(limitInput.value) || 0) : 0
            try {
                const response = await fetch(`${API_BASE}/wheel/config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({
                        reward: wheelAdminDraft.reward,
                        penalty: wheelAdminDraft.penalty,
                        penaltyQuantity: wheelAdminDraft.penaltyQuantity,
                        spinLimitPerUser
                    })
                })
                const data = await response.json()
                if (data.success) {
                    wheelConfig = {
                        reward: data.data.reward || [],
                        penalty: data.data.penalty || [],
                        penaltyQuantity: data.data.penaltyQuantity || []
                    }
                    if (typeof data.data.spinLimitPerUser === 'number') {
                        wheelSpinInfo.limit = data.data.spinLimitPerUser
                    }
                    renderWheel()
                    renderWheelSpinsLeft()
                    showAutoIndicator('转盘配置已保存')
                } else {
                    alert(data.error || '保存失败')
                }
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }


// games 页管理员打开配置面板需要奖励/惩罚类型列表（旧 SPA 依赖先访问管理后台，这里主动加载）
async function loadAdminTypesForWheel() {
    if (!currentUser || currentUser.role !== 'admin') return
    const token = localStorage.getItem('token')
    try {
        const [r, p] = await Promise.all([
            fetch(`${API_BASE}/admin/reward-types`, { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch(`${API_BASE}/admin/penalty-types`, { headers: { 'Authorization': `Bearer ${token}` } })
        ])
        const rd = await r.json()
        const pd = await p.json()
        if (rd.success) adminRewards = rd.data || []
        if (pd.success) adminPenalties = pd.data || []
    } catch (e) {
        console.error('Failed to load admin types for wheel:', e)
    }
}
