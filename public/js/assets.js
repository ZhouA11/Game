// 我的资产页（自 index.html 拆分）
        let assetLogsData = []
        let assetLogsExpanded = false

        function renderAssetLogs() {
            const el = document.getElementById('assetLogsList')
            if (!el) return
            if (!assetLogsData.length) {
                el.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无记录</p>'
                return
            }
            const visible = assetLogsExpanded ? assetLogsData : assetLogsData.slice(0, 10)
            const actionColor = { balance: '#ffd700', reward: '#28a745', penalty: '#ff6b6b' }
            el.innerHTML = visible.map(l => `
                <div style="display: flex; justify-content: space-between; gap: 12px; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div>
                        <div style="color: ${actionColor[l.action] || '#ddd'}; font-weight: bold;">${l.title}</div>
                        ${l.detail ? `<div style="font-size: 12px; color: #aaa;">${l.detail}</div>` : ''}
                    </div>
                    <div style="font-size: 12px; color: #888; white-space: nowrap;">${(l.created_at || '').slice(0, 16)}</div>
                </div>
            `).join('') + (assetLogsData.length > 10 ? `
                <div style="text-align: center; padding: 10px;">
                    <button class="btn btn-primary" onclick="assetLogsExpanded = !assetLogsExpanded; renderAssetLogs()">${assetLogsExpanded ? '收起' : `展开更多（共 ${assetLogsData.length} 条）`}</button>
                </div>
            ` : '')
        }

        async function loadUserAssets() {
            const token = localStorage.getItem('token')
            try {
                const res = await fetch(`${API_BASE}/user/assets`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await res.json()
                if (data.success) {
                    const { balance, debts, rewards, penalties } = data.data
                    document.getElementById('assetsBalance').textContent = `¥${balance || 0}`
                    document.getElementById('assetsDebts').textContent = (debts || []).length
                    document.getElementById('assetsRewards').textContent = (rewards || []).length
                    document.getElementById('assetsPenalties').textContent = (penalties || []).length

                    const debtsList = document.getElementById('assetDebtsList')
                    if (debts.length === 0) {
                        debtsList.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无欠款</p>'
                    } else {
                        debtsList.innerHTML = debts.map(d => `
                            <div style="display: flex; justify-content: space-between; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <div>
                                    <div style="font-weight: bold; color: #ff6b6b;">${d.name}</div>
                                    ${d.description ? `<div style="font-size: 12px; color: #aaa;">${d.description}</div>` : ''}
                                </div>
                                <div style="font-weight: bold; color: #ff4444;">¥${d.amount || d.value || 0}</div>
                            </div>
                        `).join('')
                    }

                    const rewardsList = document.getElementById('assetRewardsList')
                    if (rewards.length === 0) {
                        rewardsList.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无奖励</p>'
                    } else {
                        rewardsList.innerHTML = rewards.map(r => `
                            <div style="display: flex; justify-content: space-between; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <div>
                                    <div style="font-weight: bold; color: #28a745;">${r.name}</div>
                                    ${r.description ? `<div style="font-size: 12px; color: #aaa;">${r.description}</div>` : ''}
                                </div>
                                <div style="font-weight: bold; color: #28a745;">x${r.quantity || 1}</div>
                            </div>
                        `).join('')
                    }

                    const penaltiesList = document.getElementById('assetPenaltiesList')
                    if (penalties.length === 0) {
                        penaltiesList.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无惩罚</p>'
                    } else {
                        penaltiesList.innerHTML = penalties.map(p => `
                            <div style="display: flex; justify-content: space-between; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <div>
                                    <div style="font-weight: bold; color: #ff4444;">${p.name}</div>
                                    ${p.description ? `<div style="font-size: 12px; color: #aaa;">${p.description}</div>` : ''}
                                </div>
                                <div style="font-weight: bold; color: #ff4444;">x${p.quantity || 1}</div>
                            </div>
                        `).join('')
                    }
                }

                // 拉取并渲染资产变更记录
                try {
                    const logsRes = await fetch(`${API_BASE}/user/asset-logs`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    })
                    const logsData = await logsRes.json()
                    assetLogsData = logsData.success ? (logsData.data || []) : []
                } catch (e) {
                    assetLogsData = []
                }
                assetLogsExpanded = false
                renderAssetLogs()
            } catch (error) {
                console.error('Failed to load assets:', error)
            }
        }

