import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { maskObject } from '@qz/core';

import { currentTraceId } from './trace.context';

/**
 * 结构化日志（任务清单 M0-06）
 * - JSON 格式便于采集；pretty 供本地阅读
 * - 自动附带 traceId
 * - 手机号/学号/token 自动脱敏（文档 6.12.3）
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  format: 'json' | 'pretty';
  maskSensitive: boolean;
}

@Injectable()
export class AppLogger implements NestLoggerService {
  private static opts: LoggerOptions = { level: 'debug', format: 'pretty', maskSensitive: true };

  static configure(opts: LoggerOptions): void {
    AppLogger.opts = opts;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[AppLogger.opts.level];
  }

  private write(level: LogLevel, message: string, context?: string, meta?: unknown): void {
    if (!this.shouldLog(level)) return;

    const payload = {
      ts: new Date().toISOString(),
      level,
      traceId: currentTraceId(),
      context: context ?? 'App',
      message,
      ...(meta ? { meta: this.sanitize(meta) } : {}),
    };

    const line = AppLogger.opts.format === 'json' ? JSON.stringify(payload) : this.pretty(payload);
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }

  /** 敏感字段脱敏（文档 6.12.3）：仅在开启时执行，避免无谓开销 */
  private sanitize(meta: unknown): unknown {
    if (!AppLogger.opts.maskSensitive) return meta;
    return maskObject(meta as Record<string, unknown>);
  }

  /** 人类可读格式（开发环境） */
  private pretty(payload: {
    traceId: string;
    level: LogLevel;
    context: string;
    message: string;
    meta?: unknown;
  }): string {
    const tag = `[${payload.traceId}] ${payload.level.toUpperCase().padEnd(5)} ${payload.context}`;
    const extra = payload.meta ? ` ${JSON.stringify(payload.meta)}` : '';
    return `${tag} ${payload.message}${extra}`;
  }

  log(message: string, context?: string, meta?: unknown): void {
    this.write('info', message, context, meta);
  }
  debug(message: string, context?: string, meta?: unknown): void {
    this.write('debug', message, context, meta);
  }
  warn(message: string, context?: string, meta?: unknown): void {
    this.write('warn', message, context, meta);
  }
  error(message: string, trace?: string, context?: string, meta?: unknown): void {
    this.write('error', message, context, { ...(meta as object), trace });
  }
  verbose(message: string, context?: string, meta?: unknown): void {
    this.write('debug', message, context, meta);
  }
}
