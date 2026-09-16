// 步骤5 · 商店（只卖道具，G8/G10/G13/G14/G16）
// 上架硬校验：只能引用 game/clear 两类道具；引用资产、奖励、碎片、收藏外观一律拒绝
// 购买：幂等、按商品币种扣减（余额不足按该币种拦截）、每日限购生效

import { KernelError, toInt, toMoney } from '../kernel/util.js'
import { kernelWrite } from '../kernel/idempotency.js'
import { ledgerStmts } from '../kernel/ledger.js'
import { auditStmt } from '../kernel/templates.js'
import { getParam } from '../kernel/templates.js'

function bjDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

// ---------- Schema 保证（与 migrations/0013_shop.sql 等价，幂等） ----------
let shopSchemaPromise = null
export function ensureShopSchemaOnce(DB) {
  if (!shopSchemaPromise) {
    shopSchemaPromise = initShopSchema(DB).catch(error => {
      console.error('Failed to ensure shop schema:', error)
      shopSchemaPromise = null
    })
  }
  return shopSchemaPromise
}

async function initShopSchema(DB) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS shop_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'coin',
      price REAL NOT NULL,
      daily_limit INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS shop_purchases (
      username TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (username, product_id, day)
    )`,
    `INSERT OR IGNORE INTO shop_products (id, item_id, currency, price, daily_limit, is_active, sort) VALUES
      (1,  1,  'coin', 20,  5, 1, 10),
      (2,  2,  'coin', 30,  5, 1, 20),
      (3,  3,  'coin', 15,  5, 1, 30),
      (4,  4,  'coin', 25,  5, 1, 40),
      (5,  5,  'coin', 30,  5, 1, 50),
      (6,  6,  'coin', 40,  5, 1, 60),
      (7,  11, 'coin', 10,  5, 1, 70),
      (8,  12, 'coin', 30,  3, 1, 80),
      (9,  13, 'coin', 60,  3, 1, 90),
      (10, 14, 'coin', 120, 1, 1, 100),
      (11, 5,  'activity', 30, 5, 1, 110)`,
  ]
  await DB.batch(ddl.map(sql => DB.prepare(sql)))
}

// ---------- T5.2 上架硬校验（服务端权威） ----------
async function validateProduct(DB, { item_id, currency, price }) {
  const tpl = await DB.prepare('SELECT * FROM item_templates WHERE id = ?').bind(item_id).first()
  if (!tpl || !tpl.is_active) throw new KernelError('INVALID_REF', '引用的道具不存在或已停用')
  if (tpl.category === 'appearance') {
    throw new KernelError('PRODUCT_FORBIDDEN', '收藏外观不可上架商城（G16：外观只能由抓娃娃掉落）')
  }
  if (tpl.category !== 'game' && tpl.category !== 'clear') {
    throw new KernelError('PRODUCT_FORBIDDEN', '商品只能引用游戏类或惩罚减免类道具')
  }
  if (!['coin', 'activity'].includes(currency)) {
    throw new KernelError('INVALID_PARAM', '结算币种只能是金币或活跃值')
  }
  const p = toMoney(price)
  if (p <= 0) throw new KernelError('INVALID_PARAM', '价格必须大于0')
  // T5.4 减免类定价校验：定价 ≥ 减免量 × 减免单位折算价（仅校验，不参与结算）
  if (tpl.category === 'clear' && tpl.action === 'spank_reduce') {
    const unit = Number(await getParam(DB, 'reduce_unit_price', '10'))
    const floor = Math.max(1, Math.round(tpl.action_value || 1)) * unit
    if (p < floor) {
      throw new KernelError('PRICE_BELOW_FLOOR', `减免券定价不得低于减免折算价 ${floor} 币（${tpl.action_value}×${unit}）`)
    }
  }
  return { tpl, price: p }
}

// ---------- 商品 CRUD（管理端；步骤6接UI） ----------
export async function createProductOp(DB, data, operator = '') {
  const item_id = toInt(data.item_id, 0, 1, 1e12)
  const currency = data.currency === 'activity' ? 'activity' : 'coin'
  const { tpl, price } = await validateProduct(DB, { item_id, currency, price: data.price })
  const daily_limit = (data.daily_limit === undefined || data.daily_limit === '' || data.daily_limit === null)
    ? tpl.daily_limit : toInt(data.daily_limit, 0, 0, 999)
  const result = await DB.prepare(
    'INSERT INTO shop_products (item_id, currency, price, daily_limit, sort) VALUES (?, ?, ?, ?, ?)'
  ).bind(item_id, currency, price, daily_limit, toInt(data.sort, 100, 0, 9999)).run()
  const created = await DB.prepare('SELECT * FROM shop_products WHERE id = ?').bind(result.meta.last_row_id).first()
  await auditStmt(DB, { scope: 'shop_product', action: 'create', targetId: created.id, before: null, after: created, operator }).run()
  return created
}

export async function updateProductOp(DB, id, data, operator = '') {
  const before = await DB.prepare('SELECT * FROM shop_products WHERE id = ?').bind(id).first()
  if (!before) throw new KernelError('NOT_FOUND', '商品不存在', 404)
  const merged = { ...before, ...data }
  const { price, daily_limit } = await validateProduct(DB, {
    item_id: merged.item_id, currency: merged.currency, price: merged.price,
  })
  const dl = (merged.daily_limit === undefined || merged.daily_limit === '' || merged.daily_limit === null)
    ? null : toInt(merged.daily_limit, 0, 0, 999)
  await DB.batch([
    DB.prepare(
      "UPDATE shop_products SET currency = ?, price = ?, daily_limit = ?, is_active = ?, sort = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(merged.currency === 'activity' ? 'activity' : 'coin', price, dl, merged.is_active ? 1 : 0, toInt(merged.sort, 100, 0, 9999), id),
    auditStmt(DB, { scope: 'shop_product', action: 'update', targetId: id, before, after: { ...before, price, daily_limit: dl }, operator }),
  ])
  return DB.prepare('SELECT * FROM shop_products WHERE id = ?').bind(id).first()
}

// ---------- 商品列表（玩家端，含公示信息） ----------
export async function listShopProducts(DB) {
  const rows = await DB.prepare(
    `SELECT p.id, p.item_id, p.currency, p.price, p.daily_limit AS product_daily_limit, p.is_active, p.sort,
            t.name, t.rarity, t.category, t.action, t.action_value, t.scope, t.auto_mount,
            t.daily_limit AS template_daily_limit, t.description, t.image
     FROM shop_products p JOIN item_templates t ON t.id = p.item_id
     WHERE p.is_active = 1 AND t.is_active = 1
     ORDER BY p.sort, p.id`
  ).all()
  const products = (rows.results || []).map(r => ({
    ...r,
    dailyLimit: r.product_daily_limit ?? r.template_daily_limit ?? null,
    // G9 提示：券的固定 Spank 减免量与可作用稀有度上限
    reduceValue: r.action === 'spank_reduce' ? Math.max(1, Math.round(r.action_value || 1)) : null,
    maxTargetRarity: r.action === 'spank_reduce' ? r.rarity : null,
  }))
  return products
}

// ---------- 购买（幂等 / 币种扣减 / 限购 / 入包） ----------
export async function buyProductOp(DB, { username, productId, idempotencyKey = null }) {
  return kernelWrite(
    DB,
    { key: idempotencyKey, endpoint: 'shop_buy', username },
    async () => {
      const p = await DB.prepare(
        `SELECT p.*, t.name, t.category, t.is_active AS tpl_active
         FROM shop_products p JOIN item_templates t ON t.id = p.item_id
         WHERE p.id = ? AND p.is_active = 1 AND t.is_active = 1`
      ).bind(productId).first()
      if (!p) throw new KernelError('NOT_FOUND', '商品不存在或已下架', 404)

      // T5.4 限购（每日，按商品计）
      const today = bjDate()
      const limit = p.daily_limit ?? 0
      if (limit > 0) {
        const c = await DB.prepare(
          'SELECT count FROM shop_purchases WHERE username = ? AND product_id = ? AND day = ?'
        ).bind(username, productId, today).first()
        if ((c?.count || 0) >= limit) {
          throw new KernelError('PURCHASE_LIMIT', `该商品今日限购 ${limit} 次，已用完`)
        }
      }

      // G14 币种扣减：余额不足按该币种拦截
      const col = p.currency === 'coin' ? 'balance' : 'activity'
      const user = await DB.prepare(`SELECT username, ${col} AS cur FROM users WHERE username = ?`).bind(username).first()
      if (!user) throw new KernelError('USER_NOT_FOUND', '用户不存在', 404)
      if ((Number(user.cur) || 0) < p.price) {
        throw new KernelError('INSUFFICIENT_BALANCE',
          p.currency === 'coin' ? '金币不足' : '活跃值不足')
      }

      const stmts = []
      const { stmts: payStmts, balance } = await ledgerStmts(DB, {
        username, currency: p.currency, delta: -p.price, reason: 'shop_buy',
        refType: 'shop', refId: String(productId),
        assetLog: { action: 'balance', title: `商城购买：${p.name}`, detail: `-${p.price} ${p.currency === 'coin' ? '金币' : '活跃值'}` },
      })
      stmts.push(...payStmts)

      // 道具入包
      stmts.push(DB.prepare(
        `INSERT INTO player_items (username, item_id, count) VALUES (?, ?, 1)
         ON CONFLICT(username, item_id) DO UPDATE SET count = count + 1, updated_at = datetime('now')`
      ).bind(username, p.item_id))

      // 限购计数
      if (limit > 0) {
        stmts.push(DB.prepare(
          `INSERT INTO shop_purchases (username, product_id, day, count) VALUES (?, ?, ?, 1)
           ON CONFLICT(username, product_id, day) DO UPDATE SET count = count + 1`
        ).bind(username, productId, today))
      }

      const response = {
        action: 'shop_buy', productId, itemId: p.item_id, name: p.name,
        currency: p.currency, price: p.price, balance,
      }
      return { response, stmts }
    }
  )
}
