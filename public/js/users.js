// 用户管理页（自 index.html 拆分）

        let editingUserBalance = null

        let items = []

        let rewards = []

        let debts = []

        let penalties = []

        let selectedUser = null

        let editingItemId = null

        let editingRewardId = null

        let editingDebtId = null

        let editingPenaltyId = null
        function openUserBalanceModalForSelectedUser() {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            openUserBalanceModal(selectedUser.username, selectedUser.balance)
        }

        async function resetUserPassword() {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }            
            const newPassword = prompt(`请输入用户「${selectedUser.username}」的新密码（至少6位）：`)
            if (!newPassword) return
            
            if (newPassword.length < 6) {
                alert('密码长度不能少于6位')
                return
            }
            
            const confirmPassword = prompt('请再次输入新密码确认：')
            if (newPassword !== confirmPassword) {
                alert('两次输入的密码不一致')
                return
            }
            
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/user/password/reset/${encodeURIComponent(selectedUser.username)}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ newPassword })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(`用户「${selectedUser.username}」密码已重置`)
                } else {
                    alert(data.error || '密码重置失败')
                }
            } catch (error) {
                alert('密码重置失败：' + error.message)
            }
        }

        // 管理员重置用户转盘次数（奖励+惩罚一起重置）
        async function resetUserWheelSpins() {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            if (!confirm(`确定重置用户「${selectedUser.username}」的转盘次数吗？\n重置后该用户的奖励/惩罚转盘次数将恢复为满额。`)) return
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/wheel/spin/reset/${encodeURIComponent(selectedUser.username)}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ wheelType: 'all' })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message || `用户「${selectedUser.username}」转盘次数已重置`)
                } else {
                    alert(data.error || '重置失败')
                }
            } catch (error) {
                alert('重置失败：' + error.message)
            }
        }

        // 管理员按用户设置转盘次数（奖励/惩罚分开，留空跟随全局）
        async function openUserWheelLimitsModal() {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            document.getElementById('userRewardLimit').value = ''
            document.getElementById('userPenaltyLimit').value = ''
            document.getElementById('userWheelLimitsModal').classList.add('active')
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/user/wheel/limits/${encodeURIComponent(selectedUser.username)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success && data.data) {
                    if (data.data.reward !== null && data.data.reward !== undefined) {
                        document.getElementById('userRewardLimit').value = data.data.reward
                    }
                    if (data.data.penalty !== null && data.data.penalty !== undefined) {
                        document.getElementById('userPenaltyLimit').value = data.data.penalty
                    }
                }
            } catch (error) {
                console.error('Failed to load user wheel limits:', error)
            }
        }

        function closeUserWheelLimitsModal() {
            document.getElementById('userWheelLimitsModal').classList.remove('active')
        }

        async function saveUserWheelLimits() {
            if (!selectedUser) return
            const btn = document.getElementById('btnSaveUserWheelLimits')
            if (btn.disabled) return
            lockBtn(btn)
            const rewardVal = document.getElementById('userRewardLimit').value.trim()
            const penaltyVal = document.getElementById('userPenaltyLimit').value.trim()
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/user/wheel/limits/${encodeURIComponent(selectedUser.username)}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        reward: rewardVal === '' ? null : Number(rewardVal),
                        penalty: penaltyVal === '' ? null : Number(penaltyVal)
                    })
                })
                const data = await response.json()
                if (data.success) {
                    closeUserWheelLimitsModal()
                    showAutoIndicator(data.message || '转盘次数设置已保存')
                } else {
                    alert(data.error || '保存失败')
                }
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        // 物品管理
        async function loadUserItems(username) {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/items/${encodeURIComponent(username)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    items = data.data || []
                    renderItems()
                }
            } catch (error) {
                console.error('Failed to load items:', error)
                items = []
                renderItems()
            }
        }

        function renderItems() {
            const container = document.getElementById('itemsList')
            if (!container) return
            if (items.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无物品</p>'
                return
            }
            
            container.innerHTML = items.map(item => `
                <div class="item-card">
                    <div class="item-info">
                        <div class="item-name">${item.name}</div>
                        <div class="item-desc">价值: ¥${item.value} | ${item.description || '暂无描述'}</div>
                    </div>
                    <div class="item-actions">
                        <button class="btn btn-primary" onclick="editItem('${item.id}')">编辑</button>
                        <button class="btn btn-danger" onclick="deleteItem('${item.id}', this)">删除</button>
                    </div>
                </div>
            `).join('')
        }

        function openItemModal(item = null) {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            
            editingItemId = item ? item.id : null
            document.getElementById('itemModalTitle').textContent = item ? '编辑物品' : '添加物品'
            document.getElementById('itemName').value = item ? item.name : ''
            document.getElementById('itemValue').value = item ? item.value : ''
            document.getElementById('itemDesc').value = item ? item.description || '' : ''
            document.getElementById('itemModal').classList.add('active')
        }

        function closeItemModal() {
            document.getElementById('itemModal').classList.remove('active')
            editingItemId = null
        }

        async function saveItem() {
            const btn = document.getElementById('btnSaveItem')
            if (btn.disabled) return
            lockBtn(btn)
            if (!selectedUser) {
                alert('请先选择用户')
                unlockBtn(btn); return
            }

            const name = document.getElementById('itemName').value
            const value = parseFloat(document.getElementById('itemValue').value)
            const description = document.getElementById('itemDesc').value
            const token = localStorage.getItem('token')

            if (!name || isNaN(value)) {
                alert('请填写完整的物品信息')
                unlockBtn(btn); return
            }

            try {
                const itemData = { username: selectedUser.username, name, value, description }
                
                if (editingItemId) {
                    await fetch(`${API_BASE}/admin/items/${editingItemId}`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(itemData)
                    })
                } else {
                    await fetch(`${API_BASE}/admin/items`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(itemData)
                    })
                }
                
                closeItemModal()
                loadUserItems(selectedUser.username)
                showAutoIndicator('物品已保存')
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        function editItem(id) {
            const item = items.find(i => i.id == id)
            if (item) {
                openItemModal(item)
            }
        }

        async function deleteItem(id) {
            if (confirm('确定要删除这个物品吗？')) {
                const token = localStorage.getItem('token')
                try {
                    await fetch(`${API_BASE}/admin/items/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    })
                    loadUserItems(selectedUser.username)
                    showAutoIndicator('物品已删除')
                } catch (error) {
                    alert('删除失败：' + error.message)
                }
            }
        }

        // 奖励管理
        async function loadUserRewards(username) {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/rewards/${encodeURIComponent(username)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    rewards = data.data || []
                    renderRewards()
                }
            } catch (error) {
                console.error('Failed to load rewards:', error)
                rewards = []
                renderRewards()
            }
        }

        function renderRewards() {
            const container = document.getElementById('rewardsList')
            if (!container) return
            if (rewards.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无奖励</p>'
                return
            }
            
            container.innerHTML = rewards.map(reward => `
                <div class="item-card">
                    <div class="item-info">
                        <div class="item-name" style="color: #28a745;">${reward.name}${(reward.quantity || 1) > 1 ? ` <span style="font-size: 12px; color: #2d132c; background: #28a745; padding: 1px 8px; border-radius: 10px; margin-left: 6px;">x${reward.quantity}</span>` : ''}</div>
                        <div class="item-desc">价值: ¥${reward.value}${reward.description ? ` | ${reward.description}` : ''}</div>
                    </div>
                    <div class="item-actions">
                        <button class="btn btn-primary" onclick="editReward('${reward.id}')">编辑</button>
                        <button class="btn btn-danger" onclick="deleteReward('${reward.id}', this)">删除</button>
                    </div>
                </div>
            `).join('')
        }

        function openRewardModal(reward = null) {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            
            editingRewardId = reward ? reward.id : null
            document.getElementById('rewardModalTitle').textContent = reward ? '编辑奖励' : '添加奖励'
            document.getElementById('rewardName').value = reward ? reward.name : ''
            document.getElementById('rewardValue').value = reward ? reward.value : ''
            document.getElementById('rewardQuantity').value = reward ? (reward.quantity || 1) : 1
            document.getElementById('rewardModal').classList.add('active')
        }

        function closeRewardModal() {
            document.getElementById('rewardModal').classList.remove('active')
            editingRewardId = null
        }

        async function saveReward() {
            const btn = document.getElementById('btnSaveReward')
            if (btn.disabled) return
            lockBtn(btn)
            if (!selectedUser) {
                alert('请先选择用户')
                unlockBtn(btn); return
            }

            const name = document.getElementById('rewardName').value
            const value = parseFloat(document.getElementById('rewardValue').value)
            const quantity = Math.max(1, parseInt(document.getElementById('rewardQuantity').value) || 1)
            const token = localStorage.getItem('token')

            if (!name || isNaN(value)) {
                alert('请填写完整的奖励信息')
                unlockBtn(btn); return
            }

            try {
                const rewardData = { username: selectedUser.username, name, value, quantity }
                
                if (editingRewardId) {
                    await fetch(`${API_BASE}/admin/rewards/${editingRewardId}`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(rewardData)
                    })
                } else {
                    await fetch(`${API_BASE}/admin/rewards`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(rewardData)
                    })
                }
                
                closeRewardModal()
                loadUserRewards(selectedUser.username)
                showAutoIndicator('奖励已保存')
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        function editReward(id) {
            const reward = rewards.find(r => r.id == id)
            if (reward) {
                openRewardModal(reward)
            }
        }

        async function deleteReward(id) {
            if (confirm('确定要删除这个奖励吗？')) {
                const token = localStorage.getItem('token')
                try {
                    await fetch(`${API_BASE}/admin/rewards/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    })
                    loadUserRewards(selectedUser.username)
                    showAutoIndicator('奖励已删除')
                } catch (error) {
                    alert('删除失败：' + error.message)
                }
            }
        }

        // 欠款管理
        async function loadUserDebts(username) {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/debts/${encodeURIComponent(username)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    debts = data.data || []
                    renderDebts()
                }
            } catch (error) {
                console.error('Failed to load debts:', error)
                debts = []
                renderDebts()
            }
        }

        function renderDebts() {
            const container = document.getElementById('debtsList')
            if (!container) return
            if (debts.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无欠款</p>'
                return
            }
            
            container.innerHTML = debts.map(debt => `
                <div class="item-card">
                    <div class="item-info">
                        <div class="item-name" style="color: #ff6b6b;">${debt.name}</div>
                        <div class="item-desc">金额: ¥${debt.amount} | ${debt.description || '暂无描述'}</div>
                    </div>
                    <div class="item-actions">
                        <button class="btn btn-primary" onclick="editDebt('${debt.id}')">编辑</button>
                        <button class="btn btn-danger" onclick="deleteDebt('${debt.id}', this)">删除</button>
                    </div>
                </div>
            `).join('')
        }

        function openDebtModalForSelectedUser() {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            openDebtModal()
        }

        function openDebtModal(debt = null) {
            if (!selectedUser && !debt) {
                alert('请先选择用户')
                return
            }
            
            editingDebtId = debt ? debt.id : null
            document.getElementById('debtModalTitle').textContent = debt ? '编辑欠款' : '添加欠款'
            document.getElementById('debtName').value = debt ? debt.name : ''
            document.getElementById('debtAmount').value = debt ? debt.amount : ''
            document.getElementById('debtDesc').value = debt ? debt.description || '' : ''
            document.getElementById('debtModal').classList.add('active')
        }

        function closeDebtModal() {
            document.getElementById('debtModal').classList.remove('active')
            editingDebtId = null
        }

        async function saveDebt() {
            const btn = document.getElementById('btnSaveDebt')
            if (btn.disabled) return
            lockBtn(btn)
            if (!selectedUser) {
                alert('请先选择用户')
                unlockBtn(btn); return
            }

            const name = document.getElementById('debtName').value
            const amount = parseFloat(document.getElementById('debtAmount').value)
            const description = document.getElementById('debtDesc').value
            const token = localStorage.getItem('token')

            if (!name || isNaN(amount)) {
                alert('请填写完整的欠款信息')
                unlockBtn(btn); return
            }

            try {
                const debtData = { username: selectedUser.username, name, amount, description }
                
                if (editingDebtId) {
                    await fetch(`${API_BASE}/admin/debts/${editingDebtId}`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(debtData)
                    })
                } else {
                    await fetch(`${API_BASE}/admin/debts`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(debtData)
                    })
                }
                
                closeDebtModal()
                loadUserDebts(selectedUser.username)
                showAutoIndicator('欠款已保存')
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        function editDebt(id) {
            const debt = debts.find(d => d.id == id)
            if (debt) {
                openDebtModal(debt)
            }
        }

        async function deleteDebt(id) {
            if (confirm('确定要删除这个欠款吗？')) {
                const token = localStorage.getItem('token')
                try {
                    await fetch(`${API_BASE}/admin/debts/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    })
                    loadUserDebts(selectedUser.username)
                    showAutoIndicator('欠款已删除')
                } catch (error) {
                    alert('删除失败：' + error.message)
                }
            }
        }

        // 惩罚管理
        async function loadUserPenalties(username) {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/penalties/${encodeURIComponent(username)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    penalties = data.data || []
                    renderPenalties()
                }
            } catch (error) {
                console.error('Failed to load penalties:', error)
                penalties = []
                renderPenalties()
            }
        }

        function renderPenalties() {
            const container = document.getElementById('penaltiesList')
            if (!container) return
            if (penalties.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无惩罚</p>'
                return
            }
            
            container.innerHTML = penalties.map(penalty => `
                <div class="item-card">
                    <div class="item-info">
                        <div class="item-name" style="color: #ff4444;">${penalty.name}${(penalty.quantity || 1) > 1 ? ` <span style="font-size: 12px; color: #fff; background: #ff4444; padding: 1px 8px; border-radius: 10px; margin-left: 6px;">x${penalty.quantity}</span>` : ''}</div>
                        <div class="item-desc">金额: ¥${penalty.amount}${penalty.description ? ` | ${penalty.description}` : ''}</div>
                    </div>
                    <div class="item-actions">
                        <button class="btn btn-primary" onclick="editPenalty('${penalty.id}')">编辑</button>
                        <button class="btn btn-danger" onclick="deletePenalty('${penalty.id}', this)">删除</button>
                    </div>
                </div>
            `).join('')
        }

        function openPenaltyModal(penalty = null) {
            if (!selectedUser) {
                alert('请先选择用户')
                return
            }
            
            editingPenaltyId = penalty ? penalty.id : null
            document.getElementById('penaltyModalTitle').textContent = penalty ? '编辑惩罚' : '添加惩罚'
            document.getElementById('penaltyName').value = penalty ? penalty.name : ''
            document.getElementById('penaltyAmount').value = penalty ? penalty.amount : ''
            document.getElementById('penaltyQuantity').value = penalty ? (penalty.quantity || 1) : 1
            document.getElementById('penaltyModal').classList.add('active')
        }

        function closePenaltyModal() {
            document.getElementById('penaltyModal').classList.remove('active')
            editingPenaltyId = null
        }

        async function savePenalty() {
            const btn = document.getElementById('btnSavePenalty')
            if (btn.disabled) return
            lockBtn(btn)
            if (!selectedUser) {
                alert('请先选择用户')
                unlockBtn(btn); return
            }

            const name = document.getElementById('penaltyName').value
            const amount = parseFloat(document.getElementById('penaltyAmount').value)
            const quantity = Math.max(1, parseInt(document.getElementById('penaltyQuantity').value) || 1)
            const token = localStorage.getItem('token')

            if (!name || isNaN(amount)) {
                alert('请填写完整的惩罚信息')
                unlockBtn(btn); return
            }

            try {
                const penaltyData = { username: selectedUser.username, name, amount, quantity }
                
                if (editingPenaltyId) {
                    await fetch(`${API_BASE}/admin/penalties/${editingPenaltyId}`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(penaltyData)
                    })
                } else {
                    await fetch(`${API_BASE}/admin/penalties`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(penaltyData)
                    })
                }
                
                closePenaltyModal()
                loadUserPenalties(selectedUser.username)
                showAutoIndicator('惩罚已保存')
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        function editPenalty(id) {
            const penalty = penalties.find(p => p.id == id)
            if (penalty) {
                openPenaltyModal(penalty)
            }
        }

        async function deletePenalty(id) {
            if (confirm('确定要删除这个惩罚吗？')) {
                const token = localStorage.getItem('token')
                try {
                    await fetch(`${API_BASE}/admin/penalties/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    })
                    loadUserPenalties(selectedUser.username)
                    showAutoIndicator('惩罚已删除')
                } catch (error) {
                    alert('删除失败：' + error.message)
                }
            }
        }

        async function loadUsers() {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/users`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    renderUsers(data.data)
                }
            } catch (error) {
                console.error('Failed to load users:', error)
            }
        }

        function renderUsers(users) {
            const container = document.getElementById('usersList')
            container.dataset.users = JSON.stringify(users)
            container.innerHTML = users.map(user => {
                const isAdmin = user.role === 'admin'
                return `
                <div class="player-card" style="cursor: pointer;" onclick="selectUser('${user.username}', ${user.balance})">
                    <div class="player-header">
                        <div>
                            <div class="player-name">${user.username}</div>
                            <div style="font-size: 12px; color: #aaa;">注册时间: ${new Date(user.created_at).toLocaleDateString()}</div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div class="player-role ${user.role}">${isAdmin ? '管理员' : '玩家'}</div>
                            ${!isAdmin ? `<button class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;" onclick="event.stopPropagation();deleteUser('${user.username}', this)">删除</button>` : ''}
                        </div>
                    </div>
                    <div class="player-stats">
                        <div class="player-stat">
                            <div class="player-stat-value">¥${user.balance}</div>
                            <div class="player-stat-label">筹码</div>
                        </div>
                    </div>
                </div>
            `}).join('')
        }

        function selectUser(username, balance) {
            selectedUser = { username, balance }
            document.getElementById('selectedUserName').textContent = username
            document.getElementById('userBalanceDisplay').textContent = `¥${balance}`
            document.getElementById('userDetailSection').style.display = 'block'
            document.getElementById('usersList').parentElement.style.display = 'none'
            
            loadUserItems(username)
            loadUserRewards(username)
            loadUserDebts(username)
            loadUserPenalties(username)
        }

        function closeUserDetail() {
            document.getElementById('userDetailSection').style.display = 'none'
            document.getElementById('usersList').parentElement.style.display = 'block'
            selectedUser = null
            loadUsers()
        }

        async function deleteUser(username, btn) {
            if (btn && btn.disabled) return
            if (btn) lockBtn(btn)
            try {
                if (!confirm(`确定要删除用户「${username}」吗？\n此操作将同时删除该用户的所有物品、奖励、欠款、惩罚、购买记录和贷款记录，且不可恢复！`)) {
                    if (btn) unlockBtn(btn)
                    return
                }
                const token = localStorage.getItem('token')
                const response = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(username)}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(`用户「${username}」已删除`)
                    loadUsers()
                } else {
                    alert(data.error || '删除失败')
                }
            } catch (error) {
                alert('删除失败：' + error.message)
            } finally {
                if (btn) unlockBtn(btn)
            }
        }

        function openUserBalanceModal(username, balance) {
            editingUserBalance = username
            document.getElementById('balanceUsername').value = username
            document.getElementById('newBalance').value = balance
            document.getElementById('userBalanceModal').classList.add('active')
        }

        function closeUserBalanceModal() {
            document.getElementById('userBalanceModal').classList.remove('active')
            editingUserBalance = null
        }

        async function updateUserBalance() {
            const btn = document.getElementById('btnUpdateBalance')
            if (btn.disabled) return
            lockBtn(btn)
            const username = document.getElementById('balanceUsername').value
            const newBalance = parseFloat(document.getElementById('newBalance').value) || 0
            const token = localStorage.getItem('token')

            try {
                const response = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(username)}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ balance: newBalance })
                })

                const data = await response.json()
                if (data.success) {
                    closeUserBalanceModal()
                    
                    if (selectedUser && selectedUser.username === username) {
                        selectedUser.balance = newBalance
                        document.getElementById('userBalanceDisplay').textContent = `¥${newBalance}`
                    }
                    
                    loadUsers()
                    showAutoIndicator('用户筹码已更新')
                }
            } catch (error) {
                alert('更新失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

