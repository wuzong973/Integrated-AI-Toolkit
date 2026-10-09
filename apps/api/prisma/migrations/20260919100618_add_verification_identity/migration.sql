-- 认证申请补充身份字段（M3-02 服务者入驻）
--
-- 加这四列的原因：审核要看到的是"**这次提交的**是谁"，而不是"这个账号现在填的是谁"。
-- 用户事后改了资料，历史申请记录不能跟着变 —— 否则"当初凭什么通过的"就再也说不清了。
-- `school_id` 刻意**不做外键**：学校被删掉时，这条申请记录必须留下。
ALTER TABLE `verification` ADD COLUMN `college` VARCHAR(60) NULL,
    ADD COLUMN `real_name` VARCHAR(40) NULL,
    ADD COLUMN `school_id` CHAR(36) NULL,
    ADD COLUMN `student_no` VARCHAR(30) NULL;

-- ⚠️⚠️ 这里**故意删掉了 `prisma migrate dev` 自动生成的 `DROP TABLE search_index`。⚠️⚠️
--
-- 原因：`search_index` 是 `20260919120000_add_search_index` 用**手写 SQL** 建的
-- （它需要 `FULLTEXT ... WITH PARSER ngram`，而 Prisma schema 表达不了 ngram 解析器），
-- 且**没有**在 `schema.prisma` 里声明模型。于是 Prisma 把它当成"数据库里多出来的表"，
-- 每次 `migrate dev` 都会生成一条 `DROP TABLE search_index`。
--
-- 直接执行那条语句的后果：**M4-07 的中文全文检索会静默失效** ——
-- 表没了，`MysqlFulltextSearchProvider` 的查询会报错或永远返回空，
-- 而"搜不出东西"看起来像"还没建索引"，不像"表被删了"。
--
-- 后续任何人重新生成迁移时，**必须同样手工删掉这条 DROP**。
-- 根治办法见 `schema.prisma` 末尾关于 `search_index` 的说明。
