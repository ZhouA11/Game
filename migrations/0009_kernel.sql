-- ============================================================
-- 0009：互通内核（步骤1）
-- 稀有度主轴 / 三类模板库 / 掉落池引用 / 碎片配方 / 统一账本 /
-- Spank计数 / 奖励背包 / 道具库存 / 人工调整与审计 / 幂等 / 配置版本
-- 全部语句幂等，可安全重复执行
-- ============================================================

-- G6/G12：资产仅金币（沿用 users.balance）与活跃值（新增列）
ALTER TABLE users ADD COLUMN activity REAL NOT NULL DEFAULT 0;

-- ---------- T1.1 稀有度主轴（L1~L4；等级不可删除/重命名，仅可调派生参数） ----------
CREATE TABLE IF NOT EXISTS rarity_levels (
  level INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  field_weight REAL NOT NULL DEFAULT 0,   -- 铺场权重
  price_min REAL NOT NULL DEFAULT 0,      -- 定价带下限
  price_max REAL NOT NULL DEFAULT 0,      -- 定价带上限
  drop_weight REAL NOT NULL DEFAULT 0,    -- 掉落权重基准(%)
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO rarity_levels (level, name, field_weight, price_min, price_max, drop_weight) VALUES
  (1, '普通', 0.60, 5,   40,  60),
  (2, '精致', 0.25, 15,  80,  25),
  (3, '华丽', 0.12, 50,  150, 12),
  (4, '鎏金', 0.03, 120, 400, 3);

-- ---------- 全局参数（G1 游玩费用 / 减免单位折算价 / 调整审批阈值） ----------
CREATE TABLE IF NOT EXISTS kernel_params (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  note TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO kernel_params (key, value, note) VALUES
  ('play_cost_coin', '10', '单次游玩费用（金币，后台可配）'),
  ('reduce_unit_price', '10', '减免单位折算价（仅用于定价校验，不参与结算）'),
  ('adjust_threshold_coin', '1000', '资产类人工调整免审批阈值（|delta|超过则待审批）'),
  ('adjust_threshold_count', '10', '数量类（奖励/道具/惩罚）人工调整免审批阈值');

-- ---------- T1.2 奖励模板（现实世界奖励，含库存；G8 严禁上架商城） ----------
CREATE TABLE IF NOT EXISTS reward_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rarity INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'coupon',      -- coupon券码 / member会员 / physical实物 / platform平台券
  value REAL NOT NULL DEFAULT 0,            -- 折算价值（参考定价带）
  stock INTEGER NOT NULL DEFAULT -1,        -- 库存：-1=无限；0时掉落自动跳过
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- T1.2 惩罚道具模板（G11 Spank计数模型；Spank与稀有度无关） ----------
CREATE TABLE IF NOT EXISTS penalty_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rarity INTEGER NOT NULL DEFAULT 1,
  spank_min INTEGER NOT NULL DEFAULT 1,     -- 单次施加Spank数量下限
  spank_max INTEGER NOT NULL DEFAULT 1,     -- 单次施加Spank数量上限
  spank_cap INTEGER NOT NULL DEFAULT 999,   -- 单玩家在该道具上的累计上限
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- T1.2 道具模板（game游戏类 / clear减免类 / appearance收藏外观） ----------
CREATE TABLE IF NOT EXISTS item_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rarity INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL DEFAULT 'game',    -- game / clear / appearance
  action TEXT NOT NULL DEFAULT '',          -- 预置动作类型，见 kernel/resolver.js ITEM_ACTIONS
  action_value REAL DEFAULT 0,              -- 效果数值
  mount_events TEXT DEFAULT '',             -- 挂载点（逗号分隔），见 kernel/resolver.js MOUNT_EVENTS
  scope TEXT NOT NULL DEFAULT 'all',        -- all / grab / slot
  auto_mount INTEGER NOT NULL DEFAULT 0,    -- 是否默认自动挂载（减免类一律0=手动）
  priority INTEGER NOT NULL DEFAULT 100,    -- 优先级，数值小者先应用
  daily_limit INTEGER,                      -- 限购基准（次/日，空=不限），商店用（步骤5）
  price REAL,                               -- 商城参考价（受定价带与减免折算价约束，商店用）
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- T1.3 掉落池引用（模板ID+权重；ref_type 五类：金币/道具/奖励/惩罚/碎片） ----------
CREATE TABLE IF NOT EXISTS drop_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,                       -- 游戏标识（步骤2~4填入：grab/slot/wheel等）
  option TEXT NOT NULL DEFAULT 'default',   -- 游戏内选项
  side TEXT NOT NULL DEFAULT 'reward',      -- reward奖励侧 / penalty惩罚侧
  ref_type TEXT NOT NULL,                   -- coin / item / reward / penalty / fragment
  ref_id INTEGER,                           -- 模板ID或配方ID（coin类为NULL）
  amount REAL,                              -- coin类的金币数量
  weight REAL NOT NULL DEFAULT 1,           -- 权重
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_drop_pools_game ON drop_pools(game, option, side);

-- 奖励侧/惩罚侧总控概率（按游戏+选项；两者按权重归一化决定落侧）
CREATE TABLE IF NOT EXISTS drop_side_controls (
  game TEXT NOT NULL,
  option TEXT NOT NULL DEFAULT 'default',
  reward_side_prob REAL NOT NULL DEFAULT 0.5,
  penalty_side_prob REAL NOT NULL DEFAULT 0.5,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game, option)
);

-- 0库存掉落跳过计数（§2.3 库存为0自动跳过并记录次数）
CREATE TABLE IF NOT EXISTS drop_skip_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  option TEXT NOT NULL DEFAULT 'default',
  entry_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- T1.4 碎片配方（L3目标5片、L4目标7片；碎片绑定唯一合成目标） ----------
CREATE TABLE IF NOT EXISTS fragment_recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                -- item / reward
  target_id INTEGER NOT NULL,               -- 模板ID
  pieces_required INTEGER NOT NULL,         -- 服务端按目标稀有度强制：L3=5、L4=7
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS player_fragments (
  username TEXT NOT NULL,
  recipe_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, recipe_id)
);

-- ---------- 道具库存（含自动挂载开关：NULL=跟随模板默认） ----------
CREATE TABLE IF NOT EXISTS player_items (
  username TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  auto_mount INTEGER,                       -- NULL=默认 / 1=开 / 0=关
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, item_id)
);

-- ---------- T1.6 Spank累计（按 玩家×惩罚道具 分别累计；不做惩罚结算） ----------
CREATE TABLE IF NOT EXISTS player_spanks (
  username TEXT NOT NULL,
  penalty_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, penalty_id)
);

-- Spank写入来源只有三种：game_drop游戏掉落 / player_reduce玩家减免 / admin_adjust后台调整
CREATE TABLE IF NOT EXISTS spank_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  penalty_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,                   -- 正=施加，负=减免
  source TEXT NOT NULL,
  coupon_item_id INTEGER,                   -- 玩家减免时消耗的券
  admin TEXT DEFAULT '',                    -- 后台调整时的管理员
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_spank_logs_user ON spank_logs(username, created_at);

-- ---------- T1.8 奖励背包（游戏开出→入包→手动核销） ----------
CREATE TABLE IF NOT EXISTS player_reward_bag (
  username TEXT NOT NULL,
  reward_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending待核销
  source TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, reward_id, status)
);

-- ---------- 统一账本（G5/G12/G15：一切资产变动走 applyLedger，禁止直改 users） ----------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  currency TEXT NOT NULL,                   -- coin / activity
  delta REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT DEFAULT '',
  ref_id TEXT DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_by TEXT DEFAULT 'system',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(username, created_at);

-- ---------- G2 幂等记录（重复提交返回首次结果） ----------
CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL DEFAULT '',
  username TEXT DEFAULT '',
  response TEXT NOT NULL,                   -- 首次响应JSON快照
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- T1.5 Resolver效果流水（G5 可审计可回放） ----------
CREATE TABLE IF NOT EXISTS effect_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  game TEXT NOT NULL,
  event TEXT NOT NULL,                      -- 挂载点：grab.before / spin.before / penalty.before 等
  item_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  value REAL,
  detail TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- T1.7 后台人工调整（四类：coin/activity/reward/item/penalty；原因必填；超阈值待审批） ----------
CREATE TABLE IF NOT EXISTS admin_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,                   -- 被调整玩家
  target_type TEXT NOT NULL,                -- coin / activity / reward / item / penalty
  target_id INTEGER,                        -- 模板ID（reward/item/penalty时必填）
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending待审批 / applied已执行 / rejected已驳回
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  idempotency_key TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME
);

-- ---------- G5 配置变更审计 ----------
CREATE TABLE IF NOT EXISTS config_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                      -- rarity / param / reward_template / penalty_template / item_template / drop_pool / drop_control / fragment_recipe
  action TEXT NOT NULL,                     -- create / update / disable / delete
  target_id TEXT DEFAULT '',
  before TEXT DEFAULT '',                   -- 变更前JSON快照
  after TEXT DEFAULT '',                    -- 变更后JSON快照
  operator TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- G3 配置版本快照（数值配置变更时落快照，可回滚） ----------
CREATE TABLE IF NOT EXISTS config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 种子数据（固定ID，INSERT OR IGNORE 幂等；运营后续可在后台扩充）
-- ============================================================

-- 惩罚道具种子（§2.2 初始种子；Spank与稀有度不绑定）
INSERT OR IGNORE INTO penalty_templates (id, name, rarity, spank_min, spank_max, spank_cap, description) VALUES
  (1, '木拍', 1, 1, 2,  500, '轻度惩罚'),
  (2, '藤条', 2, 3, 5,  300, '中度惩罚'),
  (3, '铁尺', 2, 8, 12, 300, '重度惩罚（与稀有度无关，Spank单独配置）'),
  (4, '戒尺', 3, 6, 10, 200, '较重惩罚'),
  (5, '乌木杖', 4, 12, 20, 100, '最重惩罚');

-- 游戏类道具种子（§2.1 初始集；效果数值为初始值，后台可调）
INSERT OR IGNORE INTO item_templates (id, name, rarity, category, action, action_value, mount_events, scope, auto_mount, priority, daily_limit, price, description) VALUES
  (1, '稳定爪',     1, 'game', 'rate_boost',  15, 'grab.before', 'grab', 1, 100, 5,  20, '本次下爪成功率+15%'),
  (2, '透视镜',     2, 'game', 'reveal',       1, 'grab.before', 'grab', 0, 100, 5,  30, '模糊显示娃娃内容（含隐蔽处）'),
  (3, '连败保险',   1, 'game', 'insurance',   30, 'grab.before', 'grab', 1, 200, 3,  15, '连败3次后下次下爪成功率+30%，生效即消耗'),
  (4, '换机券',     2, 'game', 'reroll',       1, '',            'grab', 0, 100, 3,  25, '免费主动重铺1次'),
  (5, 'Nudge次数包',2, 'game', 'nudge_pack',   3, '',            'slot', 0, 100, 5,  30, 'Nudge可用次数+3，永久累计'),
  (6, 'Fever加速槽',2, 'game', 'fever_boost',  5, '',            'slot', 0, 100, 3,  40, 'Fever槽立即+5格');

-- 惩罚减免类道具种子（四档；一律手动使用；定价=减免量×减免单位折算价10，均在定价带内）
INSERT OR IGNORE INTO item_templates (id, name, rarity, category, action, action_value, mount_events, scope, auto_mount, priority, daily_limit, price, description) VALUES
  (11, '减免券·普通', 1, 'clear', 'spank_reduce', 1,  '', 'all', 0, 100, 5, 10,  '减免1点Spank，目标自选（L1以内）'),
  (12, '减免券·精致', 2, 'clear', 'spank_reduce', 3,  '', 'all', 0, 100, 3, 30,  '减免3点Spank，目标自选（L2以内）'),
  (13, '消除券·华丽', 3, 'clear', 'spank_reduce', 6,  '', 'all', 0, 100, 3, 60,  '减免6点Spank，目标自选（L3以内）'),
  (14, '赦免券·鎏金', 4, 'clear', 'spank_reduce', 12, '', 'all', 0, 100, 1, 120, '减免12点Spank，目标自选（L4以内）');

-- 奖励模板种子（G8 仅游戏产出，严禁上架商城）
INSERT OR IGNORE INTO reward_templates (id, name, rarity, kind, value, stock, description) VALUES
  (1, '奶茶券',       1, 'coupon',   15, -1, '奶茶一杯'),
  (2, '视频会员月卡', 2, 'member',   25, 10, '视频平台会员一个月'),
  (3, '电影票',       3, 'physical', 50, 5,  '电影票一张（实物）');

-- 碎片配方种子（L3目标5片、L4目标7片）
INSERT OR IGNORE INTO fragment_recipes (target_type, target_id, pieces_required) VALUES
  ('item',   13, 5),   -- 消除券·华丽（L3）
  ('item',   14, 7),   -- 赦免券·鎏金（L4）
  ('reward', 3,  5);   -- 电影票（L3）
