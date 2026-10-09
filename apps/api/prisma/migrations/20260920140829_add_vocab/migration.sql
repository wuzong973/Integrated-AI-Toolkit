-- 记单词 / 四六级词汇训练
--
-- ## 本迁移建什么
--
--   word_book            词书（CET4 / CET6 / 考研）
--   word                 词条本体
--   word_book_word       词书 ↔ 词条（一个词可同属四级与六级）
--   user_word_book       用户选中的词书 + 每日目标
--   user_word_progress   SM-2 复习进度（EF 以「百分之一」为单位的整数存，见 schema 注释）
--   word_study_log       每日学习记录 —— 打卡日历的**唯一**数据源，刻意不另建打卡表
--                        （另建一张必然出现'有学习记录没打卡行'或反之，没人会发现）
--
-- ## ⚠️ 上面两条 admin_account 语句与本功能无关，为什么留着
--
--   它们不是手写的，是 `prisma migrate dev` 的 diff 产物：
--   `20260920140000_add_admin_account` 是**手写**迁移，`updated_at` 带了
--   `DEFAULT CURRENT_TIMESTAMP(3)`、外键也是内联写法，与 `schema.prisma`
--   （`@updatedAt` 无默认值）不一致。删掉它们的话，**下次生成迁移会原样再来一遍**
--   （影子库是回放迁移建出来的，漂移永远存在）。
--   留着代价为零：Prisma 每次都显式写 updated_at，去掉默认值不改变任何行为，
--   好处是迁移历史与 schema 收敛。
--
-- ## ⚠️⚠️ 这里**故意删掉了**自动生成的 `DROP TABLE search_index` ⚠️⚠️
--
--   `search_index` 是 `20260919120000_add_search_index` 用**手写 SQL** 建的
--   （它需要 `FULLTEXT ... WITH PARSER ngram`，而 Prisma schema 表达不了 ngram 解析器），
--   且**没有**在 `schema.prisma` 里声明模型 → Prisma 把它当成"库里多出来的表"，
--   每次生成迁移都会带一条 DROP。
--   直接执行的后果是 **M4-07 的中文全文检索静默失效**：表没了、查询返回空，
--   而"搜不出东西"看起来像"还没建索引"，不像"表被删了"。
--   **后续任何人重新生成迁移时必须同样手工删掉这条 DROP**，参考
--   `20260919100618_add_verification_identity/migration.sql` 里的同样处理；
--   根治办法见 `schema.prisma` 末尾关于 search_index 的说明。

-- DropForeignKey
ALTER TABLE `admin_account` DROP FOREIGN KEY `admin_account_user_id_fkey`;

-- AlterTable
ALTER TABLE `admin_account` ALTER COLUMN `updated_at` DROP DEFAULT;


-- CreateTable
CREATE TABLE `word_book` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `desc` VARCHAR(200) NULL,
    `level` INTEGER NOT NULL DEFAULT 0,
    `word_count` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `word_book_code_key`(`code`),
    INDEX `word_book_status_level_idx`(`status`, `level`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `word` (
    `id` CHAR(36) NOT NULL,
    `spelling` VARCHAR(60) NOT NULL,
    `phonetic` VARCHAR(60) NULL,
    `senses` JSON NOT NULL,
    `examples` JSON NOT NULL,
    `mnemonic` VARCHAR(300) NULL,
    `difficulty` INTEGER NOT NULL DEFAULT 3,
    `source` VARCHAR(20) NOT NULL DEFAULT 'llm',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `word_spelling_key`(`spelling`),
    INDEX `word_difficulty_idx`(`difficulty`),
    INDEX `word_source_idx`(`source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `word_book_word` (
    `id` CHAR(36) NOT NULL,
    `book_id` CHAR(36) NOT NULL,
    `word_id` CHAR(36) NOT NULL,
    `seq` INTEGER NOT NULL DEFAULT 0,

    INDEX `word_book_word_book_id_seq_idx`(`book_id`, `seq`),
    UNIQUE INDEX `word_book_word_book_id_word_id_key`(`book_id`, `word_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_word_book` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `book_id` CHAR(36) NOT NULL,
    `daily_new` INTEGER NOT NULL DEFAULT 10,
    `daily_review` INTEGER NOT NULL DEFAULT 30,
    `is_active` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `user_word_book_user_id_is_active_idx`(`user_id`, `is_active`),
    UNIQUE INDEX `user_word_book_user_id_book_id_key`(`user_id`, `book_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_word_progress` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `word_id` CHAR(36) NOT NULL,
    `book_id` CHAR(36) NULL,
    `ease_factor` INTEGER NOT NULL DEFAULT 250,
    `interval_days` INTEGER NOT NULL DEFAULT 0,
    `repetitions` INTEGER NOT NULL DEFAULT 0,
    `due_date` DATETIME(3) NOT NULL,
    `correct_count` INTEGER NOT NULL DEFAULT 0,
    `wrong_count` INTEGER NOT NULL DEFAULT 0,
    `state` VARCHAR(20) NOT NULL DEFAULT 'new',
    `last_grade` INTEGER NULL,
    `last_review_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `user_word_progress_user_id_due_date_idx`(`user_id`, `due_date`),
    INDEX `user_word_progress_user_id_state_idx`(`user_id`, `state`),
    UNIQUE INDEX `user_word_progress_user_id_word_id_key`(`user_id`, `word_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `word_study_log` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `day` DATE NOT NULL,
    `new_count` INTEGER NOT NULL DEFAULT 0,
    `review_count` INTEGER NOT NULL DEFAULT 0,
    `correct_count` INTEGER NOT NULL DEFAULT 0,
    `wrong_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `word_study_log_user_id_day_idx`(`user_id`, `day` DESC),
    UNIQUE INDEX `word_study_log_user_id_day_key`(`user_id`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `admin_account` ADD CONSTRAINT `admin_account_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `word_book_word` ADD CONSTRAINT `word_book_word_book_id_fkey` FOREIGN KEY (`book_id`) REFERENCES `word_book`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `word_book_word` ADD CONSTRAINT `word_book_word_word_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `word`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_word_book` ADD CONSTRAINT `user_word_book_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_word_book` ADD CONSTRAINT `user_word_book_book_id_fkey` FOREIGN KEY (`book_id`) REFERENCES `word_book`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_word_progress` ADD CONSTRAINT `user_word_progress_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_word_progress` ADD CONSTRAINT `user_word_progress_word_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `word`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_word_progress` ADD CONSTRAINT `user_word_progress_book_id_fkey` FOREIGN KEY (`book_id`) REFERENCES `word_book`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `word_study_log` ADD CONSTRAINT `word_study_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
