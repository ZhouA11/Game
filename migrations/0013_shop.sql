-- ============================================================
-- 0013：步骤5 · 商店（只卖道具）与购买限购
-- ============================================================

-- 商品（G13/G14：只卖道具；每商品独立币种与价格）
CREATE TABLE IF NOT EXISTS shop_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,                     -- 引用 item_templates（game / clear 两类）
  currency TEXT NOT NULL DEFAULT 'coin',        -- coin / activity（G14 币种可配）
  price REAL NOT NULL,
  daily_limit INTEGER,                          -- 限购（次/日；NULL=取道具模板 daily_limit）
  is_active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 100,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 每日限购计数
CREATE TABLE IF NOT EXISTS shop_purchases (
  username TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, product_id, day)
);

-- 商品种子（§3.1：游戏道具 15~150 币、5/日；减免券按稀有度定价带、L4 最严 1/日）
-- 减免券定价 = 减免量 × reduce_unit_price(10)：10/30/60/120，均在定价带内
INSERT OR IGNORE INTO shop_products (id, item_id, currency, price, daily_limit, is_active, sort) VALUES
  (1,  1,  'coin', 20,  5, 1, 10),    -- 稳定爪
  (2,  2,  'coin', 30,  5, 1, 20),    -- 透视镜
  (3,  3,  'coin', 15,  5, 1, 30),    -- 连败保险
  (4,  4,  'coin', 25,  5, 1, 40),    -- 换机券
  (5,  5,  'coin', 30,  5, 1, 50),    -- Nudge次数包
  (6,  6,  'coin', 40,  5, 1, 60),    -- Fever加速槽
  (7,  11, 'coin', 10,  5, 1, 70),    -- 减免券·普通（L1，-1）
  (8,  12, 'coin', 30,  3, 1, 80),    -- 减免券·精致（L2，-3）
  (9,  13, 'coin', 60,  3, 1, 90),    -- 消除券·华丽（L3，-6）
  (10, 14, 'coin', 120, 1, 1, 100),   -- 赦免券·鎏金（L4，-12）
  (11, 5,  'activity', 30, 5, 1, 110); -- Nudge次数包（活跃值版：活跃值出口，G14）
