import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 管理后台构建配置。
 *
 * ## 为什么用 proxy 而不是直连 + CORS
 *
 * 后端默认已放行 5173（`CORS_ORIGINS`），但直连意味着**前端要写死后端地址**：
 * 换端口、换机器、上测试环境都要改代码并重新构建。
 * 走 proxy 后前端只认相对路径 `/api/v1`，地址收敛到本文件一处（`QZ_API_ORIGIN`）。
 *
 * ⚠️ proxy 只在 `vite dev` / `vite preview` 生效；**生产必须由网关（Nginx）
 * 把 `/api` 反向代理到后端**，部署时别把 dev 的便利当成生产方案。
 *
 * ## 为什么 `@qz/*` 直接指向源码而不是 dist
 *
 * `packages/core`、`packages/sdk` 按 Node 约定编译成 **CommonJS**（后端 `apps/api`
 * 需要 CJS），产物里是 `__exportStar(require("./client"), exports)` 这种动态再导出。
 * Rollup 静态分析看不到其中的具名导出，构建会直接报
 * `"HttpClient" is not exported by packages/sdk/dist/index.js`。
 *
 * 指向源码有两个好处，且都不是权宜之计：
 * 1. 打包器直接编译 TS，不再受 CJS 再导出限制；
 * 2. **不再依赖 `packages/<pkg>/dist` 的构建新鲜度** —— 否则会拿旧 dist 构建出一个
 *    与源码不符的后台，而且不报错（之前正是如此）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * 后端地址。
 *
 * ⚠️ 端口必须是 **3000**（`apps/api/.env` 的 `PORT`）—— 别在这里另起一套。
 * 曾经后端起在 3100、这里默认 3100，而小程序配的是 3000：
 * 于是同一台机器上并存两个后端，`STORAGE_PUBLIC_BASE_URL` 又是**启动时**读进内存的，
 * 两个进程签发出来的直传地址不是同一个（一个是早已失效的旧 IP），
 * 表现为"上传图片必然超时"。**地址只留一份**：以后端 `.env` 为准。
 */
const API_ORIGIN = process.env.QZ_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@qz/core': path.join(repoRoot, 'packages/core/src/index.ts'),
      '@qz/sdk': path.join(repoRoot, 'packages/sdk/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    /**
     * ⚠️ 必须显式写 `127.0.0.1`。
     *
     * Vite 5 的默认 `host` 是 `'localhost'`，而 Windows 上 Node 解析
     * `localhost` 会优先取 `::1`，于是 dev server **只监听 IPv6**：
     * `netstat` 显示 `[::1]:5173 LISTENING`，`127.0.0.1:5173` 直接拒连。
     * 后果是浏览器（会做 IPv4 回退）看着一切正常，但 `curl 127.0.0.1:5173`、
     * Playwright、以及 `verify:admin` 这类脚本全部 `fetch failed` ——
     * 报错长得像"服务没起"，排查方向会被带偏。
     * 绑定 IPv4 后 `127.0.0.1` 与 `localhost` 两者都通。
     *
     * 这里不用 `0.0.0.0`：后台是内部系统，没有理由把它暴露到整个局域网。
     */
    host: '127.0.0.1',
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: true },
      '/health': { target: API_ORIGIN, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    // 后台是内部系统，体积不敏感；但把 react 单独分包，便于网关做长期缓存
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
