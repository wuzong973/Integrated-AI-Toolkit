/**
 * 代码规范（任务清单 M0-03）
 *
 * 三条硬红线由 ESLint 强制，不靠人肉 review：
 *   ① 单文件 ≤ 300 行   ② 函数 ≤ 50 行   ③ 禁 any
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true },
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '*.cjs',
    // Vite 把 vite.config.ts 临时编译成同目录的 .timestamp-*.mjs，正常退出会自己删掉；
    // 进程被强杀（taskkill /F、崩溃）时会留在磁盘上，被 lint 当成源码扫出 import/order 警告。
    '**/vite.config.ts.timestamp-*',
    'apps/mp/miniprogram_npm',
    'apps/mp/**/*.js',
  ],
  rules: {
    'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
    complexity: ['error', 10],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
    'prefer-const': 'error',
    'import/order': [
      'warn',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
      },
    ],
  },
  overrides: [
    {
      // 测试文件：允许长用例
      files: ['**/*.spec.ts', '**/*.test.ts'],
      rules: { 'max-lines': 'off', 'max-lines-per-function': 'off', 'no-console': 'off' },
    },
    {
      // 仓库工具脚本（ESM .mjs）：console 输出就是它们的"界面"
      files: ['scripts/**/*.mjs'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2023 },
      rules: { 'no-console': 'off', 'max-lines': 'off', 'max-lines-per-function': 'off' },
    },
    {
      // 一次性数据灌入 / 运维 CLI 脚本：和上面的 `.mjs` 工具脚本同理，
      // `console.log` 就是它们的输出界面，而"把参数解析 + 校验 + 落库 + 回显"
      // 摊平在一个文件里比强行拆成三个小文件更好读。
      files: ['**/prisma/seed.ts', '**/prisma/grant-admin.ts'],
      rules: { 'no-console': 'off', 'max-lines': 'off', 'max-lines-per-function': 'off' },
    },
    {
      // NestJS：装饰器与模块定义天然是长函数
      files: ['apps/api/**/*.ts'],
      rules: { 'max-lines-per-function': 'off' },
    },
    {
      // 管理后台（React）：需要 JSX 解析与浏览器全局量。
      // 注意：解析器不加 `ecmaFeatures.jsx` 时，`.tsx` 会直接报解析错误
      // （不是警告），整个 lint 会中断 —— 这是最容易漏的一步。
      files: ['apps/admin/**/*.ts', 'apps/admin/**/*.tsx'],
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
      env: { browser: true, node: true, es2022: true },
    },
    {
      // React 组件的"函数"本体就是一棵 JSX 声明树，天然远超 50 行，
      // 与上面的 NestJS 装饰器同理（那两个 override 处理的是同一类
      // "声明式代码天然很长"的情况）。
      //
      // ⚠️ **只在 `.tsx` 关闭**：`.ts` 里的 hooks / 工具 / api 层仍受
      // 50 行约束 —— 那里的长函数是真的在堆分支，是本规则要拦的目标。
      // 同时 `max-lines`(300) 与 `complexity`(10) 对 `.tsx` **依旧生效**：
      // 单文件过长要靠拆文件，分支过多要靠拆组件，这两条不能被绕过。
      files: ['apps/admin/**/*.tsx'],
      rules: { 'max-lines-per-function': 'off' },
    },
  ],
};
