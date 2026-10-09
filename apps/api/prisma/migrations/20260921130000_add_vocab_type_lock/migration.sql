-- AlterTable
-- 题型锁定：同一次学习里重试必须还是同一道题。
--
-- 背景：题型由「词 id + 复习轮次」纯函数决定，而每次提交都会推进复习轮次
-- （答对 +1、答错归零）→ 同一个词连续提交就会当场换题（拼写→听音→填空→选义）。
-- 表现是「我拼错了再拼一遍，拼对了却判我错」，而服务端已经按新题型在判卷了，且无任何报错。
--
-- 所以题型改为**当天第一次出题时定下来、当天不再变**：
--   type_lock     = meaning | spelling | listening | cloze
--   type_lock_day = 哪一天锁的（跨天时重新抽取，保留「认识的词越考越难」的轮换手感）
-- 两列同时有值或同时为空；存量行均为 NULL，等价于「今天还没出题」。
ALTER TABLE `user_word_progress` ADD COLUMN `type_lock` VARCHAR(12) NULL,
    ADD COLUMN `type_lock_day` DATE NULL;

-- 注意：Prisma 自动生成的版本会多一条 `DROP TABLE search_index;`（那是手写 SQL 建的
-- ngram 全文索引表，schema 故意没声明）。直接执行 = M4-07 中文全文检索静默失效。已手工删除。
