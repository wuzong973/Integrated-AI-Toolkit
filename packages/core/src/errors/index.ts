import { ErrorCode, ERROR_HTTP_STATUS, renderErrorMessage } from './codes';

export * from './codes';

/**
 * 业务异常基类
 * 纪律：业务代码只抛业务异常；未知异常由全局过滤器兜底，绝不外泄堆栈（文档 6.12.2）
 */
export class BizException extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly detail?: Record<string, unknown>;
  public readonly userMessage: string;

  constructor(code: ErrorCode, detail?: Record<string, unknown>, customMessage?: string) {
    super(customMessage ?? renderErrorMessage(code, detail));
    this.name = 'BizException';
    this.code = code;
    this.detail = detail;
    this.httpStatus = ERROR_HTTP_STATUS[code] ?? 400;
    this.userMessage = customMessage ?? renderErrorMessage(code, detail);
  }

  toJSON() {
    return { code: this.code, message: this.userMessage, detail: this.detail };
  }
}

/** 常用快捷构造 */
export const biz = {
  unauthorized: (m?: string) => new BizException(ErrorCode.Unauthorized, undefined, m),
  noPermission: (m?: string) => new BizException(ErrorCode.NoPermission, undefined, m),
  notFound: (m?: string) => new BizException(ErrorCode.NotFound, undefined, m),
  paramInvalid: (detail?: Record<string, unknown>, m?: string) =>
    new BizException(ErrorCode.ParamInvalid, detail, m),
  pointsNotEnough: (required: number, available: number) =>
    new BizException(ErrorCode.PointsNotEnough, { n: required - available }),
  orderConflict: (m?: string) => new BizException(ErrorCode.OrderStatusConflict, undefined, m),
  taskAssigned: () => new BizException(ErrorCode.TaskAlreadyAssigned),
  illegalTransition: (from: string, to: string) =>
    new BizException(ErrorCode.IllegalStateTransition, { from, to }),
  toolFailed: (m?: string) => new BizException(ErrorCode.ToolExecutionFailed, undefined, m),
  copyrightAckRequired: () => new BizException(ErrorCode.CopyrightAckRequired),
  contentViolation: () => new BizException(ErrorCode.ContentViolation),
  llmUnavailable: (m?: string) => new BizException(ErrorCode.LlmUnavailable, undefined, m),
  duplicate: () => new BizException(ErrorCode.DuplicateOperation),
  internal: (m?: string) => new BizException(ErrorCode.InternalError, undefined, m),
};
