# packages/ —— 跨端共享库

判据：**不启动、不部署，只被 import**。含端侧 API（`wx.*`、Express、Prisma）的代码
一律不许放进来。

| 包 | npm 名 | 内容 | 谁在用 |
|---|---|---|---|
| `core/` | `@qz/core` | 枚举、错误码、状态机、zod 校验、金额/时间/脱敏/ID 工具、**Provider 接口 + Mock 实现** | `apps/api`、`apps/mp`、`@qz/sdk` |
| `sdk/` | `@qz/sdk` | 跨端 API SDK（fetch 版，供 H5 / 管理后台） | `apps/admin`（待落地） |

## 为什么业务规则要放 `core`

状态机、金额、错误码、校验规则一旦两端各写一份，就会出现"前端允许、后端拒绝"的死循环 bug。
`core` 是这些规则的唯一实现处，改它必须补单测（`npm test`）。

## 构建约定

- 纯 TypeScript，`strict` 全开，只依赖 zod；
- 入口统一 `src/index.ts` 做 barrel 导出，子目录各自有 `index.ts`；
- 产物在 `dist/`（`main` / `types` 指向它）。**改完 `core` 必须重新 build**，
  否则 `apps/api` 会对着旧 `dist` 做类型检查，出现"源码已改、报错还在"的假象。

```bash
npm run clean && npm run build
```

## 故意不建的包

`packages/ui`：小程序用原生 WXML、管理后台尚未开工，共享 UI 现在**没有第二个消费者**。
等 `apps/admin` 落地、真的出现重复组件时再抽，避免提前抽象。
