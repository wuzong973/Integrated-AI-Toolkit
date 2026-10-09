-- 练习中心：句子练习 / 口语跟读 / 作文练习（M4-16）
--
-- ## ⚠️⚠️ 手工删除了一条 `DROP TABLE search_index;` ⚠️⚠️
--
-- `prisma migrate diff` 自动生成的版本第一行就是它。`search_index` 是
-- `20260919120000_add_search_index` 用**手写 SQL** 建的 ngram 全文索引表，
-- schema 故意没声明（Prisma 表达不了 `WITH PARSER ngram`，见 schema 末尾说明）。
-- Prisma 因此把它当成"数据库里多出来的表"，每次生成迁移都要 DROP 一次。
-- 直接执行 = **M4-07 中文全文检索静默失效**（不报错，只是永远搜不到）。
--
-- ## ⚠️ 还删掉了 `practiceSentenceId` / `practiceTopicId` 三处外键
--
-- Prisma 会因为 `PracticeSentence.progress` 这类反向字段**自动推断**出
-- "多对多/一对多"关系，从而凭空生成两个 CHAR(36) 列与三条外键。
-- 但本设计**故意不用外键**：`practice_progress.ref_id` 指向两张不同的表
-- （句子或作文题），是"多态关联"，SQL 外键表达不了。
-- 留着那两个自动列的结果是：**列永远为 NULL、外键永远不生效**，
-- 而看 schema 的人会以为有关联约束 —— 比没有更糟。
--
-- ## 与词汇模块的关系
--
-- 复习算法**复用同一套 SM-2**（`packages/core/src/srs/sm2.ts`），
-- 所以这张表的 `ease_factor` / `interval_days` / `repetitions` / `due_date`
-- 与 `user_word_progress` 是**同口径**（EF × 100、间隔按天）。
-- `mode_lock` / `mode_lock_day` 与 `user_word_progress.type_lock` 同理：
-- 同一次练习里重试必须还是同一种题面（见 `vocab-quiz.ts` 文件头）。

-- CreateTable
CREATE TABLE `practice_sentence` (
    `id` CHAR(36) NOT NULL,
    `en` VARCHAR(300) NOT NULL,
    `zh` VARCHAR(300) NOT NULL,
    `chunks` JSON NOT NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `word_count` INTEGER NOT NULL DEFAULT 0,
    `source` VARCHAR(20) NOT NULL DEFAULT 'tatoeba',
    `source_ref` VARCHAR(40) NULL,
    `speakable` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `practice_sentence_level_word_count_idx`(`level`, `word_count`),
    INDEX `practice_sentence_speakable_level_idx`(`speakable`, `level`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_topic` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(60) NOT NULL,
    `kind` VARCHAR(20) NOT NULL DEFAULT 'mock',
    `level` VARCHAR(10) NOT NULL DEFAULT 'cet4',
    `title` VARCHAR(200) NOT NULL,
    `outline` JSON NOT NULL,
    `zh_brief` VARCHAR(400) NOT NULL,
    `sample` TEXT NULL,
    `min_words` INTEGER NOT NULL DEFAULT 120,
    `source` VARCHAR(20) NOT NULL DEFAULT 'curated',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `practice_topic_code_key`(`code`),
    INDEX `practice_topic_kind_level_idx`(`kind`, `level`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_progress` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `ref_id` CHAR(36) NOT NULL,
    `ease_factor` INTEGER NOT NULL DEFAULT 250,
    `interval_days` INTEGER NOT NULL DEFAULT 0,
    `repetitions` INTEGER NOT NULL DEFAULT 0,
    `mode_lock` VARCHAR(16) NULL,
    `mode_lock_day` DATE NULL,
    `due_date` DATETIME(3) NOT NULL,
    `pass_count` INTEGER NOT NULL DEFAULT 0,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `last_score` INTEGER NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'new',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `practice_progress_user_id_due_date_idx`(`user_id`, `due_date`),
    INDEX `practice_progress_user_id_kind_state_idx`(`user_id`, `kind`, `state`),
    UNIQUE INDEX `practice_progress_user_id_kind_ref_id_key`(`user_id`, `kind`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_attempt` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `ref_id` CHAR(36) NOT NULL,
    `mode` VARCHAR(16) NOT NULL,
    `passed` BOOLEAN NOT NULL DEFAULT false,
    `score` INTEGER NULL,
    `submitted` TEXT NULL,
    `elapsed_ms` INTEGER NULL,
    `detail` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `practice_attempt_user_id_kind_ref_id_idx`(`user_id`, `kind`, `ref_id`),
    INDEX `practice_attempt_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_study_log` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `day` DATE NOT NULL,
    `sentence_count` INTEGER NOT NULL DEFAULT 0,
    `speak_count` INTEGER NOT NULL DEFAULT 0,
    `write_count` INTEGER NOT NULL DEFAULT 0,
    `pass_count` INTEGER NOT NULL DEFAULT 0,
    `fail_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `practice_study_log_user_id_day_key`(`user_id`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey（只保留真正的一处：进度与记录都归属用户）
ALTER TABLE `practice_progress` ADD CONSTRAINT `practice_progress_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `practice_attempt` ADD CONSTRAINT `practice_attempt_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `practice_study_log` ADD CONSTRAINT `practice_study_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
