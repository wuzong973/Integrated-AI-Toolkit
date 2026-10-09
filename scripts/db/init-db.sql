-- MySQL 初始化脚本（任务清单 M0-09）
-- 本文件在容器首次创建数据库时自动执行（/docker-entrypoint-initdb.d/01-init.sql）
--
-- 与 PostgreSQL 版本的差异（迁移要点，详见 docs/architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md）：
--   1) MySQL 没有扩展机制，原 uuid-ossp / pg_trgm / pgvector 三个扩展全部移除
--      · 主键 UUID 改由 Prisma 客户端生成（schema 里的 @default(uuid())），无需数据库函数
--      · 模糊检索改用 MySQL 原生 FULLTEXT 索引（M4-07 再评估）
--      · 向量检索（M4-06 RAG）MySQL 无内置能力，需外接向量库，见迁移文档第 4 节
--   2) 字符集必须在服务端/库级显式指定 utf8mb4，否则中文与 emoji 会被截断
--   3) 时区由容器的 TZ 环境变量与 --default-time-zone 启动参数控制，此处仅作兜底

-- 会话字符集兜底
SET NAMES utf8mb4;

-- 时区兜底（容器启动参数已设 --default-time-zone=+08:00）
SET GLOBAL time_zone = '+08:00';
SET time_zone = '+08:00';

-- 影子库（prisma migrate dev 迁移预演用）
-- 官方镜像只会创建 MYSQL_DATABASE 一个库，且 MYSQL_USER 仅被授权到该库，
-- 所以影子库必须在这里由 root 建好并显式授权，否则 `npm run db:migrate` 会报
-- "User does not have permission to create a database"。
CREATE DATABASE IF NOT EXISTS `qingzhi_shadow`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON `qingzhi_shadow`.* TO 'qz'@'%';
FLUSH PRIVILEGES;

-- 说明：库名与业务账号（qz / qz_dev_password）由 docker-compose 的 MYSQL_DATABASE /
--       MYSQL_USER / MYSQL_PASSWORD 环境变量创建，无需在此重复 CREATE DATABASE；
--       表结构由 Prisma 迁移创建：npm run db:migrate
