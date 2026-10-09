import { Inject, Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  type PracticeAudioQueryDto,
  type Providers,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { RedisService } from '../../infra/redis/redis.service';

/**
 * 句子朗读音频（听写模式与口语跟读的"范读"）
 *
 * ## 与 `VocabAudioService` 是**同一套做法**，但有两点差别
 *
 * ① **语速标注在缓存键里**（`speed`）—— 听写模式需要"先慢速再正常"，
 *    这是句乐部"盲听 → 慢听 → 字幕"三阶段的落点。
 *    缓存键**必须含语速**：同一句话的慢速版与常速版是两段不同的音频，
 *    只按 (音色, 句子) 缓存会让第二次请求拿到上一次语速的音频，
 *    而这是**静默的**（音频能播，只是语速不对）。
 *
 * ⚠️ 上游 `AudioProvider.textToSpeech(text, voice?)` **只接受音色、不接受语速**，
 * 所以 `speed` 目前只用于**分桶缓存**（0.8 与 1.0 是两条缓存），
 * 实际合成仍是常速。这不是缺陷而是接口现状 —— 要让语速真正生效需要
 * 媒体侧车的 FFmpeg `atempo` 滤镜（切分/变速的能力本就在那边）。
 * 之所以还是把 `speed` 一路传到这儿：界面迟早要这个开关，
 * 而"传下来但没有缓存隔离"会让用户听到串味的音频，比暂时不生效更难查。
 *
 * ## 为什么也返回 base64
 *
 * 理由与 `VocabAudioService` 完全相同（全局 `TransformInterceptor` 会把
 * 二进制流序列化成乱码），这里不再重复论证。
 *
 * ## 为什么**不**预生成全部 2 万条句子
 *
 * 2 万条 × 约 30KB ≈ 600MB，且绝大多数句子永远没人听。按需合成 + Redis 缓存
 * 是正确取舍：热门句子命中缓存，冷门句子付一次合成成本。
 */
@Injectable()
export class PracticeAudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  async speak(
    sentenceId: string,
    query: PracticeAudioQueryDto,
  ): Promise<{ audio: string; format: string; cached: boolean }> {
    const row = await this.prisma.practiceSentence.findUnique({
      where: { id: sentenceId },
      select: { en: true },
    });
    if (!row) {
      throw new BizException(ErrorCode.NotFound, { sentenceId }, '这句话不存在，请刷新练习列表');
    }

    const voice = query.voice ?? DEFAULT_VOICE;
    // schema 已经夹过范围，这里再归一化一次是为"将来有人绕过 DTO 直接调服务"兜底
    const speed = normalizeSpeed(query.speed);
    // 缓存键**不含 userId**：同一句话同一音色同一语速对所有人都是同一段字节
    const key = `prac:tts:${voice}:${speed}:${hash(row.en)}`;

    const hit = await this.redis.getJson<string>(key);
    if (hit) return { audio: hit, format: 'mp3', cached: true };

    // ⚠️ 句子里可能有 `&` / `<` 这类字符，直接塞进 SSML 会让合成失败或吞字。
    //    这里不做 SSML 包裹（`audio.textToSpeech` 的实现自己决定怎么发），
    //    但把换行压平 —— 换行会让部分 TTS 引擎读出奇怪的停顿。
    const text = row.en.replace(/\s+/g, ' ').trim();
    const buf = await this.providers.audio.textToSpeech(text, voice);
    const audio = buf.toString('base64');

    // Redis 不可用时 `setJson` 返回 false（见 RedisService 的降级纪律）：
    // 每次都重新合成，慢但正确。所以这里不看返回值
    await this.redis.setJson(key, audio, TTS_TTL_SECONDS);
    return { audio, format: 'mp3', cached: false };
  }
}

/**
 * 默认音色。
 *
 * ⚠️ 不复用 `VOCAB_DEFAULT_VOICE`：那是**单词发音**选的音色（偏清晰的单音），
 * 而句子朗读希望是自然的连读语调，两者将来可能分叉。现在恰好同名也只是巧合，
 * 绑在一起会让"改句子音色"变成"改单词音色"，而那是两个产品决策。
 */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 音频缓存 30 天（句子内容不会变，缓存可以很长；30 天足够覆盖复习周期） */
const TTS_TTL_SECONDS = 30 * 24 * 3600;

/**
 * 语速归一化。
 *
 * ⚠️ 上游只认 0.5~2.0；超出范围有些引擎会**静默用默认语速**（音频能播、
 * 但不慢），用户点"慢速"发现没变会以为按钮坏了。所以这里显式夹紧。
 *
 * 默认 1.0 而不是 0.8：范读的第一遍应该是正常语速。
 */
function normalizeSpeed(v?: number): number {
  const n = Number(v ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(n * 10) / 10));
}

/**
 * 原文 → 缓存键的可读摘要。
 *
 * 用 djb2 而不是 `encodeURIComponent(text)`：后者会把整句塞进 Redis 的 key，
 * 中文句子经 percent-encoding 后能到几百字节 —— 既浪费内存又难排查。
 * 哈希碰撞的概率在这里可忽略（同一用户的同一句话，撞了最坏是听错语速，
 * 且句子 id 已经在调用链上游保证了正确性）。
 */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
