// 管理后台：奖励/惩罚类型管理 + 商品管理（自 index.html 拆分）

        let products = []

        let editingProductId = null

        let currentImageData = null

        let editingAdminRewardId = null

        let adminRewardImageData = null

        let editingAdminPenaltyId = null

        let adminPenaltyImageData = null
        async function loadProducts() {
            try {
                const response = await fetch(`${API_BASE}/products/list`)
                const data = await response.json()
                if (data.success) {
                    products = data.data
                    renderProducts()
                }
            } catch (error) {
                console.error('Failed to load products:', error)
            }
        }

        function renderProducts() {
            const grid = document.getElementById('productsGrid')
            if (products.length === 0) {
                grid.innerHTML = '<p style="color: #aaa; text-align: center; grid-column: 1/-1; padding: 50px;">暂无商品</p>'
                return
            }
            
            const isAdmin = currentUser.role === 'admin'
            grid.innerHTML = products.map(product => `
                <div class="product-card">
                    <div class="product-image">
                        ${product.image ? `<img src="${product.image}" alt="${product.name}">` : '<div style="color: #aaa; font-size: 48px;">📷</div>'}
                    </div>
                    <div class="product-details">
                        <div class="product-name">${product.name}</div>
                        <div class="product-price">¥${product.price}</div>
                        <div style="color: #aaa; font-size: 14px; margin-bottom: 10px;">${product.description || '暂无描述'}</div>
                        <div class="product-actions">
                            ${isAdmin ? `
                                <button class="btn btn-primary" onclick="editProduct('${product.id}')">编辑</button>
                                <button class="btn btn-danger" onclick="deleteProduct('${product.id}', this)">删除</button>
                            ` : `
                                <button class="btn btn-success" onclick="purchaseProduct('${product.id}')" style="flex: 1;">购买</button>
                            `}
                        </div>
                    </div>
                </div>
            `).join('')
        }

        function openProductModal(productId = null) {
            editingProductId = productId
            currentImageData = null
            
            if (productId) {
                const product = products.find(p => p.id === productId)
                document.getElementById('modalTitle').textContent = '编辑商品'
                document.getElementById('productName').value = product.name
                document.getElementById('productPrice').value = product.price
                document.getElementById('productDesc').value = product.description || ''
                if (product.image) {
                    currentImageData = product.image
                    document.getElementById('imagePreview').src = product.image
                    document.getElementById('imagePreview').style.display = 'block'
                    document.getElementById('uploadPlaceholder').style.display = 'none'
                }
            } else {
                document.getElementById('modalTitle').textContent = '添加商品'
                document.getElementById('productName').value = ''
                document.getElementById('productPrice').value = ''
                document.getElementById('productDesc').value = ''
                document.getElementById('imagePreview').style.display = 'none'
                document.getElementById('uploadPlaceholder').style.display = 'block'
            }
            
            document.getElementById('productModal').classList.add('active')
        }

        function closeProductModal() {
            document.getElementById('productModal').classList.remove('active')
            editingProductId = null
            currentImageData = null
        }

        function handleImageUpload(event) {
            const file = event.target.files[0]
            if (file) {
                const reader = new FileReader()
                reader.onload = function(e) {
                    currentImageData = e.target.result
                    document.getElementById('imagePreview').src = currentImageData
                    document.getElementById('imagePreview').style.display = 'block'
                    document.getElementById('uploadPlaceholder').style.display = 'none'
                }
                reader.readAsDataURL(file)
            }
        }

        async function saveProduct() {
            const btn = document.getElementById('btnSaveProduct')
            if (btn.disabled) return
            lockBtn(btn)
            const name = document.getElementById('productName').value
            const price = parseFloat(document.getElementById('productPrice').value) || 0
            const description = document.getElementById('productDesc').value

            if (!name) {
                alert('请输入商品名称')
                unlockBtn(btn)
                return
            }

            const token = localStorage.getItem('token')
            const productData = {
                name,
                price,
                description,
                image: currentImageData
            }

            try {
                let response
                if (editingProductId) {
                    response = await fetch(`${API_BASE}/admin/products`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ id: editingProductId, ...productData })
                    })
                } else {
                    response = await fetch(`${API_BASE}/admin/products`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(productData)
                    })
                }

                const data = await response.json()
                if (data.success) {
                    closeProductModal()
                    loadProducts()
                    showAutoIndicator('商品已保存')
                }
            } catch (error) {
                alert('保存失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        function editProduct(id) {
            openProductModal(id)
        }

        async function deleteProduct(id) {
            if (confirm('确定要删除这个商品吗？')) {
                const token = localStorage.getItem('token')
                try {
                    await fetch(`${API_BASE}/admin/products`, {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ id })
                    })
                    loadProducts()
                    showAutoIndicator('商品已删除')
                } catch (error) {
                    alert('删除失败：' + error.message)
                }
            }
        }

        async function loadAdminRewards() {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/reward-types`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    adminRewards = data.data || []
                    renderAdminRewards()
                }
            } catch (error) {
                console.error('Failed to load admin rewards:', error)
            }
        }

        function renderAdminRewards() {
            const container = document.getElementById('adminRewardsList')
            if (adminRewards.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无奖励，请点击"添加奖励"</p>'
                return
            }
            
            container.innerHTML = adminRewards.map(reward => `
                <div class="item-card">
                    <div class="item-info">
                        <div class="item-name" style="color: #28a745;">${reward.name}</div>
                        <div class="item-desc">价格: ¥${reward.price} | ${reward.description || '暂无描述'}</div>
                        <div class="item-desc" style="color: ${reward.shop_enabled ? '#28a745' : '#ff6b6b'}; font-size: 12px;">
                            ${reward.shop_enabled ? '✅ 已上架商店' : '❌ 未上架商店'}
                        </div>
                        ${reward.image ? '<div style="margin-top: 5px;"><img src="' + reward.image + '" style="max-width: 100px; max-height: 100px; border-radius: 8px;"></div>' : ''}
                    </div>
                    <div class="item-actions">
                        <button class="btn ${reward.shop_enabled ? 'btn-warning' : 'btn-success'}" onclick="toggleShopReward('${reward.id}', ${reward.shop_enabled ? 0 : 1}, this)">
                            ${reward.shop_enabled ? '下架' : '上架'}
                        </button>
                        <button class="btn btn-primary" onclick="editAdminReward('${reward.id}')">编辑</button>
                        <button class="btn btn-danger" onclick="deleteAdminReward('${reward.id}', this)">删除</button>
                    </div>
                </div>
            `).join('')
        }

        async function toggleShopReward(id, enabled, btn) {
            const token = localStorage.getItem('token')
            const reward = adminRewards.find(r => r.id == id)
            if (!reward) return
            try {
                const response = await fetch(`${API_BASE}/admin/reward-types/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ 
                        name: reward.name, 
                        price: reward.price, 
                        description: reward.description || '', 
                        image: reward.image || '',
                        shop_enabled: enabled 
                    })
                })
                const data = await response.json()
                if (data.success) {
                    loadAdminRewards()
                    showAutoIndicator(enabled ? '已上架到商店' : '已从商店下架')
                }
            } catch (error) {
                alert('操作失败：' + error.message)
            }
        }

        function openAdminRewardModal(reward = null) {
            editingAdminRewardId = reward ? reward.id : null
            document.getElementById('adminRewardModalTitle').textContent = reward ? '编辑奖励' : '添加奖励'
            document.getElementById('adminRewardName').value = reward ? reward.name : ''
            document.getElementById('adminRewardPrice').value = reward ? reward.price : ''
            document.getElementById('adminRewardDesc').value = reward ? reward.description || '' : ''
            
            if (reward && reward.image) {
                adminRewardImageData = reward.image
                document.getElementById('adminRewardImagePreview').src = reward.image
                document.getElementById('adminRewardImagePreview').style.display = 'block'
                document.getElementById('adminRewardUploadPlaceholder').style.display = 'none'
            } else {
                adminRewardImageData = null
                document.getElementById('adminRewardImagePreview').style.display = 'none'
                document.getElementById('adminRewardUploadPlaceholder').style.display = 'block'
            }
            
            document.getElementById('adminRewardModal').classList.add('active')
        }

        function closeAdminRewardModal() {
            document.getElementById('adminRewardModal').classList.remove('active')
            editingAdminRewardId = null
            adminRewardImageData = null
        }

        function handleAdminRewardImageUpload(event) {
            const file = event.target.files[0]
            if (file) {
                const reader = new FileReader()
                reader.onload = function(e) {
                    adminRewardImageData = e.target.result
                    document.getElementById('adminRewardImagePreview').src = e.target.result
                    document.getElementById('adminRewardImagePreview').style.display = 'block'
                    document.getElementById('adminRewardUploadPlaceholder').style.display = 'none'
                }
                reader.readAsDataURL(file)
            }
        }

        function editAdminReward(id) {
            const reward = adminRewards.find(r => r.id == id)
            if (reward) {
                openAdminRewardModal(reward)
            }
        }

        async function saveAdminReward() {
            const btn = document.getElementById('btnSaveAdminReward')
            if (btn.disabled) return
            lockBtn(btn)
            const name = document.getElementById('adminRewardName').value
            const price = parseFloat(document.getElementById('adminRewardPrice').value)
            const description = document.getElementById('adminRewardDesc').value
            const token = localStorage.getItem('token')

            if (!name) {
                alert('请输入奖励名称')
                unlockBtn(btn); return
            }
            if (isNaN(price) || price < 0) {
                alert('请输入有效的价格')
                unlockBtn(btn); return
            }

            try {
                const url = editingAdminRewardId 
                    ? `${API_BASE}/admin/reward-types/${editingAdminRewardId}`
                    : `${API_BASE}/admin/reward-types`
                
                const method = editingAdminRewardId ? 'PUT' : 'POST'

                const response = await fetch(url, {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ name, price, description, image: adminRewardImageData })
                })

                const data = await response.json()
                if (data.success) {
                    closeAdminRewardModal()
                    loadAdminRewards()
                    showAutoIndicator(editingAdminRewardId ? '奖励已更新' : '奖励已添加')
                }
            } catch (error) {
                alert('操作失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        async function deleteAdminReward(id) {
            if (!confirm('确定要删除这个奖励吗？')) return

            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/reward-types/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    loadAdminRewards()
                    showAutoIndicator('奖励已删除')
                }
            } catch (error) {
                alert('删除失败：' + error.message)
            }
        }

        // 管理后台 - 惩罚管理

        async function loadAdminPenalties() {
            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/penalty-types`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    adminPenalties = data.data || []
                    renderAdminPenalties()
                }
            } catch (error) {
                console.error('Failed to load admin penalties:', error)
            }
        }

        function renderAdminPenalties() {
            const container = document.getElementById('adminPenaltiesList')
            if (adminPenalties.length === 0) {
                container.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无惩罚，请点击"添加惩罚"</p>'
                return
            }
            
            container.innerHTML = adminPenalties.map(penalty => `
                <div class="item-card">
                    <div class="item-info">
                        <div class="item-name" style="color: #ff4444;">${penalty.name}</div>
                        <div class="item-desc">消除价格: ¥${penalty.price} | ${penalty.description || '暂无描述'}</div>
                        <div class="item-desc" style="color: ${penalty.shop_enabled ? '#28a745' : '#ff6b6b'}; font-size: 12px;">
                            ${penalty.shop_enabled ? '✅ 已上架商店' : '❌ 未上架商店'}
                        </div>
                        ${penalty.image ? '<div style="margin-top: 5px;"><img src="' + penalty.image + '" style="max-width: 100px; max-height: 100px; border-radius: 8px;"></div>' : ''}
                    </div>
                    <div class="item-actions">
                        <button class="btn ${penalty.shop_enabled ? 'btn-warning' : 'btn-success'}" onclick="toggleShopPenalty('${penalty.id}', ${penalty.shop_enabled ? 0 : 1}, this)">
                            ${penalty.shop_enabled ? '下架' : '上架'}
                        </button>
                        <button class="btn btn-primary" onclick="editAdminPenalty('${penalty.id}')">编辑</button>
                        <button class="btn btn-danger" onclick="deleteAdminPenalty('${penalty.id}', this)">删除</button>
                    </div>
                </div>
            `).join('')
        }

        async function toggleShopPenalty(id, enabled, btn) {
            const token = localStorage.getItem('token')
            const penalty = adminPenalties.find(p => p.id == id)
            if (!penalty) return
            try {
                const response = await fetch(`${API_BASE}/admin/penalty-types/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ 
                        name: penalty.name, 
                        price: penalty.price, 
                        description: penalty.description || '', 
                        image: penalty.image || '',
                        shop_enabled: enabled 
                    })
                })
                const data = await response.json()
                if (data.success) {
                    loadAdminPenalties()
                    showAutoIndicator(enabled ? '已上架到商店' : '已从商店下架')
                }
            } catch (error) {
                alert('操作失败：' + error.message)
            }
        }

        function openAdminPenaltyModal(penalty = null) {
            editingAdminPenaltyId = penalty ? penalty.id : null
            document.getElementById('adminPenaltyModalTitle').textContent = penalty ? '编辑惩罚' : '添加惩罚'
            document.getElementById('adminPenaltyName').value = penalty ? penalty.name : ''
            document.getElementById('adminPenaltyPrice').value = penalty ? penalty.price : ''
            document.getElementById('adminPenaltyDesc').value = penalty ? penalty.description || '' : ''
            
            if (penalty && penalty.image) {
                adminPenaltyImageData = penalty.image
                document.getElementById('adminPenaltyImagePreview').src = penalty.image
                document.getElementById('adminPenaltyImagePreview').style.display = 'block'
                document.getElementById('adminPenaltyUploadPlaceholder').style.display = 'none'
            } else {
                adminPenaltyImageData = null
                document.getElementById('adminPenaltyImagePreview').style.display = 'none'
                document.getElementById('adminPenaltyUploadPlaceholder').style.display = 'block'
            }
            
            document.getElementById('adminPenaltyModal').classList.add('active')
        }

        function closeAdminPenaltyModal() {
            document.getElementById('adminPenaltyModal').classList.remove('active')
            editingAdminPenaltyId = null
            adminPenaltyImageData = null
        }

        function handleAdminPenaltyImageUpload(event) {
            const file = event.target.files[0]
            if (file) {
                const reader = new FileReader()
                reader.onload = function(e) {
                    adminPenaltyImageData = e.target.result
                    document.getElementById('adminPenaltyImagePreview').src = e.target.result
                    document.getElementById('adminPenaltyImagePreview').style.display = 'block'
                    document.getElementById('adminPenaltyUploadPlaceholder').style.display = 'none'
                }
                reader.readAsDataURL(file)
            }
        }

        function editAdminPenalty(id) {
            const penalty = adminPenalties.find(p => p.id == id)
            if (penalty) {
                openAdminPenaltyModal(penalty)
            }
        }

        async function saveAdminPenalty() {
            const btn = document.getElementById('btnSaveAdminPenalty')
            if (btn.disabled) return
            lockBtn(btn)
            const name = document.getElementById('adminPenaltyName').value
            const price = parseFloat(document.getElementById('adminPenaltyPrice').value)
            const description = document.getElementById('adminPenaltyDesc').value
            const token = localStorage.getItem('token')

            if (!name) {
                alert('请输入惩罚名称')
                unlockBtn(btn); return
            }
            if (isNaN(price) || price < 0) {
                alert('请输入有效的价格')
                unlockBtn(btn); return
            }

            try {
                const url = editingAdminPenaltyId 
                    ? `${API_BASE}/admin/penalty-types/${editingAdminPenaltyId}`
                    : `${API_BASE}/admin/penalty-types`
                
                const method = editingAdminPenaltyId ? 'PUT' : 'POST'

                const response = await fetch(url, {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ name, price, description, image: adminPenaltyImageData })
                })

                const data = await response.json()
                if (data.success) {
                    closeAdminPenaltyModal()
                    loadAdminPenalties()
                    showAutoIndicator(editingAdminPenaltyId ? '惩罚已更新' : '惩罚已添加')
                }
            } catch (error) {
                alert('操作失败：' + error.message)
            } finally {
                unlockBtn(btn)
            }
        }

        async function deleteAdminPenalty(id) {
            if (!confirm('确定要删除这个惩罚吗？')) return

            const token = localStorage.getItem('token')
            try {
                const response = await fetch(`${API_BASE}/admin/penalty-types/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await response.json()
                if (data.success) {
                    loadAdminPenalties()
                    showAutoIndicator('惩罚已删除')
                }
            } catch (error) {
                alert('删除失败：' + error.message)
            }
        }

