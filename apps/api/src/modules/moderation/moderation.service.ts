import { Inject, Injectable } from '@nestjs/common';
import { BizException, ErrorCode, type ModerationResult, type Providers } from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PROVIDERS } from '../../infra/providers/providers.module';

/**
 * 送审场景。
 *
 * 取值直接复用 `WechatModerationProvider` 的 `SCENE_VALUES` 语义名，
 * 而不是让业务侧传官方数字（1/2/3/4）—— 数字看不出含义，
 * 写错一个（把「评论」填成「资料」）不会有任何报错，只会让风控维度失真。
 */
export type ModerationScene = 'profile' | 'comment' | 'forum' | 'log';

/** 一次送审的上下文 */
export interface ModerationContext {
  /** 提交内容的用户，用于溯源日志与申诉 */
  userId: string;
  scene: ModerationScene;
  /** 出问题时告诉用户"是哪一段没过"，如「交付说明」 */
  field: string;
  /** 昵称 / 标题：官方建议一并提交，可显著提高广告号识别率 */
  nickname?: string;
  title?: string;
}

/** `assertTexts` 的单个字段 */
export interface ModerationField {
  field: string;
  text?: string | null;
}

/**
 * 内容安全关卡（任务清单 M4-05，红线）。
 *
 * ## 它解决的是什么问题
 *
 * `WechatModerationProvider` 早就写好了（本地词库预检 + 官方 `msgSecCheck`），
 * `MODERATION_DRIVER` 也早就配好了 —— 但**没有任何业务代码调用它**，
 * 于是所有 UGC 写入口实际处于"裸奔"状态：用户改昵称、填交付说明、
 * 写退款理由都不经任何检查。Provider 存在 ≠ 内容被审过。
 *
 * ## 为什么要有这一层，而不是让业务直接调 Provider
 *
 * 三件事必须在**同一个地方**做对，散在每个调用点必然会漏：
 *
 * 1. **fail-closed**：审核依赖挂掉时**拦住内容**，而不是放行。
 *    这是本模块与其它依赖最本质的区别 —— 队列挂了可以放行（它只是优化），
 *    审核挂了放行等于合规事故。所以这里把 Provider 抛出的任何异常
 *    统一翻译成 `ModerationUnavailable`（50364），**绝不吞掉**。
 * 2. **openid 补齐**：微信 v2 接口必填 openid，而业务 service 手上只有 `userId`。
 *    让每个调用点自己去查一次用户表，一定会有人忘了查 → 线上每次审核都失败。
 * 3. **统一的用户可见文案**：违规（reject）与待复核（review）是两种不同处境，
 *    前者要用户改内容，后者要用户等 —— 报同一个错会让用户白改一遍。
 *
 * ## 调用姿势
 *
 * ```ts
 * await this.moderation.assertText(dto.remark, {
 *   userId, scene: 'comment', field: '交付说明',
 * });
 * ```
 *
 * 只审**文本**。图片走 `checkImage`，它依赖公网 URL（`mediaCheckAsync` 是异步接口），
 * 接入点见 `docs/dev/CONFIG-GAPS.md`。
 */
@Injectable()
export class ModerationService {
  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 审一段文本。通过则静默返回，不通过则抛 `ContentViolation`（40051）。
   *
   * 空内容直接跳过：官方接口对空串返回参数错误，把"用户没填"
   * 报成"审核失败"会让用户一头雾水。
   */
  async assertText(text: string | undefined | null, ctx: ModerationContext): Promise<void> {
    const value = text?.trim();
    if (!value) return;

    const openid = await this.resolveOpenid(ctx.userId);
    const result = await this.check(value, openid, ctx);
    if (!result.pass) this.reject(result, ctx);
  }

  /**
   * 审同一入口的多个字段（如发布需求时的标题 + 描述）。
   *
   * **串行**而不是 `Promise.all`：命中第一个违规就返回，
   * 不必把后面几个字段的官方配额也烧掉。送审是花钱的外部调用，
   * 而"哪一段没过"的顺序对用户来说无关紧要。
   */
  async assertTexts(
    fields: ModerationField[],
    ctx: Omit<ModerationContext, 'field'>,
  ): Promise<void> {
    const pending = fields
      .map((f) => ({ field: f.field, text: f.text?.trim() ?? '' }))
      .filter((f) => f.text.length > 0);
    // 全空时连用户表都不查 —— 纯空表单不该产生任何外部调用
    if (!pending.length) return;

    const openid = await this.resolveOpenid(ctx.userId);
    for (const f of pending) {
      const fieldCtx: ModerationContext = { ...ctx, field: f.field };
      const result = await this.check(f.text, openid, fieldCtx);
      if (!result.pass) this.reject(result, fieldCtx);
    }
  }

  // ---------- 内部实现 ----------

  /**
   * 取送审必需的 openid。
   *
   * 查不到就抛错而不是返回空串：那说明调用方传了个不存在的 `userId`，
   * 属于**服务端缺陷**。这种情况既不能当作"审过了"放行，
   * 也不该报成"你填的内容有问题"让用户去改一段本来没问题的文案。
   */
  private async resolveOpenid(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { openid: true },
    });
    if (user?.openid) return user.openid;

    throw new BizException(
      ErrorCode.ModerationUnavailable,
      { userId },
      '内容审核缺少用户标识，内容未被放行，请联系客服',
    );
  }

  /**
   * 调用 Provider，并把**任何**异常统一翻译成 fail-closed 的 50364。
   *
   * `BizException` 原样透传：Provider 已经分好了类（缺 openid 是 40001、
   * 接口报错是 50364），在这里再包一层只会把有用信息盖掉。
   */
  private async check(
    text: string,
    openid: string,
    ctx: ModerationContext,
  ): Promise<ModerationResult> {
    try {
      return await this.providers.moderation.checkText(text, {
        scene: ctx.scene,
        openid,
        nickname: ctx.nickname,
        title: ctx.title,
      });
    } catch (e) {
      if (e instanceof BizException) throw e;

      // 走到这里说明 Provider 抛了未预期的异常（网络中断、实现缺陷）。
      // 必须拦住内容：放行一条违规内容的代价远大于让用户重试一次。
      this.logger.error(
        `内容审核调用异常（scene=${ctx.scene} field=${ctx.field}）：${(e as Error)?.message}`,
        'ModerationService',
      );
      throw new BizException(
        ErrorCode.ModerationUnavailable,
        { scene: ctx.scene, field: ctx.field },
        '内容审核暂时不可用，内容未被放行，请稍后重试',
      );
    }
  }

  /**
   * 判定不通过时抛出用户可见错误。
   *
   * `reject` 与 `review` 必须给**不同**的文案：
   *   · reject —— 内容确实违规，用户改内容就能过；
   *   · review —— 内容待人工复核，用户改多少遍都一样，只能等。
   * 两者报同一句"请修改后重试"，第二种情况的用户会反复改到放弃。
   */
  private reject(result: ModerationResult, ctx: ModerationContext): never {
    this.logger.warn(
      `内容未通过：user=${ctx.userId} scene=${ctx.scene} field=${ctx.field} ` +
        `action=${result.action ?? 'reject'} labels=${result.labels?.join(',') ?? '-'} ` +
        `reason=${result.reason ?? '-'}`,
      'ModerationService',
    );

    const label = `「${ctx.field}」`;
    const message =
      result.action === 'review'
        ? `${label}已提交人工复核，审核通过前暂时无法提交，请稍后再试`
        : `${label}未通过安全审核，请修改后重试`;

    throw new BizException(
      ErrorCode.ContentViolation,
      { field: ctx.field, scene: ctx.scene, labels: result.labels, reason: result.reason },
      message,
    );
  }
}
