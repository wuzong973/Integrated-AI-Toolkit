import { Inject, Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  VOCAB_DEFAULT_VOICE,
  type Providers,
  type VocabAudioQueryDto,
} from '@qz/core';

import { AppLogger } from '../../common/logger/logger.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PROVIDERS } from '../../infra/providers/providers.module';
import { RedisService } from '../../infra/redis/redis.service';

import type { VocabAudioResult } from './dto/vocab.dto';

/**
 * 单词发音（记单词的听音能力）
 *
 * ## 为什么不走 `text_to_speech` 工具链路
 *
 * 工具链路要建 job、扣配额、把产物落成"我的文件"——那套流程服务的是
 * "用户提交一个合成任务并拿走产物"。而这里只是**卡片上点一下小喇叭**：
 * 同一个单词一天可能被听十几次，每次建一个 job 会污染任务列表与配额账。
 * 所以直接注入 `providers.audio`，并按 `音色 + 单词` 缓存。
 *
 * ## 为什么返回 base64 而不是二进制流
 *
 * 全局 `TransformInterceptor` 会把**所有**响应包成 `{code,message,data,traceId}`，
 * 二进制流经它会被当对象序列化成一串乱码（项目里没有任何 `StreamableFile` 用法）。
 * 单词音频只有十几 KB，base64 后约 1.4 倍，代价可以接受；
 * 换来的是接口形态与其余接口完全一致，小程序侧统一走 `http.get`。
 *
 * ## 缓存键**不含 userId**
 *
 * 同一个单词同一个音色，对所有人都是**同一段字节**。带上 userId 只会让缓存
 * 命中率除以用户数，而不会有任何隔离收益 —— 音频里不含任何个人信息。
 *
 * Redis 不可用时按 `RedisService` 的降级纪律走：读返回 null、写静默跳过，
 * 于是每次都重新合成（慢，但正确），不会因此报错。
 */
@Injectable()
export class VocabAudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  async speak(wordId: string, query: VocabAudioQueryDto): Promise<VocabAudioResult> {
    const row = await this.prisma.word.findUnique({
      where: { id: wordId },
      select: { spelling: true },
    });
    if (!row) {
      throw new BizException(
        ErrorCode.NotFound,
        { wordId },
        '这个词条不存在，请下拉刷新今日计划',
      );
    }

    const voice = query.voice ?? VOCAB_DEFAULT_VOICE;
    const key = cacheKey(voice, row.spelling);
    const hit = await this.redis.getJson<CachedAudio>(key);
    if (hit?.audioBase64) {
      return { spelling: row.spelling, voice, ...hit, cached: true };
    }

    const buffer = await this.providers.audio.textToSpeech(row.spelling, voice);
    const payload: CachedAudio = {
      format: detectFormat(buffer),
      audioBase64: buffer.toString('base64'),
      provider: this.providers.audio.name,
    };
    // 失败只告警：缓存是加速手段，写不进去不影响本次发音
    const ok = await this.redis.setJson(key, payload, CACHE_TTL_SEC);
    if (!ok) this.logger.warn(`发音缓存写入失败（不影响本次返回）：${key}`, 'VocabAudio');

    return { spelling: row.spelling, voice, ...payload, cached: false };
  }
}

/** 缓存内容（不含 `voice`/`spelling` —— 它们已经在键里，重复存只会占空间） */
interface CachedAudio {
  format: string;
  audioBase64: string;
  provider: string;
}

/** 30 天：单词发音的内容永不变，过期只为回收空间 */
const CACHE_TTL_SEC = 30 * 24 * 60 * 60;

/** 键里的单词统一小写：edge-tts 读 `Apple` 与 `apple` 完全一致，不该占两份缓存 */
function cacheKey(voice: string, spelling: string): string {
  return `vocab:tts:${voice}:${spelling.trim().toLowerCase()}`;
}

/**
 * 按文件头判形态。
 *
 * 真实链路（侧车 edge-tts）产出 mp3，Mock 产出 WAV（见 `mock-media.providers.ts`
 * 的 `toneWav`）—— 客户端要用它决定落盘扩展名，猜错会让 `InnerAudioContext`
 * 打不开文件。所以这里**读实际字节**而不是按 provider 名推断。
 */
function detectFormat(buffer: Buffer): string {
  return buffer.subarray(0, 4).toString('ascii') === 'RIFF' ? 'wav' : 'mp3';
}