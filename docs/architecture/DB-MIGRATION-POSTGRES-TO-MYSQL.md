# 数据库迁移说明：PostgreSQL 16 → MySQL 8

> 状态：**已实施**（2026-09-17）
> 影响范围：`apps/api`（Prisma schema、迁移、配置、种子数据）、`docker-compose.yml`、`scripts/`、文档与合规台账
> 关联决策：设计文档 V2.1 新增 **ADR-13**，取代原 ADR-09（选 PostgreSQL + JSONB）与 ADR-11（用 pgvector 起步）

---

## 1. 为什么改，以及放弃了什么

改的原因是**统一团队与运维技术栈到 MySQL**（任务清单原歧义 A2 的最终拍板）。

这次迁移不是"换一个连接串"就完事——原方案选 PostgreSQL 的三条理由全部失效，代价必须显式记录：

| 原方案依赖的 PG 能力 | 在 MySQL 上的状况 | 补偿措施 |
|---|---|---|
| **JSONB**（存 Agent 计划、DAG、工具参数） | MySQL 只有 `JSON`，无 GIN 索引 | 功能等价，但**半结构化字段的查询性能下降**。高频过滤字段需提升为独立列或加生成列，M2/M3 实现时注意 |
| **`String[]` 标量数组** | MySQL 不支持标量数组 | 全部落为 `JSON` 数组（见第 3 节）。**这是本次迁移改动面最大的一项** |
| **`pgvector`**（起步阶段免去独立向量库） | MySQL 无任何内置向量能力 | M4-06 知识库 RAG **必须外接向量库**，Qdrant 由"扩容可选项"变为"必需项"（多一个运维组件） |
| **内置全文检索**（`to_tsvector`） | 只有 `FULLTEXT` 索引（中文需 ngram 分词器） | M4-07 改用 MySQL FULLTEXT；中文分词效果需实测 |
| **原生 `uuid` 类型** | 无 | 改 `CHAR(36)` 存字符串，主键 UUID 由 Prisma 客户端生成 |

> **建议**：如果团队对向量检索（M4-06）有强需求且不想多维护一个组件，这个决策值得在 M4 开工前重新评估一次。届时回退成本主要是本节列出的五项，可控。

---

## 2. 变更清单

| 文件 | 变更 |
|---|---|
| `apps/api/prisma/schema.prisma` | `provider` 改 `mysql`；84 处 `@db.Uuid` → `@db.Char(36)`；19 处 `String[]` → `Json`；新增 `shadowDatabaseUrl` |
| `apps/api/prisma/migrations/20260917000000_init_mysql/` | **新增**：首次迁移 SQL（40 张表 / 36 个外键 / 842 行）+ `migration_lock.toml` |
| `apps/api/prisma/seed.ts` | 无需改动（Prisma 接受 JS 数组写入 Json 列） |
| `docker-compose.yml` | `postgres:16-alpine` → `mysql:8.4`；服务名/容器名/卷名/健康检查同步调整；锁定 utf8mb4 与时区 |
| `scripts/db/init-db.sql` | 移除三个 PG 扩展；改为 utf8mb4/时区兜底 + **创建影子库并授权** |
| `scripts/db/mysql-bootstrap.sql` | **新增**：非 Docker 场景的本机 MySQL 建库建账号脚本 |
| `.env` / `.env.example` / `apps/api/.env` | `DATABASE_URL` 改 `mysql://...`；新增 `SHADOW_DATABASE_URL` |
| `apps/api/src/common/config/env.schema.ts` | `DATABASE_URL` 提示文案；新增 `SHADOW_DATABASE_URL` |
| `apps/api/src/common/config/configuration.ts` | `db` 增加 `shadowUrl` |
| `apps/api/src/infra/prisma/prisma.service.ts` | 注入 `ConfigService`，把 `DB_POOL_MAX` 落成连接串的 `connection_limit`（此前该配置项是摆设） |
| `apps/api/src/modules/user/user.service.ts` | `skills` / `tags` 读取改用 `asStringArray()` |
| `packages/core/src/utils/json.ts` | **新增**：`asStringArray` / `asJsonArray` / `asJsonObject` + 单测 |
| `README.md` / `docs/dev/ENV.md` / `docs/OPEN_SOURCE_LICENSES.md` | 技术栈、连接串、依赖台账同步 |
| `scripts/license/license_audit.py` | 移除 `pgvector/pgvector`，Qdrant 提为必需 |
| `青智校园_开发任务清单.md` | M0-09 / M0-10 / M4-06 措辞；歧义 A2 标记为已拍板 |
| `青智校园_小程序详细设计文档_V2.md` | 修订记录新增 V2.1；1.5.2 后端选型表；ADR-09 / ADR-11 标记被取代；新增 ADR-13；拓扑图与附录 D/E 同步 |

---

## 3. 字段类型对照（逐项）

### 3.1 主键与外键

```
@db.Uuid   →   @db.Char(36)
```

MySQL 没有原生 uuid 类型。主键仍是 UUID 字符串（`@default(uuid())` 由 **Prisma 客户端**生成，不依赖数据库函数），所以原来的 `uuid-ossp` 扩展被彻底移除。

- 索引键长：`CHAR(36)` utf8mb4 = 144 字节，远低于 InnoDB 3072 字节上限，无风险
- 对比：如果改存 `BINARY(16)` 能省一半空间，但会让所有调试、日志、接口参数都变成十六进制，**本阶段不值得**；数据量上来后再评估

### 3.2 标量数组（本次最需要注意的一项）

PostgreSQL 的 `String[]` 在 MySQL 中**不存在**。19 个字段全部改为 `Json` 数组：

| 表 | 字段 |
|---|---|
| `user_profile` | `skills`、`tags` |
| `verification` | `materials`、`skill_tags` |
| `tool` | `permissions` |
| `tool_job` | `input_files`、`output_files` |
| `os_session` | `agent_stack` |
| `os_task_node` | `depends`、`skill_tags` |
| `agent_def` | `tools`、`permissions` |
| `service` | `skill_tags` |
| `task` | `skill_tags`、`attachments` |
| `order` | `delivery_files` |
| `review` | `tags`、`images` |
| `notification` | `channels` |

**读写纪律（强制）**：

```ts
// ✅ 读：必须收窄
import { asStringArray } from '@qz/core';
skills: asStringArray(profile?.skills)

// ✅ 写：直接传数组，Prisma 会序列化
await prisma.userProfile.create({ data: { userId, skills: ['摄影', '摄像'] } });

// ❌ 禁止：JsonValue 强转成 string[]
skills: profile?.skills as string[]
```

`asStringArray` 会丢弃数组里的非字符串项、非数组输入返回 `[]`。这样脏数据只会表现为"字段为空"，不会变成运行时报错。

**性能注意**：Json 列**无法直接建索引**。以下场景在 M3 实现时需要额外设计：

- `task.skill_tags` 的标签筛选 → 建议加 `task_skill_tag` 关联表，或冗余一列 `skill_tags_text` 做 FULLTEXT
- `os_task_node.depends` 的图遍历 → 在应用层处理（本来就该如此）

### 3.3 其余类型

| Prisma | PostgreSQL | MySQL | 说明 |
|---|---|---|---|
| `String` | `TEXT` / `VARCHAR(n)` | `VARCHAR(n)` | 长度上限已显式声明 |
| `String @db.Text` | `TEXT` | `TEXT` | 11 处 |
| `Json` | `JSONB` | `JSON` | 39 处；**无 GIN 索引** |
| `Int` | `INTEGER` | `INTEGER` | 金额仍为"分"，纪律不变 |
| `Boolean` | `BOOLEAN` | `BOOLEAN`（= `TINYINT(1)`） | 行为一致 |
| `DateTime` | `TIMESTAMP(3)` | `DATETIME(3)` | **无时区**。见第 5.4 节 |
| `String[]` | `TEXT[]` | `JSON` | 见 3.2 |

---

## 4. 初始化与建表

### 4.1 Docker（推荐）

```bash
docker compose up -d          # 起 MySQL 8.4 + Redis 7 + MinIO
npm run db:migrate            # 应用 prisma/migrations 下的迁移
npm run db:seed               # 1 管理员 + 3 演示用户 + 45 个工具条目（可见 37 + Agent 内部 8）
```

首次启动时容器会按顺序做三件事：建 `qingzhi` 库 → 建 `qz` 账号 → 执行 `scripts/db/init-db.sql`（建影子库 + 授权 + 锁定 utf8mb4/时区）。

### 4.2 本机已装 MySQL（无 Docker）

```bash
# 只需执行一次，需要 root 权限
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < scripts/db/mysql-bootstrap.sql

npm run db:migrate
npm run db:seed
```

### 4.3 为什么需要影子库

`prisma migrate dev` 会创建一个**影子库**来预演迁移，这需要 `CREATE DATABASE` 权限。
而无论是 Docker 的 `MYSQL_USER` 还是本机 bootstrap 脚本，业务账号都**只被授权到业务库**（这是有意的——应用账号不该有全局 DDL 权限）。

因此方案是：**预先建好 `qingzhi_shadow` 并授权给 `qz`**，再通过 schema 的 `shadowDatabaseUrl` 显式指向它。

- `prisma migrate deploy`（生产）会忽略该配置，但 Prisma 的 `env()` 仍要求变量存在，所以 `.env.example` 里必须保留
- 生产环境把 `SHADOW_DATABASE_URL` 指向任意一次性空库即可

### 4.4 首次迁移已提交

`apps/api/prisma/migrations/20260917000000_init_mysql/migration.sql` 已随本次变更入库，**不要重新执行 `prisma migrate dev --name init`**（会因迁移目录已存在而失败）。日常加字段照常 `npm run db:migrate` 即可。

---

## 5. 已知坑（都已在代码/配置中处理）

### 5.1 Json 列的默认值没有数据库级 DEFAULT ⚠️

Prisma 为 MySQL 生成迁移时**不会**输出 `DEFAULT` 子句：

```sql
`skills` JSON NOT NULL,   -- 注意：没有 DEFAULT
```

这是 Prisma 的已知行为（[prisma#23250](https://github.com/prisma/prisma/issues/23250)）：**默认值由 Prisma Client 在写入时补上**，因此 `prisma.xxx.create({ data: { userId } })` 不传 `skills` 也能正常得到 `[]`。

但要注意两个边界：

1. **用原生 SQL 直插**（`$executeRaw`、手工 SQL、其他语言的服务）时，必须显式提供所有 JSON 列，否则报 `Field 'xxx' doesn't have a default value`
2. **给已有数据的表新增 Json 列**时，迁移会在存量行上留下非法值，需要手工 `UPDATE ... SET col = JSON_ARRAY()` 回填

### 5.2 表名大小写

本机 `my.ini` 里 `lower_case_table_names=1`（Windows 默认）。schema 中所有 `@@map()` 已经是全小写 snake_case，**不受影响**。但要注意：

- **不要把表名/字段名改成驼峰**——在 Windows 上能跑，迁到 Linux 生产环境会因大小写敏感而失败
- 开发（Windows）与生产（Linux）行为不一致是 MySQL 的经典坑，本项目的命名纪律正好规避了它

### 5.3 保留字

`order`、`config`、`user` 在 MySQL 中是保留字/函数名。Prisma 生成 SQL 时统一加反引号（`` `order` ``），无问题。但**手写 SQL 时必须加反引号**。

### 5.4 时区

`DATETIME(3)` 不带时区信息。已在三处锁定为东八区：

- `docker-compose.yml`：`TZ=Asia/Shanghai` + `--default-time-zone=+08:00`
- `scripts/db/init-db.sql`：`SET GLOBAL time_zone = '+08:00'`
- 应用层：所有对外时间输出统一走 `toISOString()`（UTC）

**注意**：MySQL 的 `DATETIME` 不会像 PG 的 `TIMESTAMPTZ` 那样自动转换时区，写入什么就存什么。容器时区一旦配错，存进去的就是错的时间且无法自动纠正。

### 5.5 字符集

服务端、库、表全部锁定 `utf8mb4 / utf8mb4_unicode_ci`。**不要**用 `utf8`（那是 `utf8mb3`，存不了 emoji 和部分生僻字）——校园场景里昵称带 emoji 很常见。

---

## 6. 存量数据迁移（如果已有 PG 数据要搬）

首次迁移是新库建表，不涉及数据搬迁。若将来需要从旧 PG 库搬数据，按下面顺序做：

```bash
# ① 从 PG 导出（每张表一个 CSV，JSONB/数组列导出为 JSON 文本）
psql "$OLD_PG_URL" -c "\copy (SELECT * FROM \"user\") TO 'user.csv' WITH CSV HEADER"

# ② 数组列需要转换：PG 的 {a,b} 语法不是合法 JSON
#    用 Python 后处理：'{摄影,后期修图}' → '["摄影","后期修图"]'

# ③ 导入 MySQL（注意 JSON 列必须显式给值，见 5.1）
mysql -u qz -p qingzhi -e "LOAD DATA LOCAL INFILE 'user.csv' INTO TABLE user ..."
```

**强烈建议**：与其写转换脚本，不如**只迁移必须保留的业务数据**（用户、订单、资金流水），其余（工具目录、分类、配置）直接用 `npm run db:seed` 重建。原因是数组列与 JSONB 的语法差异会让"全量自动转换"变成一个长期维护的脚本。

---

## 7. 验证清单与实测结果

**本机 MySQL 8.0.45 上已完整实跑通过（2026-09-17）**，命令与结果如下：

| # | 检查项 | 命令 | 实测结果 |
|---|---|---|---|
| ① | schema 合法 | `npx prisma validate` | ✅ `The schema is valid` |
| ② | 类型检查 | `npm run typecheck` | ✅ 无错误（含 `typecheck:mp`） |
| ③ | 单元测试 | `npm test` | ✅ 11 文件 / 72 用例全绿 |
| ④ | 建库建账号 | `mysql -u root -p < scripts/db/mysql-bootstrap.sql` | ✅ 建出 `qingzhi` / `qingzhi_shadow`，字符集均为 `utf8mb4 / utf8mb4_unicode_ci` |
| ⑤ | 应用迁移 | `npm run db:deploy` | ✅ `20260917000000_init_mysql` 应用成功 |
| ⑥ | 表结构 | `information_schema` 查询 | ✅ **41 张表**（40 业务表 + `_prisma_migrations`）、**36 个外键**、**39 个 JSON 列**、**84 个 `char(36)` 列**——与离线生成的 SQL 完全一致 |
| ⑦ | 迁移状态 | `npx prisma migrate status` | ✅ `Database schema is up to date!`（无 drift） |
| ⑧ | **影子库** | `npx prisma migrate dev` | ✅ `Already in sync` —— `shadowDatabaseUrl` 配置生效，未出现权限错误 |
| ⑨ | 灌种子数据 | `npm run db:seed` | ✅ 学校 1 + 工具分类 7 + 服务分类 9 + 工具 32 + 用户 4 |
| ⑩ | 数据库连通 | `GET /health` | ✅ `dependencies.database: up` |
| ⑪ | **数组字段 JSON 往返** | 登录 → `PUT /user/me` 写 `skills` → 重新 `GET /user/me` | ✅ 写入 `["摄影","后期修图","剪辑"]`，重新查库读回完全一致，`JSON_TYPE` = `ARRAY` |
| ⑫ | 用户域接口 | `GET /user/roles` `/credit` `/points` `/wallet` | ✅ 全部 200 |
| ⑬ | 级联删除 | `DELETE FROM user WHERE ...` | ✅ `user_profile` / `user_role` / `wallet` 随主表级联清除（36 个外键生效） |
| ⑭ | 冒烟 | `npm run smoke` | ✅ 通过 |

**关键结论：第 ⑪ 项证实了第 5.1 节的判断。** 种子数据里只有 1 个用户显式传了 `skills`，
其余 3 个未传该字段——它们的 `skills` 落库为 `[]`。
这说明 **Prisma Client 确实在写入时补上了 `@default("[]")`**，尽管迁移 SQL 里没有 `DEFAULT` 子句。

复现命令：

```bash
# 一键复核（需 MySQL 已启动且已执行过 mysql-bootstrap.sql）
npm run db:deploy && npm run db:seed
npm run dev:api &            # 另开终端
curl -s http://127.0.0.1:3000/api/v1/health
```

> **注意**：`npm run db:migrate`（即 `prisma migrate dev`）会重新执行 `prisma generate`。
> 若此时 `nest start --watch` 正在运行，dev server 可能在客户端文件被替换的瞬间重启失败
> （报 `MODULE_NOT_FOUND: @prisma/client/default.js`）。这不是迁移问题，重启 API 即可。

---

## 8. 回滚

本次变更**未保留 PostgreSQL 迁移目录**（原先根本没有 migrations 目录，schema 是靠 `prisma db push` 的假设状态）。

回滚方式：仓库初始化 git 后，用提交历史还原，而不是在 `prisma/` 里放 `.bak` 文件：

```bash
git log --oneline -- apps/api/prisma/schema.prisma
git show <迁移前的 commit>:apps/api/prisma/schema.prisma > apps/api/prisma/schema.prisma
rm -rf apps/api/prisma/migrations
# 然后还原 docker-compose.yml / .env / scripts/db/init-db.sql
```

> 迁移期的 `schema.prisma.pg.bak`（749 行 PG 版 schema）已删除：
> 它是仓库里唯一的 `.bak` 文件，内容与本文档第 2~4 节的字段对照表重复，
> 且不会被任何工具读取。**本仓库尚未 `git init`**，因此在补上首次提交之前，
> 这份 PG 版 schema 只能靠本文档还原。请优先完成 git 初始化。
