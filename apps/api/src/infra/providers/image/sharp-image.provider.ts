import sharp from 'sharp';
import {
  BizException,
  ErrorCode,
  type ImageCompressInput,
  type ImageConvertInput,
  type ImageProvider,
} from '@qz/core';

/**
 * 图片处理真实实现（基于 Sharp，Apache-2.0，纯 CPU，零成本）
 *
 * 覆盖：压缩 / 格式转换 / 增强
 * 说明：抠图（removeBackground）、修复（inpaint）需要专用模型，由 services/ai 提供。
 *
 * ## 三处曾经的"成功但结果不对"（都已修）
 *
 * 这三个问题有共同形态：**接口正常返回、作业显示成功、用户拿到的却是错的东西**，
 * 所以它们在日志里完全查不出来。对应措施写在各方法上。
 */
export class SharpImageProvider implements ImageProvider {
  readonly name = 'sharp-image';

  /**
   * 压缩。
   *
   * ## 两个修正
   *
   * ① **按目标体积迭代时，最终结果必须校验是否达标**。
   *    以前循环结束就直接返回，压不到目标也说成功 —— 用户拿到一张比要求大的图，
   *    却没有任何迹象表明"目标没达成"。现在返回 `targetMet`，由调用方如实告知。
   *
   * ② **先按 EXIF 方向旋转**（`rotate()` 不带参数即"跟随 EXIF"）。
   *    Sharp 默认**不**读 EXIF 方向，于是手机竖拍的照片会横过来 ——
   *    而用户是在手机上拍完直接上传的，这是最常见的一类输入。
   */
  async compress(input: ImageCompressInput): Promise<{
    buffer: Buffer;
    ratio: number;
    targetMet: boolean;
  }> {
    const original = input.buffer.length;
    const format = input.format ?? 'jpeg';
    const target = input.targetSizeBytes;

    // 已经小于目标体积时**原样返回**：再压一次只会更大（重编码必产生额外损耗），
    // 而"目标已达成"却交付一个更大的文件，是典型的"成功但结果更差"。
    if (target && target > 0 && original <= target) {
      return { buffer: input.buffer, ratio: 1, targetMet: true };
    }

    if (target && target > 0) {
      const out = await compressToTarget(input.buffer, format, target);
      return {
        buffer: out,
        ratio: original === 0 ? 1 : out.length / original,
        targetMet: out.length <= target,
      };
    }

    const quality = clamp(input.quality ?? 80, 1, 100);
    const out = await render(input.buffer, format, quality);
    return { buffer: out, ratio: original === 0 ? 1 : out.length / original, targetMet: true };
  }

  async convert(input: ImageConvertInput): Promise<Buffer> {
    const pipeline = sharp(input.buffer).rotate();
    switch (input.format) {
      case 'png':
        return pipeline.png().toBuffer();
      case 'webp':
        return pipeline.webp({ quality: 85 }).toBuffer();
      case 'jpeg':
      default:
        return pipeline.jpeg({ quality: 88 }).toBuffer();
    }
  }

  async removeBackground(_buffer: Buffer): Promise<Buffer> {
    // 真实实现应由 services/ai（rembg，白名单模型）处理；此处不透传以免产生错误结果
    throw new BizException(
      ErrorCode.LlmUnavailable,
      undefined,
      '抠图能力由 AI 服务提供，请配置 AI_SERVICE_URL 后再试',
    );
  }

  /**
   * 增强：锐化 + 轻微提饱和。
   *
   * ## 为什么签名里**没有**放大倍数
   *
   * 契约曾经是 `enhance(buffer, scale: 2 | 4)`，但两个实现都不做超分：
   * Sharp 直接忽略该参数，Sidecar 用 `_scale` 显式忽略。结果是
   * 「图片增强」对外承诺 2x/4x 超分，实际只做锐化 —— 用户以为能放大，拿到的还是原尺寸。
   *
   * 这是"能力名与实现不符"，比"效果一般"更严重：它让用户按错误预期使用产物。
   * 现在把承诺收回到真实能力范围：`strength` 真正控制**锐化强度**，
   * 契约里不再保留做不到的参数。等超分模型真正部署后再单开能力，
   * 而不是继续挂着一个空参数冒充它。
   */
  async enhance(buffer: Buffer, strength = 50): Promise<Buffer> {
    const amount = clamp(strength, 0, 100);
    const pipeline = sharp(buffer).rotate();
    if (amount <= 0) return pipeline.toBuffer();

    // sigma 上限压到 2.5：超过这个值锐化会出明显光晕，反而更难看
    const sigma = (amount / 100) * 2.5;
    // 饱和度跟随强度小幅提升（最高 +15%），避免"增强"变成过饱和的塑料感
    const saturation = 1 + (amount / 100) * 0.15;
    return pipeline.sharpen({ sigma }).modulate({ saturation }).toBuffer();
  }

  async inpaint(_buffer: Buffer, _mask: Buffer): Promise<Buffer> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      undefined,
      '图片修复能力由 AI 服务提供，请配置后使用',
    );
  }
}

/**
 * 二分逼近目标体积。
 *
 * 为什么用二分而不是等步长递减：等步长在「目标远小于可达下限」时会耗尽轮次仍不达标，
 * 而二分能在固定轮次内把质量逼到最接近目标的可行值，产出尽可能好的画质。
 *
 * 返回最接近目标的产物（可能仍大于目标 —— 是否达标由调用方按 `targetMet` 判断并如实告知）。
 */
async function compressToTarget(
  input: Buffer,
  format: 'jpeg' | 'png' | 'webp',
  target: number,
): Promise<Buffer> {
  const lowest = 25;
  let lo = lowest;
  let hi = 100;
  let best: Buffer | null = null;

  for (let i = 0; i < 7 && lo <= hi; i++) {
    const quality = Math.round((lo + hi) / 2);
    const out = await render(input, format, quality);
    if (out.length <= target) {
      // 达标：记住更高画质的可行结果，再向上探
      if (!best || out.length > best.length) best = out;
      lo = quality + 1;
    } else {
      hi = quality - 1;
    }
  }

  // 二分未达标时用最低质量尽力而为，并如实标记未达成
  return best ?? render(input, format, lowest);
}

async function render(
  input: Buffer,
  format: 'jpeg' | 'png' | 'webp',
  quality: number,
): Promise<Buffer> {
  // rotate() 放在每一轮里：迭代压缩时每次都要基于"方向已修正"的图重编，
  // 否则第二轮会拿到未旋转的原图，产出方向与第一轮不一致。
  const pipeline = sharp(input).rotate();
  switch (format) {
    case 'png':
      // PNG 走调色板量化才是真压缩（quality 会置 palette=true）。
      // 不加这个，PNG 就是无损重编，压完反而更大。
      return pipeline.png({ quality, palette: true }).toBuffer();
    case 'webp':
      return pipeline.webp({ quality }).toBuffer();
    case 'jpeg':
    default:
      return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}