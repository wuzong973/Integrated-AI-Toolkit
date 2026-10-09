# 小程序视觉规范（唯一权威版本）

> 本文件是 `apps/mp` 视觉与交互的**单一事实来源**。
> 新增页面、图标、动效、装饰元素之前，必须先读完本文件；不符合本文件的改动一律返工。
> 相关：`AGENTS.md`（工程入口）、`docs/rules/DEVELOPMENT-STANDARDS.md`（十条红线）。

---

## 一、总体气质

**可爱、活泼、多彩，但克制。**

- 造型语言：圆角饱满、留白充足、元素"漂浮"在柔和光斑之上；
- 配色语言：以糖果色（中高明度、中饱和）为主，避免纯黑纯灰的死板与荧光色的刺眼；
- 动感语言：流线（行进虚线）、水波（扇贝曲线）、光斑（有机形）、扫光，四类装饰交替使用；
- 三条硬边界：
  1. **装饰不得影响可读性** —— 装饰层一律 `pointer-events:none`，内容必须包在 `.qz-content` 里；
  2. **装饰不得影响性能** —— 只动 `transform` / `opacity` / `background-position`，不动 `width`/`top` 等触发重排的属性；
  3. **页面根节点禁止 `transform` 动画** —— 会使其成为 `position:fixed` 子元素的包含块，导致悬浮球、底部操作栏错位（`qzPageIn` 因此只做透明度）。

---

## 二、配色：模块主题色板

每个页面在根节点挂一个主题类，之后所有取色都走 CSS 变量，**页面 SCSS 里不允许出现 `#RRGGBB`**（红线 2），
也不允许**数字型** `rgba(255, …)` / `rgb(0 …)` 字面量：白字用 `$text-inverse`、白罩用 `$glass-*`、
警示用 `$warning-veil/-line` / `$danger-veil`、主题色投影用 `var(--sh)` 或 `$shadow-tint-*`；
缺档位就往 `tokens.scss` 补一个再引用，别在页面里写字面量。
（`rgba($success, .08)` 这种**对令牌取色**的写法合法。裸色值今天看不出问题，代价是换肤/深色模式时这些点不会跟着变。）

```xml
<view class="qz-page th-station"> … </view>
```

```scss
.card { background: var(--ms); color: var(--mt); border-radius: var(--r-card); }
```

| 变量 | 含义 | 典型用途 |
|---|---|---|
| `--m1` | 主色 | 主按钮、强调文字、装饰主色 |
| `--m2` | 辅色 | 渐变另一端、波浪 |
| `--m3` | 点缀色 | 小圆点、次要标签、图标里的亮点 |
| `--m4` | 副点缀色 | 第二处强调，制造"多彩" |
| `--ms` | 柔和底 | 浅色块、标签底、选中态背景 |
| `--mt` | 深文本 | 浅底上的文字（保证对比度） |
| `--sh` | 彩色柔影 | 卡片/按钮投影，替代死板灰影 |
| `--r-card` | 卡片圆角 | 该模块的"形状性格" |
| `--tex-o` | 纹理浓度 | 装饰层不透明度系数 |

### 现有主题（新增页面必须复用，不要另造）

| 主题类 | 模块 | 主色 | 性格 |
|---|---|---|---|
| `.th-home` | 首页 | 青碧 | 大圆角 32，泡泡水波 |
| `.th-toolbox` | AI 工具箱 | 星蓝 | 小圆角 20，方正利落 |
| `.th-os` | 青智 OS | 幻紫 | 超大圆角 36，流线感 |
| `.th-station` | 青智驿站 | 暖橙 | 圆角 22，烟火气 |
| `.th-mine` | 我的 | 樱花粉 | 圆角 30，柔软 |
| `.th-login` | 登录 | 青紫 | 圆角 40 |
| `.th-tool-run` | 工具执行 | 靛青 | 圆角 24 |
| `.th-tool-result` | 生成结果 | 湖蓝 | 圆角 28 |
| `.th-files` | 我的文件 | 云蓝 | 圆角 18 |
| `.th-plan` | 任务看板 | 星紫 | 圆角 34 |
| `.th-task` | 任务详情 | 朱砂 | 圆角 24 |
| `.th-order` | 订单 | 海青 | 圆角 26 |
| `.th-publish` | 发布需求 | 品红 | 圆角 30 |
| `.th-workbench` | 服务者工作台 | 紫罗兰 | 圆角 18 |
| `.th-provider` | 服务者主页 | 葡萄紫 | 圆角 28 |
| `.th-apply` | 服务者认证 | 靛蓝 | 圆角 22 |
| `.th-skill` | 技能画像 | 青柠 | 圆角 26 |
| `.th-chat` | 会话 | 蓝绿 | 圆角 28 |
| `.th-wallet` | 钱包 | 翡翠 | 圆角 26 |
| `.th-credit` | 信用 | 琥珀 | 圆角 24 |
| `.th-verify` | 学生认证 | 靛蓝 | 圆角 24 |
| `.th-settings` | 设置 | 石墨青 | 圆角 16，克制 |
| `.th-toolkit` | 校园小工具 | 柠黄 | 圆角 26，轻快小物 |
| `.th-vocab` | 记单词 | 苔绿 | 圆角 30，书页曲线 |
| `.th-practice` | 练习中心 | 靛青 | 圆角 30，句式节奏 |

全局中性色 / 间距 / 形状 / 动效令牌见 `apps/mp/styles/tokens.scss`，**不要在页面里另起一套数值**。

---

## 三、图标：糖果图标库

位置 `apps/mp/styles/icons.scss`，用法：

```xml
<view class="qz-ico qz-ico-m qz-ico-float">
  <view class="qz-i qz-i-station"></view>
</view>
```

- `.qz-ico` 提供尺寸（`-s` 56 / `-m` 88 / `-l` 112 / `-xl` 152 rpx）与呼吸光环；
- `.qz-ico-float` / `-bob` / `-slow` 让图标自己"活着"；
- `.qz-i-<名字>` 是图标本体（自带底色造型 + 白色图形，48×48 网格）。

**新增图标必须遵守的造型规范：**

1. 画布 48×48，四周留 4px 安全边；
2. 自带底色造型（圆角矩形 / 圆 / 有机形），底色即该模块的识别色；
3. 图形一律 `fill='white'`，负形用底色挖空，形成通透感；
4. 左上角一枚 18% 白高光（`fill-opacity='.18'`）制造糖果质感；
5. 线条统一 `stroke-width` 2.6~3.6、`stroke-linecap='round'`；
6. **同模块共用色系，不同模块换色换形**（圆角半径、底座形状不同），这是"多彩但不雷同"的关键。
7. **同一个入口列表里，两件事不得共用同一枚图标** —— 语义相近时宁可新画一枚，靠"换色 + 换形"区分。
   实例：`pkg-toolkit/home` 曾把"考试倒计时"和"日期差计算"都挂 `qz-i-clock`，
   观感就是"这模块的图标是随便抓的"。现在补了 `.qz-i-calendar`
   （琥珀 `%23F59E0B` + `rx 12` 日历网格负形）与 `qz-i-clock`（青 `%2306B6D4` + `rx 15` 圆环指针）成对错开。

**技术约束（踩过坑）：**

- 小程序不支持 `<svg>` 标签，WXSS 也不支持本地图片做 `background-image`，所以图标只能内联 SVG data-URI；
- data-URI 里 `#` 必须写成 `%23`，属性用单引号，整个 `url("…")` 用双引号且**不能换行**；
- 纯色需求优先用 `fill='white'`，少写一个 `%23` 就少一处出错点。

TabBar 图标由 `scripts/dev/gen-tab-icons.py` 生成（纯标准库、零依赖、可复现）：
未选中态为统一中性蓝灰混色（保留色相），选中态为高饱和糖果色。

---

## 四、动效：三类，别自己写 keyframes

全部在 `apps/mp/styles/motion.scss`，页面只做组合。

| 类别 | 类名 | 用途 |
|---|---|---|
| 入场 | `.qz-an-in` `.qz-an-fade` `.qz-an-pop` `.qz-an-spring` `.qz-an-left` `.qz-an-right` `.qz-an-drop` | 首屏、切 Tab、内容换批 |
| 错位 | `.qz-d1` ~ `.qz-d8` | 列表/网格逐项延迟，避免整块同时出现 |
| 循环 | `.qz-loop-float` `-float-2` `-drift` `-blob` `-breath` `-spin` `-bob` | 装饰层常驻动效 |
| 反馈 | `.qz-press`（0.96 物理压缩 + 深度内阴影）`.qz-lift`（抬升）`.qz-ripple`（波纹） | 点击/按压，必须即时 |

节奏令牌：`$dur-instant` 12ms 按压、`$dur-press-in` 80ms 按下段、`$dur-fast` 200ms 回正、
`$dur-base` 320ms 常规、`$dur-slow` 550ms 入场；缓动只用 `$ease-out` / `$ease-spring` / `$ease-inout`。

**按压要非对称才有实体感**（`.qz-press` 的实现纪律）：按下段用极短的 `$dur-press-in + $ease-out`
（反馈必须"立刻到"），松手段用 `$dur-fast + $ease-spring`（`cubic-bezier(.34,1.56,.64,1)` 自带超调），
并按下时叠一层 `inset` 内阴影 `$press-inset`、松手即撤。CSS 的 transition 取自"目标态"那条规则，
所以"按下快、回正弹"是靠 `:active` 内外的两条 transition 分工做出来的，不是靠一个曲线调出来的。
`inset` 与卡片原本的柔影是同一个 `box-shadow` 属性、按压期间会替换它 ——
这与 `.qz-lift` 的既有行为一致（它 `:active` 也是换一档阴影），不是回归。

**逐条弹性入场**：`.qz-an-spring`（`qzSpringUp`，上浮 20rpx + 过冲到 1.012 再落定）
配 `.qz-d1..d8` 延迟；类名由 `utils/fx.ts` 的 `staggerClass(index, 'qz-an-spring')` 生成、
塞进列表数据的一个字段里，WXML 用 `{{item.anim}}` 渲染（**WXML 不能调函数**）。
既有样板：`pages/station/index.ts:124` + `index.wxml:104`（默认 `qz-an-in` 那档）。
列表项 ≤8 时逐条错位、>8 时按 8 封顶取模，避免长列表尾项等太久。

**页面切换过渡**：`.qz-page` 自带整页淡入（`qzPageIn`），页面内再对区块加 `.qz-an-in`，
形成"先整页淡入、再分区上浮"的两级层次。Tab 切换后内容变化时调 `replayAnim(this)` 重播。

**这条纪律现在有兜底**：`npm run audit:mp` 第 ㉑ 段断言页面 SCSS 里不得出现 `@keyframes`
（`styles/` 与 `app.scss` 是库本体，豁免）。此前三个页面的文件头都在自我声明"本文件不自造 @keyframes"，
但没有任何一条断言查过它 —— 纪律写而不管，等于没写。

---

## 五、装饰：流线 / 水波 / 曲线 / 光斑

全部在 `apps/mp/styles/deco.scss`。标准结构：

```xml
<view class="qz-deco">
  <view class="qz-fx" style="{{fxStyle}}">
    <view class="qz-blob qz-blob-a"></view>
    <view class="qz-blob qz-blob-b"></view>
    <view class="qz-dot qz-dot-a"></view>
  </view>
</view>
<view class="qz-content"> … 真正的内容 … </view>
```

| 类名 | 效果 |
|---|---|
| `.qz-flow` `-rev` `-soft` `-thick` | 行进虚线（流线） |
| `.qz-water` | 横向流动条纹（流水光效） |
| `.qz-wave` `-up` | 扇贝波浪曲线 |
| `.qz-curve` | 双弧错位曲线 |
| `.qz-blob` `-a` `-b` `-c` | 有机形光斑（自带形变循环） |
| `.qz-dot` `-a` `-b` `-c` | 呼吸光点 |
| `.qz-shine` `-slow` | 扫光 |
| `.qz-topline` | 卡片顶部渐变流动线 |
| `.qz-halo` | 图标光环 |
| `.qz-rise` | 粒子上升 |

**用量纪律**：一屏最多 3 个 `.qz-blob` + 2 条流线；装饰总不透明度不超过 0.4；
任何装饰都不得压住文字。

---

## 六、交互：随指针移动的动态响应

`apps/mp/utils/fx.ts` 提供指针视差（触摸 / 鼠标 / 陀螺仪三合一）。

页面四步接入：

```ts
// ① data
fxStyle: ''
// ② 根节点绑定事件
//    bindtouchstart="onFxStart" bindtouchmove="onFxMove"
//    bindtouchend="onFxEnd" bindtouchcancel="onFxEnd"
// ③ 装饰层绑定内联样式
//    <view class="qz-fx" style="{{fxStyle}}">
// ④ 方法转发 + 生命周期
onFxStart(e: WechatMiniprogram.TouchEvent) { fxStart(this, e); },
onFxMove(e: WechatMiniprogram.TouchEvent) { fxMove(this, e); },
onFxEnd() { fxEnd(this); },
onShow() { fxEnableTilt(this); },
onHide() { fxDisableTilt(); },
```

- 位移上限 `FX_RANGE = 26rpx`，超过 40rpx 会让人眩晕；
- 写入做了 30fps 节流，只写 1 个内联 `transform`，不触发内容区重排；
- **只有装饰层跟随，内容区不跟随**（否则影响阅读，属违规）；
- **这四步是全页强制项，不是可选项**：凡挂了 `.qz-deco` 的页面都要走完。
  唯一豁免是 `pages/common/webview.wxml` 的降级分支（第十一节登记"刻意不接 `.qz-fx`"，
  那一屏只有一个返回按钮，装饰跟手只会晃眼）；新增豁免要**同时**改第十一节的登记行。
  `npm run audit:mp` 第 ⑯ 段拦这个 —— 2026-10-08 盘点时 `pkg-toolkit` 10 页里有 6 页没接，
  同一模块内一半页面的光斑跟手、另一半纹丝不动，而 `tsc`/`lint`/其余守卫**全都不看这一项**；
- ⚠️ `.qz-fx` 相对 `.qz-deco` **向外扩了 40rpx**（`deco.scss` 里 `left/top/right/bottom: -40rpx`，
  为的是位移时不露边）。装饰子元素进了这一层，位置就跟着上移 40rpx，而 `.qz-deco` 是 `overflow: hidden` ——
  **按库内是否自带定位分三种处理，别一概而论**（`audit:mp` 第 ⑳ 段拦前两种）：

  | 装饰类 | 库内情况 | 进了 `.qz-fx` 之后 | 页内要写什么 |
  |---|---|---|---|
  | `qz-flow` / `qz-water` / `qz-wave` / `qz-curve` | **只有 height + 背景 + 动效，没有 `position`**（`qz-water` 连 height 都没有） | 按普通流排到视差层顶边 = `.qz-deco` 顶边**之上** 40rpx；高 ≤40rpx 的**整条被裁掉**，`qz-curve`（120rpx）被削掉上沿 | `position: absolute` + `top`/`bottom`（+ `left`/`right`，页面整宽写 `-40rpx`）。样板：`.vocab-curve`、`.text-flow` |
  | `qz-topline` | `position: absolute; top: 0` | 顶到裁切区外，6rpx 高的流动线**整条看不见** | 页内 `top: 40rpx`（≥ 外扩量）。样板：`.wb-topline` |
  | `qz-blob-a/-b/-c`、`qz-dot-a/-b/-c`、`qz-shine`、`qz-halo` | 库内已有 `position` 与偏移 | 整体偏移 ≤40rpx，肉眼无感 | **不用换算**，除非本页 SCSS 自己给过它坐标 |

  最后一种情形才需要算术：**页内给某个装饰子元素写过绝对定位坐标，包进 `.qz-fx` 后
  `left/top/right/bottom` 各自 +40rpx** 才落回原来的屏幕位置
  （例：`.tb-water` 由 `-40/-40/200` 改成 `0/0/240`；`.rise-particle` 由 `72/160` 改成 `112/200`）。
- ⚠️ 反面教训（2026-10-08）：`pkg-practice/{home,session}` 的 `.practice-curve` 一直写着 `top: 300rpx` / `420rpx`，
  看起来"处理过了"，但 `top` 对 `position: static` 的元素**完全无效** —— 那道"句式节奏线"其实一直贴在
  页面最上沿被削掉一截。**"写了 top"不等于"top 生效"**，与 ⑨⑫ 同族。

---

## 七、共享组件（`apps/mp/styles/components.scss`）

| 类名 | 用途 |
|---|---|
| `.qz-card` | 基础柔影卡（圆角取 `--r-card`） |
| `.qz-card-line` | 描边卡，密集列表用 |
| `.qz-card-tint` | 主题浅底卡，强调区块用 |
| `.qz-card-grad` | 白→柔底渐变卡，体积感 |
| `.qz-card-glow` | 彩色柔影卡 |
| `.qz-card-bar` | 左侧彩色指示条 |
| `.qz-sec` `-bar` `-title` `-sub` `-more` | 区块标题（带漂浮色条） |
| `.qz-chip` `-on` `-ghost` | 胶囊标签 |
| `.qz-btn-main` `-sub` `-plain` `-block` | 三种按钮语气 |
| `.qz-empty` `-ico` `-title` `-text` `-flow` | **所有占位/空态页统一用它** |
| `.qz-skeleton` `-line` `-short` | 加载骨架 |
| `.qz-item` `-main` `-title` `-desc` `-extra` `-arrow` `-line` | 通用列表项 |
| `.qz-head` `-row` `-main` `-title` `-sub` `-chips` | 页头（大标题 + 糖果图标 + 胶囊） |
| `.qz-grad-text` | 渐变文字（呼吸流动） |

全局还有 `.qz-err`（错误条）、`.qz-footer-bar`（底部操作栏）、`.qz-demo-badge`（演示模式角标）。

**差异化要求**：同一屏内不同类型的卡片要换用不同卡型（例如"金刚区用 `.qz-card-grad`、
工具卡用 `.qz-card-line` + 顶部彩条、任务卡用 `.qz-card-glow` + `.qz-card-bar`），
这是"层次丰富"最省力的做法。

---

## 八、页面骨架（照抄即可）

```xml
<view class="qz-page th-<模块>" bindtouchstart="onFxStart" bindtouchmove="onFxMove"
      bindtouchend="onFxEnd" bindtouchcancel="onFxEnd">
  <view class="qz-deco">
    <view class="qz-fx" style="{{fxStyle}}">
      <view class="qz-blob qz-blob-a"></view>
      <view class="qz-blob qz-blob-b"></view>
      <view class="qz-dot qz-dot-a"></view>
    </view>
  </view>

  <view class="qz-content">
    <!-- 页头 -->
    <view class="qz-head">
      <view class="qz-head-row">
        <view class="qz-ico qz-ico-l qz-ico-float"><view class="qz-i qz-i-<图标>"></view></view>
        <view class="qz-head-main">
          <text class="qz-head-title">标题</text>
          <text class="qz-head-sub">一句话说明</text>
        </view>
      </view>
    </view>

    <!-- 内容：区块标题 + 卡片 -->
    <view class="qz-container">
      <view class="qz-card qz-an-in qz-d1"> … </view>
    </view>
  </view>
</view>
```

空态页（暂无数据的占位页）统一写法：

```xml
<view class="qz-container">
  <view class="qz-empty qz-an-in">
    <view class="qz-empty-ico qz-ico qz-ico-xl qz-ico-float">
      <view class="qz-i qz-i-empty"></view>
    </view>
    <text class="qz-empty-title">标题</text>
    <text class="qz-empty-text">说明文案</text>
    <view class="qz-empty-flow qz-flow"></view>
    <view class="qz-btn-main qz-press" bindtap="onXxx">主操作</view>
  </view>
</view>
```

---

## 九、验收清单（每个页面改完自检）

- [ ] 根节点挂了 `.qz-page` + 对应 `.th-*` 主题类；
- [ ] 页面 SCSS 里**没有** `#RRGGBB`、**没有数字型** `rgba(255,…)`、没有自造圆角/阴影数值（白字用 `$text-inverse`）；
- [ ] 至少 1 个糖果图标、1 处入场动效、1 处循环装饰（流线/水波/光斑/扫光）；
- [ ] 装饰层包在 `.qz-deco` 里、内容包在 `.qz-content` 里，装饰 `pointer-events:none`；
- [ ] **装饰层走完 §六 四步**：`.qz-fx` + `style="{{fxStyle}}"` + 根节点四个 `bindtouch*` +
      `onShow` 开 `fxEnableTilt` / `onHide` 关 `fxDisableTilt`，**实机上光斑确实跟指针动**；
- [ ] **每条装饰进了 `.qz-fx` 之后真看得见**（§六 三类分工表）：`qz-flow`/`qz-water`/`qz-wave`/`qz-curve`
      库内不带 `position`，要页内补 `position` + `top/bottom`；`qz-topline` 要 `top ≥ 40rpx`；
      页内自己写过坐标的要按外扩 40rpx 换算 —— **只写 `top` 不写 `position` 等于没写**；
- [ ] **顶层区块有 `qz-an-in` + `qz-d1..d8` 两级层次**（先整页淡入、再分区上浮），不是整块同时闪现；
      `wx:for` 里的单个条目不逐条带动效类；
- [ ] 交互元素都有反馈：**可点卡片挂 `.qz-lift`（抬升-下沉），小按钮/胶囊挂 `.qz-press`**；点击区 ≥ `$hit-min`；
- [ ] 空态/错误态用 `.qz-empty` / `.qz-err`，不另造一套；
- [ ] 装饰与卡片符合第十一节"逐页视觉亮点分配表"的签名组合（与相邻页至少一处不同）；
- [ ] 渐变头区上的白色叠加只允许用 `$glass-*` 令牌，状态柔色只允许 `$warning-veil` / `$danger-veil` 等令牌，**页面里不出现裸 `rgba()` 字面量**；
- [ ] `npm run typecheck:mp` 与 `npx eslint apps/mp --ext .ts --max-warnings 0` 全绿。

### 七类"编译器查不出的静默失效"（都踩过，别重复）

| 类型 | 症状 | 判据 |
|---|---|---|
| **① 主题类未定义** | 挂 `th-xxx` 但 `themes.scss` 里没有 → 该页 `var(--m1/--ms/--mt/--sh/--r-card)` **全部失效**（卡片透明、文字变黑） | 主题类必须在 `themes.scss` 中定义 |
| **② 隐形装饰** | `qz-rise` / `qz-water` **只带动效、不带尺寸与位置**，单独用 = 0×0 元素，动画在跑却完全看不见 | 这两个类必须与形状类同用（类名 ≥ 2 个） |
| **③ 组件类名不存在** | WXML 写 `qz-card-title`，而 `styles/` 与页面 SCSS 里只有 `.card-title` → **样式一行都不生效**；文字仍显示，只是"朴素了一点" | WXML 里的 `qz-*` 类必须在 `styles/` 中有定义 |
| **④ 图标没有尺寸** | `.qz-i` 基类**不带宽高**（只有 `display:inline-block` + `background-size`），只挂 `qz-i qz-i-xxx` 就是 0×0 —— 背景图与动画都在，屏幕上什么都没有 | 必须满足其一：祖先有 `.qz-ico`、同类里有本页 SCSS 定义了宽高的类、本页 SCSS 给 `.qz-i` 设了宽高 |
| **⑤ 装饰层没接视差** | 有 `.qz-deco` 但没 `.qz-fx`：光斑/流线**纹丝不动**。单看这一页只是"死板一点"，**和同模块已接的页并排才看得出割裂** | 挂了 `.qz-deco` 就必须走完 §六 四步（豁免页见第十一节） |
| **⑥ 页面 SCSS 裸色值** | `color: #ffffff` 现在**视觉后果为零**，没人会去改；等换肤/深色模式时这几处不跟随，且没人记得它们在哪 | 页面 SCSS（`styles/**` 除外）不得有 `#RRGGBB` 或数字型 `rgba()` |
| **⑦ 装饰被视差层裁掉** | `qz-flow`/`qz-water`/`qz-wave`/`qz-curve` 库内**不带 `position`**、`qz-topline` 是 `top:0`：进了外扩 40rpx 的 `.qz-fx` 就排到裁切区之外 —— 动画在跑、不报错、屏幕上没有；页内**只补 `top` 不补 `position` 同样无效** | 见 §六 的三类分工表：position-less 要 `position` + `top/bottom`，`qz-topline` 要 `top ≥ 40rpx` |

> ③ 是 2026-09-20 做抽签工具时发现的：`pkg-toolkit/split-bill` 写了 **8 处**
> `qz-card-title`，而它自己的 SCSS 定义的是 `.card-title` —— 差一个 `qz-` 前缀，
> 于是那四个卡片标题从来没吃到过样式。**当时编译、`tsc`、所有守卫都不报。**
>
> ④ 是同日做"加到系统日历"时发现的，**实测拦下 3 处**：`pkg-toolkit/home` 的四个工具图标、
> `pages/station` 与 `pkg-os/plan` 的"演示模式"铃铛 —— 全是只挂 `qz-i qz-i-xxx` 而没有任何尺寸的裸用法。
> 教训与 ①②③ 同源：**"写了类名"不等于"类名存在"，更不等于"样式生效"；
> "写了图标类"也不等于"图标有尺寸"。**
>
> ✅ 七类现在都有守卫兜底：①② 由 `audit:mp` 的 ⑧⑨ 段、③ 由 ⑪ 段、④ 由 ⑫ 段、
> ⑤ 由 ⑯ 段（视差四步逐页断言）、⑥ 由 ⑱ 段（裸色值）覆盖，⑰ 段管"每页至少一处 `qz-an-*`"，
> 第三节的 **data-URI 写坏**（裸 `#` / 跨行 / 引号不成对 → 整条声明被 WXSS 丢掉、图标格空白）由 ⑲ 段覆盖，
> ⑦ 由 ⑳ 段覆盖（解析 `deco.scss` + 本页 SCSS，判"这条装饰到底在不在裁切区里"）
> （2026-09-20 补前四类，2026-10-08 补后四条；八把尺子均已自证：改坏后能精确报出问题与行号）。
> ⚠️ 写 ⑫ 的探针时**又踩了一次"没剥注释"**：注释里的 `.qz-press` 会和后面的真实规则
> 拼成假匹配，把中间真正的 `.qz-i { … }` 规则吞掉 —— 于是漏判了 `pkg-toolkit/home`。
> **解析 SCSS 前必须先剥块注释**（⑩ 段早就记过这条）。
> ⚠️ ⑱ 的孪生坑是**剥得太狠**：直接吃掉块注释会把里面的换行一起删掉，报出来的行号会整体前移，
> 按行号打开文件看到的是完全无关的一行。剥注释时要**按原注释的换行数补回空行**（保留行号）。

---

## 十一、逐页视觉亮点分配表（签名组合）

> 目的：解决"每页都是 blob-a+blob-b+dot-a 同一套"的雷同问题。
> 每页按下表配置 `.qz-deco` 签名组合 + 主卡型 + 反馈手法；改页面前先查本表，
> **新页面必须从未用过的组合里挑，或登记新行后再用**。

| 页面 | 主题 | 装饰签名（`.qz-deco` 内） | 页内亮点元素 | 主卡型 | 卡片反馈 |
|---|---|---|---|---|---|
| home | th-home | wave-up + blob-a/b | 泡泡水波 header | `.qz-card-grad` | lift |
| common/login | th-login | blob-a + halo | 扫光欢迎卡 | 玻璃卡（`$glass-card`） | press |
| common/webview | — | （降级分支 blob-b，视差豁免） | — | — | — |
| toolbox | th-toolbox | flow + dot-b | 卡片顶部流动线 | `.qz-card-line` + `.qz-topline` | lift |
| os | th-os | curve + flow-rev + blob-b | 导航流线 | `.qz-card-glow` | lift |
| station | th-station | water + blob-a + dot-c | 头部流水 | `.qz-card-bar` | lift |
| mine | th-mine | blob-a/b/c + rise | 头像光环 | `.qz-card-tint` | lift |
| pkg-toolbox/run | th-tool-run | flow-thick | 进度流动线 | `.qz-card-line` | press |
| pkg-toolbox/result | th-tool-result | shine + rise + dot-c | 庆祝扫光 | `.qz-card-glow` | press |
| pkg-toolbox/files | th-files | water + blob-b | 云光流动 | `.qz-card-line` | lift |
| pkg-toolbox/text | th-files | flow-soft + dot-a | 安静阅读 | `.qz-card` | press |
| pkg-os/plan | th-plan | flow-thick + blob-a | 泳道推进感 | `.qz-card-glow` | lift |
| pkg-os/history | th-os | curve + dot-a | 档案曲线 | `.qz-card-line` | lift |
| pkg-os/result | th-os | wave + shine | 交付包波浪 | `.qz-card-glow` | press |
| pkg-station/publish | th-publish | blob-c + shine | 表达起点 | `.qz-card-tint` | press |
| pkg-station/task | th-task | curve + dot-b | 热榜点缀 | `.qz-card-glow` + `.qz-card-bar` | lift |
| pkg-station/order-list | th-order | water + dot-a | 账本流水 | `.qz-card-line` | lift |
| pkg-station/order-detail | th-order | wave-up + blob-b | 契约波浪 | `.qz-card-glow` | press |
| pkg-station/service | th-provider | flow + blob-b | 服务详情动线 | `.qz-card-line` + `.qz-card-bar` | lift |
| pkg-station/service-new | th-station | shine + blob-a | 门面扫光 | `.qz-card-grad` | lift |
| pkg-station/provider | th-provider | blob-a/c + dot-c | 个人橱窗 | `.qz-card-tint` | lift |
| pkg-station/apply | th-apply | flow-soft + halo | 入驻仪式感 | `.qz-card` | press |
| pkg-station/workbench | th-workbench | topline + water | 数据仪表盘 | `.qz-card-glow` + `.qz-card-bar` | lift |
| pkg-station/skill | th-skill | rise + dot-b | 技能粒子 | `.qz-card-tint` | lift |
| pkg-station/chat | th-chat | wave + blob-b | 对话流水 | 气泡卡（页内自定义） | press |
| pkg-mine/wallet | th-wallet | rise + blob-c | 金币泡泡 | `.qz-card-glow` | lift |
| pkg-mine/credit | th-credit | shine + dot-a | 信用光环 | `.qz-card-tint` | lift |
| pkg-mine/verify | th-verify | flow + blob-a | 认证进度流 | `.qz-card` | press |
| pkg-mine/settings | th-settings | 仅 blob-b（刻意克制） | 无 | `.qz-card-line` | press |
| pkg-mine/notifications | th-mine | flow-soft + dot-b | 信使动线 | `.qz-card-line` + `.qz-card-bar` | lift |
| pkg-mine/profile | th-mine | curve + halo | 头像取景环（halo 套在头像上，换头像时跟着呼吸） | `.qz-card-grad` | press |
| pkg-mine/admin/index | th-mine | topline + dot-c | 指标卡顶部一条数据线 | `.qz-card-bar` | lift |
| pkg-mine/admin/users | th-mine | 仅 dot-c（列表页刻意克制） | 无 | `.qz-card-bar` | press |
| pkg-mine/admin/verifications | th-mine | dot-c + flow-rev | 待审队列的逆向流水 | `.qz-card-bar` | press |
| pkg-mine/admin/orders | th-mine | dot-c + water | 资金流水的水波 | `.qz-card-bar` | press |
<!-- 后台四页是一个家族：用同一枚 `dot-c` + 同一张 `.qz-card-bar` 做识别锚，
     靠第二个装饰元素（topline / 无 / flow-rev / water）区分页。
     这里刻意不"每页换一套装饰"—— 四页之间来回跳的是同一个功能，
     装饰一致才是"同一个后台"，不一致反而像四个不相干的页。
     （与执行纪律 1 不冲突：那条针对的是"同一模块里被当成不同功能做的页"。） -->
| pkg-toolkit/home | th-toolkit | flow-soft + dot-a | 工具清单动线 | `.qz-card` | press |
| pkg-toolkit/gpa | th-toolkit | shine-slow + dot-a | 成绩单反光 | `.qz-card` | press |
| pkg-toolkit/split-bill | th-toolkit | rise + dot-b | 结算天平 | `.qz-card` + 内嵌 `.qz-card-tint` | press |
| pkg-toolkit/countdown | th-toolkit | blob-c + dot-a | 日期翻页感 | `.qz-card` + 内嵌 `.qz-card-tint` | press |
| pkg-toolkit/timetable | th-toolkit | topline + water | 课表网格推进 | `.qz-card`（网格独立白卡） | press |
| pkg-toolkit/lottery | th-toolkit | flow-thick + dot-c | 抽中的名字成排弹出 | `.qz-card` + 内嵌 `.qz-card-tint` | press |
| pkg-toolkit/trip | th-toolkit | curve + dot-b | 时间轴节点逐站推进 | `.qz-card`（站点卡） | press |
| pkg-toolkit/unit-convert | th-toolkit | halo + dot-a | 结果卡下的"1 米 = 100 厘米"说明行 + 整列常用对照 | `.qz-card` + 输入 `.qz-card-grad`、结果 `.qz-card-glow`、对照 `.qz-card-line` | press |
| pkg-toolkit/date-calc | th-toolkit | water + dot-c | 天数拆成"N 周 M 天"的大数字 + 首尾各是周几 | `.qz-card` | press |
| pkg-toolkit/text-tools | th-toolkit | blob-a + shine-slow（页内压 `opacity:.6`，合计 ≈.33 回红线内） | 六格字数盘 + 八个操作 chip 就地改写、结果可回退 | `.qz-card` + 统计 `.qz-card-tint`、结果 `.qz-card-glow .qz-card-bar` | press |
| pkg-vocab/home | th-vocab | blob-a/b + curve | 翻开的书脊 | `.qz-card` + 页内 `.vocab-hero`（渐变 + topline + shine） | press |
| pkg-vocab/study | th-vocab | blob + curve | 一张题卡背后一团光 | `.qz-card` + 顶部 `.qz-topline`；**题面按题型换四种骨架**（`.study-sense` 释义 / `.study-cloze` 挖空句 / `.study-listen` 大喇叭 / `.study-input` 拼写输入），反馈区 `.study-cmp` 做左右对照 | press |
| pkg-vocab/stats | th-vocab | blob + curve | 打卡格子之外的一条弧 | `.qz-card` + `.qz-card-line` | press |
| pkg-practice/home | th-practice | blob-a/b + curve | 三个模块入口的节奏线 | `.qz-card`（模块入口）+ `.qz-card-tint`（今日进度） | lift |
| pkg-practice/session | th-practice | dot-b + curve | 题面下方的呼吸点 | `.qz-card` + 页内 `.sess-card`；**交互区按模式换骨架**（`.sess-chunks` 砖块区 / `.sess-rec` 大录音键 / `.sess-words` 逐词对照 / `.sess-essay` 正文输入），作答后摊开的批改区 `.sess-dim` | press |
| pkg-practice/stats | th-practice | blob-b + curve | 30 天格子的底色 | `.qz-card` + 页内 `.pstats-hero` / `.pstats-mod` | press |

**执行纪律**：
1. 同一模块的相邻页（如 order-list / order-detail）刻意错开装饰类型与卡型，避免"复制页"观感；
2. `.qz-lift` 只给**可点击**卡片；纯信息卡不挂（防误以为可点）；
3. 用量红线不变：一屏 ≤ 3 blob + 2 流线、装饰总不透明度 ≤ 0.4、装饰层 `pointer-events:none`。
4. **本表的每一行都要真的走完 §六 四步**：装饰签名列了 `flow` / `water` / `wave` / `curve` / `topline` 的页，
   必须按 §六 的三类分工表在本页 SCSS 里补定位，否则那条签名装饰根本看不见（⑳ 段逐条断言）。

**覆盖状态（2026-10-08 实测）**：59 份 WXML 中 58 页已接指针视差、59 页均有 `qz-an-*` 入场层次，
唯一豁免是 `pages/common/webview.wxml` 的降级分支（见 §六）。
> 2026-10-08 计数变更一：`pkg-toolbox/knowledge`（校园知识库独立页）已下线并从本表移除，WXML 48 → 47。
> 后端 `/knowledge/*` 与 AI 的 `search_knowledge` 能力**未动**。
>
> 2026-10-08 计数变更二：新增 `pkg-mine/profile`（M0-20 资料编辑）与
> `pkg-mine/admin/{index,users,verifications,orders}`（M3-20 管理后台）共 5 页，
> 同期另有一批 `pkg-toolbox` 工具页落地，现共 59 份。
> ⚠️ 这两处数字取自 `find apps/mp -name '*.wxml' | wc -l` 与 `npm run audit:mp` 的自报计数。
> 覆盖度这类句子一旦开始靠回忆写，后面的人会把它当成事实引用下去。
本轮补齐的是 `pkg-toolkit` 的 7 页落后项（countdown / gpa / split-bill / timetable / trip / home / lottery），
并修掉 6 处页面 SCSS 裸 `#ffffff`；顺带查出 `pkg-practice/{home,session}` 的 `.practice-curve`
与 `pkg-toolkit/lottery` 的 `.qz-flow` **本来就贴在裁切区外**（弧与流线一直没显示到位）。

---

## 十、已知取舍

- **深色模式**：`app.json` 声明了 `darkmode: true`，但页面样式目前基于 SCSS 常量（浅色），
  深色下仅原生导航栏会变深。模块色板未提供深色覆盖，避免出现"半深半浅"的更差结果；
  待整体切到 CSS 变量后再统一实现（属独立任务，不在本次视觉升级范围）。
- **本地字体**：未引入自定义字体（体积与合规成本高），靠字重与字号拉开层次。
