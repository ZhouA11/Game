-- ============================================================
-- 0011：步骤3 · 老虎机
-- 单行配置（符号带/赔率/转轮概率，步骤6后台可改）、玩家老虎机状态、
-- spin记录（steps[]全模拟+seed可重放）、后置交互预生成（追猴/转轮）
-- ============================================================

-- 配置（G17：概率与赔率后台可配；本步为种子配置）
CREATE TABLE IF NOT EXISTS slot_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 玩家老虎机状态（PlayerDO 职责的持久化形态）
CREATE TABLE IF NOT EXISTS slot_state (
  username TEXT PRIMARY KEY,
  fever_slot INTEGER NOT NULL DEFAULT 0,        -- Fever槽（0~12）
  fever_active INTEGER NOT NULL DEFAULT 0,      -- Fever进行中
  fever_left INTEGER NOT NULL DEFAULT 0,        -- Fever剩余免费连转次数
  fever_mult_idx INTEGER NOT NULL DEFAULT 0,    -- Fever期间倍率不重置（跨spin延续）
  free_date TEXT NOT NULL DEFAULT '',           -- 每日免费转日期
  free_left INTEGER NOT NULL DEFAULT 0,         -- 当日免费转剩余（每日登录送5次）
  nudge_date TEXT NOT NULL DEFAULT '',
  nudge_left INTEGER NOT NULL DEFAULT 0,        -- 当日Nudge剩余（每日3次）
  no_win_streak INTEGER NOT NULL DEFAULT 0,     -- 连续无中奖次数（15次保底）
  hold_active INTEGER NOT NULL DEFAULT 0,       -- 下轮保留指定1轴的权利
  last_spin_id INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- spin 记录（steps[]全模拟落库；seed可重放；回放/断线恢复）
CREATE TABLE IF NOT EXISTS slot_spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  seed INTEGER NOT NULL,
  free_type TEXT NOT NULL DEFAULT 'paid',       -- paid / free_daily / fever
  fee REAL NOT NULL DEFAULT 0,
  hold_reel INTEGER,                            -- 本轮使用的保留轴（NULL=未用）
  positions TEXT NOT NULL,                      -- 各轴停止位置JSON
  grid TEXT NOT NULL,                           -- 初始盘面JSON
  steps TEXT NOT NULL,                          -- 完整爆裂模拟序列JSON
  total_payout REAL NOT NULL DEFAULT 0,
  fragments TEXT NOT NULL DEFAULT '[]',
  monkey INTEGER NOT NULL DEFAULT 0,            -- 触发追猴小剧场
  wheel INTEGER NOT NULL DEFAULT 0,             -- 触发幸运转轮
  jackpot_hit INTEGER NOT NULL DEFAULT 0,       -- Jackpot 5连（彩池触发预留，步骤4实现账本）
  nudged INTEGER NOT NULL DEFAULT 0,            -- 该轮是否已使用 Nudge（每轮限一次）
  idempotency_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 后置交互预生成（T3.12：全部分支 spin 时预生成落库，选择后只揭示）
CREATE TABLE IF NOT EXISTS slot_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  spin_id INTEGER NOT NULL,
  type TEXT NOT NULL,                           -- monkey / wheel
  payload TEXT NOT NULL,                        -- 预生成全分支JSON
  status TEXT NOT NULL DEFAULT 'pending',       -- pending / resolved
  choice TEXT,
  result TEXT,
  idempotency_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_slot_pending_user ON slot_pending(username, status);

-- ---------- 种子配置 ----------
INSERT OR IGNORE INTO slot_config (id, config) VALUES (1, '{
  "pays": {"cherry":[1,3,8],"lemon":[1,4,10],"bell":[3,8,20],"diamond":[5,15,45],"wild":[10,10,10]},
  "weights": {"cherry":22,"lemon":20,"bell":16,"diamond":12,"wild":5,"monkey":8,"fortune":4,"jackpot":1,"empty":12},
  "feverWeights": {"cherry":22,"lemon":20,"bell":16,"diamond":12,"wild":10,"monkey":0,"fortune":4,"jackpot":1,"empty":15},
  "payScale": 0.6,
  "wheel": [
    {"type":"reward","label":"现实奖励·中额","value":50,"prob":2},
    {"type":"coin","label":"100币","value":100,"prob":6},
    {"type":"coin_range","label":"金币20~50","min":20,"max":50,"prob":28},
    {"type":"fragment","label":"华丽碎片","rarity":3,"prob":10},
    {"type":"fever","label":"Fever+5格","value":5,"prob":25},
    {"type":"nudge","label":"Nudge×2","value":2,"prob":16},
    {"type":"none","label":"谢谢参与","prob":13}
  ],
  "fragment": {"d3":6,"d4":18,"d5":33,"loyal":9},
  "fever": {"slotMax":12,"spins":8},
  "holdProb": 30,
  "nudgeDaily": 3,
  "freeDaily": 5,
  "pity": {"streak":15,"payMin":30,"payMax":80}
}');
