/**
 * 硅基流动 AI 能力自检（用**项目真实的 Provider** 打真实接口）
 *
 * ## 为什么要有它
 *
 * 接多模态/语音最容易卡在三件事上，而且报错都很难懂：
 *   ① 模型名写错（**漏了组织前缀**，如把 `Qwen/Qwen3.5-4B` 写成 `qwen3.5-4b` → 404）；
 *   ② ASR 打错端点（用 `/chat/completions` 传音频 → 400 "Model does not exist"）；
 *   ③ Key 无效或额度用尽。
 * 填完配置先跑本脚本，30 秒定位，不用跑一遍业务再猜。
 *
 * ## 为什么直接 import dist 里的 Provider
 *
 * 另写一份请求只能验证"我对协议的理解"，验证不了**项目实际跑的那段代码**。
 * 这里加载 `apps/api/dist` 里编译好的 VlmOcrProvider / SiliconflowAsrProvider，
 * 与线上同一条路径（所以运行前需要 `npm run build -w @qz/api`）。
 *
 * ## 用法
 *
 *   node scripts/dev/verify-siliconflow.mjs [测试图片路径]
 *
 * 不传图片路径时会用 sharp 自动生成一张含文字的测试图。
 * 未配置 `SILICONFLOW_API_KEY` 时脚本会明确说明如何配置并以退出码 0 结束
 *（"还没配"不是失败）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILE = resolve(ROOT, 'apps/api/.env');
const require = createRequire(import.meta.url);
/** sharp 装在 apps/api 下，用它的解析上下文才能 require 到 */
const apiRequire = createRequire(resolve(ROOT, 'apps/api/package.json'));

let failures = 0;
const check = (cond, label) => {
  if (!cond) failures += 1;
  console.log(`   ${cond ? '✅' : '❌'} ${label}`);
};
/** 只报告不计分的观察项（如厂商行为探测，厂商改行为不该让脚本变红） */
const note = (label) => console.log(`   ℹ️  ${label}`);

function readEnv() {
  const text = readFileSync(ENV_FILE, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const mask = (k) => (!k ? '(空)' : k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`);

/** 与 configuration.ts 的 buildVlm 保持同一套语义：'' → undefined（不发送） */
const envToThinking = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);

/** 生成一张含文字的测试图（sharp + SVG，复用项目已有依赖） */
async function makeTestImage() {
  const sharp = apiRequire('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="26" y="64" font-size="36" font-family="DejaVu Sans, Arial, sans-serif" fill="#111111">QINGZHI CAMPUS</text>
    <text x="26" y="112" font-size="28" font-family="DejaVu Sans, Arial, sans-serif" fill="#555555">OCR TEST 2026</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 生成 1 秒静音 WAV（只验证端点连通，不验证识别质量） */
function makeTestWav(seconds = 1, rate = 16000) {
  const dataLen = rate * seconds * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function loadProviders(env) {
  const base = {
    baseUrl: env.SILICONFLOW_BASE_URL,
    apiKey: env.SILICONFLOW_API_KEY,
  };
  try {
    const { VlmOcrProvider } = require(
      resolve(ROOT, 'apps/api/dist/infra/providers/ocr/vlm-ocr.provider.js'),
    );
    const { SiliconflowAsrProvider } = require(
      resolve(ROOT, 'apps/api/dist/infra/providers/audio/asr.provider.js'),
    );
    return {
      Ocr: VlmOcrProvider,
      Asr: SiliconflowAsrProvider,
      base,
    };
  } catch (e) {
    console.log(`\n❌ 加载 Provider 失败：${String(e?.message ?? e)}`);
    console.log('   请先构建：npm run build -w @qz/api');
    return null;
  }
}

/**
 * 逐个模型跑 OCR，报告耗时与识别内容。
 *
 * `cases` 的每项是 `{ model, enableThinking }`：`enableThinking` 为 `undefined`
 * 表示**不发送**该参数。这个区分很关键 —— 实测 DeepSeek-OCR 收到
 * `enable_thinking` 会直接 400，而 Qwen3.5 不发则会先"思考"、慢 10 倍。
 */
async function verifyOcr(Ocr, base, image, cases) {
  for (const { model, enableThinking } of cases) {
    const started = Date.now();
    const flag = enableThinking === undefined ? '不发送' : `enable_thinking=${enableThinking}`;
    try {
      const p = new Ocr({
        ...base,
        model,
        timeoutMs: 90000,
        // 与生产默认一致（VLM_MAX_RETRY=2）：免费档偶发 200+乱码，靠重试吃掉
        maxRetry: 2,
        enableThinking,
        enabled: true,
      });
      const r = await p.recognize(image);
      const ms = Date.now() - started;
      const flat = r.fullText.replace(/\s+/g, ' ');
      const hit = /QINGZHI|CAMPUS|OCR|2026/i.test(flat);
      console.log(
        `   ${model.padEnd(32)} ${String(ms).padStart(5)}ms  ${r.blocks.length} 段  [${flag}]`,
      );
      console.log(`      → ${flat.slice(0, 90)}`);
      check(hit, `${model} 识别出测试图文字`);
    } catch (e) {
      console.log(`   ${model.padEnd(32)} ❌ ${String(e?.message ?? e).slice(0, 100)}`);
      check(false, `${model} 调用成功（模型名是否带组织前缀？）`);
    }
  }
}

/**
 * 反面验证：确认 `enable_thinking` **不能**无脑发给 OCR 专用模型。
 *
 * 这条探测存在的意义是给"默认留空"这个决定留证据 —— 否则后人看到
 * `VLM_ENABLE_THINKING=` 是空值，很容易顺手改成 `false` 图省事，
 * 结果把 OCR 打挂。厂商若将来支持该参数，这里只会打印提示，不影响退出码。
 */
async function probeThinkingUnsupported(Ocr, base, image, model) {
  try {
    const p = new Ocr({
      ...base,
      model,
      timeoutMs: 90000,
      maxRetry: 1,
      enableThinking: false,
      enabled: true,
    });
    await p.recognize(image);
    note(`${model} 现在接受 enable_thinking 了 —— 可重新评估默认值`);
  } catch (e) {
    // 厂商原文在 detail.body 里（BizException 的 message 是给用户看的文案）
    const raw = `${e?.detail?.body ?? ''} ${e?.message ?? e}`;
    if (/does not support parameter enable_thinking|20015/.test(raw)) {
      note(`${model} 如预期拒绝 enable_thinking（故默认必须留空）`);
    } else if (/模型|model/i.test(String(e?.detail?.body ?? ''))) {
      note(`${model} 探测返回：${String(e.detail.body).slice(0, 100)}`);
    } else {
      note(`${model} 探测返回其它错误：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
}

/** ASR：区分"端点不通"与"音频无内容" */
async function verifyAsr(Asr, base, wav, model) {
  const started = Date.now();
  try {
    const p = new Asr({ ...base, model, timeoutMs: 120000, enabled: true });
    const r = await p.speechToText(wav);
    console.log(`   ${model.padEnd(32)} ${String(Date.now() - started).padStart(5)}ms`);
    console.log(`      → ${r.text.slice(0, 90) || '(静音音频，返回空文本属正常)'}`);
    check(true, `${model} 端点连通且返回结构正确`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 静音音频被正确判定为"无内容" = 端点通了，这是预期行为而非失败
    if (/未识别到语音内容/.test(msg)) {
      console.log(`   ${model.padEnd(32)} ${String(Date.now() - started).padStart(5)}ms`);
      console.log('      → 静音音频无内容（端点连通，属预期）');
      check(true, `${model} 端点连通（/audio/transcriptions）`);
    } else {
      console.log(`   ${model.padEnd(32)} ❌ ${msg.slice(0, 100)}`);
      check(false, `${model} 调用成功`);
    }
  }

  /**
   * 语言参数回归检查。
   * 小程序界面提供「自动识别」= `auto`，而该端点只认 ISO 639-1 白名单码，
   * 原样透传会 400。这里验证 Provider 把它归一化成了"不发送参数"，
   * 结果应仍是"无内容"（说明请求被服务端正常受理）而不是 400。
   */
  for (const lang of ['auto', 'zh', 'zh-CN']) {
    try {
      const p = new Asr({ ...base, model, timeoutMs: 120000, enabled: true });
      await p.speechToText(wav, { language: lang });
      check(true, `language=${lang} 未报错`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      const detail = String(e?.detail?.body ?? '');
      check(
        /未识别到语音内容/.test(msg),
        `language=${lang} 被服务端受理（归一化生效，未 400）`,
      );
      if (!/未识别到语音内容/.test(msg)) console.log(`      ↳ ${msg.slice(0, 80)} ${detail.slice(0, 100)}`);
    }
  }
}

/**
 * ③ 装配层验证：`.env` → validateEnv → buildConfig → RealProviderFactory
 *
 * 为什么必须有这一段：Provider 本身能跑通，不等于**接进项目后**能跑通。
 * 最常见的隐性故障是"配了 Key 但没生效，系统静默回退 Mock"——
 * 界面照常出结果，用户看到的其实是假数据。这一段就是证明"真的换成真实现了"。
 */
/**
 * 向量化（`/embeddings`）：验证维度与批量顺序。
 *
 * 为什么值得单独验：`EMBEDDING_DIMENSION` 填错**不会报错** ——
 * 只会在下游算余弦相似度时静默给出错误结果。这里拿真实返回的维度与配置比对。
 */
async function verifyEmbedding(env) {
  const { SiliconflowEmbeddingProvider } = require(
    resolve(ROOT, 'apps/api/dist/infra/providers/embedding/siliconflow-embedding.provider.js'),
  );
  const model = env.EMBEDDING_MODEL;
  const dimension = Number(env.EMBEDDING_DIMENSION ?? 1024);

  const t0 = Date.now();
  try {
    const p = new SiliconflowEmbeddingProvider({
      baseUrl: env.SILICONFLOW_BASE_URL,
      apiKey: env.SILICONFLOW_API_KEY,
      model,
      dimension,
      timeoutMs: 60000,
      maxRetry: 1,
      enabled: true,
    });
    const out = await p.embed(['青智校园', '校园二手交易平台']);
    console.log(
      `   ${model.padEnd(24)} ${String(Date.now() - t0).padStart(5)}ms  ${out.length} 条 × ${out[0]?.length} 维`,
    );
    check(out.length === 2, '批量返回条数与请求一致');
    check(out[0]?.length === dimension, `维度与配置一致（${dimension}）`);
    // 不同文本应给出不同向量（否则等于没有语义能力）
    check(
      !out[0].every((v, i) => v === out[1][i]),
      '不同文本得到不同向量（不是常数向量）',
    );
  } catch (e) {
    console.log(`   ${model.padEnd(24)} ❌ ${String(e?.message ?? e).slice(0, 100)}`);
    check(false, '向量化调用成功');
  }
}

async function verifyWiring(env) {
  let validateEnv;
  let buildConfig;
  let RealProviderFactory;
  try {
    ({ validateEnv } = require(resolve(ROOT, 'apps/api/dist/common/config/env.schema.js')));
    ({ buildConfig } = require(resolve(ROOT, 'apps/api/dist/common/config/configuration.js')));
    ({ RealProviderFactory } = require(
      resolve(ROOT, 'apps/api/dist/infra/providers/real-provider.factory.js'),
    ));
  } catch (e) {
    console.log(`   ❌ 加载配置/工厂失败：${String(e?.message ?? e)}`);
    console.log('      请先构建：npm run build -w @qz/api');
    check(false, '装配层模块可加载');
    return;
  }

  // 用真实 .env 走一遍 zod 校验，任何类型/默认值错误都会在这里暴露
  let cfg;
  try {
    cfg = buildConfig(validateEnv(env));
  } catch (e) {
    console.log(`   ❌ 配置校验失败：${String(e?.message ?? e).slice(0, 200)}`);
    check(false, 'validateEnv + buildConfig 通过');
    return;
  }
  check(true, 'validateEnv + buildConfig 通过');
  console.log(`      vlm.enabled=${cfg.vlm.enabled}  model=${cfg.vlm.model}`);
  console.log(
    `      vlm.enableThinking=${String(cfg.vlm.enableThinking)}  (undefined = 不发送)`,
  );
  console.log(`      asr.enabled=${cfg.asr.enabled}  model=${cfg.asr.model}`);

  // 工厂只用到 redis（队列）与 logger；这里只关心 ocr/audio，给最小桩即可
  const factory = new RealProviderFactory({} , { log() {}, warn() {}, error() {}, debug() {} });
  const overrides = factory.build(cfg);

  check(overrides.ocr?.constructor?.name === 'VlmOcrProvider', '工厂产出了真实 OCR Provider');
  check(
    overrides.audio?.constructor?.name === 'SiliconflowAsrProvider',
    '工厂产出了真实 ASR Provider',
  );
  check(
    overrides.embedding?.constructor?.name === 'SiliconflowEmbeddingProvider',
    '工厂产出了真实 Embedding Provider（/health 里不再有 mock-embedding）',
  );
  check(overrides.ocr?.name !== 'mock-ocr', 'OCR 未回退 Mock');
  check(
    cfg.vlm.enableThinking === envToThinking(env.VLM_ENABLE_THINKING),
    'enable_thinking 语义与配置一致（空=不发送）',
  );
}

/**
 * ④ 端到端：ToolExecutorService → MediaAiToolRunner → 真实 Provider → 产物文件
 *
 * 为什么必须有这一段：前面三段证明的是"Provider 能调通"，
 * 但用户点击时走的是 **执行器 → Runner** 这条路 —— 参数怎么取、文件怎么读、
 * 产物怎么落，任一环节写错都会表现为"接了但点不通"。
 * 这里用真实的执行器与真实的 Provider，只把 FileService 换成写本地目录的桩。
 */
async function verifyEndToEnd(env, image) {
  const { createProviders } = apiRequire('@qz/core');
  const { validateEnv } = require(resolve(ROOT, 'apps/api/dist/common/config/env.schema.js'));
  const { buildConfig } = require(resolve(ROOT, 'apps/api/dist/common/config/configuration.js'));
  const { RealProviderFactory } = require(
    resolve(ROOT, 'apps/api/dist/infra/providers/real-provider.factory.js'),
  );
  const { ToolExecutorService } = require(
    resolve(ROOT, 'apps/api/dist/modules/job/tool-executor.service.js'),
  );
  const { ImageToolRunner } = require(resolve(ROOT, 'apps/api/dist/modules/job/image-tool-runner.js'));
  const { LlmToolRunner } = require(resolve(ROOT, 'apps/api/dist/modules/job/llm-tool-runner.js'));
  const { MediaAiToolRunner } = require(
    resolve(ROOT, 'apps/api/dist/modules/job/media-ai-tool-runner.js'),
  );

  const cfg = buildConfig(validateEnv(env));
  const logger = { log() {}, warn() {}, error() {}, debug() {} };
  const factory = new RealProviderFactory({}, logger);
  const providers = createProviders(cfg.providerMode, factory.build(cfg));

  // FileService 桩：入参固定返回测试图，产物写进临时目录以便人工查看
  const outDir = join(tmpdir(), 'qz-verify-out');
  mkdirSync(outDir, { recursive: true });
  const saved = [];
  const files = {
    readObject: async () => ({ buffer: image, name: 'e2e-test.png' }),
    saveGenerated: async (_userId, input) => {
      const p = join(outDir, input.name);
      writeFileSync(p, input.buffer);
      saved.push({ ...input, path: p });
      return { id: `file-${saved.length}` };
    },
  };

  const images = new ImageToolRunner(providers, files);
  const llmTools = new LlmToolRunner(providers, files, logger);
  const mediaAi = new MediaAiToolRunner(providers, files, logger);
  const executor = new ToolExecutorService(providers, files, images, llmTools, mediaAi);

  check(executor.supports('ocr_image'), "执行器注册了 'ocr_image'");
  check(executor.supports('speech_to_text'), "执行器注册了 'speech_to_text'");

  const stages = [];
  const ctx = {
    jobId: 'verify-job',
    userId: 'verify-user',
    params: {},
    inputFiles: ['file-1'],
    onProgress: async (p, s) => stages.push(`${p}% ${s ?? ''}`.trim()),
  };

  // ---- ocr_image 全链路 ----
  try {
    const r = await executor.run('ocr_image', ctx);
    const art = saved.at(-1);
    const text = art ? readFileSync(art.path, 'utf8') : '';
    console.log(`   产物: ${art?.path ?? '(无)'}`);
    console.log(`   进度: ${stages.join(' → ')}`);
    console.log(`   正文: ${text.split('\n').filter(Boolean).slice(-2)[0]?.slice(0, 60)}`);
    check(r.outputFiles.length === 1, 'ocr_image 返回了 1 个产物文件 id');
    check(/^# .*文字识别结果/m.test(text), 'ocr_image 产物是带标题的 Markdown');
    check(/QINGZHI|CAMPUS|OCR|2026/i.test(text), 'ocr_image 产物含识别到的文字');
    check(stages.length >= 2, 'ocr_image 上报了进度（前端能显示阶段）');
  } catch (e) {
    console.log(`   ❌ ${String(e?.message ?? e).slice(0, 120)}`);
    check(false, 'ocr_image 端到端执行成功');
  }

  // ---- 前置校验：非图片必须在打第三方之前被拒 ----
  const badFiles = { ...files, readObject: async () => ({ buffer: image, name: 'a.pdf' }) };
  const badExecutor = new ToolExecutorService(
    providers,
    badFiles,
    new ImageToolRunner(providers, badFiles),
    new LlmToolRunner(providers, badFiles, logger),
    new MediaAiToolRunner(providers, badFiles, logger),
  );
  try {
    await badExecutor.run('ocr_image', ctx);
    check(false, 'ocr_image 拒绝了非图片文件');
  } catch (e) {
    check(/不是图片/.test(String(e?.message ?? '')), 'ocr_image 在本地就拒了非图片（未打穿到第三方）');
  }

  // ---- speech_to_text 全链路（静音音频：应走到"无内容"判定，证明端点已连通） ----
  const wavFiles = { ...files, readObject: async () => ({ buffer: makeTestWav(), name: 'e2e.wav' }) };
  const wavExecutor = new ToolExecutorService(
    providers,
    wavFiles,
    new ImageToolRunner(providers, wavFiles),
    new LlmToolRunner(providers, wavFiles, logger),
    new MediaAiToolRunner(providers, wavFiles, logger),
  );
  try {
    const r = await wavExecutor.run('speech_to_text', ctx);
    check(r.outputFiles.length === 1, 'speech_to_text 端到端产出文件');
  } catch (e) {
    const msg = String(e?.message ?? '');
    // 静音音频被判为"无内容"= 已经过 HTTP → 解析 → 判定，说明整条路径是通的
    check(
      /未识别到语音内容/.test(msg),
      `speech_to_text 端到端走到"无内容"判定（端点连通，非格式/网络错误）`,
    );
    if (!/未识别到语音内容/.test(msg)) console.log(`      ↳ 实际报错：${msg.slice(0, 120)}`);
  }
}

async function main() {
  console.log('\n硅基流动 AI 能力自检（调用项目真实的 Provider）\n');

  const env = readEnv();
  console.log(`   baseUrl: ${env.SILICONFLOW_BASE_URL}`);
  console.log(`   apiKey : ${mask(env.SILICONFLOW_API_KEY)}`);
  console.log(`   VLM    : ${env.VLM_MODEL}`);
  console.log(
    `   thinking: ${env.VLM_ENABLE_THINKING ? env.VLM_ENABLE_THINKING : '(留空 = 不发送)'}`,
  );
  console.log(`   ASR    : ${env.ASR_MODEL}`);

  if (!env.SILICONFLOW_API_KEY) {
    console.log('\n' + '='.repeat(74));
    console.log('未配置 SILICONFLOW_API_KEY —— OCR 与语音仍走 Mock（响应头 X-Provider: mock）');
    console.log('='.repeat(74));
    console.log('   1) 打开 https://cloud.siliconflow.cn/me/account/ak 新建 Key');
    console.log('   2) 在仓库根 .env 填：');
    console.log('        SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1');
    console.log('        SILICONFLOW_API_KEY=sk-xxxx');
    console.log('        VLM_MODEL=deepseek-ai/DeepSeek-OCR');
    console.log('        ASR_MODEL=Qwen/Qwen3-ASR-1.7B');
    console.log('   3) npm run setup:env && npm run build -w @qz/api');
    console.log('   4) node scripts/dev/verify-siliconflow.mjs');
    console.log('='.repeat(74));
    process.exit(0);
  }

  const providers = loadProviders(env);
  if (!providers) process.exit(1);
  const { Ocr, Asr, base } = providers;

  const imgPath = process.argv[2];
  const image = imgPath ? readFileSync(imgPath) : await makeTestImage();
  console.log(
    `\n   测试图: ${imgPath ?? '自动生成 (sharp+SVG)'}  ${(image.length / 1024).toFixed(0)} KB`,
  );

  console.log('\n' + '='.repeat(74));
  console.log('① OCR / 图片理解（走 /chat/completions）');
  console.log('='.repeat(74));

  /**
   * 每个模型按"它自己的脾气"配 enable_thinking：
   *   - OCR 专用模型（DeepSeek-OCR / PaddleOCR-VL）→ 不发送，发了会 400
   *   - 混合思考模型（Qwen3.5）→ 显式 false，否则会先思考、慢约 10 倍
   * 这与 Provider 里的判断逻辑一致：留空即不发送。
   */
  const ocrCases = [
    { model: env.VLM_MODEL, enableThinking: envToThinking(env.VLM_ENABLE_THINKING) },
    { model: 'deepseek-ai/DeepSeek-OCR', enableThinking: undefined },
    { model: 'PaddlePaddle/PaddleOCR-VL-1.5', enableThinking: undefined },
    { model: 'Qwen/Qwen3.5-4B', enableThinking: false },
  ].filter((c, i, a) => c.model && a.findIndex((x) => x.model === c.model) === i);

  await verifyOcr(Ocr, base, image, ocrCases);

  console.log('\n   —— 反面验证：enable_thinking 对 OCR 专用模型不安全 ——');
  await probeThinkingUnsupported(Ocr, base, image, 'deepseek-ai/DeepSeek-OCR');

  console.log('\n' + '='.repeat(74));
  console.log('② 语音转文字（走 /audio/transcriptions，与文本模型不同端点）');
  console.log('='.repeat(74));
  await verifyAsr(Asr, base, makeTestWav(), env.ASR_MODEL);

  console.log('\n' + '='.repeat(74));
  console.log('③ 向量化（走 /embeddings，与文本模型同端点但不同路径）');
  console.log('='.repeat(74));
  await verifyEmbedding(env);

  console.log('\n' + '='.repeat(74));
  console.log('④ 装配层（.env → validateEnv → buildConfig → RealProviderFactory）');
  console.log('='.repeat(74));
  await verifyWiring(env);

  console.log('\n' + '='.repeat(74));
  console.log('⑤ 端到端（执行器 → MediaAiToolRunner → 真实 Provider → 产物文件）');
  console.log('='.repeat(74));
  await verifyEndToEnd(env, image);

  console.log();
  console.log('='.repeat(74));
  console.log(failures === 0 ? '🎉 通过：OCR 与语音转文字均已可用' : `❌ 有 ${failures} 项未通过`);
  console.log('   提示：接上后 /health 的 mockProviders 里不再出现 mock-ocr / mock-audio');
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
