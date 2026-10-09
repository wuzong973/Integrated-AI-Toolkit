# 数据模型与迁移约定

Schema：`apps/api/prisma/schema.prisma`（MySQL 8）。
ORM：Prisma 6；访问统一经 `apps/api/src/infra/prisma/prisma.service.ts`。

## 1. 为什么是 MySQL（不是 PostgreSQL）

见 ADR-13（`../architecture/DECISIONS.md`）与迁移记录
`../architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md`。已评估并接受的代价：

| PG 能力 | MySQL 下的替代做法 | 代码约定 |
|---|---|---|
| JSONB + GIN 索引 | JSON 列（无索引） | 高频查询字段冗余成独立列，别在 JSON 上做筛选 |
| `String[]` 标量数组 | JSON 数组 | 读写必须过 `packages/core/src/utils/json.ts` 的 `asStringArray()` 收窄 |
| pgvector | **无** | M4-06 向量检索必须外接 Qdrant |
| pg_trgm 模糊检索 | MySQL FULLTEXT | 中文检索效果有限，M4-07 再评估 |

主键 UUID 由 **Prisma 客户端**生成（`@default(uuid())`），不依赖数据库函数。

## 2. 库与账号

| 库 | 用途 | 来源 |
|---|---|---|
| `qingzhi` | 业务库 | `DATABASE_URL` |
| `qingzhi_shadow` | 影子库，`prisma migrate dev` 迁移预演用 | `SHADOW_DATABASE_URL`（`migrate deploy` 不读） |

- Docker 场景：`docker-compose.yml` + `scripts/db/init-db.sql` 自动建库、建影子库并授权；
- 本机 MySQL：执行一次 `scripts/db/mysql-bootstrap.sql`。

## 3. 字符集与时区（踩过坑，别改）

- 库 / 表必须 `utf8mb4` + `utf8mb4_unicode_ci`，否则中文与 emoji 被截断；
- 服务端时区 `--default-time-zone=+08:00`，容器 `TZ` 同步设置；
- 时间字段在应用层统一转 ISO8601 输出，不依赖数据库时区。

## 4. 迁移流程

```bash
# 开发
npm run db:generate        # 改完 schema 后生成 client
npm run db:migrate         # 建迁移 + 应用（会用到影子库）
npm run db:seed            # 灌演示数据（1 管理员 + 3 用户 + 32 工具）

# 生产
npm run db:deploy          # 只应用已有迁移，不生成
```

纪律：
- 迁移文件（`apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`）**必须提交**，
  提交后不再编辑；要改就加一个新迁移；
- 破坏性变更（删列 / 改类型）拆成两次发布：先加新列双写，再删旧列；
- `migration_lock.toml` 固定 `provider = "mysql"`，不要手改。

## 5. 建模约定

- 表名小写复数，字段 camelCase（Prisma 风格），需要数据库侧可读时用 `@map`；
- 金额列名以 `Cents` 结尾、类型 `Int`（分），禁止 `Float` / `Decimal` 存钱；
- 状态列用 `packages/core/src/enums` 的字符串枚举，**库里存字面量**便于排查；
- 所有表带 `createdAt` / `updatedAt`；软删用可空 `deletedAt` 而不是物理删除；
- 状态字段只能由 `transition()` 改（红线），Service 里不许直接赋值。

## 6. 排查

```bash
npm run db:studio                                  # Prisma Studio 可视化
curl http://localhost:3000/api/v1/health           # dependencies.database: up | down
```

`/health` 在数据库不可用时会把 `databaseError` 一并返回（不含堆栈）。
