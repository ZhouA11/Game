// 公共：全局状态、工具函数、认证与页面引导（自 index.html 拆分）
        const API_BASE = '/api'

        
        let currentUser = null
var adminRewards = []
var adminPenalties = []

// === 图片上传 / 时间工具 ===
        async function fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result)
                reader.onerror = reject
                reader.readAsDataURL(file)
            })
        }

        function toBeijingTime(dateStr) {
            if (!dateStr) return ''
            try {
                // SQLite 返回的 datetime 不带时区标记（如 "2026-09-13 16:17:46"），视为 UTC
                const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z')
                if (isNaN(d.getTime())) return dateStr
                // 使用 toLocaleString 指定 Asia/Shanghai 时区（北京时间）
                return d.toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                }).replace(/\//g, '-')
            } catch (e) {
                return dateStr
            }
        }

// === 按钮锁定 / 自动保存提示 ===
        function showSaveStatus(elementId) {
            const element = document.getElementById(elementId)
            element.classList.add('show')
            setTimeout(() => {
                element.classList.remove('show')
            }, 2000)
        }

        // 按钮禁用/恢复辅助函数
        function lockBtn(btn) {
            if (!btn) return
            btn.disabled = true
            btn.style.opacity = '0.5'
            btn.style.cursor = 'not-allowed'
        }
        function unlockBtn(btn) {
            if (!btn) return
            btn.disabled = false
            btn.style.opacity = '1'
            btn.style.cursor = 'pointer'
        }
        async function withBtnLock(btn, callback) {
            if (!btn || btn.disabled) return
            lockBtn(btn)
            try {
                return await callback()
            } finally {
                unlockBtn(btn)
            }
        }

        function showAutoIndicator(message) {
            const indicator = document.getElementById('autoSaveIndicator')
            indicator.textContent = '✓ ' + message
            indicator.classList.add('show')
            setTimeout(() => {
                indicator.classList.remove('show')
            }, 2000)
        }

        // 管理后台 - 奖励管理

// === 余额刷新 ===
        function updateBalance(newBalance) {
            document.querySelectorAll('[id$="BalanceStat"], [id="userBalance"]').forEach(el => {
                if (el.id === 'userBalance') {
                    el.textContent = `筹码: ¥${newBalance || 0}`
                } else {
                    el.textContent = `¥${newBalance || 0}`
                }
            })
        }


// === 认证与页面引导 ===
function applyAdminVisibility() {
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = currentUser && currentUser.role === 'admin' ? 'block' : 'none'
    })
}

function setHeader() {
    document.getElementById('currentUsername').textContent = currentUser.username
    document.getElementById('userBadge').textContent = currentUser.role === 'admin' ? '管理员' : '玩家'
    document.getElementById('userBadge').className = `user-badge ${currentUser.role}`
    document.getElementById('userBalance').textContent = `筹码: ¥${currentUser.balance || 0}`
    const stat = document.getElementById('userBalanceStat')
    if (stat) stat.textContent = `¥${currentUser.balance || 0}`
}

async function verifyAuth() {
    const token = localStorage.getItem('token')
    const user = localStorage.getItem('user')
    if (token && user) {
        try {
            const response = await fetch(`${API_BASE}/user/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            if (response.ok) {
                const data = await response.json()
                currentUser = { ...JSON.parse(user), ...data }
                localStorage.setItem('user', JSON.stringify(currentUser))
                return true
            }
        } catch (error) {
            console.error('Auth check failed:', error)
        }
    }
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    location.replace('index.html')
    return false
}

async function initAppPage(loader) {
    const ok = await verifyAuth()
    if (!ok) return
    setHeader()
    applyAdminVisibility()
    if (loader) await loader()
}

async function initLoginPage() {
    const token = localStorage.getItem('token')
    const user = localStorage.getItem('user')
    if (!token || !user) return
    try {
        const response = await fetch(`${API_BASE}/user/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        })
        if (response.ok) location.replace('home.html')
    } catch (e) {}
}

        function handleLogout() {
            localStorage.removeItem('token')
            localStorage.removeItem('user')
            currentUser = null
            location.replace('index.html')
            
        }

