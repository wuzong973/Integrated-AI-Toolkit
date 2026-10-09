/**
 * 《青智校园》PM2 进程配置（服务器 101.35.46.146 / 宝塔）
 *
 * 为什么用 PM2 而不是 systemd：这台机器上另外两个项目（`my-api`、`lovechoice-api`）
 * 本来就归 PM2 管，日志与重启在宝塔的 PM2 插件里直接看得见。新增一套 systemd 机制
 * 只会让"看进程"这件事出现第二套口径。
 *
 * 落地位置：/www/wwwroot/qingzhi.wzl136122.cn/ecosystem.config.cjs
 *   pm2 start scripts/deploy/ecosystem.config.cjs
 *   pm2 save            # 写开机自启（还要 pm2 startup 一次）
 *
 * ⚠️ 这个文件里**不写任何密钥**。密钥只在仓库根的 `.env`（权限 600、严禁入库）。
 *    Nest 侧由 `apps/api/src/common/config/paths.ts` 的 ENV_FILE_PATHS 锚定读取，
 *    侧车侧由自己的 `*_HOST` / `*_PORT` 环境变量决定 —— 所以下面只放非敏感的重定向配置。
 *
 * ⚠️ 端口两条硬约束：
 *   1) API 用 **3100**，因为 3000 已被这台机器上的 `my-api` 占着；
 *   2) 侧车一律 **127.0.0.1** 且从 8101 起，因为
 *      - `services/shared/config.py` 里侧车默认 `host=0.0.0.0`，直接开公网就是
 *        把一个能执行 ffmpeg / PyMuPDF 子进程的服务暴露出去；
 *      - AI 侧车的默认端口 8000 **正好是宝塔面板自己**（BT-Panel 在 *:8000），
 *        所以用 8104 显式覆盖，绝不碰 8000/8100。
 *
 * ⚠️ 侧车运行在独立 venv（`/opt/qz-venv`，python3.11）下：
 *    - services/ 四个侧车都是**纯标准库**实现（没切 FastAPI），venv 里只需 PyMuPDF / rembg；
 *    - pdf 侧车通过 `PYMUPDF_BIN` 指向这个 venv 的 python，以子进程调 `-m pymupdf`（AGPL 隔离）；
 *    - ai 侧车按需 `import rembg` 做抠图，rembg 装在这个 venv 里。
 */

const REPO = '/www/wwwroot/qingzhi.wzl136122.cn';
const LOG_DIR = '/www/wwwlogs';
const SIDECAR_PY = '/opt/qz-venv/bin/python';

/** 侧车共用的进程参数：纯 stdlib，不需要 interpreter 之外的运行时 */
const sidecar = (name, module, port, mem = '400M') => ({
  name,
  // 注意：PM2 的 `interpreter` + `script: '-m ...'` 组合会退化成用 /usr/bin/bash
  // 去执行脚本（报 "source code cannot contain null bytes"）。标准做法是把解释器
  // 直接当 script、模块名放 args。
  script: SIDECAR_PY,
  args: `-m ${module}`,
  cwd: REPO,
  instances: 1,
  exec_mode: 'fork',
  // 侧车会拉起 ffmpeg / soffice / PyMuPDF 子进程，内存主要被子进程吃；
  // 这个数字**不代表峰值**，只用于"泄漏到停不下来时兜底重启"。
  // ai 侧车会在进程内加载 onnxruntime + u2net（抠图），给到 900M 避免误杀在途请求。
  max_memory_restart: mem,
  env: {
    // 见上面第二条硬约束：只绑环回
    [`${name.split('-')[1].toUpperCase()}_HOST`]: '127.0.0.1',
    [`${name.split('-')[1].toUpperCase()}_PORT`]: String(port),
    TZ: 'Asia/Shanghai',
  },
  out_file: `${LOG_DIR}/${name}-out.log`,
  error_file: `${LOG_DIR}/${name}-err.log`,
  merge_logs: true,
  time: true, // 日志行带时间戳，否则排查"哪个作业在哪一步挂的"没有可比对的时间轴
});

module.exports = {
  apps: [
    {
      name: 'qingzhi-api',
      script: 'apps/api/dist/main.js',
      cwd: REPO,
      // 单实例 fork，不用 cluster：
      //   1) 作业队列消费者（QUEUE_DRIVER=redis-stream）跑多份会让同一条消息被处理两次；
      //   2) 进度推送是原生 ws 挂在 HTTP server 上（apps/api/src/modules/job/job-progress.gateway.ts），
      //      多实例下连接归属会漂，前端表现为"进度条卡在 0%"。
      instances: 1,
      exec_mode: 'fork',
      // 3.6G 的机器上还跑着另外两个项目 + MySQL/Redis/MinIO/Qdrant 容器，
      // 给 API 一个硬兜底；OOM 时宁可重启这一个进程。
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
      },
      out_file: `${LOG_DIR}/qingzhi-api-out.log`,
      error_file: `${LOG_DIR}/qingzhi-api-err.log`,
      merge_logs: true,
      time: true,
      // 启动失败时不要无限重启刷日志：Prisma 引擎加载失败 / DATABASE_URL 写错
      // 这类问题会稳定复现，重启几十次只会把日志盘写满
      max_restarts: 10,
      min_uptime: '20s',
    },

    // ---------- 侧车：依赖已装在 /opt/qz-venv，系统二进制 ffmpeg/soffice/pandoc 就位 ----------
    // 启动顺序：先起侧车，再 `pm2 restart qingzhi-api`（API 启动期不探测侧车可达性，顺序不强依赖）。
    sidecar('qingzhi-media', 'services.media', 8101), // 需要 LGPL 版 ffmpeg（/usr/local/bin）
    sidecar('qingzhi-convert', 'services.convert', 8102), // 需要 LibreOffice + Pandoc（/usr/bin）
    // pdf 侧车额外把 PYMUPDF_BIN 指向 venv（以子进程调 `-m pymupdf`，AGPL 隔离）
    {
      ...sidecar('qingzhi-pdf', 'services.pdf', 8103),
      env: {
        ...sidecar('qingzhi-pdf', 'services.pdf', 8103).env,
        PYMUPDF_BIN: SIDECAR_PY,
      },
    },
    // ai 侧车：进程内加载 rembg 做抠图，内存给到 900M；
    // 人声分离（demucs/torch ≈1GB）在本机 3.6G 内存下有 OOM 风险，**暂不安装**
    // → /ai/separation 会如实返回 501，而非冒充成功（红线 10）。
    sidecar('qingzhi-ai', 'services.ai', 8104, '900M'),
  ],
};
