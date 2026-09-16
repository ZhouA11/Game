-- 转盘次数重置偏移：管理员重置后，统计有效次数时跳过此前历史记录
CREATE TABLE IF NOT EXISTS wheel_spin_resets (
  username TEXT NOT NULL,
  wheel_type TEXT NOT NULL,
  reset_offset INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, wheel_type)
);
