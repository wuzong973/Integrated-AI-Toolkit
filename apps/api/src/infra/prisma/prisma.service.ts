import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { AppConfig } from '../../common/config/configuration';
import { AppLogger } from '../../common/logger/logger.service';

/**
 * Prisma 客户端封装（任务清单 M0-10）
 *
 * 数据库：MySQL 8.0+（迁移说明见 docs/architecture/DB-MIGRATION-POSTGRES-TO-MYSQL.md）
 *
 * 设计说明（重要）：
 * 数据库不可达时**不让进程崩溃**，而是记录告警并把状态暴露给 /health。
 * 理由：
 *   ① 云环境下数据库重启/网络抖动属常态，进程自杀会导致雪崩；
 *   ② 健康检查需要能报告"数据库不可用"这一事实，而不是直接失联；
 *   ③ 本地未装 MySQL 时仍可启动 API 并跑通 /health 冒烟。
 * 但**所有涉及数据的功能**在数据库不可用时一律返回明确错误（不会静默降级）。
 *
 * 连接池：Prisma 不读 DB_POOL_MAX，只认连接串上的 connection_limit 参数，
 * 故此处由配置装配后注入，避免"改了 .env 却不生效"。
 *
 * 日志事件：第二个泛型参数必须显式写 `'warn' | 'error'`。
 * 不写的话 TS 无法从 ClientOptions 反推事件名，`$on` 的参数会被推断成 `never` 而编译失败。
 *
 * 注意（MySQL 特有）：Json 字段的 @default 由 Prisma Client 在写入时补值，
 * 数据库层没有 DEFAULT 子句。用原生 SQL 直插时**必须显式提供 JSON 列**，否则报错。
 */
@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>
  implements OnModuleInit, OnModuleDestroy
{
  private connected = false;
  private lastError: string | null = null;

  constructor(
    private readonly logger: AppLogger,
    config: ConfigService,
  ) {
    const db = config.get<AppConfig>('app')?.db;
    // 注意：log 数组必须写成内联字面量。若用对象展开或先赋给变量，
    // TS 会丢失字面量类型，$on 的事件名会被推断成 never（编译报错）。
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      datasourceUrl: db ? withPoolLimit(db.url, db.poolMax) : undefined,
    });

    // 必须显式绑定监听器：`log: [{ emit: 'event' }]` 只是把日志从"打到 stdout"改成"发事件"，
    // 不监听就等于直接丢弃。这里曾经漏绑，导致 Prisma 的告警（连接抖动、慢查询、
    // 连接池耗尽等）完全不可见 —— 数据库掉线只能靠 /health 轮询才发现。
    this.$on('warn', (e) => {
      this.logger.warn(e.message, 'Prisma', { target: e.target });
    });
    this.$on('error', (e) => {
      this.logger.error(e.message, undefined, 'Prisma', { target: e.target });
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.connected = true;
      this.lastError = null;
      this.logger.log('数据库连接已建立', 'Prisma');
    } catch (e) {
      this.connected = false;
      this.lastError = (e as Error).message;
      this.logger.warn(
        `数据库连接失败，API 仍会启动但不提供数据功能。请执行 docker compose up -d 或配置 DATABASE_URL。原因：${this.lastError}`,
        'Prisma',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch(() => undefined);
    this.logger.log('数据库连接已关闭', 'Prisma');
  }

  /** 健康检查：确认数据库可达（含重连尝试） */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      this.connected = true;
      this.lastError = null;
      return true;
    } catch (e) {
      this.connected = false;
      this.lastError = (e as Error).message;
      return false;
    }
  }

  get status(): { connected: boolean; lastError: string | null } {
    return { connected: this.connected, lastError: this.lastError };
  }
}

/**
 * 把 DB_POOL_MAX 落到 MySQL 连接串的 connection_limit 参数上。
 * - 连接串里已显式写了 connection_limit 时以连接串为准（便于临时排查）
 * - 连接串无法解析（非 URL 形式）时原样返回，不阻断启动
 */
export function withPoolLimit(url: string, poolMax: number): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', String(poolMax));
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
