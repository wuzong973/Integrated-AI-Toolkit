/**
 * 驿站发布 · 本地兜底解析（M3-07 的离线分支）
 *
 * ## 为什么单独成文件，而不是留在发布页里
 *
 *  ① **能测**。这些是纯函数，而页面文件顶层会执行 `Page({…})` 且依赖 `wx`，
 *     vitest 根本导不动。`tests/mp/` 的既有做法就是直接 import `apps/mp/utils/*`
 *     里的纯逻辑（`progress` / `request` / `env` 三个 spec 都是这么写的）。
 *     "把日期当成钱"这类 bug 只有单测钉得住 —— 它不报错，只在用户眼里是"系统乱填"。
 *  ② 页面文件有 300 行红线（eslint `max-lines`），发布页原本就贴着上限。
 *
 * ## 口径必须与后端 `POST /station/parse` 一致
 *
 * 返回的字段形状 = 后端的 `ParsedDraft`，且 **budget 单位是分**。
 * 兜底与后端不同单位的话，"预算差 100 倍"只会在断网时出现，正常情况下永远测不到 ——
 * 而线上第一个撞上它的是用户。所以这条规则连同下面的金额正则都有用例守着。
 */

/** 分类关键词表（顺序敏感：先匹配更具体的） */
const CATEGORY_RULES: { re: RegExp; id: string }[] = [
  { re: /拍|摄影|跟拍|毕业照/, id: 'photo' },
  { re: /ppt|幻灯片|设计/i, id: 'design' },
  { re: /文案|稿|写作/, id: 'copy' },
  { re: /代码|编程|开发/, id: 'code' },
  { re: /家教|辅导/, id: 'tutor' },
  { re: /主持/, id: 'host' },
  { re: /剪辑|视频/, id: 'video' },
  { re: /跑腿|取|送/, id: 'rent' },
];

export function guessCategory(text: string): string | null {
  for (const r of CATEGORY_RULES) if (r.re.test(text)) return r.id;
  return null;
}

/**
 * 预算：¥300 / 300 元 / 300 块 / 预算 300 / 价格大概 200 → **分**。
 *
 * ⚠️ 曾经的规则是 `/(\d{2,6})(元|块)?/` —— 货币单位是**可选**的，
 * 于是"任意两位以上数字"都被当成钱：「12月20日」读成 ¥12（1200 分）、
 * 「2024年6月」读成 ¥2024。预填进表单后它只是一个看起来正常的数字，
 * 用户不会怀疑，而这正是本项目反复强调的"不报错的错"。
 *
 * 现在两条支路都要求**货币语境**：
 *   ① 数字后面真的跟着货币单位（元 / 块 / ¥ / RMB）；
 *   ② 或前面真的有「预算 / 价格 / 报价」这类词，**且紧跟的数字不是日期成分**
 *      （"预算12月20日" 里的 12、20 说的是月份和日子，不是钱）。
 * 末尾那串否定预查就是"这不算一个完整金额"的清单：数字后面还接着数字、
 * 或接着 月/日/号/周/年/点（那是日期与时刻）、或接着 千/万/亿、
 * 或小数位只写了一半（"价格12.5万"里的 12 与 12.5 都不是预算）—— 一律判"没提预算"。
 * 少了这串预查，正则会在长数字里**退而求其次**地抠出一小截（"300万"能匹配上"30"），
 * 那种错比不填更隐蔽：它是个看起来完全合理的数字。
 *
 * 孤零零的「300」一律不再当预算：**宁可不预填，也不填一个猜出来的价** ——
 * 少填一项用户会自己补，填错一项用户会以为那是系统给的估价。
 *
 * ⚠️ 支持 "300.5元" 这种小数说法，但**出口必须是整数分**（`Math.round`）：
 * 红线要求金额全程用「分」的整数，浮点一旦混进 state 就会一路带到提交。
 */
const BUDGET_RE =
  /(?:(\d{1,6}(?:\.\d+)?)\s*(?:元|块|rmb|¥|￥)|(?:预算|价格|报价)\D{0,3}?(\d{2,6}(?:\.\d+)?))(?!\s*[月日号周年点]|\d|[千万亿]|\.\d)/i;

export function guessBudget(text: string): number | null {
  const m = text.match(BUDGET_RE);
  if (!m) return null;
  const yuan = Number(m[1] ?? m[2]);
  return Number.isFinite(yuan) && yuan > 0 ? Math.round(yuan * 100) : null;
}

/** 时间：6月10日 / 明天 / 下周 —— 与后端一致，**原样保留用户说法**（不换算成日期） */
export function guessTime(text: string): string | null {
  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) return `${m[1]}月${m[2]}日`;
  if (/明天/.test(text)) return '明天';
  if (/下周/.test(text)) return '下周';
  return null;
}

/** 技能标签 */
const SKILL_RULES: { re: RegExp; tag: string }[] = [
  { re: /摄影|跟拍|拍/, tag: '摄影' },
  { re: /修图|精修|后期/, tag: '后期修图' },
  { re: /主持/, tag: '主持' },
  { re: /剪辑/, tag: '剪辑' },
];

export function guessSkillTags(text: string): string[] {
  return SKILL_RULES.filter((r) => r.re.test(text)).map((r) => r.tag);
}

/**
 * 断网 / 后端不可用时的关键词兜底解析。
 *
 * 字段与 `ParsedDraft` 对齐，**只填真正确定下来的项**：
 * 猜不出来就留空，让页面按"这项没填"处理（而不是填个像样的假值）。
 */
export function localParse(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = { title: text.slice(0, 20) };

  const categoryId = guessCategory(text);
  if (categoryId) result.categoryId = categoryId;

  const budget = guessBudget(text);
  if (budget !== null) result.budget = budget;

  const time = guessTime(text);
  if (time) result.time = time;

  if (/本校|校内/.test(text)) result.location = '本校';

  const tags = guessSkillTags(text);
  if (tags.length) result.skillTags = tags;

  return result;
}
