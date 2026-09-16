// 主页面：公告栏 + 留言板（自 index.html 拆分）
        let announcementImageData = null
        let messageImageData = null

        function handleAnnouncementImageUpload(event) {
            const file = event.target.files[0]
            if (!file) return
            fileToBase64(file).then(dataUrl => {
                announcementImageData = dataUrl
                document.getElementById('announcementUploadPlaceholder').textContent = file.name
                document.getElementById('announcementUploadPlaceholder').style.display = 'block'
                document.getElementById('announcementImagePreview').src = dataUrl
                document.getElementById('announcementImagePreview').style.display = 'block'
            }).catch(() => {
                alert('图片读取失败')
            })
        }

        function handleMessageImageUpload(event) {
            const file = event.target.files[0]
            if (!file) return
            fileToBase64(file).then(dataUrl => {
                messageImageData = dataUrl
                document.getElementById('messageImageName').textContent = file.name
            }).catch(() => {
                alert('图片读取失败')
            })
        }

        // === 北京时间格式化 ===

        // === 公告栏 ===
        async function loadAnnouncements() {
            try {
                const res = await fetch(`${API_BASE}/announcements`)
                const data = await res.json()
                const board = document.getElementById('announcementBoard')
                const userData = JSON.parse(localStorage.getItem('user') || '{}')
                const isAdmin = userData.role === 'admin'
                const token = localStorage.getItem('token')
                if (data.success && data.data && data.data.length > 0) {
                    board.innerHTML = data.data.map(ann => {
                        const isDisplayed = ann.is_displayed == 1
                        const isPinned = ann.is_pinned == 1
                        const hasImage = ann.image && ann.image.trim() !== ''
                        return `
                            <div class="announcement-item" style="background: ${isPinned ? 'rgba(255,215,0,0.1)' : 'rgba(255,215,0,0.03)'}; border-radius: 8px; padding: 16px; border-left: 4px solid ${isPinned ? '#ffd700' : isDisplayed ? '#ffa500' : '#666'}; margin-bottom: 8px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleAnnouncement(this)">
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        ${isPinned ? '<span style="color: #ffd700; font-size: 14px;">📌</span>' : ''}
                                        <span style="font-size: 18px; font-weight: bold; color: ${isPinned ? '#ffd700' : '#eee'};">
                                            ${ann.title}
                                        </span>
                                        <span style="font-size: 12px; color: #888;">${toBeijingTime(ann.created_at)}</span>
                                    </div>
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        ${!isDisplayed ? '<span style="color: #666; font-size: 12px;">[折叠]</span>' : ''}
                                        <span style="color: #888; font-size: 12px;">${isPinned ? '已置顶' : ''}</span>
                                    </div>
                                </div>
                                <div class="announcement-body" style="display: ${isDisplayed ? 'block' : 'none'}; margin-top: 12px;">
                                    ${ann.content ? `<div style="color: #ccc; line-height: 1.6; white-space: pre-wrap;">${ann.content}</div>` : ''}
                                    ${hasImage ? `<img src="${ann.image}" style="max-width: 100%; max-height: 400px; border-radius: 8px; margin-top: 8px; display: block;" onerror="this.style.display='none'">` : ''}
                                    ${isAdmin ? `
                                        <div style="display: flex; gap: 8px; margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.05);">
                                            <button class="btn btn-small" style="background: ${isPinned ? '#666' : '#ffd700'}; color: #000; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="event.stopPropagation(); togglePin(${ann.id}, ${isPinned ? 0 : 1})">
                                                ${isPinned ? '取消置顶' : '置顶'}
                                            </button>
                                            <button class="btn btn-small" style="background: ${isDisplayed ? '#666' : '#ffa500'}; color: #000; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="event.stopPropagation(); toggleDisplay(${ann.id}, ${isDisplayed ? 0 : 1})">
                                                ${isDisplayed ? '折叠' : '显示'}
                                            </button>
                                            <button class="btn btn-small" style="background: #e74c3c; color: #fff; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="event.stopPropagation(); deleteAnnouncement(${ann.id})">
                                                删除
                                            </button>
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        `
                    }).join('')
                } else {
                    board.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无公告</p>'
                }
            } catch (e) {
                document.getElementById('announcementBoard').innerHTML = '<p style="color: #e74c3c; text-align: center; padding: 20px;">加载公告失败</p>'
            }
        }

        function toggleAnnouncement(el) {
            const body = el.parentElement.querySelector('.announcement-body')
            if (body) {
                body.style.display = body.style.display === 'none' ? 'block' : 'none'
            }
        }

        async function togglePin(id, isPinned) {
            const token = localStorage.getItem('token')
            try {
                await fetch(`${API_BASE}/admin/announcements/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ is_pinned: isPinned })
                })
                loadAnnouncements()
            } catch (e) {
                alert('操作失败')
            }
        }

        async function toggleDisplay(id, isDisplayed) {
            const token = localStorage.getItem('token')
            try {
                await fetch(`${API_BASE}/admin/announcements/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ is_displayed: isDisplayed })
                })
                loadAnnouncements()
            } catch (e) {
                alert('操作失败')
            }
        }

        async function deleteAnnouncement(id) {
            if (!confirm('确定删除此公告吗？')) return
            const token = localStorage.getItem('token')
            try {
                const res = await fetch(`${API_BASE}/admin/announcements/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await res.json()
                if (data.success) {
                    loadAnnouncements()
                    showAutoIndicator('公告已删除')
                }
            } catch (e) {
                alert('删除失败')
            }
        }

        async function publishAnnouncement() {
            const btn = document.getElementById('btnPublishAnnouncement')
            if (btn && btn.disabled) return
            if (btn) lockBtn(btn)
            try {
                const title = document.getElementById('announcementTitle').value
                const content = document.getElementById('announcementContent').value
                if (!title) {
                    alert('请输入公告标题')
                    unlockBtn(btn)
                    return
                }
                const token = localStorage.getItem('token')
                const body = { title, content: content || '' }
                if (announcementImageData) {
                    body.image = announcementImageData
                }
                const res = await fetch(`${API_BASE}/admin/announcements`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify(body)
                })
                const data = await res.json()
                if (data.success) {
                    document.getElementById('announcementTitle').value = ''
                    document.getElementById('announcementContent').value = ''
                    announcementImageData = null
                    document.getElementById('announcementUploadPlaceholder').textContent = '📷 点击上传公告图片（可选）'
                    document.getElementById('announcementImagePreview').style.display = 'none'
                    document.getElementById('announcementImage').value = ''
                    loadAnnouncements()
                    showAutoIndicator('公告已发布')
                }
            } catch (error) {
                alert('发布失败：' + error.message)
            } finally {
                if (btn) unlockBtn(btn)
            }
        }

        // === 留言板 ===
        async function loadMessages() {
            try {
                const res = await fetch(`${API_BASE}/messages`)
                const data = await res.json()
                const list = document.getElementById('messageList')
                const userData = JSON.parse(localStorage.getItem('user') || '{}')
                const isAdmin = userData.role === 'admin'
                const token = localStorage.getItem('token')
                if (data.success && data.data && data.data.length > 0) {
                    list.innerHTML = data.data.map(m => {
                        const hasImage = m.image && m.image.trim() !== ''
                        const comments = m.comments || []
                        return `
                            <div class="message-item" style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                    <div style="flex: 1;">
                                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                            <span style="color: #ffd700; font-weight: bold;">${m.username}</span>
                                            <span style="font-size: 12px; color: #888;">${toBeijingTime(m.created_at)}</span>
                                        </div>
                                        <div style="color: #ccc; line-height: 1.5; white-space: pre-wrap;">${m.content}</div>
                                        ${hasImage ? `<img src="${m.image}" style="max-width: 100%; max-height: 300px; border-radius: 8px; margin-top: 8px; display: block;" onerror="this.style.display='none'">` : ''}
                                    </div>
                                    ${isAdmin ? `
                                        <button class="btn btn-small" style="background: #e74c3c; color: #fff; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: 8px;" onclick="deleteMessage(${m.id})">
                                            删除
                                        </button>
                                    ` : ''}
                                </div>
                                <div style="margin-top: 10px;">
                                    <div style="font-size: 12px; color: #888; margin-bottom: 4px;">💬 评论 (${comments.length})</div>
                                    ${comments.map(c => `
                                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 5px 0 5px 10px; border-left: 2px solid rgba(255,215,0,0.15); margin-bottom: 2px;">
                                            <div style="flex: 1; min-width: 0;">
                                                <span style="color: #ffd700; font-size: 13px; font-weight: bold;">${c.username}</span>
                                                <span style="font-size: 11px; color: #888; margin-left: 6px;">${toBeijingTime(c.created_at)}</span>
                                                <div style="color: #bbb; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${c.content}</div>
                                            </div>
                                            ${(isAdmin || c.username === userData.username) ? `
                                                <button class="btn btn-small" style="background: #e74c3c; color: #fff; border: none; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; flex-shrink: 0;" onclick="deleteComment(${c.id})">删除</button>
                                            ` : ''}
                                        </div>
                                    `).join('')}
                                    <div style="display: flex; gap: 8px; margin-top: 6px;">
                                        <input type="text" id="commentInput-${m.id}" placeholder="写评论..." style="flex: 1; padding: 8px 12px; border: 1px solid rgba(255,215,0,0.2); border-radius: 6px; background: rgba(0,0,0,0.3); color: #fff; font-size: 14px; min-width: 0;" onkeydown="if(event.key==='Enter') sendComment(${m.id}, this.nextElementSibling)">
                                        <button class="btn btn-small" style="background: #ffd700; color: #2d132c; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; flex-shrink: 0;" onclick="sendComment(${m.id}, this)">发送</button>
                                    </div>
                                </div>
                            </div>
                        `
                    }).join('')
                } else {
                    list.innerHTML = '<p style="color: #aaa; text-align: center; padding: 20px;">暂无留言</p>'
                }
            } catch (e) {
                document.getElementById('messageList').innerHTML = '<p style="color: #e74c3c; text-align: center; padding: 20px;">加载留言失败</p>'
            }
        }

        async function deleteMessage(id) {
            if (!confirm('确定删除此留言吗？')) return
            const token = localStorage.getItem('token')
            try {
                const res = await fetch(`${API_BASE}/admin/messages/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await res.json()
                if (data.success) {
                    loadMessages()
                    showAutoIndicator('留言已删除')
                }
            } catch (e) {
                alert('删除失败')
            }
        }

        async function sendComment(messageId, btn) {
            if (btn && btn.disabled) return
            if (btn) lockBtn(btn)
            try {
                const token = localStorage.getItem('token')
                if (!token) {
                    alert('请先登录后再评论')
                    unlockBtn(btn)
                    return
                }
                const input = document.getElementById(`commentInput-${messageId}`)
                const content = input ? input.value.trim() : ''
                if (!content) {
                    alert('请输入评论内容')
                    unlockBtn(btn)
                    return
                }
                const res = await fetch(`${API_BASE}/messages/${messageId}/comments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ content })
                })
                const data = await res.json()
                if (data.success) {
                    loadMessages()
                } else {
                    alert(data.error || '评论失败')
                }
            } catch (error) {
                alert('评论失败：' + error.message)
            } finally {
                if (btn) unlockBtn(btn)
            }
        }

        async function deleteComment(id) {
            if (!confirm('确定删除此评论吗？')) return
            const token = localStorage.getItem('token')
            try {
                const res = await fetch(`${API_BASE}/comments/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                const data = await res.json()
                if (data.success) {
                    loadMessages()
                    showAutoIndicator('评论已删除')
                } else {
                    alert(data.error || '删除失败')
                }
            } catch (e) {
                alert('删除失败')
            }
        }

        async function sendMessage() {
            const btn = document.getElementById('btnSendMessage')
            if (btn && btn.disabled) return
            if (btn) lockBtn(btn)
            try {
                const input = document.getElementById('messageInput')
                const content = input.value.trim()
                if (!content) {
                    alert('请输入留言内容')
                    unlockBtn(btn)
                    return
                }
                const token = localStorage.getItem('token')
                const body = { content }
                if (messageImageData) {
                    body.image = messageImageData
                }
                const res = await fetch(`${API_BASE}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify(body)
                })
                const data = await res.json()
                if (data.success) {
                    input.value = ''
                    messageImageData = null
                    document.getElementById('messageImageName').textContent = ''
                    document.getElementById('messageImage').value = ''
                    loadMessages()
                } else {
                    alert(data.error || '发送失败')
                }
            } catch (error) {
                alert('发送失败：' + error.message)
            } finally {
                if (btn) unlockBtn(btn)
            }
        }

        // 资产变更记录：仅显示前10条，其余折叠

