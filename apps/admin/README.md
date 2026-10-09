# apps/admin —— 管理后台（React + Vite + TS）

**当前状态：可用。** 登录、权限、五大业务模块的列表 / 详情 / 表单 / 操作反馈都已落地。

## 跑起来

```bash
npm run dev:api      # 后端（另开一个终端）
npm run dev:admin    # 前端 → http://127.0.0.1:5173
```

默认账号 `admin` / `wzl88888`（仅本地开发库，生产必须改）。

前端**不写后端地址**：dev 走 Vite proxy（`/api` → `QZ_API_ORIGIN`，默认 `localhost:3100`），
生产由网关反代。换环境只改 `QZ_API_ORIGIN`，不用改代码、不用重新构建。

## 权限：只有一份真相

菜单显示什么、路由放行什么，全部来自**后端返回的 `permissions`**（`AuthContext` 的 `can()` / `hasAny()`）。

本地**不推导**角色能做什么 —— 角色→权限的矩阵在 `@qz/core` 的 `ADMIN_ROLE_PERMISSIONS`，
后端鉴权守卫用它，前端只消费结果。两边各写一份的结局是"菜单里看得见、点进去 403"。

角色存在 `admin_account` 表里而**不在 JWT 里**，所以停用/降权**立即生效**，不用等 token 过期。

`RequirePermission` 拿不到权限时显示"无权限"页，而**不是重定向**；静默跳转会让用户以为功能不存在。

## 令牌存 `sessionStorage`

后台能封号、能放款。`localStorage` 意味着关掉浏览器再打开还是登录态 —— 共用电脑上
下一个人打开就是别人的管理员身份。`sessionStorage` 随标签页关闭失效，等价于"关页面就退出"。

代价是"刷新保留、新开标签页要重登"，对后台是合理取舍。
`http.ts` 里 401 **不刷新 token**（后端没有 refresh 接口），直接清凭证 + 跳登录页。

## 目录

```
src/
├── auth/        AuthProvider · useAuth · PermissionGate · RequireAuth/RequirePermission
├── components/  Button/Tag/DataTable/Pagination/Toolbar/Modal/Confirm/Toast/Field/AsyncBoundary …
├── layout/      Sidebar（按权限过滤）· Topbar（面包屑）· AdminLayout
├── lib/
│   ├── api/     按域封装的接口（auth/dashboard/users/admins/content/jobs/orders）
│   ├── types.ts 与后端 service DTO 对应的前端契约类型
│   ├── status.ts 状态 → 文案/色调的唯一映射
│   ├── useAsync.ts 带"过期响应丢弃"的异步 hook
│   └── useForm.ts  复用 @qz/core 的 zod schema 做提交前校验
├── pages/       一页一目录（users/admins/content/tools/jobs/orders/audit + Dashboard/Account/404）
├── router.tsx   每个路由一条 RequirePermission（必须与 Sidebar 的过滤口径一致）
└── main.tsx
```

## 验证

```bash
npm run verify:admin      # 47 项端到端断言（需 dev:api + dev:admin 都在跑）
```

它打的是 **5173**（前端）而不是后端端口 —— 要证明"前端那条路通"：
Vite 代理、`lib/api/*` 里写的路径与载荷、后端 controller 路由三者必须严丝合缝。
这类错配的症状是 404 或"筛选没生效"，而不是报错，所以脚本逐个**断言读回来的数据**
（分页条数、详情 id 回显、列表能搜到刚建的数据、删除后不再出现），而不只看 HTTP 200。

写操作要么**自清理**（探针管理员：建 → 用 → 删），要么**写入当前值**（幂等）——
绝不"先封禁再恢复"，脚本中途挂掉就会把一个真实用户留在封禁态。

## 踩过的坑（改之前先看这里）

- **`server.host` 必须显式写 `127.0.0.1`。** Vite 5 默认 `host: 'localhost'`，Windows 上
  Node 解析 `localhost` 优先取 `::1`，dev server 于是**只监听 IPv6**：浏览器（会做 IPv4 回退）
  看着正常，但 `curl 127.0.0.1:5173`、Playwright、`verify:admin` 全部 `fetch failed`，
  报错长得像"服务没起"。
- **`@qz/core` / `@qz/sdk` 在 `vite.config.ts` 里 alias 到源码。** 这两个包按 Node 约定编译成
  CommonJS（后端需要），产物是 `__exportStar(require(...))`，Rollup 静态分析看不到具名导出，
  会报 `"HttpClient" is not exported by packages/sdk/dist/index.js`。指向源码后还顺带
  摆脱了"dist 不新就构建出与源码不符的产物"这个静默坑。
- **`@qz/core` 不能 import `node:*`。** 它号称跨端复用，一旦引入 Node 专有模块，
  只有打包器会发现（`tsc` 不会）—— `id.ts` 的 `node:crypto` 就是这么炸的，已改为 WebCrypto。
- **`.tsx` 关掉了 `max-lines-per-function`，但 `max-lines`（300 行）和 `complexity`（10）仍然生效。**
  详情页容易超复杂度，按职责拆子组件（页面骨架 / 分区 / 行渲染 / 弹窗分成独立函数）。
- **弹窗要条件挂载**（`{open ? <Modal/> : null}`），而不是靠 `open` prop 控制显隐 ——
  否则上次填的表单值会留在下一次打开里。
- 本地跑 `verify:*` 取 token 走登录夹具通道（`qz-dev:` 前缀，见 `scripts/dev/dev-login.mjs`），
  **不需要** `WECHAT_DEV_LOGIN=true` —— 那个开关会让小程序的登录一起变成假的。
