import { ErrorCode, type ImageCompressInput, type ImageConvertInput, type ImageProvider } from '@qz/core';

import { SharpImageProvider } from '../image/sharp-image.provider';

import { sniffImage } from './magic';
import type { SidecarClient } from './sidecar.client';

/**
 * 图片 Provider：**本地 Sharp + AI 侧车抠图**的组合。
 *
 * ## 为什么不是"要么全本地、要么全远程"
 *
 * 图片这一族能力的资源需求差异极大：
 *   · 压缩 / 转格式 / 增强 —— 纯 CPU，Sharp 毫秒级完成，**没有任何理由发到网络上**；
 *   · 抠图 —— 需要 rembg 的 ONNX 模型，必须走 `services/ai`。
 *
 * 如果为了抠图把整族都改成远程，压缩一张 200KB 的图也要多一次 HTTP 往返；
 * 如果为了省事让 Sharp 也"假装"能抠图，用户拿到的就是没处理过的原图。
 * 所以这里按能力分流：默认走本地，只有抠图发远程。
 *
 * ## 抠图这条路以前是断的
 *
 * `SharpImageProvider.removeBackground()` 直接抛错（"请配置 AI_SERVICE_URL 后再试"），
 * 而 `AI_SERVICE_URL` 配好了也没用 —— 侧车那边是 501 占位。
 * 现在两端都通了：`services/ai` 的 `/ai/matting` 真实执行 rembg，
 * 本类负责把图片送过去、把透明 PNG 拿回来。
 *
 * ## 缺依赖时不假装成功
 *
 * 侧车未配置 / 未装 rembg 时，`SidecarClient` 会抛出带明确指引的业务异常
 * （"抠图服务未配置" / "请安装依赖"），**不会**退回"返回原图"。
 * 返回原图看起来像成功，实际用户拿到的是一张没有透明背景的普通图片。
 */
export class SidecarImageProvider implements ImageProvider {
  /** 名字里点明组合关系，便于在日志与 /health 里一眼看出抠图走的是侧车 */
  readonly name = 'sharp+ai-sidecar';

  private readonly local = new SharpImageProvider();

  constructor(
    private readonly ai: SidecarClient,
    private readonly model: string,
  ) {}

  compress(input: ImageCompressInput): Promise<{
    buffer: Buffer;
    ratio: number;
    targetMet: boolean;
  }> {
    return this.local.compress(input);
  }

  convert(input: ImageConvertInput): Promise<Buffer> {
    return this.local.convert(input);
  }

  enhance(buffer: Buffer, strength = 50): Promise<Buffer> {
    // 超分需要 GPU，Sharp 的 sharpen + 提饱和是当前能做到的真实上限。
    // 契约里已不含放大倍数（见 ImageProvider.enhance 注释），
    // 因此这里只把"锐化强度"透传下去，不再接收一个做不到的参数。
    return this.local.enhance(buffer, strength);
  }

  inpaint(buffer: Buffer, _mask: Buffer): Promise<Buffer> {
    return this.local.inpaint(buffer, _mask);
  }

  async removeBackground(buffer: Buffer): Promise<Buffer> {
    const type = sniffImage(buffer);
    const result = await this.ai.binary(
      '/ai/matting',
      { filename: `input.${type.ext}`, contentType: type.contentType, data: buffer },
      { model: this.model },
      { errorCode: ErrorCode.LlmUnavailable, capability: '图片抠图' },
    );
    return result.buffer;
  }
}
