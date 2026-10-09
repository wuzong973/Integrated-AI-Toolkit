# apps/mp —— 微信小程序

原生小程序 + TypeScript + SCSS。工程配置（`project.config.json`）在**仓库根**，
通过 `miniprogramRoot` 指向本目录，所以开发者工具要导入仓库根。
详见 [`../../docs/dev/WECHAT-DEVTOOLS.md`](../../docs/dev/WECHAT-DEVTOOLS.md)。

## 目录

```
apps/mp/
├── app.ts          # 入口：静默登录、登录态恢复、系统信息采集、setDemoMode
├── app.json        # ★ 路由唯一来源：pages / subpackages / preloadRule / tabBar / 权限
├── app.scss        # 全局样式（引入 styles/tokens.scss）
├── pages/          # 主包：5 个 TabBar 页 + common（登录 / H5 容器）
├── pkg-toolbox/    # 分包：工具执行 / 结果 / 我的文件
├── pkg-station/    # 分包：驿站、任务、发布、订单、服务者、工作台
├── pkg-os/         # 分包：编排看板 / 交付结果
├── pkg-mine/       # 分包：钱包 / 信用 / 认证 / 设置
├── styles/         # 视觉体系：tokens（令牌）· themes（22 套模块主题色板）
│                   #   · motion（动效库）· icons（糖果图标库）· deco（装饰层）
│                   #   · components（共享组件）· theme-dark（深色变量，暂未启用）
├── utils/          # request.ts（请求层）· api.ts（接口清单）· env.ts（环境地址）
│                   #   · fx.ts（指针视差 / 陀螺仪 / 动画重播）
├── typings/        # IAppOption + miniprogram-api-typings 引用
├── assets/icons/   # TabBar 图标（每页 normal + active 两张）
├── sitemap.json    # 索引规则
├── theme.json      # 深浅色导航栏变量（app.json 的 themeLocation）
└── tsconfig.json
```

## 页面约定

- **一页一目录，目录内固定四件套**：`index.ts` / `index.wxml` / `index.scss` / `index.json`；
  辅助页（登录、H5 容器）例外，放 `pages/common/<用途>.*`；
- 新增页面必须同步 `app.json`：主包进 `pages`，分包进 `subpackages` + `preloadRule`；
- 跳转用绝对路径 `/pages/xxx/index`、`/pkg-station/task/index?id=…`，不要自己拼前缀；
- 样式只用 `styles/tokens.scss` 里的变量，**禁止硬编码色值**（红线 2）。

## 视觉与交互（动 UI 之前必读）

**唯一标准： [`docs/dev/MP-VISUAL-SYSTEM.md`](../../docs/dev/MP-VISUAL-SYSTEM.md)。**

一句话版本：页面根节点挂 `qz-page th-<模块>`，取色只用 `var(--m1..--m4/--ms/--mt/--sh/--r-card)`，
图标只用 `.qz-i-xxx`，动效只用 `motion.scss` 的现成类，装饰包 `.qz-deco`、内容包 `.qz-content`，
指针视差按 `utils/fx.ts` 的四步接入。**新增页面 / 图标 / 交互一律照此办理。**

- 模块主题色板：`styles/themes.scss`（22 套，主色家族统一、点缀色与圆角各异）；
- 糖果图标库：`styles/icons.scss`（每个图标自带底色造型 + 白色图形 + 糖果高光，48×48 网格）；
- TabBar 图标：`python scripts/dev/gen-tab-icons.py --preview`（纯标准库生成，可复现）；
- 视觉预览：`python scripts/dev/gen-visual-preview.py` → 输出 `logs/mp-visual-preview.html`，
  可在浏览器里核对主题色板、图标、动效、组件与页面示意（与小程序样式同源）。

## 请求层（`utils/request.ts`）

页面不要直接 `wx.request`。请求层已经做好：

| 能力 | 说明 |
|---|---|
| Token 注入 | `Authorization: Bearer …` |
| 401 自动刷新 | 刷新成功后重放原请求；并发只刷一次 |
| 幂等键 | 写接口自动带 `Idempotency-Key`（重放复用同一个） |
| 错误码 → 文案 | 直接用后端 `message`，不在前端维护文案表 |
| traceId | 透传与回显 |
| 演示模式 | 读 `X-Provider` → `markDemoMode()` → `getApp().globalData.demoMode` |
| loading | 按请求粒度开关（列表类默认关闭） |

接口清单集中在 `utils/api.ts`（按 `healthApi` / `authApi` / `userApi` / `toolboxApi` /
`fileApi` / `stationApi` / `orderApi` / `osApi` / `messageApi` 分组），后端契约见
[`../../docs/api/README.md`](../../docs/api/README.md)。

## 分包与体积

主包只留 TabBar 与登录相关，其余全部进 `pkg-*` 分包并用 `preloadRule` 预下载。
新增页面时优先放进对应分包，别塞进主包。

## 检查

```bash
npm run typecheck:mp        # 已并入 npm run typecheck
```

## 还没有的目录

`components/`：目前 26 个页面里没有可复用的自定义组件，因此**不预建空目录**。
出现第一个真正被 ≥2 个页面共用的组件时，按 `components/<组件名>/index.{ts,wxml,scss,json}` 建。
