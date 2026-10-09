/**
 * 静态守卫：工具 `status: 'active'` 必须与"执行器真的能跑"一致
 *
 * ## 为什么需要它
 *
 * `status` 决定界面表现：`active` 显示"免费"角标并可点击执行；
 * `planned` 显示"即将上线"并在点击时给出提示。
 *
 * 如果 `active` 但执行器没注册该工具，用户点了只会拿到
 * "该工具尚未接入执行器"这种面向开发者的报错 —— **展示与行为不一致**。
 * 这不是假设：2026-09-17 核对时发现 18 个 `active` 里有 9 个跑不通
 *（8 个未注册 + AI 抠图的 Provider 直接抛错）。
 *
 * ## 为什么静态解析而不加载 dist
 *
 * 加载 `apps/api/dist` 需要先 build，跑守卫前还要等构建，很容易被跳过。
 * 这里直接读源码文本：seed 的 `TOOLS` 数组 + 执行器的 `handlers` 字面量键，
 * 零依赖、秒级完成。
 *
 * ## 两把尺子，不是一把
 *
 * "能跑"有**两条**通路，守卫必须都认：
 *
 *   ① 工具箱工具 —— seed `status: 'active'` + 执行器注册（走作业链路）
 *   ② 内部能力（`source: 'internal'`）—— 助手进程内直调，**不进执行器**
 *      （`os-tools.ts` 分流 → `os-knowledge-tool.ts`）
 *
 * 只认 ① 的后果不是漏报，而是**把状态逼成假的**：`search_knowledge` 明明可用，
 * 却因为改成 `active` 会误报，只好一直挂着 `planned`（2026-09-19 修正）。
 *
 * ## 用法
 *
 *   node scripts/dev/check-tool-status.mjs
 *
 * 退出码非 0 表示存在"标了已上线但跑不通"（或反之）的工具。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

// ---------- ① 从 seed.ts 取「工具名 → status」 ----------
const seedSrc = readFileSync(resolve(ROOT, 'apps/api/prisma/seed.ts'), 'utf8');

/** 只取 TOOLS 数组那一段，避免误匹配 DEMO_USERS 等 */
const toolsStart = seedSrc.indexOf('const TOOLS = [');
const toolsEnd = seedSrc.indexOf('\nconst ', toolsStart + 1);
const toolsSrc = seedSrc.slice(toolsStart, toolsEnd === -1 ? undefined : toolsEnd);

/**
 * 逐块解析（每个 `{ ... }` 一块），而不是用一条大正则跨块匹配。
 * 这样 `visible` 也能一起取到 —— 它是"总数看起来小一截"的元凶：
 * 接口默认 `where: { visible: true }`，所以从接口读到的 33 并不是全量。
 *
 * ⚠️ 换行必须是 `\r?\n`（本仓库文件是 CRLF），只写 `\n` 会切不出任何一块。
 */
const seedTools = new Map();
{
  const blocks = toolsSrc.split(/\r?\n {2}\{\r?\n/).slice(1);
  for (const b of blocks) {
    const name = (b.match(/name: '([a-z_]+)'/) ?? [])[1];
    const displayName = (b.match(/displayName: '([^']+)'/) ?? [])[1];
    const status = (b.match(/status: '(active|planned)'/) ?? [])[1];
    if (!name || !status) continue;
    // 同名工具只应出现一次；重复时保留后者并提示
    if (seedTools.has(name)) {
      console.log(`   ⚠️ seed 里出现重复工具名：${name}`);
    }
    seedTools.set(name, { displayName, status, internal: /visible: false/.test(b) });
  }
}

/** 权威口径：`seed.ts` 是唯一来源，文档里的数字由 check:doc-counts 比对本值 */
const CATALOG = {
  total: seedTools.size,
  internal: [...seedTools.values()].filter((t) => t.internal).length,
  active: [...seedTools.values()].filter((t) => t.status === 'active').length,
};
CATALOG.visible = CATALOG.total - CATALOG.internal;
CATALOG.planned = CATALOG.total - CATALOG.active;

// ---------- ② 从执行器源码取「已注册的工具名」 ----------
const execSrc = readFileSync(
  resolve(ROOT, 'apps/api/src/modules/job/tool-executor.service.ts'),
  'utf8',
);

const handlersStart = execSrc.indexOf('this.handlers = {');
const handlersEnd = execSrc.indexOf('\n    };', handlersStart);
const handlersSrc = execSrc.slice(handlersStart, handlersEnd === -1 ? undefined : handlersEnd);

const registered = new Set();
for (const m of handlersSrc.matchAll(/^\s*([a-z_]+)\s*:/gm)) {
  registered.add(m[1]);
}

/**
 * 「已在执行器注册，但 Provider 还没实现」的工具 —— 仍然算跑不通，状态应为 `planned`。
 *
 * 为什么需要这份清单：`registered` 只说明**路由通了**，不说明**能力存在**。
 * 例如 `remove_background` 路由到了 `SharpImageProvider.removeBackground`，
 * 而 Sharp 做不了 AI 抠图，那个方法直接抛错（需 rembg 侧车 / `AI_SERVICE_URL`）。
 *
 * 清单里必须写清"缺什么"，这样它被移除的那天就是"能力真的补齐了"。
 * 实现补齐后：从本清单删掉 + 把 seed 里的 status 改回 `active`。
 */
/**
 * 「已注册但 Provider 未就绪」的豁免清单。
 *
 * 2026-09-19：`remove_background` 已从本表移除 —— `services/ai` 的 `/ai/matting`
 * 真实实现（rembg + u2net 白名单），后端 `SidecarImageProvider` 也接上了，
 * seed 里同步转成 `active`。留着条目会让守卫永远忽略它（清单腐化），
 * 而这正是本脚本反向检查要防的事。
 */
const PROVIDER_NOT_READY = {
  /**
   * 2026-10-08：路由与执行链（RepoToolRunner + DeepWikiProvider）已接通，
   * 但 deepwiki-open 尚未部署 —— `DEEPWIKI_BASE_URL` 为空时 Provider 回落
   * mock-repo（演示数据）。部署、配置并实测端到端后：
   * 从本清单删掉 + 把 seed 里的 status 改成 `active`（与 remove_background 同流程）。
   */
  explain_repository: 'deepwiki-open 未部署（缺 DEEPWIKI_BASE_URL），真实 Provider 未就绪',
};

// ---------- ②c AI 能力目录里的「内部能力」 ----------
/**
 * 内部能力（`source: 'internal'`）**不进执行器** —— 它们由助手进程内直调
 *（`os-tools.ts` 的分流 + `os-knowledge-tool.ts` 的实现），走的是 `OsCapabilityRegistry`
 * 而不是作业链路。
 *
 * 为什么守卫必须认识它们：本脚本原来只有一把尺子（"执行器注册了吗"），
 * 于是 `search_knowledge` 被逼成了 `planned` —— 不是因为它跑不通，
 * 而是因为改成 `active` 会误报"标为 active 但实际跑不通"。
 * **状态字段成了守卫的奴隶，而不是事实的记录。**
 * 这类"被守卫逼出来的假状态"比漏报更难发现：界面一切正常，
 * 只有 seed 与文档在说假话，而且没人会去质疑一条 `planned`。
 *
 * 判据（与 `check-ai-capabilities.mjs` 第 ⑥ 条同源）：目录里声明了
 * `source: 'internal'` 且带 `params`，就说明它有实现、有参数规范、
 * 会被注册表放行（`os-capability.registry.ts` 对内部能力**不检查 status**）。
 */
const readInternalCapabilities = () => {
  const dir = resolve(ROOT, 'apps/api/src/modules/os');
  const src = readdirSync(dir)
    .filter((f) => /^ai-capability\.catalog(\.[\w.-]+)?\.ts$/.test(f))
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .join('\n');
  // `(?:(?!toolName:)[\s\S])*?` 保证不会跨过下一条能力去匹配它的 source
  const re = /toolName:\s*'([a-z_]+)'(?:(?!toolName:)[\s\S])*?source:\s*'internal'/g;
  return new Set([...src.matchAll(re)].map((m) => m[1]));
};
const internalCapabilities = readInternalCapabilities();

// ---------- ③ 比对 ----------
const problems = [];

/**
 * 真正能跑 = （执行器已注册 **或** 属于内部能力）且 Provider 已实现。
 *
 * 内部能力不进执行器，但**助手确实调得动**，所以同样算"能跑"。
 */
const runnable = (name) =>
  (registered.has(name) || internalCapabilities.has(name)) && !(name in PROVIDER_NOT_READY);

// ---------- ②b AI 助手的意图路由表 ----------
/**
 * `INTENT_TOOL_MAP`（`apps/mp/utils/os.ts`）把用户直接送到工具执行页，
 * 所以它**只能指向真能跑的工具**。
 *
 * 这条守卫是补出来的：曾经它指向 `compress_video` / `separate_vocals`，
 * 而这两个后来被标成 `planned` —— 用户点按钮只会拿到"即将上线"的弹窗，
 * 等于 AI 助手把人引到了死路。这种"状态改了但引用没跟着改"的漂移，
 * 光靠人看是发现不了的。
 */
const osUtilSrc = readFileSync(resolve(ROOT, 'apps/mp/utils/os.ts'), 'utf8');
const mapStart = osUtilSrc.indexOf('INTENT_TOOL_MAP');
const mapEnd = osUtilSrc.indexOf('};', mapStart);
const mapSrc = osUtilSrc.slice(mapStart, mapEnd === -1 ? undefined : mapEnd);

/** 特例：这些不是"跳工具执行页"，由页面 onActionTap 另行处理（必须写清原因） */
const INTENT_SPECIAL_ACTIONS = {
  create_task: '由 pages/os 的 onActionTap 特殊处理 → switchTab 到驿站，不进工具执行页',
  toolbox: '由 pages/os 的 onActionTap 特殊处理 → switchTab 到工具箱（多工具意图让用户自己选）',
};

for (const m of mapSrc.matchAll(/toolName:\s*'([a-z_]+)'/g)) {
  const tool = m[1];
  if (tool in INTENT_SPECIAL_ACTIONS) continue;
  if (!runnable(tool)) {
    problems.push(
      `AI 助手的 INTENT_TOOL_MAP 指向「${tool}」，但它跑不通 —— ` +
        '用户点按钮会拿到"即将上线"弹窗（要么换工具，要么登记到 INTENT_SPECIAL_ACTIONS）',
    );
  }
}

// 3.1 标了 active 但跑不通 —— 用户点了必然失败
for (const [name, info] of seedTools) {
  if (info.status === 'active' && !runnable(name)) {
    const why = PROVIDER_NOT_READY[name] ? `（${PROVIDER_NOT_READY[name]}）` : '';
    problems.push(
      `「${info.displayName}」(${name}) 标为 active，但实际跑不通${why} —— 用户点了会失败`,
    );
  }
}

// 3.2 真能跑但没标 active —— 能力白白藏着，用户看不到
for (const name of registered) {
  if (!runnable(name)) continue;
  const info = seedTools.get(name);
  if (!info) {
    problems.push(`执行器注册了 ${name}，但 seed 里没有这个工具 —— 界面上看不到它`);
  } else if (info.status !== 'active') {
    problems.push(
      `「${info.displayName}」(${name}) 真能跑，但状态是 ${info.status} —— 用户看不到能用的能力`,
    );
  }
}

// 3.3 豁免清单里已经能跑的项 —— 该把它删掉了
for (const name of Object.keys(PROVIDER_NOT_READY)) {
  if (registered.has(name) && seedTools.get(name)?.status === 'active') {
    problems.push(`${name} 已在豁免清单里，但状态是 active —— 请确认能力是否已补齐并清理清单`);
  }
}

// 3.4 内部能力明明可用，seed 里却标 planned —— 状态在说假话
for (const name of internalCapabilities) {
  const info = seedTools.get(name);
  if (!info) {
    problems.push(
      `AI 能力目录里的内部能力 ${name}，在 seed 的 TOOLS 里不存在 —— ` +
        '能力对账时无据可查（`GET /tools` 也不会返回它）',
    );
    continue;
  }
  if (info.status !== 'active') {
    problems.push(
      `「${info.displayName}」(${name}) 是内部能力（助手进程内直调，不经执行器），` +
        `但 seed 里是 ${info.status} —— 助手实际调得动它，状态在说假话`,
    );
  }
}

// ---------- 输出 ----------
if (problems.length === 0) {
  const exempt = Object.keys(PROVIDER_NOT_READY).length;
  console.log(
    `✅ 工具状态与实现一致：${CATALOG.active} 个 active 全部真能跑，` +
      `${registered.size} 个已注册全部可见（另有 ${exempt} 个注册但 Provider 未实现，已豁免）` +
      (internalCapabilities.size
        ? `；${internalCapabilities.size} 个内部能力（助手进程内直调，不进执行器）状态一致`
        : ''),
  );
  console.log(
    `\n📖 权威工具口径（唯一来源：apps/api/prisma/seed.ts）\n` +
      `   工具总数 ${CATALOG.total} 条 = 用户可见 ${CATALOG.visible} + Agent 内部 ${CATALOG.internal}\n` +
      `   状态：active ${CATALOG.active} / planned ${CATALOG.planned}\n` +
      `   ⚠️ 接口 GET /api/v1/tools 默认只返回"用户可见"的 ${CATALOG.visible} 条\n` +
      `      （where: { visible: true }）；要读全量加 ?includeInternal=true。\n` +
      `      文档里的数字请引用本行，并由 npm run check:doc-counts 校验。`,
  );
  process.exit(0);
}

console.log(`❌ 发现 ${problems.length} 处"状态与实现不一致"：\n`);
for (const p of problems) console.log(`  · ${p}`);
console.log(
  '\n改法：跑不通的工具把 seed 里的 status 改成 planned（界面显示"即将上线"，' +
    '后端 assertAvailable 也会拒绝）；\n      真能跑的改回 active。不要只改一边。',
);
process.exit(1);
