// 互通内核 · 稀有度主轴（T1.1）、三类模板库（T1.2）、全局参数、审计与配置版本（G3/G5）

import { KernelError, isValidRarity, toInt, toMoney } from './util.js'

export const TEMPLATE_TABLES = {
  reward: 'reward_templates',
  penalty: 'penalty_templates',
  item: 'item_templates',
}

export const REWARD_KINDS = ['coupon', 'member', 'physical', 'platform']
export const ITEM_CATEGORIES = ['game', 'clear', 'appearance']

// ---------- 审计（G5）：审计语句与业务写入同 batch，保证原子一致 ----------
export function auditStmt(DB, { scope, action, targetId = '', before = null, after = null, operator = '' }) {
  return DB.prepare(
    'INSERT INTO config_audit (scope, action, target_id, before, after, operator) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(scope, action, String(targetId), before ? JSON.stringify(before) : '', after ? JSON.stringify(after) : '', operator)
}

export async function audit(DB, opts) {
  await auditStmt(DB, opts).run()
}

// ---------- G3 配置版本快照（数值配置变更时落快照；KV 可选缓存） ----------
export async function snapshotConfigVersion(DB, { scope = 'kernel_core', createdBy = '', kv = null } = {}) {
  const rarity = await DB.prepare('SELECT * FROM rarity_levels ORDER BY level').all()
  const params = await DB.prepare('SELECT key, value, note FROM kernel_params ORDER BY key').all()
  const payload = JSON.stringify({ rarity: rarity.results || [], params: params.results || [] })
  const maxRow = await DB.prepare('SELECT MAX(version) AS v FROM config_versions WHERE scope = ?').bind(scope).first()
  const version = (maxRow?.v || 0) + 1
  await DB.prepare(
    'INSERT INTO config_versions (scope, version, payload, status, created_by) VALUES (?, ?, ?, ?, ?)'
  ).bind(scope, version, payload, 'published', createdBy).run()
  if (kv && typeof kv.put === 'function') {
    try { await kv.put(`cfg:${scope}`, JSON.stringify({ version, payload })) } catch (e) { console.error('KV put failed:', e) }
  }
  return { scope, version }
}

// ---------- T1.1 稀有度主轴（等级不可删除/重命名，仅可调派生参数） ----------
export async function listRarity(DB) {
  const rows = await DB.prepare('SELECT * FROM rarity_levels ORDER BY level').all()
  return rows.results || []
}

export async function updateRarity(DB, level, data, operator = '') {
  if (!isValidRarity(level)) throw new KernelError('INVALID_PARAM', '稀有度等级不正确')
  const before = await DB.prepare('SELECT * FROM rarity_levels WHERE level = ?').bind(level).first()
  if (!before) throw new KernelError('NOT_FOUND', '稀有度等级不存在', 404)

  // 允许修改的派生参数：铺场权重 / 定价带 / 掉落权重基准 / 停用状态；等级与名称不可改
  const field_weight = data.field_weight !== undefined ? toMoney(data.field_weight, before.field_weight) : before.field_weight
  const price_min = data.price_min !== undefined ? toMoney(data.price_min, before.price_min) : before.price_min
  const price_max = data.price_max !== undefined ? toMoney(data.price_max, before.price_max) : before.price_max
  const drop_weight = data.drop_weight !== undefined ? toMoney(data.drop_weight, before.drop_weight) : before.drop_weight
  const is_active = data.is_active !== undefined ? (data.is_active ? 1 : 0) : before.is_active
  if (price_min > price_max) throw new KernelError('INVALID_PARAM', '定价带下限不能高于上限')

  await DB.batch([
    DB.prepare(
      `UPDATE rarity_levels SET field_weight = ?, price_min = ?, price_max = ?, drop_weight = ?, is_active = ?, updated_at = datetime('now') WHERE level = ?`
    ).bind(field_weight, price_min, price_max, drop_weight, is_active, level),
    auditStmt(DB, { scope: 'rarity', action: 'update', targetId: level, before, after: { ...before, field_weight, price_min, price_max, drop_weight, is_active }, operator }),
  ])

  const after = await DB.prepare('SELECT * FROM rarity_levels WHERE level = ?').bind(level).first()
  await snapshotConfigVersion(DB, { createdBy: operator })
  return after
}

// ---------- 全局参数 ----------
export async function listParams(DB) {
  const rows = await DB.prepare('SELECT key, value, note, updated_at FROM kernel_params ORDER BY key').all()
  return rows.results || []
}

export async function getParam(DB, key, fallback = null) {
  const row = await DB.prepare('SELECT value FROM kernel_params WHERE key = ?').bind(key).first()
  return row ? row.value : fallback
}

export async function updateParams(DB, entries = {}, operator = '') {
  const keys = Object.keys(entries || {})
  if (!keys.length) throw new KernelError('INVALID_PARAM', '缺少要更新的参数')
  const allowed = [
    'play_cost_coin', 'reduce_unit_price', 'adjust_threshold_coin', 'adjust_threshold_count',
    'grab_reroll_cost', 'grab_reroll_daily_limit', 'grab_dolls_per_layout', 'grab_hand_slip_rate', 'grab_luck_max',
  ]
  const beforeRows = await DB.prepare('SELECT key, value FROM kernel_params').all()
  const beforeMap = Object.fromEntries((beforeRows.results || []).map(r => [r.key, r.value]))

  const stmts = []
  for (const key of keys) {
    if (!allowed.includes(key)) throw new KernelError('INVALID_PARAM', `不支持的参数：${key}`)
    const num = toMoney(entries[key])
    if (num < 0) throw new KernelError('INVALID_PARAM', '参数不能为负数')
    stmts.push(DB.prepare(
      `INSERT INTO kernel_params (key, value, note) VALUES (?, ?, '')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(key, String(num)))
  }
  stmts.push(auditStmt(DB, { scope: 'param', action: 'update', targetId: keys.join(','), before: beforeMap, after: entries, operator }))
  await DB.batch(stmts)
  await snapshotConfigVersion(DB, { createdBy: operator })
  return listParams(DB)
}

// ---------- T1.2 模板校验 ----------
function validateRarity(r) {
  const rarity = toInt(r, 1, 1, 4)
  return rarity
}

function validateReward(data) {
  const name = String(data.name || '').trim()
  if (!name) throw new KernelError('INVALID_PARAM', '奖励名称不能为空')
  const rarity = validateRarity(data.rarity)
  const kind = REWARD_KINDS.includes(data.kind) ? data.kind : 'coupon'
  const value = toMoney(data.value)
  if (value < 0) throw new KernelError('INVALID_PARAM', '折算价值不能为负数')
  // stock：-1=无限，>=0 为有限库存
  const stock = data.stock === undefined || data.stock === '' || data.stock === null
    ? -1
    : toInt(data.stock, -1, -1, 1000000)
  return { name, rarity, kind, value, stock, description: String(data.description || ''), image: String(data.image || '') }
}

function validatePenalty(data) {
  const name = String(data.name || '').trim()
  if (!name) throw new KernelError('INVALID_PARAM', '惩罚道具名称不能为空')
  const rarity = validateRarity(data.rarity)
  // G11：Spank数量逐道具单独配置、与稀有度无关
  const spank_min = toInt(data.spank_min, 1, 1, 9999)
  const spank_max = toInt(data.spank_max, spank_min, 1, 9999)
  if (spank_max < spank_min) throw new KernelError('INVALID_PARAM', 'Spank上限不能低于下限')
  const spank_cap = toInt(data.spank_cap, 999, 1, 999999)
  return { name, rarity, spank_min, spank_max, spank_cap, description: String(data.description || ''), image: String(data.image || '') }
}

function validateItem(data) {
  const name = String(data.name || '').trim()
  if (!name) throw new KernelError('INVALID_PARAM', '道具名称不能为空')
  const rarity = validateRarity(data.rarity)
  const category = ITEM_CATEGORIES.includes(data.category) ? data.category : 'game'
  const action = String(data.action || '').trim()
  if (!action) throw new KernelError('INVALID_PARAM', '道具效果动作类型不能为空（只能从预置动作类型中组合，不允许自由逻辑）')
  const action_value = toMoney(data.action_value)
  const scope = ['all', 'grab', 'slot'].includes(data.scope) ? data.scope : 'all'
  const auto_mount = data.auto_mount !== undefined ? (data.auto_mount ? 1 : 0) : 0
  // G9：减免类一律手动使用，强制不可自动挂载
  if (category === 'clear' && auto_mount) {
    throw new KernelError('INVALID_PARAM', '减免类道具只能手动使用，不可自动挂载')
  }
  const priority = toInt(data.priority, 100, 1, 9999)
  const daily_limit = (data.daily_limit === undefined || data.daily_limit === '' || data.daily_limit === null)
    ? null : toInt(data.daily_limit, 0, 0, 9999)
  const price = (data.price === undefined || data.price === '' || data.price === null)
    ? null : toMoney(data.price)
  return {
    name, rarity, category, action, action_value,
    mount_events: String(data.mount_events || '').trim(), scope, auto_mount,
    priority, daily_limit, price,
    description: String(data.description || ''), image: String(data.image || ''),
  }
}

const VALIDATORS = { reward: validateReward, penalty: validatePenalty, item: validateItem }

// ---------- T1.2 模板 CRUD（管理员新建/编辑/停用；含引用保护） ----------
export async function createTemplate(DB, kind, data, operator = '') {
  const table = TEMPLATE_TABLES[kind]
  if (!table) throw new KernelError('INVALID_PARAM', '模板类型不正确')
  const fields = VALIDATORS[kind](data)
  const cols = Object.keys(fields)
  const result = await DB.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).bind(...cols.map(c => fields[c])).run()

  const created = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(result.meta.last_row_id).first()
  await auditStmt(DB, { scope: `${kind}_template`, action: 'create', targetId: created.id, before: null, after: created, operator }).run()
  return created
}

export async function updateTemplate(DB, kind, id, data, operator = '') {
  const table = TEMPLATE_TABLES[kind]
  if (!table) throw new KernelError('INVALID_PARAM', '模板类型不正确')
  const before = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
  if (!before) throw new KernelError('NOT_FOUND', '模板不存在', 404)

  // 部分更新：仅覆盖请求中出现的字段，未提供字段沿用原值
  const merged = { ...before, ...data }
  const fields = VALIDATORS[kind](merged)
  const cols = Object.keys(fields)
  await DB.prepare(
    `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...cols.map(c => fields[c]), id).run()

  const after = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
  await auditStmt(DB, { scope: `${kind}_template`, action: 'update', targetId: id, before, after, operator }).run()
  return after
}

export async function disableTemplate(DB, kind, id, operator = '') {
  const table = TEMPLATE_TABLES[kind]
  if (!table) throw new KernelError('INVALID_PARAM', '模板类型不正确')
  const before = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
  if (!before) throw new KernelError('NOT_FOUND', '模板不存在', 404)
  await DB.prepare(`UPDATE ${table} SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).bind(id).run()
  const after = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
  await auditStmt(DB, { scope: `${kind}_template`, action: 'disable', targetId: id, before, after, operator }).run()
  return after
}

// 引用保护（§4）：被掉落池引用的模板不可删除，只能停用（停用前由后台强制指定替换）
export async function deleteTemplate(DB, kind, id, operator = '') {
  const table = TEMPLATE_TABLES[kind]
  if (!table) throw new KernelError('INVALID_PARAM', '模板类型不正确')
  const before = await DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()
  if (!before) throw new KernelError('NOT_FOUND', '模板不存在', 404)

  const refTypeMap = { reward: 'reward', penalty: 'penalty', item: 'item' }
  const ref = await DB.prepare(
    "SELECT COUNT(*) AS c FROM drop_pools WHERE ref_type = ? AND ref_id = ? AND is_active = 1"
  ).bind(refTypeMap[kind], id).first()
  if (ref && ref.c > 0) {
    throw new KernelError('TEMPLATE_REFERENCED', `该模板正被 ${ref.c} 条掉落池条目引用，不可删除，只能停用`)
  }

  await DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run()
  await auditStmt(DB, { scope: `${kind}_template`, action: 'delete', targetId: id, before, after: null, operator }).run()
  return { deleted: true }
}

export async function listTemplates(DB, kind, { includeInactive = true, username = null } = {}) {
  const table = TEMPLATE_TABLES[kind]
  if (!table) throw new KernelError('INVALID_PARAM', '模板类型不正确')
  let sql = `SELECT * FROM ${table}`
  const params = []
  if (!includeInactive) sql += ' WHERE is_active = 1'
  sql += ' ORDER BY id'
  const rows = await DB.prepare(sql).bind(...params).all()
  return rows.results || []
}
