// 互通内核 · Schema 保证（与 migrations/0009_kernel.sql 等价的幂等 DDL + 种子）
// 每个 Worker 实例仅执行一次；迁移已应用时全部为 no-op

let kernelSchemaPromise = null

export function ensureKernelSchemaOnce(DB) {
  if (!kernelSchemaPromise) {
    kernelSchemaPromise = initKernelSchema(DB).catch(error => {
      console.error('Failed to ensure kernel schema:', error)
      kernelSchemaPromise = null // 失败后允许下次请求重试
    })
  }
  return kernelSchemaPromise
}

async function initKernelSchema(DB) {
  const ddl = [
    // G6/G12：活跃值（金币沿用 users.balance）
    'ALTER TABLE users ADD COLUMN activity REAL NOT NULL DEFAULT 0',

    // T1.1 稀有度主轴
    `CREATE TABLE IF NOT EXISTS rarity_levels (
      level INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      field_weight REAL NOT NULL DEFAULT 0,
      price_min REAL NOT NULL DEFAULT 0,
      price_max REAL NOT NULL DEFAULT 0,
      drop_weight REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 全局参数
    `CREATE TABLE IF NOT EXISTS kernel_params (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      note TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // T1.2 三类模板库
    `CREATE TABLE IF NOT EXISTS reward_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rarity INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'coupon',
      value REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT -1,
      description TEXT DEFAULT '',
      image TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS penalty_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rarity INTEGER NOT NULL DEFAULT 1,
      spank_min INTEGER NOT NULL DEFAULT 1,
      spank_max INTEGER NOT NULL DEFAULT 1,
      spank_cap INTEGER NOT NULL DEFAULT 999,
      description TEXT DEFAULT '',
      image TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS item_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rarity INTEGER NOT NULL DEFAULT 1,
      category TEXT NOT NULL DEFAULT 'game',
      action TEXT NOT NULL DEFAULT '',
      action_value REAL DEFAULT 0,
      mount_events TEXT DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'all',
      auto_mount INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      daily_limit INTEGER,
      price REAL,
      description TEXT DEFAULT '',
      image TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // T1.3 掉落池引用 + 总控概率
    `CREATE TABLE IF NOT EXISTS drop_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      option TEXT NOT NULL DEFAULT 'default',
      side TEXT NOT NULL DEFAULT 'reward',
      ref_type TEXT NOT NULL,
      ref_id INTEGER,
      amount REAL,
      weight REAL NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_drop_pools_game ON drop_pools(game, option, side)',
    `CREATE TABLE IF NOT EXISTS drop_side_controls (
      game TEXT NOT NULL,
      option TEXT NOT NULL DEFAULT 'default',
      reward_side_prob REAL NOT NULL DEFAULT 0.5,
      penalty_side_prob REAL NOT NULL DEFAULT 0.5,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (game, option)
    )`,
    `CREATE TABLE IF NOT EXISTS drop_skip_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      option TEXT NOT NULL DEFAULT 'default',
      entry_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // T1.4 碎片配方
    `CREATE TABLE IF NOT EXISTS fragment_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      pieces_required INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (target_type, target_id)
    )`,
    `CREATE TABLE IF NOT EXISTS player_fragments (
      username TEXT NOT NULL,
      recipe_id INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, recipe_id)
    )`,

    // 道具库存
    `CREATE TABLE IF NOT EXISTS player_items (
      username TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      auto_mount INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, item_id)
    )`,

    // T1.6 Spank 累计与流水
    `CREATE TABLE IF NOT EXISTS player_spanks (
      username TEXT NOT NULL,
      penalty_id INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, penalty_id)
    )`,
    `CREATE TABLE IF NOT EXISTS spank_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      penalty_id INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      source TEXT NOT NULL,
      coupon_item_id INTEGER,
      admin TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_spank_logs_user ON spank_logs(username, created_at)',

    // T1.8 奖励背包
    `CREATE TABLE IF NOT EXISTS player_reward_bag (
      username TEXT NOT NULL,
      reward_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, reward_id, status)
    )`,

    // 统一账本
    `CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      currency TEXT NOT NULL,
      delta REAL NOT NULL,
      balance_after REAL NOT NULL,
      reason TEXT NOT NULL,
      ref_type TEXT DEFAULT '',
      ref_id TEXT DEFAULT '',
      idempotency_key TEXT UNIQUE,
      created_by TEXT DEFAULT 'system',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(username, created_at)',

    // G2 幂等
    `CREATE TABLE IF NOT EXISTS idempotency_records (
      idempotency_key TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL DEFAULT '',
      username TEXT DEFAULT '',
      response TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // T1.5 效果流水
    `CREATE TABLE IF NOT EXISTS effect_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      game TEXT NOT NULL,
      event TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      value REAL,
      detail TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // T1.7 人工调整
    `CREATE TABLE IF NOT EXISTS admin_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER,
      delta REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      approved_by TEXT,
      idempotency_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      applied_at DATETIME
    )`,

    // G5 审计 / G3 配置版本
    `CREATE TABLE IF NOT EXISTS config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT DEFAULT '',
      before TEXT DEFAULT '',
      after TEXT DEFAULT '',
      operator TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      created_by TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  ]
  // ALTER 可能因列已存在而失败，静默忽略（D1 prepare 为惰性，本处同时兼容急切校验的本地运行时）
  try {
    await DB.prepare(ddl[0]).run()
  } catch (e) { /* 列已存在，忽略 */ }
  await DB.batch(ddl.slice(1).map(sql => DB.prepare(sql)))

  // 种子数据（幂等）
  const seeds = [
    `INSERT OR IGNORE INTO rarity_levels (level, name, field_weight, price_min, price_max, drop_weight) VALUES
      (1, '普通', 0.60, 5,   40,  60),
      (2, '精致', 0.25, 15,  80,  25),
      (3, '华丽', 0.12, 50,  150, 12),
      (4, '鎏金', 0.03, 120, 400, 3)`,
    `INSERT OR IGNORE INTO kernel_params (key, value, note) VALUES
      ('play_cost_coin', '10', '单次游玩费用（金币，后台可配）'),
      ('reduce_unit_price', '10', '减免单位折算价（仅用于定价校验，不参与结算）'),
      ('adjust_threshold_coin', '1000', '资产类人工调整免审批阈值（|delta|超过则待审批）'),
      ('adjust_threshold_count', '10', '数量类（奖励/道具/惩罚）人工调整免审批阈值')`,
    `INSERT OR IGNORE INTO penalty_templates (id, name, rarity, spank_min, spank_max, spank_cap, description) VALUES
      (1, '木拍', 1, 1, 2,  500, '轻度惩罚'),
      (2, '藤条', 2, 3, 5,  300, '中度惩罚'),
      (3, '铁尺', 2, 8, 12, 300, '重度惩罚（与稀有度无关，Spank单独配置）'),
      (4, '戒尺', 3, 6, 10, 200, '较重惩罚'),
      (5, '乌木杖', 4, 12, 20, 100, '最重惩罚')`,
    `INSERT OR IGNORE INTO item_templates (id, name, rarity, category, action, action_value, mount_events, scope, auto_mount, priority, daily_limit, price, description) VALUES
      (1, '稳定爪',     1, 'game', 'rate_boost',  15, 'grab.before', 'grab', 1, 100, 5,  20, '本次下爪成功率+15%'),
      (2, '透视镜',     2, 'game', 'reveal',       1, 'grab.before', 'grab', 0, 100, 5,  30, '模糊显示娃娃内容（含隐蔽处）'),
      (3, '连败保险',   1, 'game', 'insurance',   30, 'grab.before', 'grab', 1, 200, 3,  15, '连败3次后下次下爪成功率+30%，生效即消耗'),
      (4, '换机券',     2, 'game', 'reroll',       1, '',            'grab', 0, 100, 3,  25, '免费主动重铺1次'),
      (5, 'Nudge次数包',2, 'game', 'nudge_pack',   3, '',            'slot', 0, 100, 5,  30, 'Nudge可用次数+3，永久累计'),
      (6, 'Fever加速槽',2, 'game', 'fever_boost',  5, '',            'slot', 0, 100, 3,  40, 'Fever槽立即+5格')`,
    `INSERT OR IGNORE INTO item_templates (id, name, rarity, category, action, action_value, mount_events, scope, auto_mount, priority, daily_limit, price, description) VALUES
      (11, '减免券·普通', 1, 'clear', 'spank_reduce', 1,  '', 'all', 0, 100, 5, 10,  '减免1点Spank，目标自选（L1以内）'),
      (12, '减免券·精致', 2, 'clear', 'spank_reduce', 3,  '', 'all', 0, 100, 3, 30,  '减免3点Spank，目标自选（L2以内）'),
      (13, '消除券·华丽', 3, 'clear', 'spank_reduce', 6,  '', 'all', 0, 100, 3, 60,  '减免6点Spank，目标自选（L3以内）'),
      (14, '赦免券·鎏金', 4, 'clear', 'spank_reduce', 12, '', 'all', 0, 100, 1, 120, '减免12点Spank，目标自选（L4以内）')`,
    `INSERT OR IGNORE INTO reward_templates (id, name, rarity, kind, value, stock, description) VALUES
      (1, '奶茶券',       1, 'coupon',   15, -1, '奶茶一杯'),
      (2, '视频会员月卡', 2, 'member',   25, 10, '视频平台会员一个月'),
      (3, '电影票',       3, 'physical', 50, 5,  '电影票一张（实物）')`,
    `INSERT OR IGNORE INTO fragment_recipes (target_type, target_id, pieces_required) VALUES
      ('item',   13, 5),
      ('item',   14, 7),
      ('reward', 3,  5)`,
  ]
  await DB.batch(seeds.map(sql => DB.prepare(sql)))
}
