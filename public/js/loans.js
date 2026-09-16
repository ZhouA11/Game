// 管理员 - 贷款管理（自 index.html 拆分）
        // ==================== 管理员 - 贷款管理 ====================
        async function loadAdminLoans() {
            const token = localStorage.getItem('token')
            const container = document.getElementById('adminLoansList')
            if (!container) return
            try {
                const response = await fetch(`${API_BASE}/loans/all`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    const loans = data.data || []
                    if (loans.length === 0) {
                        container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无贷款记录</p>'
                        return
                    }
                    container.innerHTML = `<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        <thead>
                            <tr style="background: #1a1a2e;">
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">用户</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">金额</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">利率</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">应还</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">剩余</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">到期日</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">状态</th>
                                <th style="padding: 8px 6px; text-align: left; color: #aaa;">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${loans.map(loan => {
                                const statusText = loan.status === 'active' ? '进行中' : (loan.status === 'repaid' ? '已还清' : '已结清')
                                return `<tr style="border-bottom: 1px solid #333;">
                                    <td style="padding: 8px 6px; color: #4fc3f7;">${loan.username}</td>
                                    <td style="padding: 8px 6px;">¥${loan.amount}</td>
                                    <td style="padding: 8px 6px;">${loan.interest_rate}%</td>
                                    <td style="padding: 8px 6px; color: #ffd700;">¥${loan.total_repay}</td>
                                    <td style="padding: 8px 6px; color: ${loan.status === 'active' ? '#ff6b6b' : '#81c784'};">¥${loan.remaining}</td>
                                    <td style="padding: 8px 6px;">${loan.due_date}</td>
                                    <td style="padding: 8px 6px; color: ${loan.status === 'active' ? '#ffd700' : '#81c784'};">${statusText}</td>
                                    <td style="padding: 8px 6px;">
                                        ${loan.status === 'active' ? `<button class="btn btn-warning" style="padding: 2px 8px; font-size: 11px;" onclick="settleLoan(${loan.id})">结清</button>` : '-'}
                                    </td>
                                </tr>`
                            }).join('')}
                        </tbody>
                    </table></div>`
                }
            } catch (error) {
                console.error('Failed to load admin loans:', error)
            }
        }

        async function settleLoan(loanId) {
            const token = localStorage.getItem('token')
            if (!confirm('确定要强制结清这笔贷款吗？')) return
            try {
                const response = await fetch(`${API_BASE}/loans/settle`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ loanId })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message)
                    loadAdminLoans()
                } else {
                    alert(data.error)
                }
            } catch (error) {
                alert('操作失败：' + error.message)
            }
        }

