-- ============================================================
-- 0015：步骤7 · 碎片掉率校准（T7.3）
-- 基准活跃度：每日 30 次下爪 + 50 次 spin
-- 复算结论（见 test/final.test.js）：
--   鎏金碎片原掉率过低（周期>90天），上调 L4 池鎏金碎片权重 6→20 → 周期≈32天（3~5周✓）
--   华丽碎片主导项为 Fever 结束保底（步骤3规范数值，不可调），
--   下调抓娃娃华丽碎片权重使非 Fever 贡献最小化（详见汇报）
-- 同步调整后整机返还率仍在目标区间（抓娃娃 ~82.6% / 老虎机 94.12%）
-- ============================================================

UPDATE drop_pools SET weight = 2, updated_at = datetime('now')
WHERE game = 'grab' AND option = 'L2' AND ref_type = 'fragment' AND ref_id = 1;

UPDATE drop_pools SET weight = 3, updated_at = datetime('now')
WHERE game = 'grab' AND option = 'L3' AND ref_type = 'fragment' AND ref_id = 1;

UPDATE drop_pools SET weight = 2, updated_at = datetime('now')
WHERE game = 'grab' AND option = 'L3' AND ref_type = 'fragment' AND ref_id = 3;

UPDATE drop_pools SET weight = 20, updated_at = datetime('now')
WHERE game = 'grab' AND option = 'L4' AND ref_type = 'fragment' AND ref_id = 2;
