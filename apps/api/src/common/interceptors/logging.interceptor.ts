import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { AppLogger } from '../logger/logger.service';
import { runWithTrace } from '../logger/trace.context';

import { TRACE_HEADER } from './transform.interceptor';

/**
 * 请求日志拦截器（任务清单 M0-06）
 * 为每个请求建立 traceId 上下文、写入响应头，并记录耗时与状态码。
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { id: string } }>();
    const res = http.getResponse<Response>();

    // 优先复用上游传入的 traceId（便于跨服务串联）
    const traceId = (req.headers['x-trace-id'] as string) || genTraceId();
    res.setHeader(TRACE_HEADER, traceId);

    const startedAt = Date.now();

    return runWithTrace({ traceId, userId: req.user?.id, startedAt }, () =>
      next.handle().pipe(
        tap({
          next: () => {
            this.logger.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`, 'HTTP', {
              ms: Date.now() - startedAt,
            });
          },
          error: (err: Error) => {
            this.logger.error(
              `${req.method} ${req.originalUrl} 失败：${err.message}`,
              undefined,
              'HTTP',
              { ms: Date.now() - startedAt },
            );
          },
        }),
      ),
    ) as Observable<unknown>;
  }
}

function genTraceId(): string {
  return `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
