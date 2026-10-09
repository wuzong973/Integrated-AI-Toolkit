-- 管理后台登录凭证（任务清单 M0-23）
--
-- ## 这个迁移解决什么
--
-- 在此之前后端**只有微信 code 登录**：`AuthService.login(code)` → `code2Session` → `openid`。
-- 微信开放平台的「网站应用」扫码登录需要企业资质，本机与首版都跑不通；于是
-- `apps/admin/` 一直停在"只有 README"的状态（README 里还写着待办）。
--
-- 更具体的一个坑：`seed.ts` 里那个 `openid = 'demo_admin'` 的管理员
-- **根本登录不上** —— 开发模式的伪 openid 是 `dev_<stableHash(code)>`，
-- 哈希结果不可能是字面量 `demo_admin`。也就是说"种子管理员"此前是个死数据。
--
-- 本迁移引入 `admin_account`：用户名 + 密码登录，签发与小程序**同一套 JWT**
-- （`TokenService.issue`），因此 `JwtAuthGuard` / `@Roles(Role.Admin)` 全部直接复用。
--
-- ## 为什么绑定到 user 而不是独立身份
--
-- `audit_log.actor_id`、`order`/`tool_job` 的责任人都是 `user.id`。后台账号若自成一套身份，
-- 所有审计与追责链路都要额外承接一层映射，且"操作人是谁"会分裂成两套口径。
-- 绑定到 `user` 并给该 user 挂 `admin` 角色，则后台操作天然进入既有的审计与权限体系。
--
-- ## 密码存储
--
-- `password_hash` 存 **scrypt**（`node:crypto`，不引第三方依赖），格式
-- `scrypt$N$r$p$salt$hash`。参数随哈希一起存：日后调高成本参数时，
-- 旧哈希仍按其自身参数校验通过，不会出现"改一次参数全体管理员登不上"。

CREATE TABLE `admin_account` (
  `id`            CHAR(36)     NOT NULL,
  `user_id`       CHAR(36)     NOT NULL,
  `username`      VARCHAR(40)  NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `display_name`  VARCHAR(40)  NOT NULL,
  `admin_role`    VARCHAR(20)  NOT NULL,
  `status`        VARCHAR(20)  NOT NULL DEFAULT 'active',
  `last_login_at` DATETIME(3)  NULL,
  `created_by`    CHAR(36)     NULL,
  `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `admin_account_user_id_key` (`user_id`),
  UNIQUE INDEX `admin_account_username_key` (`username`),
  INDEX `admin_account_status_admin_role_idx` (`status`, `admin_role`),
  CONSTRAINT `admin_account_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
