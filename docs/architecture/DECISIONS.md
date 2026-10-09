# 架构决策索引（ADR）

> 完整正文在 `../product/青智校园_小程序详细设计文档_V2.md` 附录（ADR 表）。
> 这里只放"一句话结论 + 影响范围"，方便从代码注释里的 `ADR-xx` 快速定位。
> 新增/推翻决策时：先改设计文档附录，再更新本索引。

| 编号 | 决策 | 结论 | 代码里体现在哪 |
|---|---|---|---|
| **ADR-01** | 小程序主端技术栈 | **原生 + TypeScript**，不用 Taro / uni-app | `apps/mp/`；业务逻辑下沉到 `packages/core` 以便 H5 复用 |
| **ADR-02** | 任务编排层 | **自研轻量编排**（借鉴 Dify/n8n/LangGraph 的状态机与 HITL 思想，不引入其依赖） | `packages/core/src/state-machine/plan.ts`；M2 的 `modules/os` |
| **ADR-03** | 重型媒体任务 | **异步队列**（Redis Stream），小程序用轮询 + WebSocket 双通道推进度 | `packages/core/src/state-machine/job.ts`；`QUEUE_DRIVER` |
| **ADR-04** | 文件上传 | **前端直传对象存储**，后端只签发临时签名与确认 | `packages/core/src/providers/types.ts`（`signUpload`）；`STORAGE_*` |
| **ADR-05** | 文档转换（LibreOffice / Pandoc / ConvertX） | **独立部署 + HTTP 调用**，隔离 GPL/AGPL 传染与资源竞争 | `CONVERT_SERVICE_URL`（留空则该能力返回 50362） |
| **ADR-06** | 账号模型 | **一账号多身份**（不是两端各注册一次） | `packages/core/src/enums`（Role）；`apps/api/src/modules/user/user.service.ts` 切换身份 |
| **ADR-07** | 交易资金 | **担保交易**：钱先进平台托管账户，验收后放款 | `packages/core/src/state-machine/order.ts`；`PLATFORM_FEE_*` |
| **ADR-08** | 后端语言 | **双语言分工**：NestJS 管业务与 BFF，FastAPI 管 AI 与媒体 | `apps/api/` + `services/{ai,media}/` |
| **ADR-09** | ~~PostgreSQL + JSONB~~ | ⚠️ **已被 ADR-13 取代** | — |
| **ADR-10** | 编排规模 | 首版**不引入 K8s**，用 Docker Compose | `docker-compose.yml` |
| **ADR-11** | ~~pgvector 起步~~ | ⚠️ **已被 ADR-13 取代**（MySQL 无 pgvector，向量检索改外接 Qdrant） | M4-06 |
| **ADR-12** | 人声分离 | **不用 UVR**，直连 Demucs / spleeter（UVR 权重多为 Research Only） | `VOCAL_SEPARATION_ENGINE`；`services/ai/settings.py` |
| **ADR-13** | 数据库 | **改用 MySQL 8**（2026-09-17）。代价已评估并接受：无 JSONB 索引、无标量数组、无 pgvector、改用 FULLTEXT | `apps/api/prisma/schema.prisma`；`DB-MIGRATION-POSTGRES-TO-MYSQL.md` |
| **ADR-14** | 向量库（RAG / M4-06） | **外接 Qdrant**（2026-09-18 落地）。MySQL 8 无向量能力，ADR-13 已排除 pgvector，故 RAG 走独立向量库；未配 `VECTOR_DRIVER=qdrant` 时回退进程内 `MockVectorProvider` 并打 `mock-vector` 标（红线 10） | `apps/api/src/infra/providers/vector/qdrant-vector.provider.ts`；`VECTOR_DRIVER` / `QDRANT_*` / `RAG_*`；`docs/dev/ENV.md` 10c |

## 怎么读这些决策

- 想知道"为什么不能直接 `new OpenAI()`" → ADR-02 / 红线 9，实现见 `apps/api/src/infra/providers/`；
- 想知道"为什么 MySQL 里到处是 JSON 字符串" → ADR-13，见 `../db/README.md`；
- 想知道"为什么有个单独的转换服务" → ADR-05 + `../compliance/OPEN_SOURCE_LICENSES.md`；
- 想知道"为什么 RAG 要单独跑一个 Qdrant" → ADR-14 + `../dev/ENV.md` 的 10c；
- 想知道"为什么小程序不用跨端框架" → ADR-01。

## 记录一条新决策的模板

```markdown
### ADR-NN：<一句话标题>
- 状态：提议 / 采用 / 已取代 ADR-xx / 已被 ADR-xx 取代（日期）
- 背景：为什么现在必须决定
- 备选：A / B / C 及各自代价
- 结论与理由：选了什么，为什么
- 影响：要改哪些目录 / 配置 / 文档
```
