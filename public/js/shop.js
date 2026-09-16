// 商店页（自 index.html 拆分）
        // ==================== 商店页面 ====================
        async function loadShop() {
            await Promise.all([
                loadShopRewards(),
                loadShopPenalties(),
                loadShopProducts()
            ])
        }

        async function loadShopRewards() {
            const container = document.getElementById('shopRewardsList')
            try {
                const response = await fetch(`${API_BASE}/shop/rewards`)
                const data = await response.json()
                if (data.success && data.data.length > 0) {
                    container.innerHTML = data.data.map(reward => `
                        <div class="item-card" style="border-left: 3px solid #28a745; display: flex; flex-direction: column;">
                            ${reward.image ? `<img src="${reward.image}" style="width: 100%; height: 150px; object-fit: cover; border-radius: 6px; margin-bottom: 10px;">` : ''}
                            <div class="item-info" style="flex: 1;">
                                <div class="item-name" style="color: #28a745; font-size: 16px; font-weight: 600;">${reward.name}</div>
                                <div class="item-desc" style="color: #ffd700; font-size: 14px; margin: 4px 0;">价格: ¥${reward.price}</div>
                                ${reward.description ? `<div class="item-desc" style="font-size: 12px; color: #aaa; margin-bottom: 8px;">${reward.description}</div>` : ''}
                            </div>
                            <div class="item-actions" style="display: flex; align-items: center; gap: 6px; margin-top: auto;">
                                <input type="number" id="rewardQty_${reward.id}" value="1" min="1" max="99" style="width: 50px; background: #1a1a2e; color: #fff; border: 1px solid #333; padding: 6px; border-radius: 4px; text-align: center;">
                                <button id="btnRedeem_${reward.id}" class="btn btn-success" onclick="redeemReward(${reward.id})" style="flex:1;">兑换</button>
                            </div>
                        </div>
                    `).join('')
                } else {
                    container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无上架奖励</p>'
                }
            } catch (error) {
                container.innerHTML = '<p style="color: #ff4444; text-align: center; padding: 20px;">加载失败</p>'
            }
        }

        async function redeemReward(rewardId) {
            const token = localStorage.getItem('token')
            if (!token) { alert('请先登录'); return }
            const btn = document.getElementById(`btnRedeem_${rewardId}`)
            if (!btn || btn.disabled) return
            btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'
            const qtyInput = document.getElementById(`rewardQty_${rewardId}`)
            const quantity = parseInt(qtyInput ? qtyInput.value : 1) || 1
            try {
                const response = await fetch(`${API_BASE}/shop/redeem-reward`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ rewardId, quantity })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message)
                    const user = JSON.parse(localStorage.getItem('user') || '{}')
                    user.balance = data.balance
                    localStorage.setItem('user', JSON.stringify(user))
                    updateBalance(data.balance)
                    loadShopRewards()
                } else {
                    alert(data.error)
                    btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'
                }
            } catch (error) {
                alert('兑换失败：' + error.message)
                btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'
            }
        }

        async function loadShopPenalties() {
            const container = document.getElementById('shopPenaltiesList')
            try {
                const response = await fetch(`${API_BASE}/shop/penalties`)
                const data = await response.json()
                if (data.success && data.data.length > 0) {
                    container.innerHTML = data.data.map(penalty => `
                        <div class="item-card" style="border-left: 3px solid #ff4444; display: flex; flex-direction: column;">
                            ${penalty.image ? `<img src="${penalty.image}" style="width: 100%; height: 150px; object-fit: cover; border-radius: 6px; margin-bottom: 10px;">` : ''}
                            <div class="item-info" style="flex: 1;">
                                <div class="item-name" style="color: #ff4444; font-size: 16px; font-weight: 600;">${penalty.name}</div>
                                <div class="item-desc" style="color: #ff6b6b; font-size: 14px; margin: 4px 0;">消除价格: ¥${penalty.price}</div>
                                ${penalty.description ? `<div class="item-desc" style="font-size: 12px; color: #aaa; margin-bottom: 8px;">${penalty.description}</div>` : ''}
                            </div>
                            <div class="item-actions" style="display: flex; align-items: center; gap: 6px; margin-top: auto;">
                                <input type="number" id="penaltyQty_${penalty.id}" value="1" min="1" max="99" style="width: 50px; background: #1a1a2e; color: #fff; border: 1px solid #333; padding: 6px; border-radius: 4px; text-align: center;">
                                <button id="btnPay_${penalty.id}" class="btn btn-danger" onclick="payPenalty(${penalty.id})" style="flex:1;">消除</button>
                            </div>
                        </div>
                    `).join('')
                } else {
                    container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无上架惩罚</p>'
                }
            } catch (error) {
                container.innerHTML = '<p style="color: #ff4444; text-align: center; padding: 20px;">加载失败</p>'
            }
        }

        async function payPenalty(penaltyId) {
            const token = localStorage.getItem('token')
            if (!token) { alert('请先登录'); return }
            const btn = document.getElementById(`btnPay_${penaltyId}`)
            if (!btn || btn.disabled) return
            btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'
            const qtyInput = document.getElementById(`penaltyQty_${penaltyId}`)
            const quantity = parseInt(qtyInput ? qtyInput.value : 1) || 1
            try {
                const response = await fetch(`${API_BASE}/shop/pay-penalty`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ penaltyId, quantity })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message)
                    const user = JSON.parse(localStorage.getItem('user') || '{}')
                    user.balance = data.balance
                    localStorage.setItem('user', JSON.stringify(user))
                    updateBalance(data.balance)
                    loadShopPenalties()
                } else {
                    alert(data.error)
                    btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'
                }
            } catch (error) {
                alert('操作失败：' + error.message)
                btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'
            }
        }

        async function loadShopProducts() {
            const container = document.getElementById('shopProductsList')
            try {
                const response = await fetch(`${API_BASE}/products/list`)
                const data = await response.json()
                if (data.success && data.data.length > 0) {
                    container.innerHTML = data.data.map(product => `
                        <div class="product-card" style="display: flex; flex-direction: column;">
                            ${product.image ? `<img src="${product.image}" alt="${product.name}" style="width: 100%; height: 150px; object-fit: cover; border-radius: 6px; margin-bottom: 10px;">` : '<div style="height: 150px; background: #1a1a2e; display: flex; align-items: center; justify-content: center; font-size: 48px; border-radius: 6px; margin-bottom: 10px;">📦</div>'}
                            <div class="product-info" style="flex: 1;">
                                <div class="product-name" style="font-size: 16px; font-weight: 600;">${product.name}</div>
                                <div class="product-price" style="color: #ffd700; font-size: 14px; margin: 4px 0;">¥${product.price}</div>
                                ${product.description ? `<div class="product-desc" style="font-size: 12px; color: #aaa; margin-bottom: 8px;">${product.description}</div>` : ''}
                            </div>
                            <button id="btnPurchase_${product.id}" class="btn btn-primary purchase-btn" onclick="purchaseProduct(${product.id})" style="margin-top: auto; width: 100%;">立即购买</button>
                        </div>
                    `).join('')
                } else {
                    container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无上架商品</p>'
                }
            } catch (error) {
                container.innerHTML = '<p style="color: #ff4444; text-align: center; padding: 20px;">加载失败</p>'
            }
        }

        async function purchaseProduct(productId) {
            const token = localStorage.getItem('token')
            if (!token) { alert('请先登录'); return }
            const btn = document.getElementById(`btnPurchase_${productId}`)
            if (!btn || btn.disabled) return
            btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'
            try {
                const response = await fetch(`${API_BASE}/products/purchase`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ productId })
                })
                const data = await response.json()
                if (data.success) {
                    showAutoIndicator(data.message)
                    const user = JSON.parse(localStorage.getItem('user') || '{}')
                    user.balance = data.balance
                    localStorage.setItem('user', JSON.stringify(user))
                    updateBalance(data.balance)
                    loadShopProducts()
                    loadHomePage()
                } else {
                    alert(data.error)
                    btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'
                }
            } catch (error) {
                alert('购买失败：' + error.message)
                btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'
            }
        }

