-- ============================================================
-- 0012：步骤4 · 单人彩池（G18：全部按玩家维度持久化，禁止全局共享）
-- ============================================================

-- 彩池参数（T4.2/T4.3：入池比例与种子后台可配）
INSERT OR IGNORE INTO kernel_params (key, value, note) VALUES
  ('pool_rate', '5', '每次付费spin按费用比例入池（%）'),
  ('pool_seed', '5000', '新玩家彩池初始种子值（币）/ 出奖后重置值');

-- 玩家彩池状态（每玩家一行，amount = 当前池额）
CREATE TABLE IF NOT EXISTS pool_state (
  username TEXT PRIMARY KEY,
  amount REAL NOT NULL DEFAULT 0,
  last_payout REAL,
  last_payout_spin INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 彩池账本（G5：入池/种子/出奖全链条可对账，任意时刻 Σdelta = 当前池额）
CREATE TABLE IF NOT EXISTS pool_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  delta REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,                        -- seed / deposit / payout / reseed
  ref TEXT DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pool_ledger_user ON pool_ledger(username, id);
