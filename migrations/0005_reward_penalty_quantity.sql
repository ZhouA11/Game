-- 奖励/惩罚增加数量字段
ALTER TABLE rewards ADD COLUMN quantity INTEGER DEFAULT 1;
ALTER TABLE penalties ADD COLUMN quantity INTEGER DEFAULT 1;

-- 合并历史同类项：每组 username+name 保留最新一行，数量/价值/金额累加，其余行删除
UPDATE rewards SET
  quantity = (SELECT COALESCE(SUM(r2.quantity), 0) FROM rewards r2 WHERE r2.username = rewards.username AND r2.name = rewards.name),
  value = (SELECT COALESCE(SUM(r2.value), 0) FROM rewards r2 WHERE r2.username = rewards.username AND r2.name = rewards.name)
WHERE id IN (SELECT MAX(id) FROM rewards GROUP BY username, name);
DELETE FROM rewards WHERE id NOT IN (SELECT MAX(id) FROM rewards GROUP BY username, name);

UPDATE penalties SET
  quantity = (SELECT COALESCE(SUM(p2.quantity), 0) FROM penalties p2 WHERE p2.username = penalties.username AND p2.name = penalties.name),
  amount = (SELECT COALESCE(SUM(p2.amount), 0) FROM penalties p2 WHERE p2.username = penalties.username AND p2.name = penalties.name)
WHERE id IN (SELECT MAX(id) FROM penalties GROUP BY username, name);
DELETE FROM penalties WHERE id NOT IN (SELECT MAX(id) FROM penalties GROUP BY username, name);
