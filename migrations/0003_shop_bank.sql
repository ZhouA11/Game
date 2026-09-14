-- 奖励类型添加上架字段
ALTER TABLE reward_types ADD COLUMN shop_enabled INTEGER DEFAULT 0;

-- 惩罚类型添加上架字段
ALTER TABLE penalty_types ADD COLUMN shop_enabled INTEGER DEFAULT 0;

-- 商品添加上架字段
ALTER TABLE products ADD COLUMN shop_enabled INTEGER DEFAULT 0;

-- 贷款配置表
CREATE TABLE IF NOT EXISTS loan_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  max_amount REAL NOT NULL DEFAULT 10000,
  max_term_days INTEGER NOT NULL DEFAULT 30,
  interest_rate REAL NOT NULL DEFAULT 0.05,
  overdue_penalty_rate REAL NOT NULL DEFAULT 0.01,
  daily_penalty_rate REAL NOT NULL DEFAULT 0.01,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 插入默认贷款配置
INSERT INTO loan_config (max_amount, max_term_days, interest_rate, overdue_penalty_rate, daily_penalty_rate)
VALUES (10000, 30, 0.05, 0.01, 0.01);

-- 贷款记录表
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  amount REAL NOT NULL,
  interest_rate REAL NOT NULL,
  term_days INTEGER NOT NULL,
  total_repay REAL NOT NULL,
  remaining REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  applied_at TEXT DEFAULT (datetime('now')),
  due_date TEXT NOT NULL,
  repaid_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (username) REFERENCES users(username)
);

-- 奖励兑换记录表
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  reward_type_id INTEGER,
  reward_name TEXT NOT NULL,
  price REAL NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  redeemed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (username) REFERENCES users(username),
  FOREIGN KEY (reward_type_id) REFERENCES reward_types(id)
);

-- 惩罚消除记录表
CREATE TABLE IF NOT EXISTS penalty_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  penalty_type_id INTEGER,
  penalty_name TEXT NOT NULL,
  price REAL NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  paid_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (username) REFERENCES users(username),
  FOREIGN KEY (penalty_type_id) REFERENCES penalty_types(id)
);