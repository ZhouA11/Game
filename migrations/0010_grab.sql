-- ============================================================
-- 0010：步骤2 · 抓娃娃
-- 机器布局（内容铺场预生成）、玩家游戏状态（幸运值/保底/重铺计数）、
-- 抓取与重铺流水、抓娃娃掉落池种子（四选项=L1~L4四池）
-- 说明：开发指令书 01-常驻上下文.md 未随附附录A种子配置，
--       本文件按 §3.1 内容倾向自行设计种子，并用蒙特卡洛校准整机返还率至 87%±3
-- ============================================================

-- ---------- 机器与娃娃 ----------
CREATE TABLE IF NOT EXISTS grab_machines (
  id TEXT PRIMARY KEY,
  dolls_left INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 娃娃：铺场时内容预生成落库（T2.5），开娃只读取
CREATE TABLE IF NOT EXISTS grab_dolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  rarity INTEGER NOT NULL,
  size REAL NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_machine',      -- in_machine / taken
  taken_by TEXT,
  taken_source TEXT,                               -- grab / hand_slip
  taken_at DATETIME,
  -- 预生成内容（开娃只读）
  ref_type TEXT NOT NULL,                          -- coin/item/reward/penalty/fragment
  ref_id INTEGER,
  amount REAL,
  spanks INTEGER,
  -- 保底内容：惩罚连败≥3时的必出奖励（同为铺场时预生成，保持"开娃不掷骰"）
  pity_ref_type TEXT,
  pity_ref_id INTEGER,
  pity_amount REAL,
  pity_spanks INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_grab_dolls_machine ON grab_dolls(machine_id, status);

-- ---------- 玩家游戏状态（PlayerDO 职责的持久化形态） ----------
CREATE TABLE IF NOT EXISTS player_game_state (
  username TEXT NOT NULL,
  game TEXT NOT NULL,
  luck INTEGER NOT NULL DEFAULT 0,                 -- 幸运值：每次下爪+1（含失败），满100下次重铺插L3+表层娃娃
  penalty_streak INTEGER NOT NULL DEFAULT 0,       -- 惩罚连败（跨机位累计）：≥3时下爪必出奖励（用铺场预生成的保底内容）
  fail_streak INTEGER NOT NULL DEFAULT 0,          -- 抓取连败（连败保险道具生效条件）
  reroll_date TEXT NOT NULL DEFAULT '',            -- 主动重铺计数日期（北京时间）
  reroll_count INTEGER NOT NULL DEFAULT 0,         -- 当日主动重铺次数（付费+换机券合计，上限50）
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, game)
);

-- ---------- 流水（可对账可回放，G5） ----------
CREATE TABLE IF NOT EXISTS grab_grabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  doll_id INTEGER NOT NULL,
  rarity INTEGER NOT NULL,
  success INTEGER NOT NULL,
  hand_slip INTEGER NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  ref_type TEXT DEFAULT '',
  ref_id INTEGER,
  amount REAL,
  spanks INTEGER,
  effects TEXT DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grab_rerolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  mode TEXT NOT NULL,                              -- free_empty / coin / coupon
  cost REAL NOT NULL DEFAULT 0,
  coupon_item_id INTEGER,
  luck_inserted INTEGER NOT NULL DEFAULT 0,
  dolls INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- 抓娃娃参数 ----------
INSERT OR IGNORE INTO kernel_params (key, value, note) VALUES
  ('grab_reroll_cost', '30', '主动重铺费用（金币）'),
  ('grab_reroll_daily_limit', '50', '主动重铺每日上限（付费+换机券合计）'),
  ('grab_dolls_per_layout', '12', '每次铺场的娃娃数量'),
  ('grab_hand_slip_rate', '0.3', '抓取失败时手滑bonus概率'),
  ('grab_luck_max', '100', '幸运值上限（满值后下次重铺插入L3+表层娃娃）');

-- ---------- T2.9 收藏外观种子（G16：只能由抓娃娃掉落，严禁上架商城） ----------
INSERT OR IGNORE INTO item_templates (id, name, rarity, category, action, action_value, mount_events, scope, auto_mount, priority, price, description) VALUES
  (21, '娃娃皮肤·奶黄',     1, 'appearance', 'collect', 0, '', 'all', 0, 100, 10,  '娃娃机常见款皮肤'),
  (22, '娃娃皮肤·粉红豹',   2, 'appearance', 'collect', 0, '', 'all', 0, 100, 20,  '人气款皮肤'),
  (23, '头像框·星光',       3, 'appearance', 'collect', 0, '', 'all', 0, 100, 40,  '华丽头像框'),
  (24, '娃娃皮肤·鎏金凤凰', 4, 'appearance', 'collect', 0, '', 'all', 0, 100, 100, '鎏金限定皮肤，仅华丽/鎏金池掉落'),
  (25, '头像框·鎏金王冠',   4, 'appearance', 'collect', 0, '', 'all', 0, 100, 80,  '鎏金限定头像框，仅鎏金池掉落');

-- ---------- T2.8 掉落池四选项种子（game='grab'，选项=L1/L2/L3/L4 四池） ----------
-- 权重经蒙特卡洛校准（30000次下爪，整机返还率≈87%，设计值87%，允许80%~90%）
-- L1 普通池：小奖为主、小惩罚（期望价值≈6.9）
INSERT OR IGNORE INTO drop_pools (id, game, option, side, ref_type, ref_id, amount, weight) VALUES
  (1,  'grab', 'L1', 'reward',  'coin',      NULL, 4,  30),
  (2,  'grab', 'L1', 'reward',  'coin',      NULL, 6,  20),
  (3,  'grab', 'L1', 'reward',  'coin',      NULL, 10, 10),
  (4,  'grab', 'L1', 'reward',  'coin',      NULL, 12, 6),
  (5,  'grab', 'L1', 'penalty', 'penalty',   1,    NULL, 12),  -- 木拍 +1~2 Spank
  (6,  'grab', 'L1', 'reward',  'item',      1,    NULL, 5),   -- 稳定爪
  (7,  'grab', 'L1', 'reward',  'item',      3,    NULL, 4),   -- 连败保险
  (8,  'grab', 'L1', 'reward',  'item',      21,   NULL, 3),   -- 娃娃皮肤·奶黄（外观）
-- L2 精致池：中等奖惩、掉华丽碎片（期望价值≈11.4）
  (9,  'grab', 'L2', 'reward',  'coin',      NULL, 9,  20),
  (10, 'grab', 'L2', 'reward',  'coin',      NULL, 12, 12),
  (11, 'grab', 'L2', 'reward',  'coin',      NULL, 22, 6),
  (12, 'grab', 'L2', 'penalty', 'penalty',   2,    NULL, 14),  -- 藤条 +3~5
  (13, 'grab', 'L2', 'penalty', 'penalty',   3,    NULL, 8),   -- 铁尺 +8~12
  (14, 'grab', 'L2', 'reward',  'item',      2,    NULL, 4),   -- 透视镜
  (15, 'grab', 'L2', 'reward',  'item',      4,    NULL, 4),   -- 换机券
  (16, 'grab', 'L2', 'reward',  'item',      5,    NULL, 3),   -- Nudge次数包
  (17, 'grab', 'L2', 'reward',  'fragment',  1,    NULL, 6),   -- 华丽碎片（消除券·华丽）
  (18, 'grab', 'L2', 'reward',  'item',      22,   NULL, 3),   -- 娃娃皮肤·粉红豹（外观）
-- L3 华丽池：大奖大惩并存、掉华丽碎片与外观（期望价值≈17.8）
  (19, 'grab', 'L3', 'reward',  'coin',      NULL, 25, 12),
  (20, 'grab', 'L3', 'reward',  'coin',      NULL, 40, 4),
  (21, 'grab', 'L3', 'penalty', 'penalty',   4,    NULL, 20),  -- 戒尺 +6~10
  (22, 'grab', 'L3', 'reward',  'item',      13,   NULL, 3),   -- 消除券·华丽
  (23, 'grab', 'L3', 'reward',  'item',      6,    NULL, 3),   -- Fever加速槽
  (24, 'grab', 'L3', 'reward',  'fragment',  1,    NULL, 8),   -- 华丽碎片（消除券·华丽）
  (25, 'grab', 'L3', 'reward',  'fragment',  3,    NULL, 6),   -- 华丽碎片（电影票）
  (26, 'grab', 'L3', 'reward',  'item',      23,   NULL, 3),   -- 头像框·星光（外观）
-- L4 鎏金池：现实奖励与重惩罚并存、掉鎏金碎片与限定外观（期望价值≈35.8）
  (27, 'grab', 'L4', 'reward',  'coin',      NULL, 45,  6),
  (28, 'grab', 'L4', 'reward',  'coin',      NULL, 80,  2),
  (29, 'grab', 'L4', 'reward',  'coin',      NULL, 150, 1),
  (30, 'grab', 'L4', 'penalty', 'penalty',   5,    NULL, 14),  -- 乌木杖 +12~20
  (31, 'grab', 'L4', 'reward',  'item',      14,   NULL, 3),   -- 赦免券·鎏金
  (32, 'grab', 'L4', 'reward',  'fragment',  2,    NULL, 6),   -- 鎏金碎片（赦免券·鎏金）
  (33, 'grab', 'L4', 'reward',  'reward',    3,    NULL, 2),   -- 电影票（现实奖励）
  (34, 'grab', 'L4', 'reward',  'item',      24,   NULL, 2),   -- 娃娃皮肤·鎏金凤凰（限定外观）
  (35, 'grab', 'L4', 'reward',  'item',      25,   NULL, 2);   -- 头像框·鎏金王冠（限定外观）

-- 四池奖惩总控概率：惩罚侧占比随稀有度递增（高稀有度池大奖大惩并存）
INSERT OR IGNORE INTO drop_side_controls (game, option, reward_side_prob, penalty_side_prob) VALUES
  ('grab', 'L1', 0.88, 0.12),
  ('grab', 'L2', 0.75, 0.25),
  ('grab', 'L3', 0.65, 0.35),
  ('grab', 'L4', 0.62, 0.38);

-- 默认抓娃娃机
INSERT OR IGNORE INTO grab_machines (id, dolls_left) VALUES ('grab-1', 0);
