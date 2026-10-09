## 变更说明

<!-- 一句话说清这个 PR 做了什么 -->

## 关联任务

<!-- 关联 docs/product/青智校园_开发任务清单.md 的任务编号，如 M0-05 -->

- 任务编号：
- 所属里程碑：

## 服务哪条主链路

<!-- 执行守则第 1 条：不服务三条主链路的任务不进首版，请明确回答 -->

- [ ] L1：AI 文件加工（一句话 → 真实文件）
- [ ] L2：AI 编排 + 人力协同（办活动 → 驿站派单）
- [ ] L3：服务交易闭环（发布 → 支付 → 验收 → 评价）
- [ ] 不属于主链路（请说明必要性）：

## 影响范围

<!-- 勾选本次改动落在哪些层，帮助 reviewer 判断风险 -->

- [ ] `packages/core`（两端共用，**必须带单测**）
- [ ] `apps/api`（common / infra / modules）
- [ ] `apps/mp`（页面 / 请求层 / 样式）
- [ ] `services/*`（Python 侧车）
- [ ] 数据库 Schema + 迁移
- [ ] 配置（`.env.example` + `env.schema.ts` + `docs/dev/ENV.md` 三处已同步）
- [ ] 文档

## 自测与验收

<!-- 验收标准必须可观测、可复现（执行守则第 5 条） -->

- [ ] `npm run lint` 通过（0 error 0 warning）
- [ ] `npm run typecheck` 通过（含小程序端）
- [ ] `npm test` 通过
- [ ] `npm run build` 通过
- [ ] `npm run smoke` 通过（若改动了后端启动路径）
- [ ] 新增/修改的状态迁移已被单测覆盖（若涉及状态机）
- [ ] 接口改动已同步 `docs/api/README.md` 与设计文档

## 红线自查

- [ ] 未引入 License 不明确的依赖；新增依赖已登记到 `docs/compliance/OPEN_SOURCE_LICENSES.md`
- [ ] 未使用假数据冒充功能；Mock 走 `X-Provider: mock` 标记（红线 10）
- [ ] 单文件 ≤ 300 行、函数 ≤ 50 行、无 `any`（红线 8）
- [ ] 外部依赖均通过 Provider 接口访问，未直接调用第三方 SDK（红线 9）
- [ ] 样式只用 Design Token，未硬编码色值（红线 2）
- [ ] 涉版权功能已做服务端强制校验与审计（若涉及）
- [ ] 未在仓库根新增散落文件；未提交日志 / 构建产物 / `.bak`

## 截图 / 录屏

<!-- UI 改动请附截图；接口改动请附请求响应示例（含 traceId） -->
