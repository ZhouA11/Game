-- ============================================================
-- 0014：步骤6 · 运营后台
-- 配置提审/发布流程（预发验证 → 全量发布 → 回滚）
-- ============================================================

CREATE TABLE IF NOT EXISTS config_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                          -- grab / slot / rarity
  payload TEXT NOT NULL,                        -- 配置快照JSON
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending待审批 / staging预发验证通过 / published已发布 / rolled_back已回滚
  rtp_result TEXT DEFAULT '',                   -- 提审/预发时的返还率三表JSON
  created_by TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME
);

-- 后台看板所需索引
CREATE INDEX IF NOT EXISTS idx_config_reviews_scope ON config_reviews(scope, status);
