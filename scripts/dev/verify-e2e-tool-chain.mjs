#!/usr/bin/env node
/**
 * M1-15~M1-17 验收：**真实 HTTP** 的工具端到端闭环。
 *
 * ## 为什么必须另有一个脚本（不能只靠 verify:tools）
 *
 * `verify:tools` 是**直接调服务层**的 —— 它证明"执行器能跑"，
 * 但看不到 HTTP 层的任何东西：状态码、响应体包装、鉴权、
 * 入参校验、作业入队与轮询、产物落库与下载。
 *
 * 2026-09-18 交付可用性排查时实测发现：这两层会**各自出问题而互不暴露**。
 * 例：`/health` 的 `queue.degraded` 只有在真实 HTTP 链路上才看得到；
 * 工具入参字段名写错（`input` vs `params`）在服务层测试里根本不会触发。
 *
 * 所以本脚本按**用户真实操作顺序**打一遍：
 *
 *   ① presign 申请签名 → ② PUT 直传二进制 → ③ confirm 落库 → ④ 伪造签名必须被拒
 *   → ⑤ 列表能查到 → ⑥ 签发下载地址 → ⑦ 下载字节与上传一致
 *   → ⑧ 调工具拿 jobId → ⑨ 轮询到终态 → ⑩ 下载产物并**打印正文**
 *
 * ⚠️ 第 ⑩ 步是刻意的：只看"状态码 200"不够 ——
 *    免费档模型会返回 HTTP 200 + 一长串重复字符（"假成功"）。
 *    正文必须打出来给人看。
 *
 * ## 用法
 *
 *   npm run verify:e2e
 *   node scripts/dev/verify-e2e-tool-chain.mjs [baseUrl]
 *
 * 前置：后端已启动（见 docs/dev/ENV.md）。
 */
import { resolveBaseUrl } from './base-url.mjs';
import { devLoginCode } from './dev-login.mjs';

const BASE = resolveBaseUrl(process.argv[2]);
const TOOL = process.env.E2E_TOOL ?? 'summarize_text';

/** 探针正文（需 >50 字，否则 summarize_text 会以"内容太短"拒绝） */
const CONTENT =
  '青智校园是一个面向高校学生的 AI 服务平台，提供 AI 工具箱、青智 OS 助手与校园驿站三大能力。' +
  '本文用于验证「上传 → 调用工具 → 取得产物」这条端到端链路是否真的通。' +
  '如果这段文字能被正确总结，说明文件链路、作业队列与模型调用三部分都是真实工作的。';

let token = '';
let failures = 0;

const ok = (cond, label) => {
  if (!cond) failures += 1;
  console.log(`   ${cond ? '✅' : '❌'} ${label}`);
  return cond;
};

async function call(method, path, { body, raw, headers: extra, timeout = 120000 } = {}) {
  const headers = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && raw === undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(timeout),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 二进制或非 JSON 响应：保留原文，json 留空由调用方判断
  }
  return { status: res.status, json, text };
}

/** 轮询作业到终态；超时返回最后一次快照（由调用方断言） */
async function waitTerminal(jobId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await call('GET', `/jobs/${jobId}`)).json?.data ?? null;
    if (last && ['succeeded', 'failed', 'canceled', 'rejected'].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

/** 篡改签名末位 → 必须 403（证明 HMAC 校验真的生效，不是摆设） */
async function verifyForgedSignatureRejected(putPath, bytes) {
  const tail = putPath.endsWith('A') ? 'B' : 'A';
  const tampered = putPath.slice(0, -1) + tail;
  const res = await call('PUT', tampered, { raw: bytes, headers: { 'Content-Type': 'text/plain' } });
  ok(res.status === 403, `④ 伪造签名被拒（HTTP ${res.status}，期望 403）`);
}

/** ① ~ ④ 上传三步 + 签名防伪 */
async function uploadProbeFile() {
  console.log('\n── 文件链路（presign → 直传 → confirm）──');
  const bytes = Buffer.from(CONTENT, 'utf8');
  const filename = `e2e-${Date.now()}.txt`;

  const presign = await call('POST', '/files/presign', {
    body: { filename, size: bytes.length, contentType: 'text/plain', scene: 'uploaded' },
  });
  const d = presign.json?.data ?? {};
  ok(presign.status === 201, `① presign（HTTP ${presign.status}）`);
  if (!ok(Boolean(d.uploadUrl), '拿到 uploadUrl（本地存储应返回签名地址）')) return null;

  const putPath = d.uploadUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');
  const put = await call('PUT', putPath, { raw: bytes, headers: { 'Content-Type': 'text/plain' } });
  ok(put.status === 200, `② 直传 PUT（HTTP ${put.status}，${bytes.length} 字节）`);

  const confirm = await call('POST', '/files/confirm', {
    body: { objectKey: d.objectKey, filename, size: bytes.length, scene: 'uploaded' },
  });
  const fileId = confirm.json?.data?.id ?? '';
  ok(confirm.status === 201 && Boolean(fileId), `③ confirm 落库（HTTP ${confirm.status}）`);

  await verifyForgedSignatureRejected(putPath, bytes);
  return fileId ? { fileId, bytes } : null;
}

/** ⑤ ~ ⑦ 列表 / 签发地址 / 字节一致 */
async function verifyDownload(fileId, bytes) {
  const list = await call('GET', '/files');
  const found = (list.json?.data ?? []).some((f) => f.id === fileId);
  ok(found, '⑤ 我的文件列表能查到刚上传的文件');

  const dl = await call('GET', `/files/${fileId}/download`);
  const url = dl.json?.data?.url ?? '';
  if (!ok(Boolean(url), `⑥ 签发下载地址（HTTP ${dl.status}）`)) return;

  const got = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await got.arrayBuffer());
  ok(buf.equals(bytes), `⑦ 下载字节与上传一致（HTTP ${got.status}，${buf.length} 字节）`);
}

/** ⑧ 提交作业，拿 jobId */
async function submitJob(fileId) {
  console.log(`\n── 工具闭环（invoke ${TOOL} → 轮询 → 取产物）──`);
  const inv = await call('POST', `/tools/${TOOL}/invoke`, {
    body: { params: { length: 'short' }, fileIds: [fileId], copyrightAck: false, async: true },
  });
  const jobId = inv.json?.data?.jobId ?? '';
  ok(inv.status === 201 && Boolean(jobId), `⑧ 提交作业（HTTP ${inv.status}，jobId=${jobId || '无'}）`);
  return jobId || null;
}

/** ⑨ 轮询到终态 */
async function awaitJob(jobId) {
  const t0 = Date.now();
  const job = await waitTerminal(jobId);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(job?.status === 'succeeded', `⑨ 作业到达成功终态（status=${job?.status}，耗时 ${secs}s）`);
  if (job?.error) console.log(`      ↳ 错误：${job.error}`);
  return job?.outputFiles?.[0] ?? null;
}

/**
 * ⑩ 取产物并打印正文。
 *
 * ⚠️ `job.outputFiles` 里是**文件 id**，不是 URL —— 必须再查一次 `GET /files/:id`
 * 才能拿到文件名（踩过：直接把 id 当名字显示，界面上是一串 uuid）。
 */
async function printArtifact(outputId) {
  const meta = await call('GET', `/files/${outputId}`);
  const name = meta.json?.data?.name ?? '';
  ok(Boolean(name), `⑩ 产物文件名（${name || '空'}）`);

  const dl = await call('GET', `/files/${outputId}/download`);
  const url = dl.json?.data?.url ?? '';
  if (!ok(Boolean(url), '拿到产物下载地址')) return;

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const body = await res.text();
  console.log(`\n   ── 产物正文（${body.length} 字符）──`);
  console.log(
    body
      .split('\n')
      .map((l) => `   │ ${l}`)
      .join('\n'),
  );
  console.log('');

  // 免费档模型会返回 HTTP 200 + 重复字符的"假成功"，只验状态码会漏掉
  const uniq = new Set(body.replace(/\s/g, ''));
  ok(body.trim().length > 20, '产物非空');
  ok(uniq.size > 8, `产物不是重复字符（去空白后不同字符 ${uniq.size} 个）`);
}

/** 打印依赖状态，让"降级"在报告里可见 */
async function reportDependencies() {
  const health = await call('GET', '/health');
  const h = health.json?.data ?? {};
  console.log(`   ℹ️ 依赖：database=${h.dependencies?.database} redis=${h.dependencies?.redis}`);
  if (h.queue?.degraded) {
    console.log('   ℹ️ 队列处于**降级**（进程内执行）—— 链路仍可验证，但生产需 Redis');
  }
}

async function login() {
  const res = await call('POST', '/auth/login', { body: { code: devLoginCode('e2e') } });
  token = res.json?.data?.accessToken ?? '';
  return ok(res.status === 201 && Boolean(token), `登录（HTTP ${res.status}）`);
}

(async () => {
  console.log(`\n工具端到端闭环（真实 HTTP）\n   后端：${BASE}\n   工具：${TOOL}`);

  if (!(await login())) process.exit(1);
  await reportDependencies();

  const uploaded = await uploadProbeFile();
  if (!uploaded) {
    console.log('\n❌ 文件上传未通过，工具闭环无法验证');
    process.exit(1);
  }

  await verifyDownload(uploaded.fileId, uploaded.bytes);

  const jobId = await submitJob(uploaded.fileId);
  const outputId = jobId ? await awaitJob(jobId) : null;
  if (outputId) await printArtifact(outputId);

  console.log('\n' + '='.repeat(74));
  console.log(
    failures === 0
      ? '🎉 通过：上传 → 调工具 → 取产物，真实 HTTP 端到端可用'
      : `❌ 有 ${failures} 项未通过`,
  );
  console.log('='.repeat(74) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})();
