-- ToolJob 产出指标（MQ-01 度量闭环）
--
-- ## 这个迁移解决什么
--
-- 此前 `tool_job` 只有 `output_files`（文件 id 列表），**没有任何产出指标**：
-- 压缩率、分辨率、时长、页数、字数全都不可见，结果页只能显示「共 N 个产物」。
--
-- 后果不是"信息少"，而是**劣质产物无法被发现**：
--   · 图片"压完比原图还大"、视频落到低质量编码器、文档只有 800 字、
--     PPT 每页空得只剩标题 —— 这些在数据上与优质产物完全同形；
--   · 用户只能靠肉眼判断，排查时也没有依据可查。
--
-- 这是"成功但劣质"能长期存在的根本原因，所以它是后续所有质量改进的度量基座。
--
-- ## 三个字段的分工
--
--   result        产出指标（JSON）：体积前后、分辨率、时长、页数、字数、编码器等。
--                 结构定义在 `apps/api/src/modules/job/job-result.ts`。
--   quality_score 质量分（0-100）：只有 AI 类产出有（文档/PPT/图表），其余为 NULL。
--                 评分器在 `packages/core/src/quality`，与提示词、CI 闸门同源。
--   quality_issues 扣分项（JSON 数组，人类可读）：如 ["篇幅不足：1800/3000 字"]。
--
-- ## 为什么 result 用 JSON 而不是给每个指标开一列
--
-- 各工具的产出指标形状差异极大（图片看体积与分辨率、视频看时长与编码器、
-- PPT 看页数与版式种类），开列会让 tool_job 随着工具增加不断加宽，
-- 且大多数列为 NULL。指标是**产物的属性**，不是作业的标识，用 JSON 更合适。
-- 需要按指标查询时再从 JSON 里抽，而不是提前把所有工具的形状假设进表结构。

-- ⚠️ 生产库是 MySQL 5.7.44（与服务器上既有项目共用），而 **8.0.13 之前
--    JSON 列不允许有默认值**（MySQL 官方 Data Type Defaults 明文）。
--    原先这里写的是 `JSON NOT NULL DEFAULT ('{}')`，在 5.7 上执行会直接中止迁移，
--    API 起不来。故去掉列级 DEFAULT。
--    功能不受影响：Prisma schema 里的 `@default("{}")` / `@default("[]")`
--    本来就由**应用层**补值（Prisma 对 MySQL 的 JSON 默认值不下发到 DDL），
--    所以去掉 DDL 默认值后，写入路径仍然带默认值。
--    ⚠️ 改本文件会改变迁移 checksum；生产是全新库（无 `_prisma_migrations` 记录）不受影响，
--       本地开发库由 `prisma db push` 建表、同样没有迁移记录，故也不会触发 checksum 冲突。
ALTER TABLE `tool_job`
  ADD COLUMN `result` JSON NOT NULL COMMENT '产出指标：体积/分辨率/时长/页数/字数等',
  ADD COLUMN `quality_score` INT NULL COMMENT 'AI 产出的质量分（0-100），非 AI 工具为 NULL',
  ADD COLUMN `quality_issues` JSON NOT NULL COMMENT '质量扣分项（人类可读）';