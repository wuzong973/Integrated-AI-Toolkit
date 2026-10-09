-- ============================================================================
-- 本机 MySQL 初始化（非 Docker 场景）
-- 适用：已在本机安装 MySQL 8.0+，且不使用 docker compose 的开发者
--
-- 执行方式（需要 root 权限，只需执行一次）：
--   "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < scripts/db/mysql-bootstrap.sql
--
-- 执行完成后即可：
--   npm run db:migrate   # 建表
--   npm run db:seed      # 灌入演示数据
--
-- 说明：Docker 场景不需要本文件 —— docker-compose.yml 的 MYSQL_DATABASE /
--       MYSQL_USER 环境变量 + scripts/db/init-db.sql 已覆盖同样的初始化。
-- ============================================================================

-- 1) 业务库
CREATE DATABASE IF NOT EXISTS `qingzhi`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2) 影子库（prisma migrate dev 迁移预演用，可随时清空）
CREATE DATABASE IF NOT EXISTS `qingzhi_shadow`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) 业务账号（与 .env 的 DATABASE_URL 保持一致）
--    本机连接走 localhost，Docker 场景走 '%'，两个 host 都建以保持一致
CREATE USER IF NOT EXISTS 'qz'@'localhost' IDENTIFIED BY 'qz_dev_password';
CREATE USER IF NOT EXISTS 'qz'@'%'         IDENTIFIED BY 'qz_dev_password';

-- 4) 只授权到这两个库：应用账号拿不到全局 CREATE/DROP，降低误操作风险
GRANT ALL PRIVILEGES ON `qingzhi`.*        TO 'qz'@'localhost';
GRANT ALL PRIVILEGES ON `qingzhi_shadow`.* TO 'qz'@'localhost';
GRANT ALL PRIVILEGES ON `qingzhi`.*        TO 'qz'@'%';
GRANT ALL PRIVILEGES ON `qingzhi_shadow`.* TO 'qz'@'%';

FLUSH PRIVILEGES;

-- 5) 自检：确认字符集与时区
SELECT @@character_set_database AS db_charset, @@collation_database AS db_collation
  FROM DUAL;
