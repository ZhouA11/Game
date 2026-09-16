-- 按用户定义的转盘次数：奖励/惩罚转盘分开设置
-- NULL = 跟随全局 wheel_settings.spin_limit_per_user；0 = 不限；正整数 = 具体次数
CREATE TABLE IF NOT EXISTS user_wheel_limits (
  username TEXT PRIMARY KEY,
  reward_limit INTEGER,
  penalty_limit INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
