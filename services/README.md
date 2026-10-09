# services/ —— Python 侧车服务

NestJS 主后端（`apps/api`）负责业务与编排；AI 与媒体能力放在 Python 侧，
因为 Whisper / Demucs / PaddleOCR / rembg 只在 Python 生态成熟（决策见 ADR-08）。

| 服务 | 包 | 默认端口 | 环境变量 | 启动 |
|---|---|---|---|---|
| AI 能力 | `services/ai` | 8000 | `AI_HOST` / `AI_PORT` | `npm run dev:ai` |
| 媒体处理 | `services/media` | 8001 | `MEDIA_HOST` / `MEDIA_PORT` | `npm run dev:media` |

## 目录约定

```
services/
├── shared/            # 两个服务共用的代码（勿在各自包里复制一份）
│   ├── config.py      #   .env 读取 + 公共 BaseSettings
│   ├── http.py        #   HTTP 骨架：/health、501 未实现、404、Mock 标记
│   └── logging.py     #   单行 JSON 结构化日志（与 Node 端 AppLogger 同构）
├── ai/
│   ├── __main__.py    # 入口：python -m services.ai
│   ├── settings.py    # AiSettings（模型白名单等）
│   ├── routes.py      # 端点注册表：(方法, 路径) -> 能力说明 + 任务编号
│   └── requirements.txt
└── media/             # 同构
```

## 运行

```bash
# 必须在仓库根执行（模块路径以 services 为包根）
python -m services.ai
python -m services.media

curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8001/health
```

`npm run dev:ai` / `npm run dev:media` 就是上面两条命令的别名。

## 骨架阶段的契约（红线 10）

* `/health` 立即返回 200，冒烟检查（`npm run smoke`）依赖它；
* 业务端点一律 **501 + code 50341**，明确"能力未实现"，不返回假数据；
* 所有响应带 `X-Provider: mock` 与 `X-Service-Stage: skeleton`，前端据此显示"演示模式"角标。

换成 FastAPI 实现时：只替换服务器部分，`routes.py` 的端点清单与错误码保持不变。

## 许可纪律

* **FFmpeg 必须是 LGPL 构建**：`npm run check:ffmpeg`（`scripts/license/check-ffmpeg-license.sh`）；
  Python 侧只以子进程调用 CLI，不链接 `libav*`。
* 抠图只用白名单模型（`u2net`）；`isnet` / `birefnet` 许可受限（设计文档 2.8.4）。
* 新增任何 Python 依赖前，先在 `docs/compliance/OPEN_SOURCE_LICENSES.md` 登记。
* LibreOffice / Pandoc / ConvertX 等 GPL/AGPL 组件**绝不装进这里**，必须独立部署（ADR-05）。
