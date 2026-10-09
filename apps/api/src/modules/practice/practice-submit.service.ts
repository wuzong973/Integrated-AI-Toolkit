import { Inject, Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  SPEAK_PASS_SCORE,
  WRITE_MIN_WORDS,
  countWords,
  gradeFromOutcome,
  judgeSentence,
  scoreSpoken,
  type Grade,
  type PracticeSubmitDto,
  type Providers,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { PROVIDERS } from '../../infra/providers/providers.module';

import { EssayGraderService } from './essay-grader.service';
import type { PracticeSubmitResult } from './dto/practice.dto';
import { PracticePersistService, gradeOfEssay } from './practice-persist.service';
import { PracticeQueueService } from './practice-queue.service';
import { notFound, requireSpeakableUpload } from './practice-input';

/**
 * 判卷（练习中心的核心写路径）
 *
 * ## 三条与词汇模块共享的纪律
 *
 * ① **对错由服务端算**，不采信客户端 —— 抓包改一个 `pass: true` 就能把 SM-2
 *    的调度刷成任意形状。口语的 `score` 同理：客户端只传**音频**，
 *    转写与打分都在服务端做（打分依赖 ASR 的输出）。
 *
 * ② **`modeLock` 用当天锁**，见 `practice-persist.service.ts`。
 *
 * ③ **一次作答落三样东西且必须同事务** —— 已抽到 `PracticePersistService`。
 *
 * ## 与词汇模块的**关键差别**：这里多写一张 `attempt` 表
 *
 * 词汇只有"进度 + 日志"，因为单词卡片的作答没有回看价值（错了就再来一遍）。
 * 而练习中心的**作文**必须能回看原文与批改 —— 那是用户花 20 分钟写的东西，
 * 只存一个分数等于把他写的内容丢了。所以 `attempt.submitted` 存全文。
 *
 * ## 门槛三档（刻意不同）
 *
 *   · `chunks` / `recall` / `listen` —— **全对才算过**（`judgeSentence`）；
 *   · `speak` —— **≥60%**（`SPEAK_PASS_SCORE`）；
 *   · `write` —— **写够词数就算完成**，不设"过/不过"（作文没有客观及格线，
 *     硬判会让"写了 400 词但跑题"与"写了 120 词很扎实"得到同一个结论）。
 */
@Injectable()
export class PracticeSubmitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PracticeQueueService,
    private readonly grader: EssayGraderService,
    private readonly persist: PracticePersistService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  async submit(userId: string, dto: PracticeSubmitDto): Promise<PracticeSubmitResult> {
    if (dto.module === 'write') return this.submitEssay(userId, dto);
    if (dto.module === 'speak') return this.submitSpeak(userId, dto);
    return this.submitSentence(userId, dto);
  }

  /* ==================== 句子：连词成句 / 中译英 / 听写 ==================== */

  /**
   * 句子题。
   *
   * ⚠️ **客户端不传模式**，服务端也**不去区分**这三种模式：它们的判卷规则
   * 完全一样（全对才算过），差别只在"题面怎么给"。锁到具体模式由 `modeLock` 负责，
   * 它取自上一次下发的题面 —— 而不是这次提交时声称自己是什么模式
   * （"声称"等于给了一个可篡改且无意义的入口）。
   */
  private async submitSentence(
    userId: string,
    dto: PracticeSubmitDto,
  ): Promise<PracticeSubmitResult> {
    const row = await this.prisma.practiceSentence.findUnique({
      where: { id: dto.refId },
      select: { id: true, en: true, zh: true },
    });
    if (!row) throw notFound('句子');

    const verdict = judgeSentence(row.en, dto.text ?? '');
    const saved = await this.persist.write({
      userId,
      module: 'sentence',
      kind: 'sentence',
      refId: row.id,
      mode: 'chunks',
      pass: verdict.correct,
      score: verdict.score,
      submitted: dto.text ?? '',
      elapsedMs: dto.elapsedMs,
      grade: sentenceGrade(verdict.correct, verdict.score),
      detail: { words: verdict.detail },
    });

    return {
      module: 'sentence',
      mode: 'chunks',
      pass: verdict.correct,
      score: verdict.score,
      words: verdict.detail.map((d) => ({ word: d.word, ok: d.ok })),
      target: row.en,
      reference: row.zh,
      transcript: null,
      // 差多少分才满分 → 界面显示"再对 2 个词就全对了"
      needScore: Math.max(0, 100 - verdict.score),
      write: null,
      schedule: toSchedule(saved),
      today: await this.queue.dayStat(userId),
    };
  }

  /* ==================== 口语：录音 → ASR → 词级对齐 ==================== */

  /**
   * 口语跟读。
   *
   * ## 为什么要**转写 + 对齐**而不是"让模型听音频给个分"
   *
   * 让 LLM 听音频打分的方案有两个硬伤：① 分数不可复现（同一个音频两次不同分），
   * 而 SM-2 会按这个分数排复习，抖动会直接污染调度；② 用户看不到"哪个词没读对"，
   * 只能反复重读全句。词级对齐两者都解决了：分数确定，且能精确指出
   * "management 漏了、the 读成了 a"。
   *
   * ## 没识别到内容 ≠ 报错
   *
   * `scoreSpoken(target, '')` 返回 0 分并**如实落库**（fail），而不是抛 500。
   * 抛错会让"用户按了录音但没出声"看起来像后端故障，而它其实是一次正常的失败作答。
   *
   * ## ⚠️ ASR 失败（网络 / 额度）与"没听清"必须分开
   *
   * ASR 抛 `BizException` 时**向上抛，不落库** —— 用户没有任何过错，
   * 把它记成一次"错"会让复习计划冤枉地后退（EF 下降、间隔归 1）。
   * 只有"ASR 成功但内容为空"才是真正的"没说 / 没说清"。
   */
  private async submitSpeak(
    userId: string,
    dto: PracticeSubmitDto,
  ): Promise<PracticeSubmitResult> {
    // ⚠️ 先查库再校验（顺序不能反）：`speakable` 是库里的字段，
    // 不知道目标句就没法判"这句话该不该朗读"。
    // 这也是**唯一**先查后校验的入口 —— 另外两个模块的入参是自足的
    const target = await this.prisma.practiceSentence.findUnique({
      where: { id: dto.refId },
      select: { id: true, en: true, zh: true, speakable: true },
    });
    const input = requireSpeakableUpload(dto, target);

    const { text: transcript } = await this.providers.audio.speechToText(input.audio, {
      // 跟读的目标句是英文，**显式指定语言而不是自动识别** ——
      // 自动识别在中英混读时会把英文句识别成中文谐音，分数会莫名其妙地低
      language: 'en',
    });

    const verdict = scoreSpoken(input.row.en, transcript);
    const saved = await this.persist.write({
      userId,
      module: 'speak',
      kind: 'sentence',
      refId: input.row.id,
      mode: 'speak',
      pass: verdict.passed,
      score: verdict.score,
      submitted: transcript,
      elapsedMs: dto.elapsedMs,
      grade: speakGrade(verdict.passed, verdict.score),
      detail: { words: verdict.detail, transcript },
    });

    return {
      module: 'speak',
      mode: 'speak',
      pass: verdict.passed,
      score: verdict.score,
      words: verdict.detail.map((d) => ({ word: d.word, ok: d.ok })),
      target: input.row.en,
      reference: input.row.zh,
      transcript,
      // 差多少分 → 界面显示"再对 2 个词就过了"。比一个"没过"有用得多
      needScore: Math.max(0, SPEAK_PASS_SCORE - verdict.score),
      write: null,
      schedule: toSchedule(saved),
      today: await this.queue.dayStat(userId),
    };
  }

  /* ==================== 作文 ==================== */

  /**
   * 作文提交与批改。
   *
   * ## 太短时**仍然落库**，只是不批改
   *
   * 若"太短"就整条丢掉，用户写了 70 词点了提交、界面报"太短"、
   * 然后刷新一看什么都没有 —— 那 70 词白写了。所以照存，
   * 回一个 `tooShort: true` 的批改结果（含词数与下限），让用户能接着写完再交。
   *
   * ## 不设"及格线"
   *
   * `pass` 的含义是"这篇算完成了一次练习"，不是"这篇写得好"。见文件头。
   *
   * ## 批改失败不阻断提交
   *
   * `EssayGraderService.grade` 内部已降级（返回 0 分 + 说明），所以这里
   * 不需要 try/catch —— 但它**必须留日志**，否则"作文分数一直是 0"
   * 看起来会像"用户写得差"。
   */
  private async submitEssay(
    userId: string,
    dto: PracticeSubmitDto,
  ): Promise<PracticeSubmitResult> {
    const text = (dto.text ?? '').trim();
    if (!text) {
      throw new BizException(ErrorCode.ParamInvalid, undefined, '作文内容为空，写点什么再交吧');
    }
    const topic = await this.prisma.practiceTopic.findUnique({ where: { id: dto.refId } });
    if (!topic) throw notFound('作文题目');

    const wordCount = countWords(text);
    const minWords = topic.minWords || WRITE_MIN_WORDS;
    const tooShort = wordCount < minWords;
    const review = tooShort
      ? shortReview(wordCount, minWords)
      : await this.grader.grade({
          title: topic.title,
          outline: asOutline(topic.outline),
          text,
        });

    const saved = await this.persist.write({
      userId,
      module: 'write',
      kind: 'topic',
      refId: topic.id,
      mode: 'write',
      pass: !tooShort,
      score: review.total,
      submitted: text,
      elapsedMs: dto.elapsedMs,
      grade: gradeOfEssay(review.total),
      detail: { wordCount, dimensions: review.dimensions, comments: review.comments },
    });

    return {
      module: 'write',
      mode: 'write',
      pass: !tooShort,
      score: review.total,
      words: null,
      target: null,
      reference: topic.zhBrief,
      transcript: null,
      needScore: 0,
      write: {
        total: review.total,
        dimensions: review.dimensions,
        comments: review.comments,
        suggestions: review.suggestions,
        // 范文是**可空列**（有些题目就是不给范文）。声明为 `string` 而不是
        // `string | null` 是刻意的：界面在同一个位置渲染它，多一路 null 分支
        // 只会多一种"这里该显示什么"的猜测。空串由界面显示"这道题没给范文"
        sample: topic.sample ?? '',
        wordCount,
        tooShort,
      },
      schedule: toSchedule(saved),
      today: await this.queue.dayStat(userId),
    };
  }
}

/* ==================== 门槛映射（三档，刻意不同） ==================== */

/**
 * 句子题"接近对"的门槛：80% 词命中给 `vague`（比"完全不会"高），
 * 但**不给通过** —— 拼写与翻译没有客观噪声，错一个词就是错。
 */
const SENTENCE_NEAR_MISS = 80;

/** 口语"部分正确"的门槛（低于过关线但明显努力过） */
const SPEAK_PARTIAL = 30;

function sentenceGrade(correct: boolean, score: number): Grade {
  if (correct) return gradeFromOutcome('right');
  if (score >= SENTENCE_NEAR_MISS) return gradeFromOutcome('vague');
  return gradeFromOutcome('wrong');
}

function speakGrade(passed: boolean, score: number): Grade {
  if (passed) return gradeFromOutcome('right');
  if (score >= SPEAK_PARTIAL) return gradeFromOutcome('vague');
  return gradeFromOutcome('wrong');
}

/** 太短时的批改结果（**不调 LLM** —— 词数不够时批改没意义，还会白花一次额度） */
function shortReview(wordCount: number, minWords: number) {
  return {
    total: 0,
    dimensions: [],
    comments: [`这篇只有 ${wordCount} 词，还没到 ${minWords} 词的下限，先写完再看批改。`],
    suggestions: [],
  };
}

/** 把 `practice_topic.outline` 的 Json 收窄成 `string[]` */
function asOutline(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && Boolean(x.trim()));
}

function toSchedule(saved: { intervalDays: number; dueAt: Date; state: string }) {
  return {
    intervalDays: saved.intervalDays,
    dueDate: saved.dueAt.toISOString(),
    state: saved.state,
  };
}
