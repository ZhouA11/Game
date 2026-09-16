// 银行/贷款页 + 贷款配置与银行开关（自 index.html 拆分）
        // ==================== 银行/贷款页面 ====================
        async function loadBank() {
            // 先检查银行状态
            try {
                const statusRes = await fetch(`${API_BASE}/bank/status`)
                const statusData = await statusRes.json()
                const bankOpen = statusData.bank_open === true
                updateBankStatusUI(bankOpen)
            } catch (e) {
                console.error('Failed to check bank status:', e)
            }

            await Promise.all([
                loadLoanConfig(),
                loadMyLoans()
            ])
            // 更新银行页统计
            try {
                const token = localStorage.getItem('token')
                const response = await fetch(`${API_BASE}/user/profile`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data) {
                    document.getElementById('bankBalanceStat').textContent = `¥${data.balance || 0}`
                }
            } catch (e) {}
        }

        function updateBankStatusUI(bankOpen) {
            const banner = document.getElementById('bankStatusBanner')
            if (!banner) return
            const bankPage = document.getElementById('bank')
            if (!bankOpen) {
                banner.style.display = 'block'
                banner.style.background = 'rgba(255, 68, 68, 0.15)'
                banner.style.border = '1px solid #ff4444'
                banner.style.color = '#ff4444'
                banner.textContent = '🔒 银行目前关闭中，无法申请贷款'
                bankPage.classList.add('bank-disabled')
            } else {
                banner.style.display = 'block'
                banner.style.background = 'rgba(40, 167, 69, 0.15)'
                banner.style.border = '1px solid #28a745'
                banner.style.color = '#28a745'
                banner.textContent = '✅ 银行正常开放'
                bankPage.classList.remove('bank-disabled')
            }
            // 更新管理员面板的开关
            const toggle = document.getElementById('bankToggle')
            const statusLabel = document.getElementById('bankToggleStatus')
            if (toggle) {
                toggle.checked = bankOpen
                statusLabel.textContent = bankOpen ? '🟢 营业中' : '🔴 已关闭'
                statusLabel.style.color = bankOpen ? '#28a745' : '#ff4444'
            }
        }

        async function toggleBankStatus() {
            const toggle = document.getElementById('bankToggle')
            const token = localStorage.getItem('token')
            const bankOpen = toggle.checked
            try {
                const res = await fetch(`${API_BASE}/admin/bank/toggle`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ bank_open: bankOpen })
                })
                const data = await res.json()
                if (data.success) {
                    showAutoIndicator(bankOpen ? '银行已开启' : '银行已关闭')
                    updateBankStatusUI(data.bank_open)
                } else {
                    alert(data.error)
                    toggle.checked = !bankOpen
                }
            } catch (error) {
                alert('操作失败：' + error.message)
                toggle.checked = !bankOpen
            }
        }

        async function loadAdminBankStatus() {
            try {
                const res = await fetch(`${API_BASE}/bank/status`)
                const data = await res.json()
                if (data.success !== undefined) {
                    updateBankStatusUI(data.bank_open === true)
                }
            } catch (e) {
                console.error('Failed to load admin bank status:', e)
            }
        }

        async function loadLoanConfig() {
            try {
                const response = await fetch(`${API_BASE}/loans/config`)
                const data = await response.json()
                if (data.success && data.data) {
                    const cfg = data.data
                    // 银行页面显示
                    const displayDiv = document.getElementById('loanConfigDisplay')
                    if (displayDiv) {
                        displayDiv.innerHTML = `
                            <div style="background: #16213e; padding: 12px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 24px; color: #ffd700;">¥${cfg.max_amount || 0}</div>
                                <div style="font-size: 12px; color: #aaa;">贷款上限</div>
                            </div>
                            <div style="background: #16213e; padding: 12px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 24px; color: #4fc3f7;">${cfg.max_term_days || 0}天</div>
                                <div style="font-size: 12px; color: #aaa;">最长期限</div>
                            </div>
                            <div style="background: #16213e; padding: 12px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 24px; color: #81c784;">${cfg.interest_rate || 0}%</div>
                                <div style="font-size: 12px; color: #aaa;">利率</div>
                            </div>
                            <div style="background: #16213e; padding: 12px; border-radius: 6px; text-align: center;">
                                <div style="font-size: 24px; color: #ff8a65;">${cfg.daily_penalty_rate || 0}%</div>
                                <div style="font-size: 12px; color: #aaa;">逾期日罚息</div>
                            </div>
                        `
                    }
                    // 管理后台表单填充
                    if (document.getElementById('loanCfgMaxAmount')) {
                        document.getElementById('loanCfgMaxAmount').value = cfg.max_amount || ''
                        document.getElementById('loanCfgMaxTerm').value = cfg.max_term_days || ''
                        document.getElementById('loanCfgInterestRate').value = cfg.interest_rate || ''
                        document.getElementById('loanCfgDailyPenalty').value = cfg.daily_penalty_rate || ''
                    }
                    return cfg
                }
            } catch (error) {
                console.error('Failed to load loan config:', error)
            }
            return null
        }

        async function saveLoanConfig() {
            const btn = document.getElementById('btnSaveLoanConfig')
            if (btn.disabled) return
            lockBtn(btn)
            const max_amount = parseFloat(document.getElementById('loanCfgMaxAmount').value)
            const max_term_days = parseInt(document.getElementById('loanCfgMaxTerm').value)
            const interest_rate = parseFloat(document.getElementById('loanCfgInterestRate').value)
            const daily_penalty_rate = parseFloat(document.getElementById('loanCfgDailyPenalty').value)
            const token = localStorage.getItem('token')

            if (!max_amount || !max_term_days || isNaN(interest_rate)) {
                alert('请填写完整的配置信息')
                unlockBtn(btn); return
            }

            try {
                const response = await fetch(`${API_BASE}/loans/config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ max_amount, max_term_days, interest_rate, daily_penalty_rate: daily_penalty_rate || 0 })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator('贷款配置已更新')
                    loadLoanConfig()
                } else {
                    alert(data.error)
                }
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        async function applyLoan() {
            const btn = document.getElementById('btnApplyLoan')
            if (btn.disabled) return
            lockBtn(btn)
            const token = localStorage.getItem('token')
            if (!token) { alert('请先登录'); unlockBtn(btn); return }

            // 本地检查银行状态
            const bankPage = document.getElementById('bank')
            if (bankPage.classList.contains('bank-disabled')) {
                document.getElementById('loanResult').innerHTML = '<p style="color: #ff4444;">❌ 银行目前已关闭，无法申请贷款</p>'
                unlockBtn(btn); return
            }

            const amount = parseFloat(document.getElementById('loanAmount').value)
            const termDays = parseInt(document.getElementById('loanTermDays').value)
            const resultDiv = document.getElementById('loanResult')

            if (!amount || amount <= 0) {
                resultDiv.innerHTML = '<p style="color: #ff4444;">请输入有效的贷款金额</p>'
                unlockBtn(btn); return
            }
            if (!termDays || termDays <= 0) {
                resultDiv.innerHTML = '<p style="color: #ff4444;">请输入有效的贷款期限</p>'
                unlockBtn(btn); return
            }

            try {
                const response = await fetch(`${API_BASE}/loans/apply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ amount, termDays })
                })
                const data = await response.json()
                if (data.success) {
                    resultDiv.innerHTML = `<p style="color: #28a745;">✅ ${data.message}，到账 ¥${amount}</p>`
                    document.getElementById('loanAmount').value = ''
                    document.getElementById('loanTermDays').value = ''
                    updateBalance(data.balance)
                    loadMyLoans()
                    loadBank()
                } else {
                    resultDiv.innerHTML = `<p style="color: #ff4444;">❌ ${data.error}</p>`
                }
            } catch (error) {
                resultDiv.innerHTML = `<p style="color: #ff4444;">❌ 申请失败：${error.message}</p>`
            } finally {
                unlockBtn(btn)
            }
        }

        async function loadMyLoans() {
            const token = localStorage.getItem('token')
            if (!token) return
            const container = document.getElementById('myLoansList')
            try {
                const response = await fetch(`${API_BASE}/loans/list`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    const loans = data.data || []
                    // 更新统计
                    const activeLoans = loans.filter(l => l.status === 'active')
                    const remainingTotal = activeLoans.reduce((sum, l) => sum + l.remaining, 0)
                    document.getElementById('bankTotalLoans').textContent = loans.length
                    document.getElementById('bankActiveLoans').textContent = activeLoans.length
                    document.getElementById('bankRemainingDebt').textContent = `¥${remainingTotal}`

                    if (loans.length === 0) {
                        container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无贷款记录</p>'
                        return
                    }

                    container.innerHTML = `<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <thead>
                            <tr style="background: #1a1a2e;">
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">金额</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">利率</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">期限</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">应还总额</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">剩余欠款</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">到期日</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">状态</th>
                                <th style="padding: 10px 8px; text-align: left; color: #aaa;">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${loans.map(loan => {
                                const dueDate = new Date(loan.due_date)
                                const now = new Date()
                                const isOverdue = now > dueDate && loan.status === 'active'
                                const statusText = loan.status === 'active' ? (isOverdue ? '⚠️ 逾期' : '✅ 进行中') : (loan.status === 'repaid' ? '✅ 已还清' : '📋 已结清')
                                const statusColor = loan.status === 'active' ? (isOverdue ? '#ff4444' : '#4fc3f7') : '#81c784'
                                return `<tr style="border-bottom: 1px solid #333;">
                                    <td style="padding: 10px 8px;">¥${loan.amount}</td>
                                    <td style="padding: 10px 8px;">${loan.interest_rate}%</td>
                                    <td style="padding: 10px 8px;">${loan.term_days}天</td>
                                    <td style="padding: 10px 8px; color: #ffd700;">¥${loan.total_repay}</td>
                                    <td style="padding: 10px 8px; color: ${loan.status === 'active' ? '#ff6b6b' : '#81c784'};">¥${loan.remaining}</td>
                                    <td style="padding: 10px 8px;">${loan.due_date}</td>
                                    <td style="padding: 10px 8px; color: ${statusColor};">${statusText}</td>
                                    <td style="padding: 10px 8px;">
                                        ${loan.status === 'active' ? `
                                            <button class="btn btn-primary" style="padding: 4px 10px; font-size: 12px;" onclick="repayLoan(${loan.id})">还款</button>
                                            <button class="btn btn-success" style="padding: 4px 10px; font-size: 12px;" onclick="repayFullLoan(${loan.id})">还清</button>
                                        ` : ''}
                                    </td>
                                </tr>`
                            }).join('')}
                        </tbody>
                    </table></div>`
                }
            } catch (error) {
                container.innerHTML = '<p style="color: #ff4444; text-align: center; padding: 20px;">加载失败</p>'
            }
        }

        async function repayLoan(loanId) {
            const token = localStorage.getItem('token')
            if (!token) return
            const amount = prompt('请输入还款金额：')
            if (!amount || isNaN(amount) || parseFloat(amount) <= 0) return
            try {
                const response = await fetch(`${API_BASE}/loans/repay`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ loanId, amount: parseFloat(amount) })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message)
                    updateBalance(data.balance)
                    loadMyLoans()
                    loadBank()
                } else {
                    alert(data.error)
                }
            } catch (error) {
                alert('还款失败：' + error.message)
            }
        }

        async function repayFullLoan(loanId) {
            const token = localStorage.getItem('token')
            if (!token) return
            if (!confirm('确定要一次性还清这笔贷款吗？')) return
            try {
                const response = await fetch(`${API_BASE}/loans/repay`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ loanId })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message)
                    updateBalance(data.balance)
                    loadMyLoans()
                    loadBank()
                } else {
                    alert(data.error)
                }
            } catch (error) {
                alert('还款失败：' + error.message)
            }
        }

