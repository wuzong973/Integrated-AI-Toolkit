import { isAbsolute, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConfig } from '../configuration';
import { validateEnv } from '../env.schema';

/**
 * 配置装配 —— 路径类配置的锚定
 *
 * 背景（2026-09-18 实测踩到的真 bug）：`LOCAL_STORAGE_DIR` 默认 `./data/uploads`
 * 是相对路径，而 `LocalStorageProvider` 用 `resolve(baseDir)` 解析 ——
 * 等价于相对 `process.cwd()`。于是**换个启动方式存储根就变了**：
 *
 *   · `npm run start:dev -w @qz/api`（cwd = apps/api）→ `apps/api/data/uploads`
 *   · `cd 仓库根 && node apps/api/dist/main.js`（cwd = 仓库根）→ `data/uploads`
 *
 * 现象极具迷惑性：**文件在磁盘上、数据库也有记录，下载却 404「文件不存在或已被删除」**。
 * 所以这里断言的是"**与 cwd 无关**"，而不是某个具体目录 ——
 * 只要断言写死绝对路径，就又会变成"换个机器就挂"的脆弱用例。
 */
describe('buildConfig —— 存储目录必须锚定到应用根，不随 cwd 漂移', () => {
  /** 最小可校验环境（validateEnv 是严格模式，缺必填项直接抛） */
  const BASE = {
    NODE_ENV: 'test',
    DATABASE_URL: 'mysql://u:p@localhost:3306/qz',
    JWT_SECRET: 'test-secret-at-least-16-chars',
  } as const;

  const env = validateEnv({ ...BASE });

  it('LOCAL_STORAGE_DIR 解析成绝对路径（不再依赖 process.cwd）', () => {
    const cfg = buildConfig(env);
    expect(isAbsolute(cfg.storage.localDir)).toBe(true);
  });

  it('⭐ 与 process.cwd() 无关：改 cwd 后结果不变', () => {
    const before = buildConfig(env).storage.localDir;

    const original = process.cwd();
    try {
      process.chdir(resolve(original, 'apps/api'));
      const after = buildConfig(env).storage.localDir;
      expect(after).toBe(before);
    } finally {
      process.chdir(original);
    }
  });

  it('相对路径锚定到 api 应用根（apps/api），而不是仓库根', () => {
    const cfg = buildConfig(env);
    // 默认值是 './data/uploads'，期望落在 apps/api/data/uploads
    expect(cfg.storage.localDir.replace(/\\/g, '/')).toMatch(/apps\/api\/data\/uploads$/);
  });

  it('绝对路径原样保留（想放别处就写绝对路径）', () => {
    const abs = resolve('D:/tmp/qz-uploads');
    const cfg = buildConfig(validateEnv({ ...BASE, LOCAL_STORAGE_DIR: abs }));
    expect(cfg.storage.localDir).toBe(abs);
  });
});
