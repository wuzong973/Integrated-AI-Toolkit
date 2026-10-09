/**
 * LLM 接入自检（用**项目真实的 Provider**打真实接口）
 *
 * ## 为什么要有它
 *
 * 接入 LLM 最容易卡在"三件小事"上，而且都表现为同一句看不懂的报错：
 *   ① baseUrl 写错（多了/少了一段路径）；
 *   ② Key 无效或余额/额度已用尽；
 *   ③ **模型名在该服务商不存在**（例如把 `deepseek-reasoner` 填到智谱上）。
 * 有了这个脚本，填完配置先跑一次，30 秒定位，不用去跑一遍"生成 PPT"再猜。
 *
 * ## 为什么直接 import dist 里的 Provider 而不是另写一份请求
 *
 * 另写一份只能验证"我对协议的理解"，验证不了**项目实际用的那段代码**。
 * 这里直接加载 `apps/api/dist` 里编译好的 `OpenAiCompatibleLlmProvider`，
 * 与线上是同一条路径（所以脚本前需要 `npm run build -w @qz/api` 或 `npm run build`）。
 *
 * ## 用法
 *
 *   node scripts/dev/verify-llm.mjs
 *
 * 未配置 `LLM_API_KEY` 时脚本会**明确告诉你该怎么配**并以退出码 0 结束
 *（"还没配"不是失败，不该让 CI 或你误以为坏了）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * ⚠️ 读**仓库根** `.env`，而不是 `apps/api/.env`。
 *
 * `apps/api/.env` 只是 `scripts/dev/setup-env.mjs` 从根 `.env` 复制出来的**生成物**
 *（Prisma CLI 只认 schema 同级目录，才需要那一份）。配置的**唯一事实来源是根 `.env`**
 *（见 `apps/api/src/common/config/paths.ts` 的 `ENV_FILE_PATHS`）。
 *
 * 2026-09-19 实测踩到：改了根 `.env` 的 `LLM_FALLBACK_MODELS` 后跑本脚本，
 * 它仍读旧值并报"降级链 [glm-4.7-flash]" —— **差点据此得出错误结论**。
 * 与后端读不同文件的脚本，会给出**看起来权威、实际过期**的结论。
 */
const ENV_FILE = [resolve(ROOT, '.env'), resolve(ROOT, 'apps/api/.env')].find((p) =>
  existsSync(p),
);

const require = createRequire(import.meta.url);

let failures = 0;
const ok = (c) => (c ? '✅' : '❌');
const check = (cond, label) => {
  if (!cond) failures += 1;
  console.log(`   ${ok(cond)} ${label}`);
};

/** 读取 .env（只取需要的几项，不引入 dotenv） */
function readEnv() {
  const text = readFileSync(ENV_FILE, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const mask = (key) => (key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`);

/** 未配置时的引导（写得具体，省一次来回问） */
function printSetupGuide(env) {
  console.log();
  console.log('='.repeat(74));
  console.log('未配置 LLM_API_KEY —— 还没有接上真实模型（当前走 Mock）');
  console.log('='.repeat(74));
  console.log(`   当前 baseUrl : ${env.LLM_BASE_URL || '(空)'}`);
  console.log(
    `   当前模型     : intent=${env.LLM_MODEL_INTENT} generate=${env.LLM_MODEL_GENERATE} plan=${env.LLM_MODEL_PLAN}`,
  );
  console.log();
  console.log('   两条免费的接入方式（都实测过地址可达）：');
  console.log();
  console.log('   ① 智谱 GLM（永久免费不限量，中文最强，推荐）');
  console.log('      注册 https://open.bigmodel.cn → 控制台生成 API Key');
  console.log('      LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4');
  console.log('      LLM_MODEL_INTENT=glm-4.7-flash');
  console.log('      LLM_MODEL_GENERATE=glm-4.7-flash');
  console.log('      LLM_MODEL_PLAN=glm-4.7-flash');
  console.log();
  console.log('   ② 硅基流动（新用户送 2000 万 token，9B 以下永久免费）');
  console.log('      注册 https://cloud.siliconflow.cn → 生成 API Key');
  console.log('      LLM_BASE_URL=https://api.siliconflow.cn/v1');
  console.log('      LLM_MODEL_INTENT=Qwen/Qwen2.5-7B-Instruct');
  console.log('      LLM_MODEL_GENERATE=Qwen/Qwen2.5-7B-Instruct');
  console.log('      LLM_MODEL_PLAN=deepseek-ai/DeepSeek-V3（额度有限，规划用）');
  console.log();
  console.log('   ③ 本地 Ollama（完全免费，需显卡）');
  console.log('      LLM_BASE_URL=http://127.0.0.1:11434/v1   LLM_API_KEY=ollama（随便填非空）');
  console.log('      LLM_MODEL_*=qwen3.5:9b');
  console.log();
  console.log(
    '   配置写在 apps/api/.env（三处 .env 都要同步时可以只改这一个，见 docs/dev/ENV.md）。',
  );
  console.log('   填完先跑本脚本，再跑业务：node scripts/dev/verify-llm.mjs');
  console.log('='.repeat(74));
}

/** 三个档位各打一次真实请求 */
async function verifyTiers(provider, cfg) {
  const tiers = [
    ['intent', cfg.models.intent],
    ['generate', cfg.models.generate],
    ['plan', cfg.models.plan],
  ];

  for (const [tier, model] of tiers) {
    const started = Date.now();
    try {
      // ⚠️ maxTokens 不能太小：GLM-4.7/5.x 是推理型模型，token 会先花在 reasoning 上，
      // 太小会导致 content 为空（这是实测踩过的坑，不是理论风险）
      const res = await provider.chat([{ role: 'user', content: '只回复两个字：可以' }], {
        tier,
        maxTokens: 600,
        temperature: 0,
      });
      const ms = Date.now() - started;
      const text = (res.content || '').trim().slice(0, 20);
      const usage = res.usage
        ? ` prompt=${res.usage.promptTokens} completion=${res.usage.completionTokens}`
        : '';
      console.log(
        `   ${tier.padEnd(9)} ${String(model).padEnd(30)} ${String(ms).padStart(5)}ms  → 「${text}」${usage}`,
      );
      check(!!text, `${tier} 档有返回内容`);
    } catch (e) {
      console.log(
        `   ${tier.padEnd(9)} ${String(model).padEnd(30)} ❌ ${String(e?.message ?? e).slice(0, 90)}`,
      );
      check(false, `${tier} 档调用成功（模型名是否在该服务商存在？）`);
    }
  }
}

/** 结构化输出：M2 的 Agent/Tool 编排全靠它 */
async function verifyStructured(provider) {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      sections: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'sections'],
    additionalProperties: false,
  };

  try {
    const res = await provider.structured(
      [
        { role: 'system', content: '你是 PPT 大纲助手，只输出 JSON。' },
        { role: 'user', content: '给「校园二手交易平台」写一个 3 节的 PPT 大纲' },
      ],
      schema,
      // 推理型模型会先花 token 在 reasoning 上，这里必须给足，
      // 否则 content 为空（maxTokens=300 时实测 1007 字符推理把额度吃光）
      { tier: 'generate', maxTokens: 2000, temperature: 0 },
    );
    const json = res;
    console.log(`   结构化输出 → ${JSON.stringify(json).slice(0, 160)}`);
    check(
      typeof json?.title === 'string' && Array.isArray(json?.sections),
      '返回了符合 schema 的 JSON',
    );
  } catch (e) {
    console.log(`   ❌ 结构化输出失败：${String(e?.message ?? e).slice(0, 160)}`);
    check(false, '结构化输出可用（PPT 大纲 / Agent 编排依赖它）');
  }
}

/** 从 .env 值组装 Provider 配置（供 loadProvider 与降级验证共用） */
function buildCfg(env) {
  return {
    driver: env.LLM_DRIVER,
    baseUrl: env.LLM_BASE_URL ?? '',
    apiKey: env.LLM_API_KEY ?? '',
    models: {
      intent: env.LLM_MODEL_INTENT,
      generate: env.LLM_MODEL_GENERATE,
      plan: env.LLM_MODEL_PLAN,
    },
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60000),
    // ⚠️ 必填：漏了它 `TimeBudget` 的 deadline 会算成 NaN，于是**一次请求都发不出去**，
    //    报错是 'budget-exhausted-before-first-attempt' —— 看起来像"预算太小"，
    //    其实是"压根没传"。2026-09-18 这个漏项让整个脚本的三个档位全部假失败。
    totalBudgetMs: Number(env.LLM_TOTAL_BUDGET_MS ?? 45000),
    maxRetry: Number(env.LLM_MAX_RETRY ?? 3),
    // 降级模型：主模型重试耗尽后按顺序再试（抗免费档 429/1305 过载）
    fallbackModels: String(env.LLM_FALLBACK_MODELS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reasoningEffort: env.LLM_REASONING_EFFORT ?? '',
    // 与 env.schema 同构：只有显式 `false` 才算关（未设置 / 空值都视为默认 true）
    disableThinking: String(env.LLM_DISABLE_THINKING ?? 'true').toLowerCase() !== 'false',
    enabled: true,
  };
}

/** 加载编译产物里的 Provider 类（与线上同一条代码路径） */
function loadProviderClass() {
  try {
    const { OpenAiCompatibleLlmProvider } = require(
      resolve(ROOT, 'apps/api/dist/infra/providers/llm/openai-compatible.provider.js'),
    );
    return OpenAiCompatibleLlmProvider;
  } catch (e) {
    console.log(`\n❌ 加载 Provider 失败：${String(e?.message ?? e)}`);
    console.log('   请先构建：npm run build -w @qz/api');
    return null;
  }
}

/** 从 .env 值组装 Provider（与线上同一条代码路径：直接加载编译产物） */
function loadProvider(env) {
  const Provider = loadProviderClass();
  return Provider ? new Provider(buildCfg(env)) : null;
}

/**
 * ③ 降级机制验证
 *
 * 用**真实请求次数**判断有没有"白打一次往返"：
 *   · 确定性失败（模型不存在 → 400）必须**不降级** —— 换了也一样失败，多打一次纯浪费；
 *   · 主模型可用时必须由主模型回答，不能无谓地换成降级模型。
 *
 * 注意：这里**不主动制造 429**（造不出来，过载与否由平台决定）。
 * "过载时真的会换模型"由单测确定性覆盖
 *（`apps/api/src/infra/providers/llm/__tests__/openai-compatible.spec.ts`）。
 */
async function verifyFallback(env, Provider) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls += 1;
    return realFetch(...args);
  };

  try {
    // 3.1 确定性失败（模型不存在）不触发降级
    const bogus = new Provider({
      ...buildCfg(env),
      models: { intent: 'x', generate: 'glm-not-exist-model', plan: 'x' },
      maxRetry: 1,
      fallbackModels: ['glm-5.3-flash'],
    });
    calls = 0;
    let threw = false;
    try {
      await bogus.chat([{ role: 'user', content: 'hi' }]);
    } catch {
      threw = true;
    }
    check(threw, '模型名不存在时抛错（不静默成功）');
    check(calls === 1, `确定性失败只打 1 次请求（实际 ${calls}）—— 不浪费降级往返`);

    // 3.2 主模型可用时由主模型回答
    calls = 0;
    const p = new Provider({ ...buildCfg(env), maxRetry: 1 });
    const res = await p.chat([{ role: 'user', content: '只回复两个字：可以' }]);
    check(!!res.content, '主模型返回内容');
    console.log(
      `      由「${res.model ?? '未知'}」回答；配置的主模型是「${env.LLM_MODEL_GENERATE}」` +
        `，降级链 [${buildCfg(env).fallbackModels.join(', ') || '空'}]`,
    );
    check(calls >= 1, '请求确实发到了服务商');
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * 3.3 降级链**逐个模型**体检（真实请求）
 *
 * ⚠️ 为什么必须单独做：3.1 / 3.2 验的是"**机制**"（该不该换、会不会换），
 * 单测验的是"换的动作" —— **没有任何一项验证"换过去的那个模型自己能不能用"**。
 * 这正是 2026-09-19 发现的漏洞：配置里的 `glm-4.7-flash` 实测 **2/2 全部 429**
 *（「该模型当前访问量过大」，90~145ms 快速失败），降级链形同虚设
 *（主模型一过载就必然失败），却没有任何检查报警。
 *
 * 判据是"能返回非空内容"。耗时一并打印 —— 因为"可用但比主模型慢 4 倍"
 * 同样会让降级变成烧光预算（降级链与主模型**共享同一个总预算**）。
 *
 * 失败会**重试一次**再判定：免费档过载是时段性的，单次失败不足以定论。
 */
async function probeFallbackModels(env, Provider) {
  const models = buildCfg(env).fallbackModels;
  if (!models.length) {
    console.log('      降级链为空 —— 主模型失败即失败（合法配置，但要知道自己在裸奔）');
    return;
  }

  for (const model of models) {
    const p = new Provider({
      ...buildCfg(env),
      models: { intent: model, generate: model, plan: model },
      fallbackModels: [],
      maxRetry: 1,
      // 这里量的是模型本身，不想被线上预算提前掐断
      totalBudgetMs: 120000,
      timeoutMs: 60000,
    });
    const t0 = Date.now();
    let detail = '';
    let usable = false;
    for (let attempt = 1; attempt <= 2 && !usable; attempt++) {
      try {
        const res = await p.chat([{ role: 'user', content: '只回复两个字：可以' }], {
          maxTokens: 200,
        });
        usable = !!res.content;
        detail = `返回「${String(res.content).trim().slice(0, 12)}」`;
      } catch (e) {
        detail = String(e?.message ?? e).slice(0, 130);
      }
    }
    const ms = Date.now() - t0;
    check(usable, `降级模型「${model}」可用（${ms}ms）${usable ? '' : ` —— ${detail}`}`);
  }
}

/** ③ 段落外壳（单独成函数，避免 main 的圈复杂度超限） */
async function runFallbackSection(env) {
  const Provider = loadProviderClass();
  if (!Provider) return;

  console.log('\n' + '='.repeat(74));
  console.log('③ 降级机制（主模型过载时是否真的会换模型）');
  console.log('='.repeat(74));
  await verifyFallback(env, Provider);
  await probeFallbackModels(env, Provider);
}

async function main() {
  console.log('\nLLM 接入自检（调用项目真实的 OpenAiCompatibleLlmProvider）\n');

  const env = readEnv();
  const apiKey = env.LLM_API_KEY ?? '';

  console.log(`   驱动   : ${env.LLM_DRIVER}`);
  console.log(`   baseUrl: ${env.LLM_BASE_URL ?? ''}`);
  console.log(`   apiKey : ${apiKey ? mask(apiKey) : '(空)'}`);
  console.log(`   主模型 : ${env.LLM_MODEL_GENERATE}`);
  console.log(`   降级链 : ${env.LLM_FALLBACK_MODELS || '(未配置)'}`);
  console.log(`   推理深度: ${env.LLM_REASONING_EFFORT || '(不发送)'}`);

  if (!apiKey) {
    printSetupGuide(env);
    process.exit(0);
  }

  const provider = loadProvider(env);
  if (!provider) process.exit(1);

  const cfg = {
    models: {
      intent: env.LLM_MODEL_INTENT,
      generate: env.LLM_MODEL_GENERATE,
      plan: env.LLM_MODEL_PLAN,
    },
  };

  console.log('\n' + '='.repeat(74));
  console.log('① 三个档位各打一次真实请求（顺便验证模型名是否存在）');
  console.log('='.repeat(74));
  await verifyTiers(provider, cfg);

  console.log('\n' + '='.repeat(74));
  console.log('② 结构化输出（PPT 大纲与 Agent 编排依赖）');
  console.log('='.repeat(74));
  await verifyStructured(provider);

  await runFallbackSection(env);

  console.log();
  console.log('='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：LLM 已可用，可以接 M1-07（PPT 大纲走模型）'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('   提示：接上后 /health 的 mockProviders 里不再出现 mock-llm');
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
