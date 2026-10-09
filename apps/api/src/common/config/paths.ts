import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * 路径解析 —— 所有"配置里写的相对路径"都在这里锚定成绝对路径。
 *
 * ## 为什么不能用 `process.cwd()`
 *
 * 2026-09-18 实测踩到的真 bug：`LOCAL_STORAGE_DIR` 默认是**相对路径**
 * `./data/uploads`，而 `LocalStorageProvider` 用 `resolve(baseDir)` 解析 ——
 * 等价于相对 `process.cwd()`。于是**换个启动方式，存储根就变了**：
 *
 *   · `npm run start:dev -w @qz/api`（cwd = apps/api）→ 落在 `apps/api/data/uploads`
 *   · `cd 仓库根 && node apps/api/dist/main.js`（cwd = 仓库根）→ 落在 `data/uploads`
 *
 * 后果极具迷惑性：**文件明明在磁盘上、数据库也有记录，下载却报 404
 * 「文件不存在或已被删除」** —— 因为新进程在另一个目录里找。
 * （实测：用户生成的两个文件在 `apps/api/data/uploads`，
 *   而重启后的后端去 `data/uploads` 找，0 个文件。）
 *
 * 锚定到应用根后，两种启动方式指向同一个目录；已有的数据无需迁移。
 * 想放到别处就写**绝对路径**（绝对路径原样使用）。
 */
export const APP_ROOT = findAppRoot(__dirname);

function findAppRoot(start: string): string {
  let dir = start;
  // 上限 6 层，避免异常目录结构下死循环
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：找不到 package.json 时退回启动目录（保持旧行为，不炸）
  return process.cwd();
}

/** 把可能是相对路径的配置项锚定到应用根目录 */
export function anchorToAppRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(APP_ROOT, p);
}

/**
 * 仓库根目录 —— 从应用根再向上找**带 `workspaces` 的 package.json**。
 *
 * `apps/api/.env` 只是 `scripts/dev/setup-env.mjs` 从根 `.env` 复制出来的
 * **生成物**（Prisma CLI 只认 schema 同级目录，才需要那一份）；
 * 配置的唯一事实来源永远是仓库根的 `.env`。
 */
const REPO_ROOT = findRepoRoot(APP_ROOT);

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    if (isWorkspaceRoot(parent)) return parent;
    dir = parent;
  }
  // 兜底：单包部署（没有 workspaces）时退回应用根，保持旧行为
  return start;
}

function isWorkspaceRoot(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
    return parsed.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * `.env` 候选路径，**锚定绝对路径、按优先级排列**（先出现者优先，不覆盖已有键）。
 *
 * ## 为什么不能写 `['.env.local', '.env']`
 *
 * 相对路径按 `process.cwd()` 解析，于是**换个启动方式就读到另一份文件**：
 *
 *   · `npm run dev:api`（cwd = `apps/api`）→ 读 `apps/api/.env`
 *   · `cd 仓库根 && node apps/api/dist/main.js`（cwd = 仓库根）→ 读 `.env`
 *
 * 而 `apps/api/.env` 是**生成物** —— 改了根 `.env` 却忘了跑 `npm run setup:env` 时，
 * 配置会**静默过期**：新加的配置项"明明配了却不生效"，且没有任何报错。
 * 2026-09-18 实测踩到：`VECTOR_DRIVER` / `QDRANT_*` / `RAG_*` /
 * `LLM_TOTAL_BUDGET_MS` 等 11 个键只在根 `.env` 里，用 `cd apps/api` 启动时全部读不到。
 *
 * 锚定后两种启动方式读到同一份；`apps/api/.env` 仍保留在列表末尾兜底
 * （Prisma 与旧部署习惯），只是不再因 cwd 而改变优先级。
 */
export const ENV_FILE_PATHS = [
  join(REPO_ROOT, '.env.local'),
  join(REPO_ROOT, '.env'),
  join(APP_ROOT, '.env.local'),
  join(APP_ROOT, '.env'),
];
