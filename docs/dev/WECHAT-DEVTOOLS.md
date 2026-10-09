# 微信开发者工具：导入与联调

## 一、导入哪个目录？

**导入仓库根目录**（例如 `D:\项目`），不要导入 `apps/mp`。

原因：`project.config.json` 只有一份，放在仓库根，靠
`"miniprogramRoot": "apps/mp/"` 指向小程序源码。
这样"打开仓库 = 打开小程序"，也不会出现两份配置互相覆盖。

> 历史故障：仓库根曾残留一份没有 `miniprogramRoot` 的 `project.config.json`，
> 于是开发者工具在根目录找 `app.json`，报
> **「模拟器启动失败：Error: app.json: 在项目根目录未找到 app.json」**。
> 现在根配置已修正；如果再看到这个报错，先确认导入的是仓库根、
> 且根目录 `project.config.json` 里有 `miniprogramRoot`。

## 二、配置分两个文件

| 文件 | 是否入库 | 放什么 |
|---|---|---|
| `project.config.json` | ✅ 入库 | 团队共享：`miniprogramRoot`、`appid`、`compileType`、编译插件开关 |
| `project.private.config.json` | ❌ gitignore | 个人：基础库版本、是否校验合法域名、热重载等 |

关键项（`project.config.json` → `setting`）：

```json
"useCompilerPlugins": ["typescript", "sass"]
```

**必须开着**：源码是 `.ts` 和 `.scss`，靠开发者工具内置插件编译成 `.js` / `.wxss`。
把它设成 `false` 会导致所有页面脚本与样式都不生效。

个人配置里的 `"urlCheck": false` 等价于界面上的
「详情 → 本地设置 → 不校验合法域名…」，开发期 API 是 `http://127.0.0.1:3000` 时必须关。

## 三、联调步骤

```bash
# 1) 起后端（另开终端）
npm run dev:api          # http://localhost:3000/api/v1
npm run smoke            # 确认 /health 返回 200

# 2) 开发者工具导入仓库根 → 编译
```

预期看到：

- 5 个 TabBar 页可切换；
- 首页状态条「**后端已连接 · v0.1.0 · DB up**」—— 这就是前后端真实联通的证据；
- 若后端仍有能力是 Mock 实现，界面显示「演示模式」角标（红线 10，正常现象）。

## 四、接口地址在哪改

**唯一改动点：`apps/mp/config/endpoints.ts`**（地址数据集中在这里，`utils/env.ts` 只做选择与校验）。

```ts
export const LOCAL_API_BASE   = 'https://qingzhi.wzl136122.cn';  // 开发者工具 / 真机调试 / 预览
export const TRIAL_API_BASE   = 'https://qingzhi.wzl136122.cn';  // 体验版（无独立 staging，与正式版同址）
export const RELEASE_API_BASE = 'https://qingzhi.wzl136122.cn';  // 正式版
```

`LOCAL_API_BASE` 有两种填法，按**当下要调什么**选：

| 模式 | 填什么 | 什么时候用 |
|---|---|---|
| **直连线上**（当前配置） | `https://qingzhi.wzl136122.cn` | 只看前端 / 要用线上已部署的能力与真实数据。⚠️ 写操作会落在**生产库** |
| **本地后端** | 本机局域网 IP，如 `http://192.168.127.32:3000` | 要改后端代码、看日志、做破坏性试验 |

⚠️ 本地模式**必须是电脑的局域网 IP，不能是 `127.0.0.1`**（真机上回环地址指向手机自己）。
开发者工具下局域网 IP 同样可用，所以统一填 IP，两边都能跑。
查本机 IP：`ipconfig` 看「无线局域网适配器 WLAN」下的 IPv4 地址。

⚠️ 直连线上时，该域名必须已加入微信公众平台「开发设置 → 服务器域名」的
**request / uploadFile / downloadFile / socket** 四类白名单 —— 漏配哪一类，对应功能在真机上直接失败，
而开发者工具勾了「不校验合法域名」时**看不出来**。

### ⭐ 本地模式下换 Wi-Fi：先跑 `npm run check:api-base`

**这是本项目最容易把排查带偏的一类故障。** 家用路由器是 DHCP，换 Wi-Fi / 重启路由器 /
开热点都会让本机 IP 变，而 `endpoints.ts` 里还写着旧地址。现象是：

```
GET http://<旧IP>:3000/api/v1/... net::ERR_CONNECTION_TIMED_OUT
```

**看起来像后端挂了，其实后端一直好好的**（2026-09-20 实测：本机从 `192.168.11.x`
换到 `192.168.31.x`，后端始终正常监听 `0.0.0.0:3000`）。
注意是 **TIMED_OUT 而不是 CONNECTION_REFUSED** —— 旧 IP 已经不在本网段了，
SYN 包没人应答，所以是超时；如果只是"后端没起"，会是立刻拒绝。

```bash
npm run check:api-base          # 比对本机网卡地址，不符时给出该改成什么
npm run check:api-base -- --fix # 顺便自动改掉 endpoints.ts 与本文档
```

它会读 `LOCAL_API_BASE` 的 host，然后**按 host 分两种模式**：

- **局域网地址**（本地模式）：① 与本机所有非 link-local IPv4 比对；② 比对 `.env` 的 `PORT`
  与 `STORAGE_PUBLIC_BASE_URL`；③ 探测 `${base}/api/v1/health`；④ 检查本文档是否跟着漂移。
- **公网域名**（直连线上模式，当前配置）：网卡 / 端口 / 本地 `.env` 比对**全部跳过**
  （那是本地后端的配置，与线上无关），只探测 `${base}/api/v1/health` 是否真应答，
  并且 `--fix` **不会**把地址改回局域网 IP。

> ⚠️ 它**不在**"交付前必须全绿"那一组里：结论依赖当前这台机器的网络，
> 换台机器跑（CI / 同事电脑）必然失败，而那并不是缺陷。
> 它是**诊断工具**，不是门禁 —— 放进交付链只会制造假红灯。

**换网络后 IP 会变（DHCP），也不必改代码** —— 在开发者工具「**真机调试 → Storage**」面板写入一次即可：

| key | value |
|---|---|
| `qz_api_base` | `http://<本机局域网IP>:3000`（例：`http://192.168.127.32:3000`） |

覆盖值**仅 `develop` 环境生效**，且必须是 `http(s)://` 开头、非占位域名，否则被忽略
（脏值不会把开发环境弄成连不上）；体验版 / 正式版**永不读取**，不会被本地存储劫持。
覆盖生效时启动日志会多打一条 warn，`tests/mp/env.spec.ts` 里有专门用例锁死这个行为。

**环境不再靠手改常量**：`utils/env.ts` 读 `wx.getAccountInfoSync().miniProgram.envVersion`
自动判定 `develop` / `trial` / `release`，所以不存在"忘了改 `ENV` 就把开发地址发上线"这种事故。
`npm run audit:mp` 会拦住"把地址字面量写回 `utils/env.ts`"的改法。

**占位域名会主动报错，不会静默失败**：地址仍是 `*.example.com`（RFC 2606 保留域名）时，
请求层会**立刻失败**并提示去 `endpoints.ts` 填真实域名 —— 这是刻意的设计，
因为让 DNS 解析失败后弹"网络开小差了"会把一个配置错误伪装成网络抖动，排查成本极高。

### 真机联调前置清单

真机（真机调试 / 预览二维码 / 体验版）与开发者工具的差异集中在**网络可达性**上，
逐项确认后再开始排查代码（下表以**本地模式**为准；直连线上时 1~4、6 不适用，
改为确认域名已加进微信后台的四类白名单，并跑 `npm run check:api-base` 探测线上应答）：

| # | 检查项 | 为什么 | 怎么做 |
|---|---|---|---|
| 1 | `LOCAL_API_BASE` 是**局域网 IP**（`127.0.0.1` 必错） | 真机上 `127.0.0.1` 指向**手机自己**，不是你的电脑 | 症状是**所有请求 `(failed)`、0 B、几十毫秒**（本地快速失败，不是超时）。改 `endpoints.ts`，或用 `qz_api_base` 覆盖 |
| 2 | 电脑与手机在**同一网络**，且 `LOCAL_API_BASE` 的 IP 是**本机当前**地址 | 跨网段不可达；而换 Wi-Fi / 重启热点后本机 IP 会变，配置里却还是旧 IP | **先跑 `npm run check:api-base`** —— 自动比对本机网卡地址，不符时直接给出该改成什么（`--fix` 自动改代码与文档）。症状是**所有请求 `ERR_CONNECTION_TIMED_OUT`**（旧 IP 已不在本网段，SYN 无人应答） |
| 3 | 后端监听 `0.0.0.0` | 只监听回环时局域网连不上 | `netstat -ano \| grep ":3000.*LISTENING"` 应显示 `0.0.0.0:3000`（本项目默认如此） |
| 4 | 防火墙放行 3000（**公用**配置文件） | 网络常被识别为「公用」；规则若只覆盖「专用」就被挡 | 本机已有 `Node.js JavaScript Runtime` 的公用 profile TCP 放行规则。若不通，管理员执行：<br>`netsh advfirewall firewall add rule name="qz-dev-3000" dir=in action=allow protocol=TCP localport=3000 profile=any` |
| 5 | 勾选「不校验合法域名」 | 局域网 IP 不是合法域名，微信会直接拦 | 详情 → 本地设置；`project.private.config.json` 设 `urlCheck: false` |
| 6 | `STORAGE_PUBLIC_BASE_URL` 是**同一 IP** | 留空会回落 `localhost`，真机上文件下载 / 图片预览指向手机自己 | 见 `docs/dev/ENV.md` 第 5 节；**改完必须重启后端**才生效 |
| 7 | 后端已重新构建并重启 | 本项目后端是**一次性进程**，改了 `apps/api/src` 不重新构建就还是旧产物 | `npm run build -w @qz/api` 后重启；**不要**只重启不构建 |
| 8 | 改完地址**重新编译**并重跑真机调试 | 地址是**编译期常量**（`endpoints.ts`）或小程序启动时读一次（storage 覆盖），不重跑不生效 | 开发者工具「编译」/ 手机端「重新进入真机调试」 |

**最快的判据（先做这一步，30 秒出结论）**：用**手机浏览器**打开
`http://<你的IP>:3000/api/v1/health` —— 返回 JSON 说明网络链路通，问题在小程序侧（第 1/5/8 条）；
打不开说明是网络侧（第 2/3/4 条）。真机调试面板里"连接状态正常、往返耗时几百毫秒"只说明
**调试通道**通了，**不代表 HTTP 请求能出去** —— 这两件事互不相关，别被它误导。

**超时 vs 拒绝，一眼分流**（控制台里那串英文别略过，它直接指向不同原因）：

| Console 报错 | 含义 | 查哪一条 |
|---|---|---|
| `net::ERR_CONNECTION_TIMED_OUT` | 包发出去了、**没人应答** —— 地址不在本网段，或被防火墙丢包 | 第 2 条（**先跑 `check:api-base`**）/ 第 4 条 |
| `net::ERR_CONNECTION_REFUSED`、或 `(failed)` 且几十毫秒返回 | 地址是对的，但**没人在这个端口上听** | 第 3 / 7 条（后端没起 / 没重新构建） |
| `net::ERR_NAME_NOT_RESOLVED` | 域名解析不了 —— 多半是填了占位域名或写错域名 | `endpoints.ts` / 第 5 条 |

⚠️ 前两种都发生在**局域网**里，**都不是"网络不好"** —— 本机直连不存在真实的网络抖动，
别去重启路由器，先按上表定位。

> 启动日志会打印一行 `[env] 环境=develop 基址=http://...`，先看这一行确认实际生效的地址，
> 比翻源码快得多。真机联调时若看到的是 `127.0.0.1`，第 1 条就没做。

> ⚠️ **上线前必做**：`TRIAL_API_BASE` / `RELEASE_API_BASE` 换成**已备案 + HTTPS +
> 已加入小程序后台 request 合法域名**的真实域名。当前二者仍是占位域名，
> 未替换前体验版与正式版的**所有请求都会失败**（请求层会明确报出这一点）。

## 五、路由与分包

- 路由唯一来源是 `apps/mp/app.json`（`pages` / `subpackages` / `preloadRule` / `tabBar`）；
- 主包只放 5 个 TabBar 页 + 登录 / H5 容器，其余按业务域进 `pkg-*` 分包；
- 分包页跳转写绝对路径：`/pkg-station/task/index?id=xxx`；
- 新增页面：建目录 → 放 `index.{ts,wxml,scss,json}` 四件套 → 在 `app.json` 登记
  （分包还要同步 `preloadRule`）。

当前主包路由：

| 路径 | 页面 |
|---|---|
| `pages/home/index` | 首页 |
| `pages/toolbox/index` | 工具箱 |
| `pages/os/index` | 青智 OS 会话（TabBar「AI」） |
| `pages/station/index` | 青智驿站 |
| `pages/mine/index` | 我的 |
| `pages/common/login` | 授权登录 |
| `pages/common/webview` | H5 容器 |

> `pages/os/index` 曾叫 `pages/os/chat`，已统一为"一页一目录、目录内 index.*"的写法。

## 六、常见报错速查

| 报错 | 原因 | 处理 |
|---|---|---|
| `app.json: 在项目根目录未找到 app.json` | 导入的不是仓库根，或根配置缺 `miniprogramRoot` | 重新导入仓库根，核对配置 |
| 页面全空白 / 样式全无 | `useCompilerPlugins` 没开 `typescript` + `sass` | 见第二节 |
| 请求报"不在合法域名列表" | 未勾选「不校验合法域名」 | `project.private.config.json` 设 `urlCheck: false` |
| 请求全部 401 | 后端没起，或改过 `JWT_SECRET` 使旧 token 失效 | `npm run dev:api`；清除登录态重进 |
| 真机能开工具页但接口不通 | 用了 `127.0.0.1` | 换局域网 IP / 内网穿透（见第四节） |
