-- 资产变更记录日志
CREATE TABLE IF NOT EXISTS asset_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_asset_logs_user ON asset_logs(username, created_at);

-- 一次性数据修正：历史上转盘惩罚把次数 N 写在描述里（如“转盘惩罚 100下”），
-- 现改为数量 = 原数量 × N，并清空描述
UPDATE penalties
SET quantity = quantity * CAST(REPLACE(SUBSTR(REPLACE(description, ' ', ''), 5), '下', '') AS INTEGER),
    description = ''
WHERE REPLACE(description, ' ', '') LIKE '转盘惩罚%下'
  AND REPLACE(SUBSTR(REPLACE(description, ' ', ''), 5), '下', '') GLOB '[0-9]*';
