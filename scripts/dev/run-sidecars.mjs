/**
 * 一条命令启动全部侧车（AI / 媒体 / 转换 / PDF）。
 *
 * ## 为什么需要它 —— 这不是"顺手加个脚本"
 *
 * 交付排查里出现过这么一条：**抠图被标成 active、守卫也通过，但用户点下去报
 * "抠图服务未配置"** —— 因为 `services/ai` 侧车根本没启动。
 *
 * 问题不在代码：后端的降级是**刻意**的（未配置就明确报错，而不是返回原图假装成功）。
 * 问题在于**几个侧车要分别开几个终端敲几条命令**，漏开一个的症状是
 * "某个功能单独不可用"，而它既不像崩溃那样显眼，也不会在 /health 里变成红色。
 *
 * 所以这里把"起全部侧车"变成一个动作。任一进程退出时一起收摊，
 * 避免留下"看起来在跑、其实只有一个活着"的半死状态。
 *
 * ## 用法
 *
 *   npm run dev:sidecars
 *
 * PowerShell / cmd 下同样可用（本脚本自己 spawn，不依赖 shell 的后台语法 ——
 * `cmd &` 这类写法在命令返回时会被回收，只剩一个孤儿进程）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 侧车清单：服务名 → 模块入口 */
const SERVICES = [
  { name: 'ai', module: 'services.ai', port: 8000 },
  { name: 'media', module: 'services.media', port: 8001 },
  { name: 'convert', module: 'services.convert', port: 8002 },
  { name: 'pdf', module: 'services.pdf', port: 8003 },
];

/** 找一个可用的 Python。
 *
 * 候选顺序与 `run-python.mjs` **保持一致**（Windows 上常见的是 `py` 启动器而不是
 * `python.exe`）。两边不一致的后果很隐蔽：单独 `npm run dev:ai` 能起来，
 * 而 `npm run dev:sidecars` 起来的却是另一个解释器 —— 那个多半没装 rembg，
 * 于是抠图莫名其妙地返回 501。
 */
function resolvePython() {
  const explicit = process.env.PYTHON_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  for (const bin of ['python3', 'python', 'py']) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

const python = resolvePython();
if (!python) {
  console.error('未找到 Python 解释器（试过 python3 / python / py）。');
  console.error('请安装 Python ≥ 3.11 并加入 PATH，或用 PYTHON_BIN 指定解释器路径。');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

for (const svc of SERVICES) {
  const child = spawn(python, ['-u', '-m', svc.module], {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 前缀化输出：三个服务的日志混在一起时，没有前缀就分不清是谁在说话
  const tag = `[${svc.name}:${svc.port}]`;
  const pipe = (stream, isError) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) (isError ? console.error : console.log)(`${tag} ${line}`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('error', (e) => {
    console.error(`${tag} 启动失败：${e.message}`);
    console.error('  请确认 Python 可用（可用 PYTHON_BIN 指定解释器路径）');
    shutdown(1);
  });

  child.on('exit', (code) => {
    // 任何一路退出都收摊：留着一个"半活"的侧车组比全部停掉更难排查
    console.error(`${tag} 已退出（code=${code}），正在停止其余侧车`);
    shutdown(code ?? 0);
  });

  children.push(child);
}

console.log(`已启动 ${SERVICES.length} 个侧车（Python: ${python}）`);
console.log('  ai      :8000   抠图（需 rembg；权重在 ~/.u2net/）');
console.log('  media   :8001   音视频（需 LGPL 构建的 ffmpeg）');
console.log('  convert :8002   文档转换（需自装 LibreOffice / Pandoc）');
console.log('  pdf     :8003   PDF（需自装 PyMuPDF，AGPL 引擎独立安装 + PYMUPDF_BIN）');
console.log('未装依赖的服务不影响其余服务；各自的能力可用性见 /health');
console.log('Ctrl+C 停止全部。\n');

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
