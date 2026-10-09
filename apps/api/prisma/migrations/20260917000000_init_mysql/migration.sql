-- CreateTable
CREATE TABLE `school` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `city` VARCHAR(60) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `school_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user` (
    `id` CHAR(36) NOT NULL,
    `openid` VARCHAR(64) NOT NULL,
    `unionid` VARCHAR(64) NULL,
    `phone` VARCHAR(20) NULL,
    `nickname` VARCHAR(40) NULL,
    `avatar` VARCHAR(500) NULL,
    `school_id` CHAR(36) NULL,
    `college` VARCHAR(60) NULL,
    `grade` VARCHAR(20) NULL,
    `real_name` VARCHAR(40) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `last_login` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_openid_key`(`openid`),
    UNIQUE INDEX `user_phone_key`(`phone`),
    INDEX `user_school_id_idx`(`school_id`),
    INDEX `user_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_role` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `role` VARCHAR(20) NOT NULL,
    `scope` VARCHAR(20) NOT NULL DEFAULT 'self',
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_role_role_status_idx`(`role`, `status`),
    UNIQUE INDEX `user_role_user_id_role_key`(`user_id`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_profile` (
    `user_id` CHAR(36) NOT NULL,
    `credit_score` INTEGER NOT NULL DEFAULT 80,
    `skills` JSON NOT NULL,
    `bio` VARCHAR(300) NULL,
    `tags` JSON NOT NULL,
    `points` INTEGER NOT NULL DEFAULT 0,
    `balance` INTEGER NOT NULL DEFAULT 0,
    `frozen` INTEGER NOT NULL DEFAULT 0,
    `total_income` INTEGER NOT NULL DEFAULT 0,
    `completed_orders` INTEGER NOT NULL DEFAULT 0,
    `rating_sum` INTEGER NOT NULL DEFAULT 0,
    `rating_count` INTEGER NOT NULL DEFAULT 0,
    `accept_orders` BOOLEAN NOT NULL DEFAULT true,
    `last_active_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `user_profile_credit_score_idx`(`credit_score`),
    INDEX `user_profile_last_active_at_idx`(`last_active_at`),
    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `materials` JSON NOT NULL,
    `skill_tags` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `reject_reason` VARCHAR(300) NULL,
    `reviewer_id` CHAR(36) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `verification_user_id_type_idx`(`user_id`, `type`),
    INDEX `verification_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `file_asset` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `size` INTEGER NOT NULL,
    `object_key` VARCHAR(400) NOT NULL,
    `thumb_url` VARCHAR(600) NULL,
    `hash` VARCHAR(128) NULL,
    `scene` VARCHAR(30) NOT NULL,
    `source` VARCHAR(40) NULL,
    `download_count` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `expire_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `file_asset_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    INDEX `file_asset_expire_at_idx`(`expire_at`),
    INDEX `file_asset_scene_idx`(`scene`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tool_category` (
    `id` VARCHAR(40) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `icon` VARCHAR(120) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `scene` VARCHAR(30) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tool` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `display_name` VARCHAR(60) NOT NULL,
    `category_id` VARCHAR(40) NOT NULL,
    `description` VARCHAR(300) NOT NULL,
    `provider` VARCHAR(60) NULL,
    `input_schema` JSON NULL,
    `output_schema` JSON NULL,
    `sync` BOOLEAN NOT NULL DEFAULT false,
    `timeout_sec` INTEGER NOT NULL DEFAULT 300,
    `price` INTEGER NOT NULL DEFAULT 0,
    `permissions` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'planned',
    `requires_copyright_ack` BOOLEAN NOT NULL DEFAULT false,
    `daily_quota` INTEGER NOT NULL DEFAULT 0,
    `use_count` INTEGER NOT NULL DEFAULT 0,
    `version` VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    `sort` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tool_name_key`(`name`),
    INDEX `tool_category_id_status_idx`(`category_id`, `status`),
    INDEX `tool_status_sort_idx`(`status`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tool_job` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `tool_name` VARCHAR(60) NOT NULL,
    `params` JSON NOT NULL,
    `input_files` JSON NOT NULL,
    `output_files` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'queued',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `stage` VARCHAR(120) NULL,
    `cost` INTEGER NOT NULL DEFAULT 0,
    `provider` VARCHAR(60) NULL,
    `error` VARCHAR(600) NULL,
    `run_id` CHAR(36) NULL,
    `node_id` VARCHAR(40) NULL,
    `idempotency_key` VARCHAR(80) NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tool_job_idempotency_key_key`(`idempotency_key`),
    INDEX `tool_job_user_id_status_created_at_idx`(`user_id`, `status`, `created_at` DESC),
    INDEX `tool_job_status_started_at_idx`(`status`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `os_session` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `title` VARCHAR(120) NULL,
    `scene` VARCHAR(40) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `context_summary` TEXT NULL,
    `agent_stack` JSON NOT NULL,
    `token_used` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `os_session_user_id_status_updated_at_idx`(`user_id`, `status`, `updated_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `os_message` (
    `id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `role` VARCHAR(20) NOT NULL,
    `agent_name` VARCHAR(40) NULL,
    `content_type` VARCHAR(20) NOT NULL DEFAULT 'text',
    `content` TEXT NOT NULL,
    `cards` JSON NULL,
    `tool_calls` JSON NULL,
    `tokens` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `os_message_session_id_created_at_idx`(`session_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `os_plan_run` (
    `id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `goal` TEXT NOT NULL,
    `plan` JSON NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'planning',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `total_cost` INTEGER NOT NULL DEFAULT 0,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `os_plan_run_session_id_status_idx`(`session_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `os_task_node` (
    `id` CHAR(36) NOT NULL,
    `run_id` CHAR(36) NOT NULL,
    `node_id` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `agent` VARCHAR(40) NULL,
    `tool` VARCHAR(60) NULL,
    `depends` JSON NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `result` JSON NULL,
    `error` VARCHAR(600) NULL,
    `hitl_type` VARCHAR(20) NULL,
    `hitl_payload` JSON NULL,
    `ref_task_id` CHAR(36) NULL,
    `skill_tags` JSON NOT NULL,
    `budget` INTEGER NOT NULL DEFAULT 0,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `os_task_node_run_id_status_idx`(`run_id`, `status`),
    UNIQUE INDEX `os_task_node_run_id_node_id_key`(`run_id`, `node_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_def` (
    `name` VARCHAR(40) NOT NULL,
    `display_name` VARCHAR(60) NOT NULL,
    `description` VARCHAR(400) NOT NULL,
    `system_prompt` TEXT NOT NULL,
    `tools` JSON NOT NULL,
    `permissions` JSON NOT NULL,
    `input_schema` JSON NULL,
    `output_schema` JSON NULL,
    `model_policy` JSON NULL,
    `max_steps` INTEGER NOT NULL DEFAULT 5,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `fallback_agent` VARCHAR(40) NULL,
    `version` VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agent_call_log` (
    `id` CHAR(36) NOT NULL,
    `run_id` CHAR(36) NULL,
    `session_id` CHAR(36) NULL,
    `agent_name` VARCHAR(40) NOT NULL,
    `model` VARCHAR(60) NULL,
    `prompt_tokens` INTEGER NOT NULL DEFAULT 0,
    `completion_tokens` INTEGER NOT NULL DEFAULT 0,
    `total_tokens` INTEGER NOT NULL DEFAULT 0,
    `latency_ms` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'succeeded',
    `error` VARCHAR(600) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `agent_call_log_agent_name_created_at_idx`(`agent_name`, `created_at` DESC),
    INDEX `agent_call_log_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `service_category` (
    `id` VARCHAR(40) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `icon` VARCHAR(120) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `service` (
    `id` CHAR(36) NOT NULL,
    `provider_id` CHAR(36) NOT NULL,
    `category_id` VARCHAR(40) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `description` TEXT NOT NULL,
    `cover` VARCHAR(600) NULL,
    `price` INTEGER NOT NULL DEFAULT 0,
    `price_unit` VARCHAR(20) NOT NULL DEFAULT 'fixed',
    `delivery_days` INTEGER NOT NULL DEFAULT 3,
    `service_area` VARCHAR(20) NOT NULL DEFAULT 'school',
    `skill_tags` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
    `order_count` INTEGER NOT NULL DEFAULT 0,
    `view_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `service_status_category_id_idx`(`status`, `category_id`),
    INDEX `service_provider_id_status_idx`(`provider_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task` (
    `id` CHAR(36) NOT NULL,
    `task_no` VARCHAR(40) NOT NULL,
    `publisher_id` CHAR(36) NOT NULL,
    `category_id` VARCHAR(40) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `description` TEXT NOT NULL,
    `budget` INTEGER NOT NULL DEFAULT 0,
    `budget_type` VARCHAR(20) NOT NULL DEFAULT 'fixed',
    `deadline` DATETIME(3) NULL,
    `location` VARCHAR(160) NULL,
    `skill_tags` JSON NOT NULL,
    `attachments` JSON NOT NULL,
    `source` VARCHAR(20) NOT NULL DEFAULT 'manual',
    `ref_run_id` CHAR(36) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'draft',
    `apply_count` INTEGER NOT NULL DEFAULT 0,
    `view_count` INTEGER NOT NULL DEFAULT 0,
    `selected_provider_id` CHAR(36) NULL,
    `published_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `task_task_no_key`(`task_no`),
    INDEX `task_status_category_id_created_at_idx`(`status`, `category_id`, `created_at` DESC),
    INDEX `task_publisher_id_status_idx`(`publisher_id`, `status`),
    INDEX `task_ref_run_id_idx`(`ref_run_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_application` (
    `id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `provider_id` CHAR(36) NOT NULL,
    `quote` INTEGER NOT NULL DEFAULT 0,
    `message` VARCHAR(500) NULL,
    `match_score` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `task_application_provider_id_status_idx`(`provider_id`, `status`),
    INDEX `task_application_task_id_match_score_idx`(`task_id`, `match_score` DESC),
    UNIQUE INDEX `task_application_task_id_provider_id_key`(`task_id`, `provider_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order` (
    `id` CHAR(36) NOT NULL,
    `order_no` VARCHAR(40) NOT NULL,
    `task_id` CHAR(36) NULL,
    `service_id` CHAR(36) NULL,
    `buyer_id` CHAR(36) NOT NULL,
    `provider_id` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `platform_fee` INTEGER NOT NULL DEFAULT 0,
    `provider_income` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(30) NOT NULL DEFAULT 'pending_payment',
    `revision_count` INTEGER NOT NULL DEFAULT 0,
    `requirement` TEXT NULL,
    `delivery_files` JSON NOT NULL,
    `delivery_remark` VARCHAR(500) NULL,
    `cancel_reason` VARCHAR(300) NULL,
    `refund_reason` VARCHAR(300) NULL,
    `pay_deadline` DATETIME(3) NULL,
    `deliver_deadline` DATETIME(3) NULL,
    `paid_at` DATETIME(3) NULL,
    `started_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `accepted_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `refunded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `order_order_no_key`(`order_no`),
    INDEX `order_buyer_id_status_idx`(`buyer_id`, `status`),
    INDEX `order_provider_id_status_idx`(`provider_id`, `status`),
    INDEX `order_status_pay_deadline_idx`(`status`, `pay_deadline`),
    INDEX `order_status_deliver_deadline_idx`(`status`, `deliver_deadline`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_timeline` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `event` VARCHAR(60) NOT NULL,
    `operator_id` CHAR(36) NULL,
    `payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `order_timeline_order_id_created_at_idx`(`order_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `pay_no` VARCHAR(64) NULL,
    `channel` VARCHAR(20) NOT NULL DEFAULT 'wechat',
    `amount` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `refund_amount` INTEGER NOT NULL DEFAULT 0,
    `refund_no` VARCHAR(64) NULL,
    `paid_at` DATETIME(3) NULL,
    `refunded_at` DATETIME(3) NULL,
    `raw_callback` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_order_id_key`(`order_id`),
    UNIQUE INDEX `payment_pay_no_key`(`pay_no`),
    INDEX `payment_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet` (
    `user_id` CHAR(36) NOT NULL,
    `balance` INTEGER NOT NULL DEFAULT 0,
    `frozen` INTEGER NOT NULL DEFAULT 0,
    `total_income` INTEGER NOT NULL DEFAULT 0,
    `points` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_ledger` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `amount` INTEGER NOT NULL,
    `balance_after` INTEGER NOT NULL,
    `ref_type` VARCHAR(30) NULL,
    `ref_id` VARCHAR(60) NULL,
    `remark` VARCHAR(200) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `wallet_ledger_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    INDEX `wallet_ledger_ref_type_ref_id_idx`(`ref_type`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `points_ledger` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `delta` INTEGER NOT NULL,
    `reason` VARCHAR(60) NOT NULL,
    `ref_id` VARCHAR(60) NULL,
    `balance_after` INTEGER NOT NULL,
    `kind` VARCHAR(20) NOT NULL DEFAULT 'charge',
    `expire_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `points_ledger_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `withdrawal` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `fee` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `remark` VARCHAR(200) NULL,
    `reviewer_id` CHAR(36) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `withdrawal_user_id_status_idx`(`user_id`, `status`),
    INDEX `withdrawal_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `review` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `reviewer_id` CHAR(36) NOT NULL,
    `target_id` CHAR(36) NOT NULL,
    `rating` INTEGER NOT NULL,
    `tags` JSON NOT NULL,
    `content` VARCHAR(500) NULL,
    `images` JSON NOT NULL,
    `is_anonymous` BOOLEAN NOT NULL DEFAULT false,
    `reply` VARCHAR(500) NULL,
    `replied_at` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'normal',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `review_target_id_created_at_idx`(`target_id`, `created_at` DESC),
    UNIQUE INDEX `review_order_id_reviewer_id_key`(`order_id`, `reviewer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_log` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `delta` INTEGER NOT NULL,
    `reason` VARCHAR(60) NOT NULL,
    `ref_id` VARCHAR(60) NULL,
    `balance_after` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `credit_log_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `conversation` (
    `id` CHAR(36) NOT NULL,
    `participant_a` CHAR(36) NOT NULL,
    `participant_b` CHAR(36) NOT NULL,
    `ref_type` VARCHAR(30) NULL,
    `ref_id` VARCHAR(60) NULL,
    `last_message` VARCHAR(300) NULL,
    `last_message_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `conversation_participant_a_last_message_at_idx`(`participant_a`, `last_message_at` DESC),
    INDEX `conversation_participant_b_last_message_at_idx`(`participant_b`, `last_message_at` DESC),
    UNIQUE INDEX `conversation_participant_a_participant_b_key`(`participant_a`, `participant_b`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message` (
    `id` CHAR(36) NOT NULL,
    `conversation_id` CHAR(36) NOT NULL,
    `sender_id` CHAR(36) NOT NULL,
    `type` VARCHAR(20) NOT NULL DEFAULT 'text',
    `content` TEXT NOT NULL,
    `read_status` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `message_conversation_id_created_at_idx`(`conversation_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type` VARCHAR(40) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `content` VARCHAR(600) NOT NULL,
    `ref` JSON NULL,
    `channels` JSON NOT NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notification_user_id_read_at_idx`(`user_id`, `read_at`),
    INDEX `notification_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscribe_grant` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `template_id` VARCHAR(80) NOT NULL,
    `scene` VARCHAR(40) NOT NULL,
    `used` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `subscribe_grant_user_id_template_id_used_idx`(`user_id`, `template_id`, `used`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `activity` (
    `id` CHAR(36) NOT NULL,
    `org_id` CHAR(36) NOT NULL,
    `school_id` CHAR(36) NULL,
    `title` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `cover` VARCHAR(600) NULL,
    `location` VARCHAR(160) NULL,
    `start_at` DATETIME(3) NULL,
    `end_at` DATETIME(3) NULL,
    `capacity` INTEGER NOT NULL DEFAULT 0,
    `signup_count` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `activity_school_id_status_idx`(`school_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `activity_signup` (
    `id` CHAR(36) NOT NULL,
    `activity_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `checked_in` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `activity_signup_activity_id_user_id_key`(`activity_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `announcement` (
    `id` CHAR(36) NOT NULL,
    `school_id` CHAR(36) NULL,
    `title` VARCHAR(120) NOT NULL,
    `content` TEXT NOT NULL,
    `start_at` DATETIME(3) NULL,
    `end_at` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'published',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `announcement_school_id_status_start_at_idx`(`school_id`, `status`, `start_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_doc` (
    `id` CHAR(36) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `source` VARCHAR(300) NULL,
    `category` VARCHAR(40) NOT NULL,
    `content` TEXT NOT NULL,
    `embedding` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_doc_category_status_idx`(`category`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` CHAR(36) NOT NULL,
    `actor_id` CHAR(36) NULL,
    `action` VARCHAR(60) NOT NULL,
    `target_type` VARCHAR(40) NULL,
    `target_id` VARCHAR(60) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ip` VARCHAR(60) NULL,
    `trace_id` VARCHAR(60) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_actor_id_created_at_idx`(`actor_id`, `created_at` DESC),
    INDEX `audit_log_target_type_target_id_idx`(`target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `config` (
    `key` VARCHAR(80) NOT NULL,
    `value` JSON NOT NULL,
    `scope` VARCHAR(30) NOT NULL DEFAULT 'global',
    `updated_by` CHAR(36) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_outbox` (
    `id` CHAR(36) NOT NULL,
    `event_name` VARCHAR(80) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `error` VARCHAR(600) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sent_at` DATETIME(3) NULL,

    INDEX `event_outbox_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_record` (
    `key` VARCHAR(80) NOT NULL,
    `user_id` CHAR(36) NULL,
    `endpoint` VARCHAR(160) NOT NULL,
    `response` JSON NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'processing',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expire_at` DATETIME(3) NOT NULL,

    INDEX `idempotency_record_expire_at_idx`(`expire_at`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user` ADD CONSTRAINT `user_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `school`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_role` ADD CONSTRAINT `user_role_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_profile` ADD CONSTRAINT `user_profile_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification` ADD CONSTRAINT `verification_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `file_asset` ADD CONSTRAINT `file_asset_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tool` ADD CONSTRAINT `tool_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `tool_category`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tool_job` ADD CONSTRAINT `tool_job_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tool_job` ADD CONSTRAINT `tool_job_tool_name_fkey` FOREIGN KEY (`tool_name`) REFERENCES `tool`(`name`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `os_session` ADD CONSTRAINT `os_session_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `os_message` ADD CONSTRAINT `os_message_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `os_session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `os_plan_run` ADD CONSTRAINT `os_plan_run_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `os_session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `os_task_node` ADD CONSTRAINT `os_task_node_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `os_plan_run`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `service` ADD CONSTRAINT `service_provider_id_fkey` FOREIGN KEY (`provider_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `service` ADD CONSTRAINT `service_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `service_category`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task` ADD CONSTRAINT `task_publisher_id_fkey` FOREIGN KEY (`publisher_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task` ADD CONSTRAINT `task_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `service_category`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_application` ADD CONSTRAINT `task_application_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_application` ADD CONSTRAINT `task_application_provider_id_fkey` FOREIGN KEY (`provider_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order` ADD CONSTRAINT `order_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order` ADD CONSTRAINT `order_service_id_fkey` FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order` ADD CONSTRAINT `order_buyer_id_fkey` FOREIGN KEY (`buyer_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order` ADD CONSTRAINT `order_provider_id_fkey` FOREIGN KEY (`provider_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_timeline` ADD CONSTRAINT `order_timeline_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet` ADD CONSTRAINT `wallet_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_ledger` ADD CONSTRAINT `wallet_ledger_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `points_ledger` ADD CONSTRAINT `points_ledger_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `review` ADD CONSTRAINT `review_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `review` ADD CONSTRAINT `review_reviewer_id_fkey` FOREIGN KEY (`reviewer_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `review` ADD CONSTRAINT `review_target_id_fkey` FOREIGN KEY (`target_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_log` ADD CONSTRAINT `credit_log_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message` ADD CONSTRAINT `message_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activity` ADD CONSTRAINT `activity_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `school`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activity_signup` ADD CONSTRAINT `activity_signup_activity_id_fkey` FOREIGN KEY (`activity_id`) REFERENCES `activity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `announcement` ADD CONSTRAINT `announcement_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `school`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

