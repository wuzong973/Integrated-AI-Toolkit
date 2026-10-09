import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';

/** 统一响应体（文档 9.1） */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  traceId: string;
}

/** traceId 响应头名（与 LoggingInterceptor 保持一致） */
export const TRACE_HEADER = 'X-Trace-Id';

/**
 * 统一响应封装（任务清单 M0-07）
 *
 * 实现说明：
 * 这里从**响应头**读取 traceId，而不是用 AsyncLocalStorage。
 * 原因：rxjs 的 map 回调在订阅时执行，已经跳出 LoggingInterceptor 建立的
 *       async 上下文，直接读 ALS 会拿到空值（实测得到 "-"）。
 *       响应头由 LoggingInterceptor 在同一请求上写入，读取最可靠。
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'ok',
        data,
        traceId: (res.getHeader(TRACE_HEADER) as string) ?? '-',
      })),
    );
  }
}
