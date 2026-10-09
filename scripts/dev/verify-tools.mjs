/**
 * 端到端验证：把 seed 里所有 `status: 'active'` 的**工具箱**工具**真的跑一遍**
 *
 * ## 为什么需要它
 *
 * "执行器注册了" 只说明路由通了，不等于"点了能出结果"。本脚本用**真实的
 * ToolExecutorService + 真实 Provider**（LLM 打智谱、OCR/ASR 打硅基流动）
 * 逐个执行，只把 FileService 换成写本地临时目录的桩。
 *
 * 与 `check-tool-status.mjs` 的分工：
 *   · check-tool-status  静态比对（秒级、无需网络）→ 防"状态漂移"
 *   · verify-tools       真跑一遍（要 Key、要网络）→ 防"配好了但打不通"
 *
 * ## 覆盖范围：只覆盖"走作业链路"的工具
 *
 * 内部能力（`source: 'internal'`，如 `search_knowledge`）**不在本脚本范围** ——
 * 它们不进执行器，由助手进程内直调，覆盖它们的是 `verify:os`（走真实 HTTP 对话）。
 * 所以本脚本的结论是"**N 个 active 工具箱工具**全部真能跑"，不是"所有 active 工具"。
 *
 * ## 已注册但没有用例 = 失败（不是提示）
 *
 * 这是"五步接入清单"第 5 步（补 verify:tools 用例）**唯一的强制点**：
 * 前四步（seed / 执行器 / inputSchema / 能力目录）都各有静态守卫，
 * 只有"到底跑过没有"没有机器在管。放行它，就等于允许一个
 * "执行器认它、验证脚本从没验过它"的工具上线 —— 而那类工具恰恰最可能在
 * 用户手里炸（真实链路一次都没被跑过）。
 *
 * ## 用法
 *
 *   npm run build -w @qz/api && npm run verify:tools
 *
 * 前置：`.env` 里配好 LLM_* 与 SILICONFLOW_*。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const apiRequire = createRequire(resolve(ROOT, 'apps/api/package.json'));

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}`);
};

// ---------- 载入真实装配 ----------
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
const { MediaToolRunner } = require(resolve(ROOT, 'apps/api/dist/modules/job/media-tool-runner.js'));
const { PdfToolRunner } = require(resolve(ROOT, 'apps/api/dist/modules/job/pdf-tool-runner.js'));
const { DataToolRunner } = require(resolve(ROOT, 'apps/api/dist/modules/job/data-tool-runner.js'));
const { RepoToolRunner } = require(resolve(ROOT, 'apps/api/dist/modules/job/repo-tool-runner.js'));

/** 读 apps/api/.env（由根 .env 同步而来，setup:env 生成） */
function readEnv() {
  const out = {};
  for (const line of readFileSync(resolve(ROOT, 'apps/api/.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ---------- 测试素材 ----------
async function makeImage() {
  const sharp = apiRequire('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="26" y="64" font-size="36" font-family="Arial" fill="#111111">QINGZHI CAMPUS</text>
    <text x="26" y="112" font-size="28" font-family="Arial" fill="#555555">TOOL VERIFY 2026</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 1 秒静音 WAV（ASR 用；静音被正确判为"无内容"即算路径通） */
function makeWav(seconds = 1, rate = 16000) {
  const n = rate * seconds * 2;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}

/**
 * 3 秒立体声 WAV（人声分离用）。
 *
 * 刻意做成**左右声道不同频率**：Demucs 是按内容分离的模型，
 * 用静音虽然也能把链路跑通，但"两条轨道都是静音"证明不了它真的在工作。
 * 有实际波形，才能验证"产物确实是音频、且每条轨道都非空"。
 *
 * 时长取 3 秒是权衡：CPU 上 Demucs 大约要跑"音频时长的 1~3 倍"，
 * 再长会让验证脚本从"跑一遍"变成"等很久"。
 */
function makeStereoWav(seconds = 3, rate = 44100) {
  const frames = rate * seconds;
  const dataBytes = frames * 4; // 2 声道 × 16bit
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i += 1) {
    const l = Math.sin((2 * Math.PI * 220 * i) / rate);
    const r = Math.sin((2 * Math.PI * 660 * i) / rate);
    b.writeInt16LE(Math.round(l * 12000), 44 + i * 4);
    b.writeInt16LE(Math.round(r * 12000), 46 + i * 4);
  }
  return b;
}

const TEXT = `青智校园是一个面向高校学生的 AI 工具与互助服务平台。
它把常用的文档处理、图片处理、音视频转换做成开箱即用的工具箱，
同时提供青智驿站让学生之间可以互相接单、互相帮忙。
平台的定位是：能交给 AI 做的自动做，需要真人做的帮你发到驿站。
这段文字用于验证长文总结工具是否真的能调用大模型并产出摘要文件。

在真实场景里，用户上传的多是自己写的课程作业、社团活动材料或者整理好的笔记，
长度通常在几百字到几千字之间。因此验证素材刻意写成一段有完整信息量的短文，
而不是几个孤立的关键词 —— 后者会让"总结"退化成"复述"，验证不出真实能力。`;

/**
 * 测试视频（音视频类工具用）。
 *
 * 用 ffmpeg 现生成而不是往仓库塞一个二进制样例：
 *   ① 仓库不该出现"只在验证脚本里用"的素材文件；
 *   ② 分辨率/时长需要能调（压缩用例依赖"源文件足够大"才不会触发收益判断）。
 *
 * 找不到 ffmpeg 时**返回 null 并让音视频用例明确跳过**，而不是让整个脚本失败 ——
 * ffmpeg 是系统级依赖，"没装"与"功能坏了"是两件事，混在一起会误导排障。
 */
function makeVideo(ffmpegBin) {
  const bin = ffmpegBin || 'ffmpeg';
  const out = join(outDir, 'verify_input.mp4');
  try {
    execFileSync(
      bin,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '3', '-c:v', 'mpeg4', '-qscale:v', '2', '-c:a', 'aac', '-shortest',
        out,
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(out);
  } catch {
    return null;
  }
}

/**
 * 测试 PDF。
 *
 * 与 `makeVideo` 同一套取舍：**现生成而不是往仓库塞二进制素材**。
 * 生成方式是调外部 PyMuPDF（`PYMUPDF_BIN`）—— 这不是把 AGPL 引进仓库：
 * 验证脚本运行在开发机上、调用的是仓库之外独立安装的解释器，
 * 与 `services/pdf` 的运行时做法完全一致。
 *
 * 刻意让第 1 页可被文本抽取（后续 `parse_document` 用例依赖它），并做 6 页
 *（拆分用例需要"至少能拆出 2 份"）。
 */
function makePdf(pymupdfBin) {
  const bin = pymupdfBin;
  if (!bin) return null;
  const out = join(outDir, 'verify_input.pdf');
  // 六页、每页都有可抽取的英文文本（parse_document 依赖它），
  // 页数 > 2 是为了让"按范围拆分"能产出多份。
  // ⚠️ 反斜杠与换行都用字符码拼：源码里写字面量会被中间层吃掉一层（踩过两次）。
  const py = [
    'import pymupdf',
    'doc = pymupdf.open()',
    'for i in range(6):',
    '    p = doc.new_page()',
    '    p.insert_text((72, 120), f"QINGZHI PAGE {i+1}", fontsize=24)',
    '    p.insert_text((72, 170), "verify tool pdf text extraction", fontsize=12)',
    'doc.save(r' + QUOTE + out.split(BACKSLASH).join(SLASH) + QUOTE + ')',
  ].join(NL);
  try {
    execFileSync(bin, ['-c', py], { stdio: 'ignore' });
    const buf = readFileSync(out);
    return buf.length > 500 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 全部 active 工具的验证用例。`fixture` 决定入参文件类型。`fixture` 决定入参文件类型。
 * 入参名取自 `apps/api/prisma/tool-input-schemas.ts`（以后端声明为准）。
 */
/** 换行符。用它拼多行文本，避免在源码里写字面量换行或转义序列 */
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const SLASH = String.fromCharCode(47);
const QUOTE = String.fromCharCode(34);

const CASES = [
  { name: 'generate_outline', params: { topic: '校园二手交易平台', depth: 2 } },
  {
    name: 'generate_ppt',
    params: { topic: '校园二手交易平台', purpose: '路演', pages: 6, style: '简约' },
  },
  { name: 'summarize_text', params: { length: 'short' }, fixture: 'text' },
  { name: 'generate_image_prompt', params: { subject: '黄昏下的校园图书馆', style: '水彩' } },
  { name: 'compress_image', params: { quality: 70, format: 'jpeg' }, fixture: 'image' },
  { name: 'convert_image', params: { format: 'webp' }, fixture: 'image' },
  { name: 'enhance_image', params: { strength: 50 }, fixture: 'image' },
  // 2026-09-19 补：`services/ai` 的 /ai/matting 已真实实现（rembg + u2net 白名单），
  // 后端 SidecarImageProvider 也接上了。此前它被归为"Provider 未实现"因此在
  // 验证清单外 —— 那种"能力做完了但验证脚本还当它不存在"的状态最危险：
  // check:tools 会因为豁免清单而放行，而真实链路从没被跑过。
  { name: 'remove_background', params: {}, fixture: 'image' },
  { name: 'ocr_image', params: { lang: 'zh' }, fixture: 'image' },

  // ---- 二维码（node-qrcode 纯计算，2026-09-20 接入）----
  // 注意没有 `fixture`：它是工具箱里**唯一不需要上传文件**的工具，
  // 输入就是一段文本。留着这条注释，免得后来人以为漏写了素材。
  {
    name: 'generate_qrcode',
    params: { text: 'https://example.com/qz-campus', size: 512, level: 'M' },
  },
  { name: 'speech_to_text', params: { language: 'zh' }, fixture: 'wav' },
  // ---- 文字转语音（edge-tts，2026-09-20 接入）----
  // 同样**没有 fixture**：文本来自参数，不是上传素材（与 speech_to_text 方向相反）
  {
    name: 'text_to_speech',
    params: { text: '青智校园，文字转语音端到端验证。', voice: 'zh-CN-XiaoxiaoNeural' },
  },

  // ---- 音视频类（services/media 侧车，2026-09-19 转 active）----
  { name: 'compress_video', params: { quality: 'low' }, fixture: 'video' },
  { name: 'convert_video', params: { format: 'gif' }, fixture: 'video' },
  { name: 'cut_video', params: { startSec: 0.5, endSec: 2 }, fixture: 'video' },
  {
    name: 'add_subtitle',
    // 用数组 join 构造多行文本：源码里写字面量换行会被 prettier 重排、
    // 写转义序列又容易被中间层吃掉一层，join 是唯一稳的写法。
    params: { srt: ['1', '00:00:00,000 --> 00:00:01,500', '青智校园 测试字幕', ''].join(NL) },
    fixture: 'video',
  },
  { name: 'convert_audio', params: { format: 'mp3' }, fixture: 'video' },

  // ---- 音频裁剪 / 降噪（services/media 新增端点，2026-09-19 转 active）----
  { name: 'cut_audio', params: { startSec: 0.2, endSec: 0.8 }, fixture: 'wav' },
  { name: 'denoise_audio', params: { strength: 'medium' }, fixture: 'wav' },

  // ---- PDF 类（services/pdf 侧车，2026-09-19 转 active）----
  // merge 需要至少 2 个文件：here 复用同一份 PDF（合并自身与自身，
  // 产物页数应为 2 倍 —— 足以验证"真的合并了"而不是返回原文件）
  // ---- 图片转 PDF（sharp + pdf-lib，2026-09-20 接入）----
  // ⚠️ 它与下面三个 PDF 工具**不走同一条链路**：那三个走 services/pdf 侧车（PyMuPDF 子进程），
  // 这个走 Node 侧 —— 因为 PyMuPDF CLI 没有"图片转 PDF"子命令。链路不同，用例不能合并。
  { name: 'images_to_pdf', params: { pageSize: 'a4' }, fixture: 'image' },
  {
    name: 'merge_pdf',
    params: {},
    fixture: 'pdf',
    inputFiles: ['file-1', 'file-2'],
  },
  { name: 'split_pdf', params: { mode: 'ranges', ranges: '1-2,4-N' }, fixture: 'pdf' },
  { name: 'compress_pdf', params: {}, fixture: 'pdf' },
  { name: 'parse_document', params: {}, fixture: 'pdf' },

  // ---- 纯 LLM 类（2026-09-19 转 active）----
  { name: 'generate_resume', params: { position: '前端开发实习生' } },
  { name: 'generate_mindmap', params: { topic: '数据结构期末复习', depth: 3 } },
  {
    name: 'translate_text',
    params: { target: 'en', text: '青智校园是面向高校学生的一站式服务平台。' },
  },
  { name: 'paper_summary', params: {}, fixture: 'text' },
  {
    name: 'solve_question',
    params: { text: '已知一个直角三角形的两条直角边分别为 3 和 4，求斜边长。', subject: '数学' },
  },

  // ---- 2026-09-19 新接入的三个工具 ----
  // 它们的共同点是"此前的状态与实现不一致"：generate_document / analyze_data 是纯代码活，
  // separate_vocals 卡在模型部署上。三条链路都在这里被真跑一遍，而不是只改 seed 的状态位。
  {
    name: 'generate_document',
    params: { docType: 'event_plan', topic: '校园音乐节', extra: '控制在 800 字以内' },
  },
  {
    name: 'analyze_data',
    // 直接用粘贴文本：这既是接口的一条路径，也是"从 Excel 复制粘贴"的真实形态。
    // 数据刻意做出**可验证的规律**（大三满意度明显偏低），这样"AI 有没有读到数据"是能看出来的。
    params: {
      text: [
        '姓名,年级,满意度,备注',
        '张三,大一,5,很喜欢',
        '李四,大一,4,',
        '王五,大二,3,一般',
        '赵六,大二,5,',
        '钱七,大三,2,排队太久',
      ].join(NL),
      focus: '哪个年级的满意度最低？',
    },
  },
  {
    name: 'separate_vocals',
    params: { stems: '2' },
    fixture: 'stereo',
    // 人声分离的产物天然是两条轨道（人声 + 伴奏），不是一条
    expectFiles: 2,
  },

  // ---- 仓库解读（deepwiki-open，2026-10-08 接入，seed 保持 planned）----
  // 同样没有传统意义的"素材"：输入就是参数里的仓库 URL。
  // fixture 名 `deepwiki` 是**探活开关**——只有 .env 配了 DEEPWIKI_BASE_URL
  // 才会往 fixtures 里放这份素材，未部署时用例按"缺素材"跳过而不是失败
  //（服务不在是环境缺口，不是功能坏了；转 active 前先配好并跑通它）。
  {
    name: 'explain_repository',
    // 用 deepwiki-open 自己的仓库做样本：被测服务对该仓库必然有现成 Wiki
    params: { repo_url: 'https://github.com/AsyncFuncAI/deepwiki-open', language: 'zh' },
    fixture: 'deepwiki',
  },
];

// ---------- FileService 桩（模块级，供 readObject 读取当前素材） ----------
const outDir = join(tmpdir(), 'qz-verify-tools');
let currentFixture = 'image';
let fixtures = {};
let names = {};
let saved = [];

const files = {
  readObject: async () => ({ buffer: fixtures[currentFixture], name: names[currentFixture] }),
  saveGenerated: async (_userId, input) => {
    const p = join(outDir, input.name);
    writeFileSync(p, input.buffer);
    saved.push({ name: input.name, path: p, size: input.buffer.length });
    return { id: `file-${saved.length}` };
  },
};

/** 静音音频被判为"无内容"= 端点连通且解析正确，属预期而非失败 */
const isExpectedNoSpeech = (c, msg) =>
  c.fixture === 'wav' && /未识别到语音内容/.test(msg);

/** 跑单个用例，返回展示用的一行结果 */
/**
 * 依次执行全部用例，返回被跳过的条数。
 *
 * 抽成独立函数有两个原因：① 主流程的圈复杂度会超红线；
 * ② "跳过"这件事需要与"失败"在代码层面分开表达 ——
 * 缺 ffmpeg 素材是**环境缺口**，不是功能坏了。
 */
/**
 * 打印本次验证实际生效的模型与模式。
 *
 * 单独抽出来是因为它是**排障的第一现场**：产物不对时先看这里 ——
 * 是模型没配上走了 Mock，还是模型配了但输出异常，两条路的排查方向完全不同。
 */
function printEffectiveConfig(cfg) {
  // 注意 `cfg.llm.models` 是分级对象（intent/generate/plan），不是单个 model 字段
  const or = (enabled, value) => (enabled ? value : '（未配置 → Mock）');
  console.log(`   LLM         : ${or(cfg.llm.enabled, cfg.llm.models.generate)}`);
  console.log(`   OCR         : ${or(cfg.vlm.enabled, cfg.vlm.model)}`);
  console.log(`   ASR         : ${or(cfg.asr.enabled, cfg.asr.model)}`);
  console.log(`   providerMode: ${cfg.providerMode}`);
}

async function runAllCases(executor) {
  let skipped = 0;
  for (const c of CASES) {
    if (c.fixture && !fixtures[c.fixture]) {
      skipped += 1;
      console.log(`  ${c.name.padEnd(24)} ${'—'.padStart(7)}   ⏭ 跳过（缺少 ${c.fixture} 素材）`);
      continue;
    }
    const { ok, ms, detail } = await runOne(executor, c);
    console.log(`  ${c.name.padEnd(24)} ${String(ms).padStart(6)}ms  → ${detail}`);
    check(ok, `${c.name} 端到端执行成功`);
  }
  if (skipped) {
    console.log(`
  （另有 ${skipped} 项因缺少素材被跳过，不计入通过数）`);
  }
  return skipped;
}

async function runOne(executor, c) {
  currentFixture = c.fixture ?? 'image';
  const before = saved.length;
  const t0 = Date.now();
  const ctx = {
    jobId: `verify-${c.name}`,
    userId: 'verify-user',
    params: c.params,
    inputFiles: c.inputFiles ?? ['file-1'],
    onProgress: async () => {},
  };

  try {
    const r = await executor.run(c.name, ctx);
    const ms = Date.now() - t0;
    // 产物**个数**由用例声明：人声分离天然返回多条轨道（人声 + 伴奏），
    // 用"必须恰好 1 个"去卡它，会让一个正常的多产物工具永远验证不过。
    const expected = c.expectFiles ?? 1;
    const produced = saved.slice(before);
    const detail = produced.length
      ? produced.map((f) => `${f.name} (${(f.size / 1024).toFixed(1)}KB)`).join(' + ')
      : '(无产物)';
    return { ok: r.outputFiles.length === expected && produced.length === expected, ms, detail };
  } catch (e) {
    const msg = String(e?.message ?? e);
    return isExpectedNoSpeech(c, msg)
      ? { ok: true, ms: Date.now() - t0, detail: '静音音频无内容（路径通，属预期）' }
      : { ok: false, ms: Date.now() - t0, detail: `❌ ${msg.slice(0, 90)}` };
  }
}

// 仓库解读的"素材"是 deepwiki 服务本身：配置了地址才算素材就绪，
// 否则用例进入"缺素材跳过"通道（与 ffmpeg / PyMuPDF 缺失同一处理逻辑）。
// 抽成函数与探活提示放一起，main 里只拿布尔结果。
function probeDeepwiki() {
  const ready = !!readEnv().DEEPWIKI_BASE_URL;
  if (!ready) {
    console.log('   ⚠️ 未配置 DEEPWIKI_BASE_URL，仓库解读用例将被跳过');
  }
  return ready;
}

// ffmpeg / PyMuPDF 属外部二进制：缺失不算脚本失败，对应类用例按"缺素材"跳过。
// 抽成函数让探活与提示在一起，main 只拿结果（同 probeDeepwiki 的理由）。
function probeBinaries() {
  const video = makeVideo(process.env.FFMPEG_BIN || readEnv().FFMPEG_BIN);
  if (!video) {
    console.log('   ⚠️ 未找到 ffmpeg（FFMPEG_BIN / PATH），音视频类用例将被跳过');
  }
  const pdf = makePdf(readEnv().PYMUPDF_BIN);
  if (!pdf) {
    console.log('   ⚠️ 未找到 PyMuPDF（PYMUPDF_BIN），PDF 类用例将被跳过');
  }
  return { video, pdf };
}

async function main() {
  console.log('\n工具端到端验证（真实 Provider，逐个真跑）\n');

  const cfg = buildConfig(validateEnv(readEnv()));
  const logger = { log() {}, warn() {}, error() {}, debug() {} };
  const providers = createProviders(
    cfg.providerMode,
    new RealProviderFactory({}, logger).build(cfg),
  );

  printEffectiveConfig(cfg);

  mkdirSync(outDir, { recursive: true });
  const { video, pdf } = probeBinaries();
  const deepwikiReady = probeDeepwiki();
  fixtures = {
    image: await makeImage(),
    text: Buffer.from(TEXT, 'utf8'),
    wav: makeWav(),
    // 立体声素材（人声分离用）。它是纯 JS 生成的，不像 video/pdf 那样依赖外部二进制，
    // 所以不放进"缺素材就跳过"的那一档。
    stereo: makeStereoWav(),
    ...(video ? { video } : {}),
    ...(pdf ? { pdf } : {}),
    ...(deepwikiReady ? { deepwiki: Buffer.alloc(1) } : {}),
  };
  names = {
    image: 'verify.png',
    text: 'verify.md',
    wav: 'verify.wav',
    stereo: 'verify_stereo.wav',
    ...(video ? { video: 'verify_input.mp4' } : {}),
  };
  saved = [];
  currentFixture = 'image';

  const executor = new ToolExecutorService(
    providers,
    files,
    new ImageToolRunner(providers, files),
    new LlmToolRunner(providers, files, logger),
    new MediaAiToolRunner(providers, files, logger),
    new MediaToolRunner(providers, files),
    new PdfToolRunner(providers, files),
    // ⚠️ 新执行器一律追加在**末尾**：构造器是位置参数，
    // 插在中间会让它后面所有实参整体错位（"把 A 当成 B"）。
    new DataToolRunner(providers, files, logger),
    new RepoToolRunner(providers, files),
  );

  // 已注册但没写用例的工具：**必须失败**，不是提示。
  //
  // ⚠️ 这是"五步接入清单"第 5 步唯一的强制点：seed / 执行器 / inputSchema /
  // 能力目录四步都各有静态守卫，只有"到底真跑过没有"没有任何机器在管。
  // 放行它 = 允许"执行器认它、验证脚本从没验过它"的工具上线，
  // 而那类工具恰恰最可能在用户手里炸（真实链路一次都没被跑过）。
  // `PROVIDER_NOT_READY` 那条"靠豁免而不是靠验证"的路已经删了，这里同理。
  const missing = executor.supportedTools.filter((t) => !CASES.some((c) => c.name === t));
  if (missing.length) {
    console.log(`\n❌ 已注册但没有验证用例：${missing.join(', ')}`);
    console.log('   五步接入清单第 5 步未完成 —— 要么在本文件 CASES 里补用例，要么从执行器摘掉。');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(74));
  const skipped = await runAllCases(executor);

  console.log('\n' + '='.repeat(74));
  console.log(`   产物目录：${outDir}`);
  console.log(
    failures === 0
      ? `🎉 通过：${CASES.length - skipped} 个 active 工具箱工具全部真能跑（内部能力见 verify:os）`
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
