// 一次性拆分脚本：把 public/index.html（单文件 SPA）机械拆分为多页面结构
// 用法: node tools/split-site.js
const fs = require('fs')
const path = require('path')

const PUB = path.join(__dirname, '..', 'public')
// 始终从原始单文件副本读取，避免脚本重跑时读到已拆分的 index.html
const src = fs.readFileSync(path.join(__dirname, 'source-index.html'), 'utf8')

const V = 'v=4' // 静态资源缓存戳

// ---------- 工具 ----------
function slice(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker)
  if (s < 0) throw new Error(`start not found: ${label || startMarker}`)
  if (src.indexOf(startMarker, s + 1) >= 0) throw new Error(`start not unique: ${label || startMarker}`)
  const e = src.indexOf(endMarker, s)
  if (e < 0) throw new Error(`end not found: ${label || endMarker}`)
  return src.slice(s, e).replace(/\s+$/, '\n')
}

function write(rel, content) {
  const p = path.join(PUB, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  console.log('write', rel, content.length, 'bytes')
}

// ---------- HTML 提取 ----------
const styleCSS = src.match(/<style>([\s\S]*?)<\/style>/)[1].trim()
const authHTML = src.slice(src.indexOf('    <div id="authSection">'), src.indexOf('    <div id="mainSection"')).trimEnd()
const headerHTML = src.slice(src.indexOf('        <div class="header">'), src.indexOf('        <div class="container">')).trimEnd()
const wheelOverlayHTML = src.slice(src.indexOf('    <div class="wheel-overlay" id="wheelOverlay">'), src.indexOf('    <div class="modal" id="productModal">')).trimEnd()
const indicatorHTML = src.slice(src.indexOf('    <div class="auto-save-indicator" id="autoSaveIndicator">'), src.indexOf('    <script>')).trimEnd()

// 弹窗按出现顺序切块
const modalIds = ['productModal', 'userBalanceModal', 'userWheelLimitsModal', 'assetModal', 'debtModal', 'itemModal', 'rewardModal', 'penaltyModal', 'adminRewardModal', 'adminPenaltyModal']
const modalHTML = {}
modalIds.forEach((id, i) => {
  const start = `    <div class="modal" id="${id}">`
  const end = i < modalIds.length - 1
    ? `    <div class="modal" id="${modalIds[i + 1]}">`
    : '    <div class="auto-save-indicator"'
  modalHTML[id] = src.slice(src.indexOf(start), src.indexOf(end)).trimEnd()
})

// ---------- PAGE_CONTENT 模板提取 ----------
const pageKeys = ['home', 'assets', 'shop', 'bank', 'admin', 'users', 'games']
const pageHTML = {}
pageKeys.forEach((key) => {
  const start = src.indexOf(`"${key}": \``)
  if (start < 0) throw new Error(`page key not found: ${key}`)
  const bodyStart = src.indexOf('`', start) + 1
  // 每个模板都以「`,」+ 行尾结尾（兼容 CRLF）
  const endRel = src.slice(start).match(/`,\r?\n/)
  if (!endRel) throw new Error(`page template end not found: ${key}`)
  const bodyEnd = start + endRel.index
  const body = src.slice(bodyStart, bodyEnd)
  pageHTML[key] = body.trimEnd()
})

// ---------- JS 提取 ----------
const js = {}

// 全局变量分区
const globalsSrc = slice('        const API_BASE', '        function showAuthTab', 'globals')
function pickGlobal(name, source) {
  const re = new RegExp(`^\\s*(?:let|const) ${name} = .*$`, 'm')
  const m = (source || globalsSrc).match(re)
  if (!m) throw new Error(`global not found: ${name}`)
  return m[0]
}
js.common_globals = [
  pickGlobal('API_BASE'),
  pickGlobal('currentUser'),
  'var adminRewards = []',
  'var adminPenalties = []'
].join('\n')
js.admin_globals = ['products', 'editingProductId', 'currentImageData', 'editingAdminRewardId', 'adminRewardImageData', 'editingAdminPenaltyId', 'adminPenaltyImageData'].map(n => pickGlobal(n, src)).join('\n')
js.users_globals = ['editingUserBalance', 'items', 'rewards', 'debts', 'penalties', 'selectedUser', 'editingItemId', 'editingRewardId', 'editingDebtId', 'editingPenaltyId'].map(n => pickGlobal(n)).join('\n')

// 认证（登录/注册成功改为跳转 home.html）
js.auth_core = slice('        function showAuthTab', '        function handleLogout', 'auth_core')
  .replaceAll('showMainApp()', "location.replace('home.html')")

// 公共工具
js.f_fileToBase64 = slice('        async function fileToBase64', '        function handleAnnouncementImageUpload', 'fileToBase64')
js.f_time = slice('        function toBeijingTime', '        // === 公告栏 ===', 'toBeijingTime')
js.f_utils = slice('        function showSaveStatus', '        let adminRewards', 'utils')
js.f_updateBalance = slice('        function updateBalance', '        checkAuth()', 'updateBalance')

// handleLogout → 跳转登录页
js.f_logout = slice('        function handleLogout', '        // Page HTML content', 'handleLogout')
  .replaceAll("document.getElementById('authSection').style.display = 'block'", "location.replace('index.html')")
  .replace(/document\.getElementById\('mainSection'\)\.style\.display = 'none'\n?/, '')

// 各页面域
js.home_lets = slice('        let announcementImageData', '        async function fileToBase64', 'home_lets')
js.home_handlers = slice('        function handleAnnouncementImageUpload', '        function toBeijingTime', 'home_handlers')
js.home_ann = slice('        // === 公告栏 ===', '        // === 留言板 ===', 'announcements')
js.home_msg = slice('        // === 留言板 ===', '        let assetLogsData', 'messages')
js.assets = slice('        let assetLogsData', '        function showPage', 'assets')
js.wheel = slice('        // ==================== 转盘系统 ====================', '        function openUserBalanceModalForSelectedUser', 'wheel')
js.users1 = slice('        function openUserBalanceModalForSelectedUser', '        async function loadProducts', 'users1')
js.products = slice('        async function loadProducts', '        async function loadUsers', 'products')
js.users2 = slice('        async function loadUsers', '        function showSaveStatus', 'users2')
js.adminRewards = slice('        async function loadAdminRewards', '        let adminPenalties', 'adminRewards')
js.adminPenalties = slice('        async function loadAdminPenalties', '        // ==================== 商店页面 ====================', 'adminPenalties')
js.shop = slice('        // ==================== 商店页面 ====================', '        // ==================== 银行/贷款页面 ====================', 'shop')
js.bank = slice('        // ==================== 银行/贷款页面 ====================', '        // ==================== 管理员 - 贷款管理 ====================', 'bank')
js.loans = slice('        // ==================== 管理员 - 贷款管理 ====================', '        function updateBalance', 'loans')

// 转盘配置面板原本调用 admin 页的渲染版 loadAdminRewards/loadAdminPenalties，
// 拆分后 games 页不加载 admin.js，改用本文件提供的轻量版 loadAdminTypesForWheel
js.wheel = js.wheel.replace(
  'await Promise.all([loadAdminRewards(), loadAdminPenalties()])',
  'await loadAdminTypesForWheel()'
)

// 渲染函数加 null 守卫（详情区未打开/页面无对应容器时直接返回，避免报错）
js.users1 = js.users1.replace(
  /((?:async )?function (?:renderItems|renderRewards|renderDebts|renderPenalties)\(\) \{\r?\n\s*const container = document\.getElementById\('\w+'\))/g,
  '$1\n            if (!container) return'
)

// 银行状态 UI 在无 banner 的页面（如 admin 页调用 loadAdminBankStatus）直接返回
js.bank = js.bank.replace(
  /function updateBankStatusUI\(bankOpen\) \{\r?\n(\s*const banner = document\.getElementById\('bankStatusBanner'\))/,
  'function updateBankStatusUI(bankOpen) {\n$1\n            if (!banner) return'
)

// ---------- 组装 JS 文件 ----------
write('js/common.js', `// 公共：全局状态、工具函数、认证与页面引导（自 index.html 拆分）
${js.common_globals}

// === 图片上传 / 时间工具 ===
${js.f_fileToBase64}
${js.f_time}
// === 按钮锁定 / 自动保存提示 ===
${js.f_utils}
// === 余额刷新 ===
${js.f_updateBalance}

// === 认证与页面引导 ===
function applyAdminVisibility() {
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = currentUser && currentUser.role === 'admin' ? 'block' : 'none'
    })
}

function setHeader() {
    document.getElementById('currentUsername').textContent = currentUser.username
    document.getElementById('userBadge').textContent = currentUser.role === 'admin' ? '管理员' : '玩家'
    document.getElementById('userBadge').className = \`user-badge \${currentUser.role}\`
    document.getElementById('userBalance').textContent = \`筹码: ¥\${currentUser.balance || 0}\`
    const stat = document.getElementById('userBalanceStat')
    if (stat) stat.textContent = \`¥\${currentUser.balance || 0}\`
}

async function verifyAuth() {
    const token = localStorage.getItem('token')
    const user = localStorage.getItem('user')
    if (token && user) {
        try {
            const response = await fetch(\`\${API_BASE}/user/profile\`, {
                headers: { 'Authorization': \`Bearer \${token}\` }
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
        const response = await fetch(\`\${API_BASE}/user/profile\`, {
            headers: { 'Authorization': \`Bearer \${token}\` }
        })
        if (response.ok) location.replace('home.html')
    } catch (e) {}
}

${js.f_logout}
`)

write('js/auth.js', `// 登录 / 注册（自 index.html 拆分）
${js.auth_core}
`)

write('js/home.js', `// 主页面：公告栏 + 留言板（自 index.html 拆分）
${js.home_lets}
${js.home_handlers}
${js.home_ann}
${js.home_msg}
`)

write('js/assets.js', `// 我的资产页（自 index.html 拆分）
${js.assets}
`)

write('js/wheel.js', `// 转盘系统：游戏页转盘 + 数量小转盘 + 转盘配置（自 index.html 拆分）
${js.wheel}

// games 页管理员打开配置面板需要奖励/惩罚类型列表（旧 SPA 依赖先访问管理后台，这里主动加载）
async function loadAdminTypesForWheel() {
    if (!currentUser || currentUser.role !== 'admin') return
    const token = localStorage.getItem('token')
    try {
        const [r, p] = await Promise.all([
            fetch(\`\${API_BASE}/admin/reward-types\`, { headers: { 'Authorization': \`Bearer \${token}\` } }),
            fetch(\`\${API_BASE}/admin/penalty-types\`, { headers: { 'Authorization': \`Bearer \${token}\` } })
        ])
        const rd = await r.json()
        const pd = await p.json()
        if (rd.success) adminRewards = rd.data || []
        if (pd.success) adminPenalties = pd.data || []
    } catch (e) {
        console.error('Failed to load admin types for wheel:', e)
    }
}
`)

write('js/users.js', `// 用户管理页（自 index.html 拆分）
${js.users_globals}
${js.users1}
${js.users2}
`)

write('js/admin.js', `// 管理后台：奖励/惩罚类型管理 + 商品管理（自 index.html 拆分）
${js.admin_globals}
${js.products}
${js.adminRewards}
${js.adminPenalties}
`)

write('js/shop.js', `// 商店页（自 index.html 拆分）
${js.shop}
`)

write('js/bank.js', `// 银行/贷款页 + 贷款配置与银行开关（自 index.html 拆分）
${js.bank}
`)

write('js/loans.js', `// 管理员 - 贷款管理（自 index.html 拆分）
${js.loans}
`)

// ---------- 组装页面 ----------
write('css/style.css', `${styleCSS}

/* 多页面导航兼容：nav 使用 <a> 链接 */
a.nav-btn {
    text-decoration: none;
    display: inline-block;
}
`)

const NAV_ITEMS = [
  ['home', '主页面', false],
  ['assets', '我的资产', false],
  ['shop', '商店', false],
  ['bank', '银行', false],
  ['admin', '管理后台', true],
  ['users', '用户管理', true],
  ['wheel', '幸运转盘', false],
  ['games', '游戏界面', false]
]

function buildHeader(activePage) {
  let html = headerHTML
  // 直接重建导航区（源 SPA 无 wheel 入口，逐按钮替换无法覆盖新增页面）
  const navInner = NAV_ITEMS.map(([id, label, adminOnly]) => {
    const cls = `nav-btn${adminOnly ? ' admin-only' : ''}${id === activePage ? ' active' : ''}`
    return `<a class="${cls}" href="${id}.html">${label}</a>`
  }).join('\n                    ')
  const navRe = /(<div class="nav">)[\s\S]*?(<\/div>\s*<div class="user-info">)/
  if (!navRe.test(html)) throw new Error('nav block not found in header')
  html = html.replace(navRe, `$1\n                    ${navInner}\n                $2`)
  return html
}

function pageHead() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>11的娱乐游戏网站</title>
    <link rel="stylesheet" href="css/style.css?${V}">
</head>
<body>
`
}

function buildAppPage({ activePage, pageKey, modals = [], includeWheelOverlay = false, scripts = [], boot, transformPage }) {
  let page = pageHTML[pageKey]
  if (transformPage) page = transformPage(page)
  if (!page.includes('class="page active"')) {
    page = page.replace('class="page"', 'class="page active"')
  }
  const scriptTags = ['common', ...scripts].map(s => `    <script src="js/${s}.js?${V}"></script>`).join('\n')
  return `${pageHead()}    <div id="mainSection">
${buildHeader(activePage)}

        <div class="container">
${page}
        </div>

${modals.map(id => modalHTML[id]).join('\n\n')}${modals.length ? '\n\n' : ''}${includeWheelOverlay ? wheelOverlayHTML + '\n\n' : ''}${indicatorHTML}
    </div>

${scriptTags}
    <script>${boot}</script>
</body>
</html>
`
}

// 登录页
write('index.html', `${pageHead()}${authHTML}

    <script src="js/common.js?${V}"></script>
    <script src="js/auth.js?${V}"></script>
    <script>initLoginPage()</script>
</body>
</html>
`)

write('home.html', buildAppPage({
  activePage: 'home', pageKey: 'home',
  scripts: ['home'],
  boot: `initAppPage(() => { try { loadAnnouncements(); loadMessages() } catch (error) { console.error('Failed to load board data:', error) } })`
}))

write('assets.html', buildAppPage({
  activePage: 'assets', pageKey: 'assets',
  scripts: ['assets'],
  boot: `initAppPage(loadUserAssets)`
}))

write('shop.html', buildAppPage({
  activePage: 'shop', pageKey: 'shop',
  scripts: ['shop'],
  boot: `initAppPage(loadShop)`
}))

write('bank.html', buildAppPage({
  activePage: 'bank', pageKey: 'bank',
  scripts: ['bank'],
  boot: `initAppPage(loadBank)`
}))

write('admin.html', buildAppPage({
  activePage: 'admin', pageKey: 'admin',
  modals: ['adminRewardModal', 'adminPenaltyModal', 'productModal'],
  scripts: ['admin', 'bank', 'loans'],
  boot: `initAppPage(() => { if (currentUser && currentUser.role === 'admin') { loadAdminRewards(); loadAdminPenalties(); loadLoanConfig(); loadAdminBankStatus(); loadAdminLoans() } })`
}))

write('users.html', buildAppPage({
  activePage: 'users', pageKey: 'users',
  modals: ['userBalanceModal', 'userWheelLimitsModal', 'assetModal', 'debtModal', 'itemModal', 'rewardModal', 'penaltyModal'],
  scripts: ['users'],
  boot: `initAppPage(() => { if (currentUser && currentUser.role === 'admin') loadUsers() })`
}))

// games 页：幸运转盘入口改为跳转独立页面 wheel.html（emptyTip 移至转盘页）
write('games.html', buildAppPage({
  activePage: 'games', pageKey: 'games',
  scripts: [],
  boot: `initAppPage()`,
  transformPage(page) {
    return page
      .replace('onclick="openWheelOverlay()"', "onclick=\"location.href='wheel.html'\"")
      .replace(/\s*<div id="wheelEmptyTip"[\s\S]*?<\/div>\r?\n/, '\n')
  }
}))

// 幸运转盘独立页：转盘浮层内联为页面主体，返回按钮跳回游戏中心
write('wheel.html', `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>幸运转盘 - 11的娱乐游戏网站</title>
    <link rel="stylesheet" href="css/style.css?${V}">
    <style>
        /* 转盘页：浮层静态内联展示（覆盖 fixed 全屏样式） */
        .wheel-overlay {
            position: relative;
            inset: auto;
            z-index: auto;
            display: block;
            overflow-y: visible;
            padding: 0;
            background: none;
        }
        .wheel-overlay::before { display: none; }
        .container { max-width: 620px; margin: 0 auto; padding: 20px 16px; }
    </style>
</head>
<body>
    <div id="mainSection">
${buildHeader('wheel')}

        <div class="container">
            <div id="wheelEmptyTip" style="color: #aaa; text-align: center; display: none;">转盘尚未配置，请联系管理员在转盘内进行配置</div>
${wheelOverlayHTML.replace('onclick="closeWheelOverlay()"', "onclick=\"location.href='games.html'\"")}
        </div>

${indicatorHTML}
    </div>

    <script src="js/common.js?${V}"></script>
    <script src="js/wheel.js?${V}"></script>
    <script>initAppPage(() => { initWheelPage(); loadAdminTypesForWheel(); openWheelOverlay() })</script>
</body>
</html>
`)

console.log('\nDone.')
