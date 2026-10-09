import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { BizException, ErrorCode, ERROR_HTTP_STATUS, IllegalTransitionError } from '@qz/core';

import { TRACE_HEADER } from '../interceptors/transform.interceptor';
import { AppLogger } from '../logger/logger.service';

/** 统一错误响应体 */
interface ErrorBody {
  code: number;
  message: string;
  data: null;
  traceId: string;
  detail?: Record<string, unknown>;
}

/**
 * NestJS 内置异常的框架原话。
 *
 * 路由未注册时 NestJS 抛的 `NotFoundException` 其 message 是
 * `Cannot POST /api/v1/station/tasks` —— 这是**框架原话**，直接透传有两个问题：
 *   ① 把内部路由结构暴露给用户（违反本文件的纪律 ②「对外绝不外泄」）；
 *   ② 小程序端 `toastError` 会把这串英文原样弹给用户。
 *
 * 实测（2026-09-18）：驿站发布页点「发布」→ 用户看到
 * `Cannot POST /api/v1/station/tasks`。
 */
const FRAMEWORK_ROUTE_MESSAGE = /^Cannot\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i;

/**
 * 把 HttpException 的 message 归一化成用户能看懂的话。
 *
 * 只处理**框架句式**，其余 message（例如 ValidationPipe 的字段级提示、
 * 业务代码自己写的 `new NotFoundException('任务不存在或已下架')`）原样保留 ——
 * 那些是刻意写给用户看的，替换反而会丢信息。
 *
 * 纯函数、无副作用，便于单测。
 */
export function normalizeHttpMessage(status: number, raw: string): string {
  if (!FRAMEWORK_ROUTE_MESSAGE.test(raw)) return raw;
  return status === HttpStatus.NOT_FOUND
    ? '该功能尚未开放，敬请期待'
    : '请求方式不正确，请升级小程序后重试';
}

/**
 * 全局异常过滤器（任务清单 M0-07）
 * 纪律：
 *  ① 业务异常返回对应 code + HTTP + 用户文案；
 *  ② 未知异常记录完整堆栈，但**对外绝不外泄**（文档 6.12.2）；
 *  ③ traceId 从响应头读取（与成功响应保持一致）。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = (res.getHeader(TRACE_HEADER) as string) ?? '-';

    if (exception instanceof BizException) return this.replyBiz(exception, res, traceId);
    if (exception instanceof IllegalTransitionError)
      return this.replyTransition(exception, res, traceId);
    if (exception instanceof HttpException) return this.replyHttp(exception, res, traceId);

    this.replyUnknown(exception, res, traceId);
  }

  /** ① 业务异常（含用户文案与可选 detail） */
  private replyBiz(e: BizException, res: Response, traceId: string): void {
    this.logger.warn(`业务异常 ${e.code}: ${e.userMessage}`, 'Exception');
    this.send(res, e.httpStatus, {
      code: e.code,
      message: e.userMessage,
      data: null,
      traceId,
      ...(e.detail ? { detail: e.detail } : {}),
    });
  }

  /** ② 状态机非法迁移 → 40904 */
  private replyTransition(e: IllegalTransitionError, res: Response, traceId: string): void {
    this.logger.warn(`非法状态迁移 ${e.entity}: ${e.from} → ${e.to}`, 'Exception');
    this.send(res, 409, {
      code: ErrorCode.IllegalStateTransition,
      message: '当前状态不允许该操作',
      data: null,
      traceId,
      detail: { from: e.from, to: e.to, entity: e.entity },
    });
  }

  /** ③ NestJS HttpException（含 ValidationPipe 的 400） */
  private replyHttp(e: HttpException, res: Response, traceId: string): void {
    const status = e.getStatus();
    const body = e.getResponse();
    const raw =
      typeof body === 'string'
        ? body
        : ((body as { message?: string | string[] }).message ?? '请求失败');

    const text = Array.isArray(raw) ? raw.join('；') : raw;

    this.send(res, status, {
      // ⚠️ 约定：非 400 的 HttpException 用 `status * 100` 当业务码，
      //    故 **40400 专指「路由未注册」**（业务侧的 404 走 BizException → 40401）。
      //    小程序端据此把「接口还没上线」和「内容不存在」区分开。
      code: status === HttpStatus.BAD_REQUEST ? ErrorCode.ParamInvalid : status * 100,
      message: normalizeHttpMessage(status, text),
      data: null,
      traceId,
    });
  }

  /** ④ 未知异常：内部记录堆栈，对外只给通用文案 */
  private replyUnknown(exception: unknown, res: Response, traceId: string): void {
    const err = exception as Error;
    this.logger.error(`未捕获异常：${err?.message}`, err?.stack, 'Exception');
    this.send(res, ERROR_HTTP_STATUS[ErrorCode.InternalError] ?? 500, {
      code: ErrorCode.InternalError,
      message: '服务开小差了，请稍后重试',
      data: null,
      traceId,
    });
  }

  private send(res: Response, status: number, body: ErrorBody): void {
    res.status(status).json(body);
  }
}
