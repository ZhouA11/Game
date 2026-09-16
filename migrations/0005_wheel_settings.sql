-- 转盘全局设置：每用户可转次数（0 = 不限）
CREATE TABLE IF NOT EXISTS wheel_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spin_limit_per_user INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO wheel_settings (id, spin_limit_per_user) VALUES (1, 0);
