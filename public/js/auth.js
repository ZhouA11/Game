// 登录 / 注册（自 index.html 拆分）
        function showAuthTab(tab) {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'))
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'))
            
            if (tab === 'login') {
                document.querySelectorAll('.auth-tab')[0].classList.add('active')
                document.getElementById('loginForm').classList.add('active')
            } else {
                document.querySelectorAll('.auth-tab')[1].classList.add('active')
                document.getElementById('registerForm').classList.add('active')
            }
        }

        async function handleLogin() {
            const btn = document.getElementById('btnLogin')
            if (btn.disabled) return
            lockBtn(btn)
            const username = document.getElementById('loginUsername').value
            const password = document.getElementById('loginPassword').value
            const errorDiv = document.getElementById('loginError')

            if (!username || !password) {
                errorDiv.textContent = '用户名和密码不能为空'
                errorDiv.classList.add('show')
                unlockBtn(btn)
                return
            }

            try {
                const response = await fetch(`${API_BASE}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                })

                const data = await response.json()

                if (data.success) {
                    localStorage.setItem('token', data.token)
                    localStorage.setItem('user', JSON.stringify(data.user))
                    currentUser = data.user
                    location.replace('home.html')
                } else {
                    errorDiv.textContent = data.error
                    errorDiv.classList.add('show')
                    unlockBtn(btn)
                }
            } catch (error) {
                errorDiv.textContent = '登录失败，请检查网络连接'
                errorDiv.classList.add('show')
                unlockBtn(btn)
            }
        }

        async function handleRegister() {
            const btn = document.getElementById('btnRegister')
            if (btn.disabled) return
            lockBtn(btn)
            const username = document.getElementById('registerUsername').value
            const password = document.getElementById('registerPassword').value
            const confirmPassword = document.getElementById('registerConfirmPassword').value
            const errorDiv = document.getElementById('registerError')

            if (!username || !password) {
                errorDiv.textContent = '用户名和密码不能为空'
                errorDiv.classList.add('show')
                unlockBtn(btn)
                return
            }

            if (password !== confirmPassword) {
                errorDiv.textContent = '两次输入的密码不一致'
                errorDiv.classList.add('show')
                unlockBtn(btn)
                return
            }

            try {
                const response = await fetch(`${API_BASE}/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, role: 'player' })
                })

                const data = await response.json()

                if (data.success) {
                    localStorage.setItem('token', data.token)
                    localStorage.setItem('user', JSON.stringify(data.user))
                    currentUser = data.user
                    location.replace('home.html')
                } else {
                    errorDiv.textContent = data.error
                    errorDiv.classList.add('show')
                    unlockBtn(btn)
                }
            } catch (error) {
                errorDiv.textContent = '注册失败，请检查网络连接'
                errorDiv.classList.add('show')
                unlockBtn(btn)
            }
        }

