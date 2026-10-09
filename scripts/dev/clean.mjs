#!/usr/bin/env node
/**
 * 清理构建产物
 *
 * 为什么需要：@qz/api 通过 node_modules 软链引用 @qz/core / @qz/sdk 的 **dist**，
 * 源码结构变动后若 dist 未重建，类型检查会对着旧产物通过或报错，排查成本极高。
 *
 * 用法：npm run clean
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../..');

/** 只删构建产物与缓存，绝不碰源码 */
const TARGETS = [
  'apps/api/dist',
  'apps/api/tsconfig.tsbuildinfo',
  'packages/core/dist',
  'packages/core/tsconfig.tsbuildinfo',
  'packages/sdk/dist',
  'packages/sdk/tsconfig.tsbuildinfo',
  'apps/mp/miniprogram_npm',
];

for (const target of TARGETS) {
  const abs = path.join(root, ...target.split('/'));
  try {
    await rm(abs, { recursive: true, force: true });
    process.stdout.write('已清理 ' + target + '\n');
  } catch (err) {
    process.stderr.write(`清理 ${target} 失败：${err.message}\n`);
  }
}
