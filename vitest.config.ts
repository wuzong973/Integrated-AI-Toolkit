import { defineConfig } from 'vitest/config';

/**
 * 全仓单测入口（在仓库根执行）。
 *
 * 测试文件落点：
 *   · `packages/**`、`apps/api/**` —— 与被测代码同目录，命名 `*.spec.ts`；
 *   · `tests/**` —— **只放小程序的测试**（原因见下）。
 *
 * 为什么小程序的测试必须放 `tests/`：
 *   `project.config.json` 的 `miniprogramRoot` 就是 `apps/mp/`，即**发布包本身**。
 *   包内没被引用到的文件会被开发者工具的「过滤无依赖文件」分析点名
 *   （控制台报「xxx 目录下的所有文件将会被忽略」），也有被误打包的风险。
 *
 * 覆盖小程序逻辑的价值：它的**纯逻辑**（进度合并、字段转换等）不依赖 wx API，
 * 完全可以在 Node 里验证。此前没有覆盖，这类逻辑只能靠开发者工具里手点 ——
 * 而"点了没反应"恰恰是最难回溯的一类问题。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/src/**/*.spec.ts', 'apps/api/src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 状态机 / 计费 / 工具函数是红线要求必须全覆盖的部分
      include: ['packages/core/src/**/*.ts', 'apps/api/src/common/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.spec.ts', '**/*.d.ts'],
    },
  },
});
