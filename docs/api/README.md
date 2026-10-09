# 接口契约

后端：`apps/api`（NestJS）。本文件描述**所有接口共同遵守的规则**；
单个接口的字段定义以 `@qz/core` 的 zod schema 为准（前后端同一份），
运行时可打开 Swagger：`http://localhost:3000/docs`（非生产环境）。

## 1. Base URL 与版本

```
{host}/api/v1/<资源>
```

- 由 `API_PREFIX`（默认 `/api/v1`）决定，`src/main.ts` 拆成全局前缀 `/api` + URI 版本 `v1`
  （拆分逻辑与用例见 `apps/api/src/common/config/api-prefix.ts`）；
- 破坏性变更升 `v2`；同一版本内只加字段不减字段、不改语义。

## 2. 统一响应体

成功（`src/common/interceptors/transform.interceptor.ts`）：

```json
{ "code": 0, "message": "ok", "data": {}, "traceId": "b7c2…" }
```

失败（`src/common/filters/global-exception.filter.ts`）：

```json
{
  "code": 40101,
  "message": "登录已过期，请重新登录",
  "data": null,
  "traceId": "b7c2…",
  "detail": {}
}
```

- `code` 是**业务码**，HTTP 状态码由 `packages/core/src/errors/codes.ts` 的映射决定。
  两者都要看：HTTP 判断"要不要重试"，`code` 判断"给用户看什么"；
- `message` 已是可直接展示的中文文案，前端不要自己维护文案表；
- `detail` 只在需要结构化信息（如参数级错误）时出现；
- **未知异常永远返回通用文案**，堆栈只进服务端日志（文档 6.12.2）。

错误码清单见 `../dev/ERROR_CODES.md`。

## 3. traceId

- 请求进来时 `LoggingInterceptor` 生成（或沿用请求头 `X-Trace-Id`）并写回响应头；
- 响应体的 `traceId` 与之一致，日志里也带它；
- 报障时给 traceId，不要截图整屏。

## 4. 鉴权

| 场景 | 做法 |
|---|---|
| 登录 | `POST /api/v1/auth/login`，body `{ code }`（`wx.login` 的临时凭证） |
| 携带凭证 | `Authorization: Bearer <accessToken>` |
| 免登录接口 | 控制器方法加 `@Public()`（如 `/health`、`/auth/login`、`/auth/refresh`） |
| 取当前用户 | 参数装饰器 `@CurrentUser()` |
| 续期 | `POST /auth/refresh`，body `{ refreshToken }`；小程序请求层在 401 时自动刷新并重放原请求，且并发去重 |

Token 有效期：`JWT_ACCESS_EXPIRE`（默认 2h）/ `JWT_REFRESH_EXPIRE`（默认 30d）。

## 5. 幂等

- **所有写接口（POST / PUT / DELETE）必须带 `Idempotency-Key` 请求头**；
- 小程序请求层自动生成 UUID 并附带（`apps/mp/utils/request.ts`），刷新重放时复用同一个键；
- 后端用 `@IdempotencyKey()` 装饰器取值（`src/common/decorators/index.ts`）。

## 6. 列表 / 分页约定

- 入参：`page`（从 1 开始）、`pageSize`（默认 20，上限 100）、可选 `keyword` / `categoryId` / `status`；
- 出参：`{ list: T[], total: number, page: number, pageSize: number }`；
- 时间字段一律 ISO8601 字符串；金额一律「分」整数（字段名以 `Cents` 结尾）。

## 7. Mock 标记（红线 10）

`src/common/middleware/mock-marker.middleware.ts` 为**每个响应**附加：

| 响应头 | 含义 |
|---|---|
| `X-Provider-Mode` | `real` 或 `mock-present` |
| `X-Provider` | 只要本次装配里存在 Mock 实现即为 `mock` |
| `X-Mock-Providers` | 仍处于 Mock 的具体能力名（逗号分隔） |

小程序 `markDemoMode()` 读取 `X-Provider` 并同步到 `getApp().globalData.demoMode`，
页面据此显示"演示模式"角标。`GET /health` 的 `mockProviders` 字段是同一份信息。

## 8. 限流

`@nestjs/throttler` 全局生效：窗口 `THROTTLE_TTL` 秒内最多 `THROTTLE_LIMIT` 次。
超限返回 HTTP 429 + 业务码 42901，前端应退避而不是重试风暴。

## 9. 新增接口的清单

1. 在 `packages/core/src/validators` 定义入参 / 出参 schema（前后端共用）；
2. 在 `apps/api/src/modules/<领域>/` 加 controller + service，DTO 类型从 `@qz/core` import；
3. 新错误码加到 `packages/core/src/errors/codes.ts` 并同步 `../dev/ERROR_CODES.md`；
4. 写接口确认幂等与鉴权装饰器齐全；
5. 补 `<name>.spec.ts`（校验管道、状态迁移、金额边界）；
6. 在 `apps/mp/utils/api.ts` 增加对应方法，页面只调它。
