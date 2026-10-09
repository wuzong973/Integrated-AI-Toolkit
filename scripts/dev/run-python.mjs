#!/usr/bin/env node
/**
 * Python 解释器解析 + 转发
 *
 * 为什么需要它：Windows 上常见的是 py 启动器而不是 python.exe，
 * 脚本里写死 `python ...` 会在本机报"不是内部或外部命令"。
 * 本脚本按 python3 -> python -> py 依次探测，用第一个可用的转发全部参数。
 *
 * 用法：
 *   node scripts/dev/run-python.mjs -m services.ai
 *   node scripts/dev/run-python.mjs scripts/license/license_audit.py --sleep 1
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

/** 候选解释器：POSIX 优先 python3，Windows 优先 py 启动器 */
const CANDIDATES = ['python3', 'python', 'py'];

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('用法：node scripts/dev/run-python.mjs <python 参数...>\n');
  process.exit(2);
}

function resolveInterpreter() {
  for (const bin of CANDIDATES) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

const interpreter = resolveInterpreter();
if (!interpreter) {
  process.stderr.write(
    `未找到 Python 解释器（试过 ${CANDIDATES.join(' / ')}）。请安装 Python ≥ 3.11 并加入 PATH。\n`,
  );
  process.exit(1);
}

const child = spawn(interpreter, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
