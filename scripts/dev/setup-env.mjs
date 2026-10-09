#!/usr/bin/env node
/**
 * 环境文件准备脚本
 *
 * 背景：Prisma CLI 在 schema 所在目录查找 .env，而本项目把配置收敛在仓库根目录。
 * 本脚本把根目录 .env 同步到需要它的位置，避免"多处配置不一致"。
 *
 * 用法：
 *   node scripts/dev/setup-env.mjs          # 若根 .env 不存在则从 .env.example 复制
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * 仓库根目录。
 *
 * ⚠️ 这里必须是 `../..`：本脚本位于 `scripts/dev/`，只退一层会算成 `scripts/`，
 * 于是它会去找 `scripts/.env.example` → 报「缺少 .env.example，无法初始化」，
 * 而仓库根明明有。脚本被移进子目录时漏改过，已修（`npm run setup:env` 曾因此完全不可用）。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootEnv = join(root, '.env');
const exampleEnv = join(root, '.env.example');

if (!existsSync(rootEnv)) {
  if (!existsSync(exampleEnv)) {
    console.error('缺少 .env.example，无法初始化');
    process.exit(1);
  }
  copyFileSync(exampleEnv, rootEnv);
  console.log(
    '已从 .env.example 创建根目录 .env（请按需填写第三方密钥，逐项说明见 docs/dev/ENV.md）',
  );
} else {
  console.log('根目录 .env 已存在');
}

/**
 * 需要同步 .env 的目标位置。
 * Prisma CLI 只在 schema 所在目录及其上级找 .env，因此必须复制一份到 apps/api/；
 * 它是生成物（已 gitignore），唯一事实来源永远是仓库根的 .env。
 */
const targets = [join(root, 'apps/api/.env')];

for (const t of targets) {
  copyFileSync(rootEnv, t);
  console.log('已同步 ->', relative(root, t).replace(/\\/g, '/'));
}

console.log('\n下一步：');
console.log('  1) npm run db:up            启动 MySQL / Redis / MinIO');
console.log('  2) npm run db:migrate       建表');
console.log('  3) npm run db:seed          灌入演示数据');
console.log('  4) npm run dev:api          启动后端（apps/api）');
console.log(
  '  5) 微信开发者工具导入【仓库根目录】（project.config.json 的 miniprogramRoot 指向 apps/mp）',
);
console.log('     指引见 docs/dev/WECHAT-DEVTOOLS.md');
