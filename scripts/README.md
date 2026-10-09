# scripts/ —— 仓库级工具脚本

判据：**不随应用部署**，只在开发、初始化或 CI 里跑。按用途分目录，不按语言分目录。

| 目录 | 文件 | 作用 | 常用入口 |
|---|---|---|---|
| `db/` | `init-db.sql` | Docker 首次启动时建影子库并授权 | 由 `docker-compose.yml` 自动挂载 |
| | `mysql-bootstrap.sql` | 非 Docker：本机 MySQL 建库建账号 | `mysql -u root -p < scripts/db/mysql-bootstrap.sql` |
| `dev/` | `setup-env.mjs` | 生成根 `.env` 并同步一份给 Prisma | `npm run setup:env` |
| | `smoke.mjs` | 断言 `/health` 返回 200 且字段完整 | `npm run smoke`（CI 用 `--spawn`） |
| | `run-python.mjs` | 跨平台解析 Python 解释器（python3 / python / py） | `npm run dev:ai`、`npm run license:audit` |
| | `clean.mjs` | 清掉所有 `dist` 与 tsbuildinfo | `npm run clean` |
| `docs/` | `md2docx.py` | Markdown → Word（标题 / 表格 / 代码块 / 列表） | `npm run docs:docx -- <src.md> <dst.docx>` |
| `license/` | `license_audit.py` | 核查 npm / pip 依赖的 License | `npm run license:audit` |
| | `check-ffmpeg-license.sh` | 断言 FFmpeg 是 LGPL 构建 | `npm run check:ffmpeg` |

## 约定

- Node 脚本用 `.mjs`（ESM）+ 标准库，不引新依赖；头部注释必须写"为什么需要它"和用法；
- 脚本一律从**仓库根**执行（`npm run <script>` 已经是），内部路径按 `scripts/<类别>/<文件>` 写；
- 新增脚本先归到已有类别；确实没有合适类别再加新目录，并更新本表；
- 会写文件的脚本（如 `setup-env.mjs`）只能写 `.env` / `logs/`，不许改源码。
