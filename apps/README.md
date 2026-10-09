# apps/ —— 可独立运行的应用

每个子目录是一个独立应用（有自己的 `package.json`，能被启动或上传）。
能被两端复用的逻辑不放这里，放 `../packages/`。

| 目录 | 是什么 | 状态 | 启动 |
|---|---|---|---|
| [`api/`](./api/README.md) | **后端主服务** · NestJS + Prisma | ✅ 可运行 | `npm run dev:api` |
| [`mp/`](./mp/README.md) | 微信小程序 · 原生 + TypeScript | ✅ 可编译 | 开发者工具导入**仓库根** |
| [`admin/`](./admin/README.md) | 管理后台 · React + Vite | ⬜ 预留（M0-23） | — |

> 小程序工程配置 `project.config.json` 在仓库根（通过 `miniprogramRoot` 指向 `mp/`），
> 不在 `mp/` 下 —— 原因见 [`../docs/dev/WECHAT-DEVTOOLS.md`](../docs/dev/WECHAT-DEVTOOLS.md)。
