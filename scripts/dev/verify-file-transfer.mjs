/**
 * 端到端验证：文件资产链路（上传 presign → 直传 → confirm；下载 签发地址 → 回流字节）
 *
 * ## 为什么需要它
 *
 * 这条链路的两端分居两处：后端 `FileService` / `FileController` / `LocalStorageController`，
 * 客户端 `apps/mp/utils/file-transfer.ts`。**单测覆盖不到真正的接缝** ——
 * `file.service.spec.ts` 把存储换成了桩，`LocalStorageController` 的 HMAC 令牌校验、
 * 直传端点的字节流写入、以及"下载回来的字节是否与上传的完全一致"都不会被走到。
 * 结果就是：单测全绿，真机点"下载"却下不来。
 *
 * 本脚本走**真实 HTTP**（真实 Nest 进程 + 真实本地存储 + 真实签名令牌），
 * 只从数据库借一个已有用户来签 access token，跑完把记录与磁盘文件都清掉。
 *
 * ## 与其它 verify 脚本的分工
 *
 *   · verify-tools          工具**执行器**能不能真跑出产物（不走 HTTP）
 *   · verify-file-transfer  文件**传输链路**能不能真存取（走 HTTP，本脚本）
 *   · check:tools           工具可用性的静态比对（秒级，无需网络）
 *
 * ## 用法
 *
 *   node scripts/dev/verify-file-transfer.mjs      # 或 npm run verify:files
 *
 * 前置：后端已在 `http://127.0.0.1:3000` 运行；`STORAGE_DRIVER=local`；
 *       数据库里有至少一个用户（`npm run db:seed` 即可）。
 */
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(ROOT, 'apps/api/package.json'));
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? '  → ' + extra : ''}`);
};

/** 1×1 的合法 PNG：体积小、字节确定，便于断言"下载的与上传的完全一致" */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** 环境变量：以 apps/api/.env 为准，缺的从根 .env 补（两者由 npm run setup:env 同步） */
function readEnv() {
  const out = {};
  for (const file of [resolve(ROOT, '.env'), resolve(ROOT, 'apps/api/.env')]) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

/** 上传链路：presign → 直传原始字节 → confirm → 列表可见 */
async function runUpload(api, name) {
  const pre = await api('/files/presign', {
    method: 'POST',
    body: JSON.stringify({
      filename: name,
      size: PNG.length,
      contentType: 'image/png',
      scene: 'uploaded',
    }),
  });
  const presign = pre.body?.data;
  check(pre.status < 300, `① presign（HTTP ${pre.status}）`, presign?.objectKey);
  if (!presign?.uploadUrl) throw new Error('presign 未返回数据：' + JSON.stringify(pre.body));

  // 小程序侧对应 wx.request 的 PUT + ArrayBuffer（wx.uploadFile 发不了 PUT）
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: PNG,
  });
  check(
    put.status < 300,
    `② 直传 PUT（HTTP ${put.status}，host=${new URL(presign.uploadUrl).host}）`,
    (await put.text()).slice(0, 80),
  );

  const conf = await api('/files/confirm', {
    method: 'POST',
    body: JSON.stringify({
      objectKey: presign.objectKey,
      filename: name,
      size: PNG.length,
      scene: 'uploaded',
    }),
  });
  const fileId = conf.body?.data?.id;
  check(!!fileId, `③ confirm 落库（HTTP ${conf.status}）`, fileId ?? JSON.stringify(conf.body));
  if (!fileId) throw new Error('confirm 未返回 fileId');

  const list = await api('/files');
  check(
    Array.isArray(list.body?.data) && list.body.data.some((f) => f.id === fileId),
    '④ 我的文件列表能查到',
  );

  return { fileId, objectKey: presign.objectKey };
}

/** 下载链路：签发地址 → 字节比对 → 伪造签名必须被拒 */
async function runDownload(api, fileId) {
  const dl = await api(`/files/${fileId}/download`);
  const url = dl.body?.data?.url;
  check(!!url, `⑤ 签发下载地址（HTTP ${dl.status}）`, url?.replace(/\/[^/]+$/, '/<token>'));
  if (!url) return;

  // 长度对但内容错是最难发现的一类问题，所以比的是完整字节
  const binRes = await fetch(url);
  const bin = Buffer.from(await binRes.arrayBuffer());
  check(
    binRes.status === 200 && bin.equals(PNG),
    `⑥ 下载字节与上传一致（HTTP ${binRes.status}，${bin.length}B）`,
  );

  // 改掉 HMAC 签名后必须被拒（越权下载的防线）
  const bad = await fetch(url.replace(/(\/files\/local\/[^.]*)\.(.*)$/, '$1.AAAA'));
  check(bad.status >= 400, `⑦ 伪造签名被拒（HTTP ${bad.status}）`);
}

/**
 * 清理：记录硬删（回收站里不留测试数据）+ 磁盘文件删除。
 *
 * ⚠️ 存储根现在是**确定的** `apps/api/data/uploads`（`LOCAL_STORAGE_DIR` 相对路径
 * 已锚定到应用根，见 `configuration.ts` 文件头注释），不再需要"两个可能的根都清一遍"。
 *
 * ⚠️ 删除失败**不能影响脚本结论**：本机有"安全删除"保护（同一轮删除数超阈值会拦下），
 * 而跑这个脚本前常常刚跑过 `nest build`（会删 400+ 个 dist 文件），
 * 累计数一超就轮到这里的 `rmSync` 报错。清理失败只是留个垃圾文件，
 * 不该让"链路验证通过"变成"脚本失败"。
 */
async function cleanup(prisma, env, fileId, objectKey) {
  if (fileId) await prisma.fileAsset.delete({ where: { id: fileId } }).catch(() => {});
  if (objectKey) {
    const p = resolve(ROOT, 'apps/api', env.LOCAL_STORAGE_DIR || './data/uploads', objectKey);
    try {
      rmSync(p, { force: true });
    } catch (e) {
      console.log(`   ℹ️ 清理磁盘文件失败（不影响验证结论，可手动删）：${p}`);
      console.log(`      ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    }
  }
  await prisma.$disconnect();
}

async function main() {
  const env = readEnv();
  const base = `http://127.0.0.1:${env.PORT || 3000}${env.API_PREFIX || '/api/v1'}`;
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });

  // 借一个已有用户：本脚本只验证"链路通不通"，不负责造数据
  const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!user) {
    console.log('❌ 数据库里没有用户，先跑 npm run db:seed');
    await prisma.$disconnect();
    process.exit(1);
  }

  // 直接用 JWT_SECRET 签一个 access token（载荷与 TokenService.issue 一致），
  // 省掉"微信 code 换 token"那一步 —— 本脚本不该依赖微信服务。
  const token = jwt.sign(
    { sub: user.id, openid: user.openid, roles: [], isAdmin: false },
    env.JWT_SECRET,
    { expiresIn: '10m' },
  );
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const api = async (path, init = {}) => {
    const res = await fetch(base + path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  console.log('='.repeat(74));
  console.log(`   后端：${base}`);
  console.log(`   用户：${user.id}（${user.nickname ?? '未设置昵称'}）`);
  console.log('='.repeat(74) + '\n');

  let fileId = null;
  let objectKey = null;

  try {
    const up = await runUpload(api, `e2e-文件链路-${Date.now()}.png`);
    fileId = up.fileId;
    objectKey = up.objectKey;

    await runDownload(api, fileId);

    const del = await api(`/files/${fileId}`, { method: 'DELETE' });
    check(del.status < 300, `⑧ 删除成功（HTTP ${del.status}）`);
  } catch (e) {
    check(false, '流程异常', e.message);
  } finally {
    await cleanup(prisma, env, fileId, objectKey);
  }

  console.log('\n' + '='.repeat(74));
  console.log(failures === 0 ? '🎉 通过：文件上传 / 下载链路端到端可用' : `❌ 有 ${failures} 项未通过`);
  console.log('='.repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
