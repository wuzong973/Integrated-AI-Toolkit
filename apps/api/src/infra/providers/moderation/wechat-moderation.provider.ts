import {
  BizException,
  ErrorCode,
  describeHits,
  scanLexicon,
  type ModerationProvider,
  type ModerationRequest,
  type ModerationResult,
} from '@qz/core';

import type { AppConfig } from '../../../common/config/configuration';
import type { AppLogger } from '../../../common/logger/logger.service';

import { WechatAccessToken } from './wechat-access-token';

/** 微信内容安全接口基址 */
const WX_API = 'https://api.weixin.qq.com';
const TOKEN_URL = `${WX_API}/cgi-bin/stable_token`;
const TEXT_CHECK_PATH = 'wxa/msg_sec_check';
const IMAGE_CHECK_PATH = 'wxa/media_check_async';

/**
 * `msgSecCheck` 单次正文上限（字符）。超过就**分片**送审，绝不做截断。
 *
 * 截断是个隐蔽的合规漏洞：把超长正文的尾部直接丢掉，等于那段内容从没被审过，
 * 而接口返回的却是 `pass` —— 从日志上看每一条都"审核通过"。
 */
const MAX_CONTENT_CHARS = 2500;

/** 官方建议同时提交昵称，能显著提高对"广告号"的识别率 */
const MAX_NICKNAME_CHARS = 64;
const MAX_TITLE_CHARS = 128;

/** 接口的结论取值 */
type Suggest = 'pass' | 'review' | 'risky';

interface TextCheckResponse {
  errcode?: number;
  errmsg?: string;
  trace_id?: string;
  result?: { suggest?: Suggest; label?: number };
}

interface MediaCheckResponse {
  errcode?: number;
  errmsg?: string;
  trace_id?: string;
}

/** 场景值：1 资料 / 2 评论 / 3 论坛 / 4 社交日志（官方定义） */
const SCENE_VALUES: Record<string, number> = {
  profile: 1,
  comment: 2,
  forum: 3,
  log: 4,
  // 业务侧常用的语义名 → 官方场景值。驿站的任务正文与评论同属「论坛」类
  task: 3,
  service: 3,
  review: 2,
};

/**
 * 内容安全 Provider —— 微信官方接口（M4-05，红线：不得用 LLM 提示词替代）。
 *
 * ## 判定顺序
 *
 * 1. **本地校园词库**（`@qz/core` 的 `CAMPUS_LEXICON` + 运维配置的补充词）
 *    —— 不联网、不花配额、即时返回。命中直接拒。
 * 2. **官方 `msgSecCheck`** —— 唯一的主判据，能识别变体与谐音。
 *
 * 本地词库**放在最前面**，不是为了替代官方接口，而是纯优化：
 * 校园里最常见的灰色广告（代考、刷单）字面高度固定，先用零成本的方式挡掉，
 * 剩下的才花配额。官方接口的调用量因此显著下降，但覆盖面一点没少。
 *
 * ## 图片为什么"审不了就拦"
 *
 * `mediaCheckAsync` 是**异步**接口：它只收公网 URL，返回的也只是一个 `trace_id`，
 * 真正的结论通过消息推送回到开发者服务器。也就是说，
 * **这个接口在任何时刻都不会给出"这张图可以放行"的即时答案**。
 *
 * 所以 `checkImage` 的语义是"已提交审核、结果未到"，返回
 * `pass:false + action:'review'` —— 在结果回来之前内容处于待审状态，不放行。
 * 反过来（返回 pass）会让所有图片直接绕过审核，那才是真正的事故。
 *
 * ## 依赖不可用时 fail-closed
 *
 * 拿不到 token 或接口报错时，抛 `ModerationUnavailable`（50364），
 * **不放行内容**。这是本 Provider 与其它 Provider 最本质的区别：
 * 队列、缓存、限流挂了可以 fail-open（它们是优化）；审核挂了必须 fail-closed，
 * 因为放行一条违规内容的代价是合规事故，而拦住的代价只是用户重试一次。
 */
export class WechatModerationProvider implements ModerationProvider {
  readonly name = 'wechat-moderation';

  private readonly token: WechatAccessToken;

  constructor(
    private readonly cfg: AppConfig['moderation'],
    private readonly logger: AppLogger,
  ) {
    this.token = new WechatAccessToken(
      {
        appid: cfg.appid,
        secret: cfg.secret,
        url: TOKEN_URL,
        refreshAheadSec: cfg.tokenRefreshAheadSec,
        timeoutMs: cfg.timeoutMs,
      },
      logger,
    );
  }

  async checkText(text: string, req?: ModerationRequest): Promise<ModerationResult> {
    const local = this.scanLocal(text);
    if (local) return local;

    const openid = this.requireOpenid(req);
    const chunks = splitByChars(text, MAX_CONTENT_CHARS);

    // 逐片送审，命中 risky 立即返回 —— 不必把剩下的配额也烧完
    for (const chunk of chunks) {
      const result = await this.checkChunk(chunk, openid, req);
      if (!result.pass) return result;
    }
    return { pass: true, action: 'pass' };
  }

  async checkImage(_buffer: Buffer, req?: ModerationRequest): Promise<ModerationResult> {
    this.requireOpenid(req);

    if (!req?.mediaUrl) {
      throw new BizException(
        ErrorCode.ModerationUnavailable,
        { provider: this.name },
        '图片审核需要公网可访问的 URL，请先上传文件取得下载地址后再送审',
      );
    }

    const json = await this.post<MediaCheckResponse>(IMAGE_CHECK_PATH, {
      media_url: req.mediaUrl,
      media_type: 2,
      version: 2,
      scene: this.resolveScene(req.scene),
      openid: req.openid,
    });

    this.logger.log(
      `图片已提交异步审核（traceId=${json.trace_id ?? '?'}），结论将通过消息推送回写`,
      'WechatModerationProvider',
    );

    // 见类注释：异步接口拿不到即时结论，因此**默认不放行**，等推送回写后再改判
    return {
      pass: false,
      action: 'review',
      reason: json.trace_id
        ? `图片审核结果待推送（traceId=${json.trace_id}）`
        : '图片审核结果待推送',
    };
  }

  // ---------- 内部实现 ----------

  /** 本地词库预检。命中则直接返回拒绝结论，不消耗官方接口配额 */
  private scanLocal(text: string): ModerationResult | null {
    const hits = scanLexicon(text, this.cfg.extraWords);
    if (hits.size === 0) return null;

    return {
      pass: false,
      labels: [...hits.keys()],
      action: 'reject',
      reason: `命中本地词库：${describeHits(hits)}`,
    };
  }

  private requireOpenid(req?: ModerationRequest): string {
    if (req?.openid) return req.openid;
    // v2 接口把 openid 列为必填；不带它调用会直接失败。
    // 与其发一个注定失败的请求，不如在这里把原因说清楚。
    throw new BizException(
      ErrorCode.ParamInvalid,
      { provider: this.name },
      '内容审核缺少用户 openid（微信 v2 接口必填）',
    );
  }

  private async checkChunk(
    content: string,
    openid: string,
    req?: ModerationRequest,
  ): Promise<ModerationResult> {
    const json = await this.post<TextCheckResponse>(TEXT_CHECK_PATH, {
      content,
      version: 2,
      scene: this.resolveScene(req?.scene),
      openid,
      nickname: clamp(req?.nickname, MAX_NICKNAME_CHARS),
      title: clamp(req?.title, MAX_TITLE_CHARS),
    });

    const suggest = json.result?.suggest ?? 'review';

    if (suggest === 'pass') return { pass: true, action: 'pass' };
    if (suggest === 'review') {
      return {
        pass: false,
        action: 'review',
        reason: `内容需要人工复核（label=${json.result?.label ?? '?'}）`,
      };
    }
    return {
      pass: false,
      labels: ['wechat-risky'],
      action: 'reject',
      reason: `内容被判定为违规（label=${json.result?.label ?? '?'}）`,
    };
  }

  /**
   * 带"token 失效重取一次"的 POST。
   *
   * 40001 / 42001 是 token 过期或无效 —— 这类失败**与内容无关**，
   * 重取一次 token 就能过。不重试的话，token 到期的那一刻起
   * 所有内容都会审核失败，而用户会以为是自己的文案有问题。
   */
  private async post<T extends { errcode?: number; errmsg?: string }>(
    path: string,
    body: Record<string, unknown>,
    retryOnTokenError = true,
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${WX_API}/${path}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    const json = (await res.json()) as T & { errcode?: number; errmsg?: string };

    if (json.errcode === 0) return json;

    if (retryOnTokenError && (json.errcode === 40001 || json.errcode === 42001)) {
      this.logger.warn(`access_token 已失效（${json.errcode}），重取后重试一次`, 'WechatModerationProvider');
      await this.token.renew();
      return this.post<T>(path, body, false);
    }

    throw new BizException(
      ErrorCode.ModerationUnavailable,
      { provider: this.name, path, errcode: json.errcode, errmsg: json.errmsg },
      `内容审核服务返回错误（${json.errcode ?? '?'}），内容未被放行`,
    );
  }

  private async getToken(): Promise<string> {
    try {
      return await this.token.get();
    } catch (e) {
      throw new BizException(
        ErrorCode.ModerationUnavailable,
        { provider: this.name, reason: (e as Error)?.message },
        '内容审核服务暂时不可用，内容未被放行，请稍后重试',
      );
    }
  }

  private resolveScene(scene?: string): number {
    return SCENE_VALUES[scene ?? ''] ?? this.cfg.scene;
  }
}

/** 按**码点**切分而不是按 UTF-16 单元 —— 后者会把 emoji 与部分汉字切成两半 */
function splitByChars(text: string, size: number): string[] {
  const chars = [...text];
  if (chars.length <= size) return [text];

  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(''));
  }
  return chunks;
}

function clamp(value: string | undefined, max: number): string {
  const text = (value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}
