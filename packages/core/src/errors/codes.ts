/**
 * 全量错误码（文档附录 B）
 * 分段规则：0 成功 | 401xx 认证授权 | 403xx 权限配额 | 400xx 参数业务 |
 *           404xx 资源不存在 | 409xx 状态冲突 | 429xx 限流 |
 *           500xx 系统错误 | 503xx 依赖不可用
 */
export enum ErrorCode {
  Ok = 0,

  // ---------- 401xx 认证与授权 ----------
  Unauthorized = 40101,
  TokenExpired = 40102,
  TokenInvalid = 40103,

  // ---------- 403xx 权限与配额 ----------
  StudentVerificationRequired = 40311,
  ProviderVerificationRequired = 40312,
  NoPermission = 40313,
  PointsNotEnough = 40321,
  DailyQuotaExceeded = 40322,
  CopyrightAckRequired = 40323,
  AccountFrozen = 40324,

  // ---------- 400xx 参数与业务校验 ----------
  ParamInvalid = 40001,
  FileTooLarge = 40031,
  FileFormatUnsupported = 40032,
  FileCorrupted = 40033,
  ContentViolation = 40051,
  ThinkInjectionDetected = 40052,

  // ---------- 404xx 资源不存在 ----------
  NotFound = 40401,

  // ---------- 409xx 状态冲突 ----------
  DuplicateOperation = 40901,
  OrderStatusConflict = 40902,
  TaskAlreadyAssigned = 40903,
  IllegalStateTransition = 40904,

  // ---------- 429xx 限流 ----------
  TooManyRequests = 42901,
  ConcurrentRunLimit = 42902,

  // ---------- 500xx 系统错误 ----------
  InternalError = 50001,
  ToolExecutionFailed = 50041,
  JobTimeout = 50042,
  AiOutputInvalid = 50043,

  // ---------- 503xx 依赖不可用 ----------
  LlmUnavailable = 50341,
  QueueBusy = 50361,
  ConvertServiceUnavailable = 50362,
  StorageUnavailable = 50363,
  /**
   * 内容审核服务不可用（微信内容安全接口调用失败）。
   *
   * 单独一个码的原因：它的**降级策略与其它依赖不同** —— 其它依赖挂了可以
   * fail-open（放行 + 告警），审核挂了只能 fail-closed（拦住 + 明确提示）。
   * 前端必须能区分这两种情况，否则用户会以为是"服务崩了"而反复重试。
   */
  ModerationUnavailable = 50364,
  /** 短信服务不可用（服务商尚未选型，见 SMS_DRIVER 的说明） */
  SmsUnavailable = 50365,
  /**
   * 地图服务不可用。
   *
   * 覆盖三类原因，且**故意不细分**：key 无效/类型选错（如把「Web端 JS API」
   * 的 key 用在服务端）、配额用尽、网络超时 —— 对用户的处置都是"稍后重试"，
   * 而真正的排查线索（高德的 `info` / `infocode`）已经打进服务端日志。
   * 若将来某类需要用户做不同动作（如"去后台补配额"），再拆不迟。
   */
  MapServiceUnavailable = 50366,
}

/** 错误码 → HTTP 状态 */
export const ERROR_HTTP_STATUS: Record<number, number> = {
  [ErrorCode.Unauthorized]: 401,
  [ErrorCode.TokenExpired]: 401,
  [ErrorCode.TokenInvalid]: 401,
  [ErrorCode.StudentVerificationRequired]: 403,
  [ErrorCode.ProviderVerificationRequired]: 403,
  [ErrorCode.NoPermission]: 403,
  [ErrorCode.PointsNotEnough]: 403,
  [ErrorCode.DailyQuotaExceeded]: 403,
  [ErrorCode.CopyrightAckRequired]: 403,
  [ErrorCode.AccountFrozen]: 403,
  [ErrorCode.ParamInvalid]: 400,
  [ErrorCode.FileTooLarge]: 400,
  [ErrorCode.FileFormatUnsupported]: 400,
  [ErrorCode.FileCorrupted]: 400,
  [ErrorCode.ContentViolation]: 400,
  [ErrorCode.ThinkInjectionDetected]: 400,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.DuplicateOperation]: 409,
  [ErrorCode.OrderStatusConflict]: 409,
  [ErrorCode.TaskAlreadyAssigned]: 409,
  [ErrorCode.IllegalStateTransition]: 409,
  [ErrorCode.TooManyRequests]: 429,
  [ErrorCode.ConcurrentRunLimit]: 429,
  [ErrorCode.InternalError]: 500,
  [ErrorCode.ToolExecutionFailed]: 500,
  [ErrorCode.JobTimeout]: 500,
  [ErrorCode.AiOutputInvalid]: 500,
  [ErrorCode.LlmUnavailable]: 503,
  [ErrorCode.QueueBusy]: 503,
  [ErrorCode.ConvertServiceUnavailable]: 503,
  [ErrorCode.StorageUnavailable]: 503,
  [ErrorCode.ModerationUnavailable]: 503,
  [ErrorCode.SmsUnavailable]: 503,
  [ErrorCode.MapServiceUnavailable]: 503,
};

/**
 * 错误码 → 用户文案（文档附录 B.3：必须说清"发生了什么 + 下一步能做什么"）
 * 支持 {n} / {list} / {t} 占位符，由调用方传入 detail 替换。
 */
export const ERROR_MESSAGES: Record<number, string> = {
  [ErrorCode.Unauthorized]: '请先登录后再操作',
  [ErrorCode.TokenExpired]: '登录已过期，请重新登录',
  [ErrorCode.TokenInvalid]: '登录状态无效，请重新登录',
  [ErrorCode.StudentVerificationRequired]: '完成学生认证即可发布需求',
  [ErrorCode.ProviderVerificationRequired]: '完成服务者认证即可接单',
  [ErrorCode.NoPermission]: '你没有权限查看该内容',
  [ErrorCode.PointsNotEnough]: '积分不足（还差 {n} 分），去完成任务或充值',
  [ErrorCode.DailyQuotaExceeded]: '今日该工具使用次数已达上限，明天再来',
  [ErrorCode.CopyrightAckRequired]: '请先确认你拥有该内容的版权或合法授权',
  [ErrorCode.AccountFrozen]: '账号已被限制，请联系客服',
  [ErrorCode.ParamInvalid]: '请检查填写的内容',
  [ErrorCode.FileTooLarge]: '文件超过 {n}MB，请压缩后再试',
  [ErrorCode.FileFormatUnsupported]: '暂不支持该格式，支持：{list}',
  [ErrorCode.FileCorrupted]: '文件无法读取，请检查后重新上传',
  [ErrorCode.ContentViolation]: '内容未通过安全审核，请修改后重试',
  [ErrorCode.ThinkInjectionDetected]: '输入包含不安全内容，请修改后重试',
  [ErrorCode.NotFound]: '内容不存在或已被删除',
  [ErrorCode.DuplicateOperation]: '该操作已完成，无需重复提交',
  [ErrorCode.OrderStatusConflict]: '当前订单状态不支持该操作',
  [ErrorCode.TaskAlreadyAssigned]: '该任务已被选定服务者',
  [ErrorCode.IllegalStateTransition]: '当前状态不允许该操作',
  [ErrorCode.TooManyRequests]: '操作太频繁，请稍后再试',
  [ErrorCode.ConcurrentRunLimit]: '同时进行的任务过多，请等待其中一个完成',
  [ErrorCode.InternalError]: '服务开小差了，请稍后重试',
  [ErrorCode.ToolExecutionFailed]: '处理失败，积分已原路退回，可重试或转人工',
  [ErrorCode.JobTimeout]: '任务超时，积分已退回，可重试',
  [ErrorCode.AiOutputInvalid]: 'AI 输出格式异常，已自动重试，请稍后再试',
  [ErrorCode.LlmUnavailable]: 'AI 服务繁忙，请稍后重试或换一种说法',
  [ErrorCode.QueueBusy]: '当前排队 {n} 人，预计 {t} 分钟，完成后将通知你',
  [ErrorCode.ConvertServiceUnavailable]: '转换服务暂时不可用，请稍后重试',
  [ErrorCode.StorageUnavailable]: '文件服务暂时不可用，请稍后重试',
  [ErrorCode.ModerationUnavailable]: '内容审核暂时不可用，请稍后重试',
  [ErrorCode.SmsUnavailable]: '短信服务暂时不可用，请稍后重试',
  [ErrorCode.MapServiceUnavailable]: '地图服务暂时不可用，请稍后重试',
};

/**
 * 用 detail 替换文案占位符。
 *
 * ⚠️ 没传 detail 时，占位符必须被替换成**空串**，不能原样返回模板 ——
 * 否则调用方漏传 detail（例如 `new BizException(ErrorCode.PointsNotEnough)`）
 * 就会把「积分不足（还差 {n} 分）」原封不动弹给用户。
 * 写用例时发现的：原实现里 `if (!detail) return tpl;` 正是这个效果。
 */
export function renderErrorMessage(code: number, detail?: Record<string, unknown>): string {
  const tpl = ERROR_MESSAGES[code] ?? '操作失败，请稍后重试';
  return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = detail?.[key];
    return v === undefined || v === null ? '' : String(v);
  });
}
