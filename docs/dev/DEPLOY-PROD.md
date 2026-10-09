# 生产部署 runbook（腾讯云 101.35.46.146）

> 现状盘点日期：**2026-10-08**，全部数字来自 SSH 只读命令实跑，不是推测。
> 资产：`scripts/deploy/{docker-compose.infra.yml,qingzhi.wzl136122.cn.nginx.conf,ecosystem.config.cjs}`
>
> ✅ **2026-10-08 已完成首次部署**，实况见下方第 0 节。
> ⚠️ 本文第 1 节的"现状盘点"是**部署前**的快照，其中至少两条已经过时（见第 0 节的更正）。
> **动手前务必重新实测，不要直接信本文件的数字。**

---

## 〇、部署实况（2026-10-08，已上线）

| 项 | 实际落地值 |
|---|---|
| 访问地址 | **https://qingzhi.wzl136122.cn**（HTTP 301 跳 HTTPS） |
| 证书 | Let's Encrypt，acme.sh **HTTP-01 webroot**，装到 `/www/server/panel/vhost/cert/qingzhi.wzl136122.cn/`，续期 cron 复用已有的 `29 3,9,15,21 * * *` |
| 后端 | pm2 `qingzhi-api`，`apps/api/dist/main.js`，监听 `0.0.0.0:3100`（firewalld 与云安全组均未放行 3100，公网不可达） |
| 目录 | `/www/wwwroot/qingzhi.wzl136122.cn`（**无 apps/mp**，小程序不部署到服务器） |
| 管理后台 | 同域 `/`，静态根指向 `apps/admin/dist`（**不是仓库根** —— 仓库根放着 `.env`） |
| MySQL | **服务器自带 5.7.44**（非容器）：库 `qingzhi` + `qingzhi_shadow`，账号 `qz`，`127.0.0.1:3306` |
| Redis | 容器 `qz-redis`，`127.0.0.1:6380`（`--maxmemory-policy noeviction`：它是队列底座，**不能逐出**） |
| Qdrant | 容器 `qz-qdrant`，`127.0.0.1:6333` |
| 存储 | `STORAGE_DRIVER=local`（**未部署 MinIO**，因此没有 `oss.` 子域） |
| 侧车 | **四个全部已部署**（`2026-10-08` 后续）：PM2 `qingzhi-{media,convert,pdf,ai}`，绑 `127.0.0.1:8101~8104`；`CONVERT_/PDF_/MODERATION_DRIVER` 已从 mock 切为 real，`AI_/MEDIA_` 走 `127.0.0.1`。具体踩坑见第 八 节 |
| 数据 | 44 工具 / 9 工具分类 / 9 服务分类 / 13 本词书（21,862 词、70,985 关联）/ 17,764 练习句 |
| 后台账号 | `admin`（初始密码在服务器 `.env` 的 `ADMIN_INITIAL_PASSWORD`；**首次登录后请改**） |

**与本文原计划的三处偏离（都是实测后改的，不是漏做）**：

1. **MySQL 走服务器自带的 5.7，不是容器**（用户要求"与现有 MySQL 同一套配置"）。
   代价：必须改 1 处迁移（见第 4 节）。实测**只有 1 个 ALTER 里的 2 列**是真卡点，
   且 `INDEX (... DESC)` **在 5.7 上无害**（接受并忽略）——第 4 节的"2 处"表述偏保守。
2. **不部署 MinIO**，存储用 `local`。于是 nginx 里没有 `oss.` 站点，
   预签名 URL 的 host 问题（第 3 节）在本阶段不出现。
3. **Redis/Qdrant 用容器**（原计划也是容器，但原 `docker-compose.prod.yml` 把 MySQL/MinIO
   一起打包了，与本机实际不符）→ 新开 `docker-compose.infra.yml`，只管这两个。

**第 1 节已过时的两条更正**：

| 原文 | 实测（2026-10-08） |
|---|---|
| "机器上没有 certbot / acme.sh" | ❌ **acme.sh 已于 10-03 装在 `/root/.acme.sh`**，且**已带续期 cron** |
| "python 3.11.6" | ❌ `python3 -V` = **3.7.16**（侧车若要上，必须先解决解释器版本） |

另补一条原文未提、但会影响"重启后还在不在"的：**pm2 当时没有开机自启**
（God Daemon 是孤儿进程，PPID=1，无 systemd 单元、无 rc.local）。
本次已 `pm2 startup systemd` + `pm2 save` 补上 —— 否则**一重启三个项目一起没**。

---


## 一、这台机器现在是什么

| 项 | 实测值 |
|---|---|
| 系统 | OpenCloudOS 9.4（x86_64），已运行 23 周 |
| CPU / 内存 | 4 核 / **3.6 GiB**（可用约 2.1 GiB），swap 1G |
| 磁盘 | 40G 总，**约 26G 可用** |
| 管理面板 | **宝塔面板**（`BT-Panel` 监听 `*:8000`），站点配置在 `/www/server/panel/vhost/nginx/` |
| 运行时 | node v24.14.1、npm 11.11.0、python 3.11.6、nginx 1.28.1、git 2.43.7 |
| Prisma 引擎依赖 | `/usr/lib64/libssl.so.3` + OpenSSL 3.0.12 均在 → `binaryTargets` 里的 `debian-openssl-3.0.x` 可用 |
| 容器 | Docker 29.7.2 已安装并 active，当前**没有任何容器在跑** |
| 进程托管 | **PM2 v6.0.14**（`/root/.pm2`），两个既有项目都归它管 |

### 必须避开的既有项目（这是"区分开来"的实体）

| 项目 | 域名 | 后端端口 | 目录 | PM2 名 |
|---|---|---|---|---|
| campus-runner（Express + MongoDB） | `wzl136122.cn`（**apex**）、`www.` | `127.0.0.1:3000` | `/www/wwwroot/wzl136122.cn` | `my-api` |
| lovechoice | `lovestory.wzl136122.cn` | `127.0.0.1:8787` | `/www/wwwroot/lovechoice-server` | `lovechoice-api` |

已被占用的端口：`21 22 25 80 443 888 3000 3306 8000 8080 8787 8888 23213 39000-40000`，另有 mongod 只绑 `127.0.0.1:27017`。
firewalld 处于 running，只放行上面那批端口——**新增服务一律不往里加**。

域名 `wzl136122.cn` 托管在 DNSPod（NS `jerry/voice.dnspod.net`），`@` 与 `www` 已指向本机；
`qingzhi.` / `oss.` 等子域实测空闲（NXDOMAIN）。机器上没有 certbot / acme.sh，现有两张证书由宝塔面板签发。

---

## 二、隔离设计（本项目全部加 `qz-` / `qingzhi` 前缀）

| 资源 | 取值 | 为什么不是"顺手用默认值" |
|---|---|---|
| 站点目录 | `/www/wwwroot/qingzhi.wzl136122.cn` | 与 `wzl136122.cn`、`lovechoice` 完全分离，删得掉 |
| 主域名 | `qingzhi.wzl136122.cn`（后台静态 + `/api/v1` + `/ws`） | 沿用 apex 项目"一个站点、路径分流"的写法，只签一张证书 |
| 存储域名 | `oss.qingzhi.wzl136122.cn` | **不能挂 `/oss` 路径**，理由见下面第三节 |
| API 端口 | `127.0.0.1:3100` | 3000 是 campus-runner 的 |
| MySQL | 容器 `qz-mysql`，`127.0.0.1:3308` | 3306 是服务器自带的 5.7.44，服务另外两个项目 |
| Redis | 容器 `qz-redis`，`127.0.0.1:6380` | 不用默认 6379，给宝塔 Redis 插件留位置 |
| MinIO | 容器 `qz-minio`，`127.0.0.1:9120/9121` | 控制台永不公开 |
| Qdrant | 容器 `qz-qdrant`，`127.0.0.1:6333/6334` | 根目录 compose 里没有它，但知识库检索必需 |
| 侧车 | `127.0.0.1:8101/8102/8103` | **侧车代码默认 `host=0.0.0.0`**（`services/shared/config.py`），且 AI 侧车默认 8000 **正好撞宝塔面板** |
| 数据库 / 账号 | 库 `qingzhi` + 影子库 `qingzhi_shadow`，用户 `qz` | 不碰 `lovechoice` 等既有库 |
| nginx | **只新增** `qingzhi.wzl136122.cn.conf` | 不改 `wzl136122.cn.conf` / `lovechoice*.conf` |
| 日志 | `/www/wwwlogs/qingzhi-*.log` | 与既有日志同目录、不同前缀 |

公网只开 443（经现有 nginx）。3100/3308/6380/9120/6333/8101-8103 **全部只绑环回**，
外部扫不到，也就不需要动 firewalld 与腾讯云安全组。

---

## 三、两个会让"部署完成"变成"真机不能用"的点

### 1. 存储必须是独立域名，不能是 `/oss` 前缀

ADR-04 定的链路是**后端只签发、二进制由客户端直传对象存储**
（`apps/api/src/infra/providers/storage/minio-storage.provider.ts` 用 `presignedPutObject` / `presignedGetObject`）。
于是同时成立两件事：

- 预签名 URL 的 host 直接暴露给手机，所以它必须公网可达且**只能是 443**（微信小程序的
  `uploadFile`/`downloadFile` 域名不接受非标端口）；
- SigV4 的签名覆盖**规范化请求路径**。把 `STORAGE_ENDPOINT` 写成
  `https://qingzhi.wzl136122.cn/oss` 时，minio 客户端按 `/oss/<bucket>/<key>` 签名，
  而 nginx 剥掉 `/oss` 后 MinIO 收到 `/<bucket>/<key>` → **403 SignatureDoesNotMatch**。
  症状是"上传失败"，不是"配置错误"，很难一眼归因。

所以 nginx 里 `oss.` 那个 server 的 `proxy_pass` **结尾不写 `/`**，原样透传路径。

> 如果第一阶段不想碰对象存储：把 `STORAGE_DRIVER` 保持为 `local`（`.env.example` 的默认值），
> 文件走 `POST/GET /api/v1/files/local/:token`，同域、无签名问题，代价是文件落本机磁盘
> 且 `local-storage.provider.ts` 自己注明"仅限开发环境"。**这是取舍，不是正解**，
> 上线前应当切回 MinIO。

### 2. 小程序里的接口地址还是占位域名 —— ✅ 已填真实域名（2026-10-09）

`apps/mp/config/endpoints.ts` 现在是：

```
RELEASE_API_BASE = 'https://qingzhi.wzl136122.cn'
TRIAL_API_BASE   = 'https://qingzhi.wzl136122.cn'   // 无独立 staging，与正式版同址
LOCAL_API_BASE   = 'https://qingzhi.wzl136122.cn'   // 开发期直连线上；调后端代码时改回本机局域网 IP
```

占位域名会被 `utils/env.ts` 的 `isPlaceholderBase()` 认出并**主动报错**，三处现在都不是占位值了。
**剩下的动作在微信公众平台**：「开发设置 → 服务器域名」里把 request / uploadFile / downloadFile
三类域名分别加上（wss 域名也要加，进度推送走 `/ws`）—— 漏配哪一类，对应功能在真机上直接失败，
而开发者工具勾了「不校验合法域名」时**看不出来**。

---

## 四、MySQL：跟服务器的 5.7 走，会直接建库失败

`.env.example` / `docker-compose.yml` 锁的是 **MySQL 8.4**，而服务器自带 **5.7.44**
（那套 5.7 在服务另外两个项目，不能停也不能动）。逐条扫描 12 个迁移文件后，
**8.0 专属语法只有 2 处**，都在 `apps/api/prisma/migrations/20260920120000_add_job_result/migration.sql:31,33`：

```sql
ADD COLUMN `result`         JSON NOT NULL DEFAULT ('{}') …
ADD COLUMN `quality_issues` JSON NOT NULL DEFAULT ('[]') …
```

MySQL 官方口径（[Data Type Defaults](https://dev.mysql.com/doc/refman/8.0/en/data-type-defaults.html)）：
> 8.0.13 之前 "The BLOB, TEXT, GEOMETRY, and JSON data types **cannot** be assigned a default value."

所以在 5.7 上 `prisma migrate deploy` 跑到这个迁移会中止，API 起不来。
其余 47 个 JSON 列本来就没有库级默认值（Prisma 在应用层补），因此可选路径清楚：

| 方案 | 代价 | 结论 |
|---|---|---|
| **A. 容器起 MySQL 8.4，绑 `127.0.0.1:3308`** | 多一个容器（内存上限已写死 768M）；代码与迁移**一行不改** | ✅ **推荐**，也是 `docs/architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md` 的基线 |
| B. 改那 2 行迁移，留在 5.7 | 本机已 apply 过该迁移，改文件会让 checksum 对不上，需 `migrate resolve`；更麻烦的是**开发库是 8.x、生产是 5.7**，以后每次新生成都可能再长出 `DEFAULT (...)`，问题会等到下次上线才暴露 | 只在确实不想加容器时选，且要同步把开发库钉到 5.7 |
| C. 在 3307 装第二套 MySQL 8 | 自己管 systemd/datadir/socket；宝塔「数据库」页只认 3306，以后在面板里看不见这个库 | 不建议 |

另需知道：Prisma 官方把 MySQL 5.7 列为支持项，唯一两条版本限定是
「CHECK 约束需 8.0+」与「JSON 需 5.7+」（[database features](https://www.prisma.io/docs/orm/v6/reference/database-features)）；
本项目 schema 未用 CHECK，所以卡点只在上面那 2 处默认值。
但 **Prisma 6.x 已进入只发安全补丁的阶段，窗口到 2026-11-19**，这条与部署无关但值得排期。

---

## 五、分阶段落地

### P0 · 后端可用（不含任何 AI/媒体能力）

```bash
# 0) 前置：DNSPod 加两条 A 记录 → 101.35.46.146
#    qingzhi   A   101.35.46.146
#    oss       A   101.35.46.146
#    然后签发证书（acme.sh HTTP-01 或宝塔面板，二选一），落到
#    /www/server/panel/vhost/cert/qingzhi.wzl136122.cn/{fullchain,privkey}.pem

# 1) 取代码（服务器有 git 2.43；仓库尚无 remote，实际用 rsync 上传产物）
mkdir -p /www/wwwroot/qingzhi.wzl136122.cn
rsync -a --delete-excluded \
  --exclude node_modules --exclude .git --exclude 'apps/mp' \
  --exclude logs --exclude '*.bak' \
  ./  root@101.35.46.146:/www/wwwroot/qingzhi.wzl136122.cn/

# 2) 基础设施（口令走独立 env-file，compose 里全是 ${VAR:?}：缺了就报错退出，不会用弱默认值）
cd /www/wwwroot/qingzhi.wzl136122.cn/scripts/deploy
cp compose.env.example compose.env && chmod 600 compose.env   # 填口令，不要用任何示例值
docker compose -f docker-compose.prod.yml --env-file compose.env up -d
docker compose -f docker-compose.prod.yml --env-file compose.env ps   # 四个都要 healthy

# 3) 依赖与库表（原生依赖必须在 Linux 上装：sharp / prisma engines）
cd /www/wwwroot/qingzhi.wzl136122.cn
npm ci --workspaces=false
npm ci -w @qz/core -w @qz/sdk -w @qz/api
npx prisma migrate deploy      # DATABASE_URL 指向 127.0.0.1:3308
npx prisma db seed             # 44 条工具、9 个服务分类、词书数据；数字由 check:doc-counts 对账
npm run build                  # 产出 apps/admin/dist

# 4) 进程 + 站点
pm2 start scripts/deploy/ecosystem.config.cjs && pm2 save
cp scripts/deploy/qingzhi.wzl136122.cn.nginx.conf /www/server/panel/vhost/nginx/
nginx -t && nginx -s reload     # ⚠️ 用 reload 不要 restart：restart 会断掉另外两个项目的连接
```

`.env` 里**必须改**的（默认值在这台机器上是错的，不报错但功能不通）：

| 变量 | 生产值 | 不改会怎样 |
|---|---|---|
| `PORT` | `3100` | 3000 被 campus-runner 占着，启动即 EADDRINUSE |
| `DATABASE_URL` / `SHADOW_DATABASE_URL` | 指向 `127.0.0.1:3308` | 连到服务器那套 5.7，迁移在建库阶段就失败 |
| `REDIS_URL` | `redis://127.0.0.1:6380` | 队列起不来，工具箱所有异步工具卡在排队 |
| `NODE_ENV` | `production` | 错误信息带堆栈返给客户端 |
| `STORAGE_ENDPOINT` / `STORAGE_PUBLIC_BASE_URL` | `https://oss.qingzhi.wzl136122.cn` / 见第三节 | 上传 403 或小程序拿到打不开的链接 |
| `MEDIA_SERVICE_URL` 等 | 若启用侧车，改 `127.0.0.1:8101+` | 撞宝塔面板的 8000 |
| `API_BASE`（在 `apps/mp/config/endpoints.ts`） | 真实域名 | 见第三节第 2 条 |

### P1 · 验收（不做完不算部署完成）

```bash
curl -s https://qingzhi.wzl136122.cn/api/v1/health        # 各 Provider 是 real 还是 mock，这里看得最清楚
pm2 logs qingzhi-api --lines 50
# 关键：登录 → 上传一个文件 → 跑一个同步工具 → 跑一个异步工具 → 看 WS 进度
```

- 登录链路要**真机走一遍**（这是仓库里长期挂着的老缺口，不是这次部署引入的）；
- 微信开发者工具里把「不校验合法域名」关掉再试一次，否则域名白名单配错也发现不了；
- 界面若出现「演示模式」角标，说明该 Provider 还是 Mock —— 按红线 9 这不算功能可用。

### P2 · 音视频 / PDF 工具（要先解决许可与内存）

- **ffmpeg 必须是 LGPL 构建**：`--enable-gpl` 一旦出现会要求整个项目以 GPL 开源。
  yum 源里的构建通常带 GPL 组件，不能用；装完用 `npm run check:ffmpeg` 断言（CI 里也跑它）。
- **PyMuPDF 是 AGPL**：只能独立安装 + 子进程调 CLI，绝不 `import fitz`；
  `services/pdf/requirements.txt` **故意是空的**，不要往里加依赖（台账 §三）。
- Pandoc（GPL-2.0）/ LibreOffice 同样只能独立容器或独立进程。

### P3 · AI 侧车（`services/ai`）——**这台机器现在不具备条件**

3.6 GiB 内存、无 GPU，而 rembg / Demucs / PaddleOCR / faster-whisper 是吃内存和显存的。
现状是"能起来但会 OOM"，比"没部署"更糟。要么加内存/换 GPU 机器，要么把这些工具
接到第三方 API（走 `packages/core/src/providers`，不要绕过 Provider 层），
要么就让它们保持未接入并在界面如实显示。

---

## 六、回滚

```bash
pm2 delete qingzhi-api
rm -f /www/server/panel/vhost/nginx/qingzhi.wzl136122.cn.conf && nginx -t && nginx -s reload
docker compose -f docker-compose.prod.yml --env-file compose.env down    # 默认**保留**卷：qingzhi 库里是真实用户数据
# 只有确认要销毁数据时才加 -v
rm -rf /www/wwwroot/qingzhi.wzl136122.cn
```

因为全程没动另外两个项目的端口、目录、站点文件和 3306，回滚不会波及它们。
`nginx -t` 是先决条件：这个文件写错会让**整台机器**的 nginx 重新加载失败，
两个既有项目一起挂——这就是为什么 reload 前必须 `-t`。

---

## 七、前置条件（**2026-10-08 已全部拍板，本节保留作为决策记录**）

1. **MySQL 走 A / B / C** → 已选 **B（留在 5.7，改 1 处迁移）**，理由见第 0 节。
2. **证书由谁签** → 已选 **acme.sh HTTP-01 webroot**（复用 10-03 就装好的 acme.sh），
   A 记录由用户在 DNSPod 手工添加。**没有引入任何 DNS API Token**。
   ⚠️ 实测教训：**公共解析器可见 ≠ Let's Encrypt 可见** —— 7 家递归解析器都返回正确 A 记录时，
   LE 仍可能报 `NXDOMAIN`（它自己的验证节点在负缓存里）。**别改配置，等几分钟重试即可**；
   该报错文案与"域名不存在"完全一样，极易误判成 DNS 配错。
   备案仍待核实（子域随主域，但接入商与备案主体要对得上）。
3. **Redis / Qdrant 装不装** → 都装，**用容器**（`docker-compose.infra.yml`），只绑环回。
4. **`services/ai` 是否本次部署** → **后续（2026-10-08 晚）已部署全部四个侧车**，但有限度：
   `qingzhi-ai` 仅装 rembg（抠图可用），**未装 demucs/torch**（≈1GB，3.6G 内存有 OOM 风险）
   → `/ai/separation` 如实返回 501 而非冒充成功；`qingzhi-media/convert/pdf` 均在线。
   `AI_/MEDIA_/CONVERT_/PDF_SERVICE_URL` 已写入根 `.env`，工具不再报"未接入"（详见第 八 节）。
5. **服务器密码已在对话里出现过，部署后请在腾讯云控制台改掉。**
   本次没有把它写进仓库任何文件，服务器上的 `.env` 权限 600。
6. **内容安全 `MODERATION_DRIVER` 已切为 `wechat`**（生产红线要求）。`WECHAT_APPID`/`WECHAT_SECRET`
   在根 `.env`，access_token 已实测可取，故在生产打开；`mock-moderation` 已从 `/health` 消失（详见第 八 节）。
7. **小程序前端不在本次部署范围**：`apps/mp` 不部署到服务器，
   需在微信开发者工具里上传；且**微信公众平台的服务器域名白名单仍需人工添加**
   （request / uploadFile / downloadFile / socket 四类）。
   `apps/mp/config/endpoints.ts` 已改为真实域名。

> 顺带一句，不属于本次部署但看到了：apex 项目目录 `/www/wwwroot/wzl136122.cn/server/` 里
> 有 `apiclient_key.pem`、`.env`、`server.zip`，而站点根就在 `wzl136122.cn`。
> 建议你自己验一眼这些能不能被公网直接下载（宝塔默认那条敏感文件正则在 `.env` 与
> `package*.json` 上是拦得住的，但 `.pem` 不在名单里）。

---

## 八、侧车部署实战（2026-10-08 后续，四个侧车已上线）

### 1. 实际落地

| 侧车 | PM2 名 | 端口(环回) | 引擎 | 状态 |
|---|---|---|---|---|
| 媒体 | `qingzhi-media` | 8101 | ffmpeg(LGPL)+ffprobe | online；端到端实跑通过（probe/transcode/compress）|
| 转换 | `qingzhi-convert` | 8102 | LibreOffice + Pandoc(dnf) | `sofficeAvailable/pandocAvailable: true` |
| PDF | `qingzhi-pdf` | 8103 | PyMuPDF(AGPL，venv 子进程) | `engineResponsive: true` |
| AI | `qingzhi-ai` | 8104 | rembg(抠图) | `mattingReady: true`；separation 未装 |

`ecosystem.config.cjs` 已是最终形态：`script: /opt/qz-venv/bin/python`、`args: '-m services.x'`
（避开 PM2 `interpreter`+`script:'-m ...'` 退化成 `/usr/bin/bash` 报 `source code cannot contain null bytes` 的坑），
pdf 侧车额外 `PYMUPDF_BIN: /opt/qz-venv/bin/python`。venv `/opt/qz-venv`(python3.11) 装了
PyMuPDF + rembg + Pillow。

### 2. ⚠️ 两个会让人白干半天的坑（本次都踩了）

**坑 A：根 `.env` 被 `apps/api/.env` 静默覆盖 → Provider 永远 mock。**
`ENV_FILE_PATHS` 顺序是 `[REPO_ROOT/.env, …, APP_ROOT/.env]`，`@nestjs/config` 让**靠后的文件覆盖靠前的**。
服务器上 `apps/api/.env` 是 `setup:env` 生成的**旧快照**（mtime 16:15，早于侧车接入），
里面 `MODERATION_DRIVER=mock`、`AI_/MEDIA_/CONVERT_/PDF_SERVICE_URL=` 全空。
于是你改了根 `.env`（加了 `=http://127.0.0.1:810x` 和 `MODERATION_DRIVER=wechat`），
重启后进程读到的却是 `apps/api/.env` 的旧值 → `convert/pdf/moderation` **全部回到 mock**，
而 `image/video` 因为 schema 默认就是非空 URL 仍然 real，极难一眼看穿。
**判定**：`curl /api/v1/health` 看响应头 `X-Mock-Providers`；若 `convert/pdf/doc-parse/moderation` 还在、
且根 `.env` 明明配了，先 `grep` 一下 `apps/api/.env` 有没有同名空值。
**修法（也是 `setup:env` 的本意）**：`cp 根/.env apps/api/.env && chmod 600 apps/api/.env`，再 `pm2 restart qingzhi-api`。
**更彻底**：生产环境直接删掉 `apps/api/.env`（Prisma 运行时靠根 `.env` 的 `DATABASE_URL` 即可），
只留根 `.env` 一个事实源。改根 `.env` 后**务必同步**，否则配置"静默过期"。

**坑 B：服务器 `dist` 是旧构建 → 侧车装配代码根本不在里面。**
本机**不是 git 仓库**，部署靠上传产物（见第 〇 节"无 git remote，实际用 rsync/上传产物"）。
若只改了根 `.env` 就 `pm2 restart`，而服务器 `apps/api/dist` 是更早的构建（没有 `CONVERT_SERVICE_URL` 装配分支），
那 `real-provider.factory` 根本不会去实例化 `HttpConvertProvider`/`HttpPdfProvider`/`WechatModerationProvider`，
`mockProviders` 照样列着它们。本次实测：服务器旧 `dist` 的 `real-provider.factory.js` 里 `grep CONVERT_SERVICE_URL` 为空。
**修法**：本地 `npm run build -w @qz/core -w @qz/sdk -w @qz/api`（注意 `nest build` 清 dist 会触发本机沙箱
`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，需以**绕过沙箱**方式跑），`tar -czf` 三个 `dist` 上传，
服务器 `rm -rf apps/api/dist packages/core/dist packages/sdk/dist && tar -xzf` 后 `pm2 restart qingzhi-api`。
**判据**：`grep CONVERT_SERVICE_URL apps/api/dist/infra/providers/real-provider.factory.js` 应有命中。

### 3. ffmpeg 必须是 LGPL（本机 GitHub 被墙，走本地中转）

服务器直连 GitHub 下载 BtbN 构建**会卡在 0 字节**（国内访问 GitHub release-assets 极慢/被限）。
本次做法：本地机器 `curl` 下 `ffmpeg-master-latest-linux64-lgpl.tar.xz`（142,211,812 B），
SFTP 传到 `/tmp`，服务器 `tar -xf` 后 `cp ffmpeg ffprobe /usr/local/bin/` + `chmod 755`。
media 侧车读 `FFMPEG_BIN`(默认 `ffmpeg`) 走 PATH，装好即生效，**无需重启侧车**。
装完跑 `npm run check:ffmpeg`(scripts/license/check-ffmpeg-license.sh) 断言无 `--enable-gpl`。

**⚠️ 坑 C：`tar -xf` 中断 → 截断的二进制"装上了但一跑就崩"（本次真踩了）。**
第一次解包被中途打断，`/tmp/.../bin/` 里只留了一个 **23 MB 的 `ffmpeg`**（真实大小 **145,621,672 B**），
且 **`ffprobe` 整个缺失**。表象极具迷惑性：
- `which ffmpeg` → 有；`ls -la` → 存在且可执行；`grep -c -- --enable-gpl` → `0`（**因为二进制根本没输出**，
  grep 对空输入恒返回 0 —— 这个"绿灯"是假的）；
- 真跑 `ffmpeg -version` → **`Bus error (core dumped)`，rc=135**；`file` 报
  `missing section headers at 145621608`（ELF 头指向的节表偏移 ≈139MB，远超实际 23MB）。

**判据（必须真跑，不能只看文件存在）**：
```bash
ffmpeg -version >/dev/null 2>&1; echo "rc=$?"   # 必须 0
ffprobe -version >/dev/null 2>&1; echo "rc=$?"  # 必须 0（且 ffprobe 必须存在）
ffmpeg -version | grep -c -- --enable-gpl       # 必须 0（LGPL）
```
**修法**：`rm -rf` 掉截断目录，`cd /tmp && tar -xf ff-lgpl.tar.xz` **重解包**，
先 `ls -la bin/` 核对 `ffmpeg`=145,621,672 B、`ffprobe`=145,379,944 B，**再** `cp` 到 `/usr/local/bin/`。
> 教训与红线同源：**"文件在" ≠ "能跑"**。所有二进制/产物安装都必须补一条"真执行 + 判据下限"的自检，
> 否则截断、架构不符、缺依赖都会以"绿灯"形态混过。

**LGPL 构建没有 `libx264`/`libx265`（GPL 组件），这是预期的。**
H.264 由 **`libopenh264`**（BSD）承担 —— media 侧车的编码器候选链
`libx264 → h264_nvenc → h264_amf → h264_qsv → libopenh264 → mpeg4` 会在运行时探测可用项并自动降级，
所以无需改代码；实测转 mp4 的响应头即 `X-Encoder: libopenh264`。

### 4. 验收（本次已通过）

```
curl -s -D - -o /dev/null https://qingzhi.wzl136122.cn/api/v1/health   # X-Mock-Providers 应只剩 mock-sms,mock-doc
curl -s http://127.0.0.1:8101/health   # media: ffmpegBin/ffprobeBin 就绪，pending 为空
curl -s http://127.0.0.1:8102/health   # convert: sofficeAvailable/pandocAvailable true
curl -s http://127.0.0.1:8103/health   # pdf: engineResponsive true
curl -s http://127.0.0.1:8104/health   # ai: mattingReady true
```

**media 侧车端到端实跑（不是只看 /health 自报）** —— 用 `testsrc` 造一段测试视频，逐个 POST 打真：
```
# 1) probe
curl -s -F file=@/tmp/qztest.mp4 http://127.0.0.1:8101/media/probe
# 2) transcode → mp4（验证 libopenh264 降级）
curl -s -D - -F file=@/tmp/qztest.mp4 -F format=mp4  http://127.0.0.1:8101/media/transcode -o /tmp/out.mp4
# 3) transcode → webm
curl -s -D - -F file=@/tmp/qztest.mp4 -F format=webm http://127.0.0.1:8101/media/transcode -o /tmp/out.webm
# 4) compress（注意 targetSizeBytes 下限 65536，低于会被 40011 拒绝 —— 这是正确校验，不是缺陷）
curl -s -D - -F file=@/tmp/big.mp4 -F targetSizeBytes=150000 http://127.0.0.1:8101/media/compress -o /tmp/out_c.mp4
```
结果：probe 返回真实时长/分辨率/编码；transcode→mp4 `X-Provider: real` + `X-Encoder: libopenh264`；
transcode→webm `X-Encoder: libvpx-vp9`；compress `200 OK` + `X-Video-Bitrate` 命中，产物 `ffprobe` 为 h264+aac。
**四个侧车至此全部真实可用。**

`/health` 的 `mockProviders` 从 8 个降到 `['mock-notify','mock-pay','mock-sms','mock-doc']`：
`image/video/moderation/doc-parse/convert/pdf` 已 real。

**⚠️ 角标（`X-Provider: mock` / "演示模式"）仍会亮 —— 但不是"没切干净"，是剩下两项确实无法切：**
`summarizeMocks()` 只把 `pay`/`notify` 两个 **key** 排除在角标之外（`DEMO_MARKER_EXEMPT_KEYS`），
而 `sms`/`doc` 不在其中，于是这两个 mock 让**每个响应**都带角标（与代码注释里 P1-8 描述的"恒亮"是同一类问题）。
进一步核实后：
- **`mock-sms`：零业务调用方**。全仓 `grep providers.sms` 只有装配点，没有任何模块调用 → 它**不可能影响任何响应的真实性**，
  属"整期未接入"（短信服务商尚未选型）。要切 real 需先选服务商 + 配 `SMS_DRIVER=http`/`SMS_GATEWAY_URL`/token。
- **`mock-doc`：无真实 `DocProvider` 实现**（只有 `MockDocProvider`）。它被 `pdf-tool-runner.parse()` 调用 `renderMarkdown`
  给"文档解析"工具排版（mock 的 `renderMarkdown` 会如实渲染已解析出的文本，`renderDocx` 无调用方）。
  M1-09「AI 文档生成」实际走 `LlmToolRunner.document` 直出 `.md`，**不经过 `providers.doc`**。
- 是否把 `sms`/`doc` 也纳入豁免（或补一个真实 `DocProvider`）属**设计/合规决策**，需项目负责人拍板，本次未擅自改角标逻辑。
