/*
  Warnings:

  - 已手工删除 Prisma 自动生成的 `DROP TABLE search_index`。
    `search_index` 是 `20260919120000_add_search_index` 用**手写 SQL** 建的 ngram 全文索引表，
    schema.prisma 故意不声明它（Prisma 表达不了 `WITH PARSER ngram`）。
    不删这行 → 执行后 M4-07 中文全文检索**静默失效**（接口不报错、只是永远搜不到）。

  - `word.phrases` 是 NOT NULL JSON，MySQL 建表时会用默认值填满已有行；
    对空表等价于无默认值，对已有行需要脚本回填（`db:gen-words` 会写）。
*/
-- AlterTable
ALTER TABLE `word` ADD COLUMN `phrases` JSON NOT NULL,
    ADD COLUMN `uk_phonetic` VARCHAR(60) NULL;

-- AlterTable
ALTER TABLE `word_book` ADD COLUMN `category` VARCHAR(20) NOT NULL DEFAULT 'exam';

-- CreateIndex
CREATE INDEX `word_book_category_level_idx` ON `word_book`(`category`, `level`);
