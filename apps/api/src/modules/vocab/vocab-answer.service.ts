import { Injectable } from '@nestjs/common';
import {
  BizException,
  ErrorCode,
  INITIAL_SRS_STATE,
  bizDayDate,
  gradeFromOutcome,
  review,
  type Grade,
  type VocabAnswerDto,
} from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type { VocabAnswerResult, VocabQuestionType } from './dto/vocab.dto';
import { VocabBookService } from './vocab-book.service';
import { VocabQuizService } from './vocab-quiz';
import { judge, type Question } from './vocab-question';
import { WORD_SELECT, toWordDetail, type WordRow } from './vocab-word';

/**
 * 判卷与落库（记单词的核心写路径）
 *
 * ## 对错由**服务端**判定，不采信客户端
 *
 * 客户端只提交选项 key 或用户输入。正确答案是服务端按 `vocab-question.ts` 的
 * 确定性算法重算出来的 —— 与出题时是同一份算法、同一份数据，所以必然相同。
 *
 * ## `repetitions` 必须用**写库前**的值来出题
 *
 * 题型由 `(词 id, repetitions)` 决定（见 `vocab-question.ts` 的"轮换"）。
 * 所以这里先读出 `existing`、用它的 `repetitions` 调 `buildOne`，
 * **之后**才写库。顺序反了就会"出题时是看词选义、判卷时按拼写题算"，
 * 而这是静默的：只是答案对不上，没有任何报错。
 *
 * ## 一次作答要落三样东西，且必须在同一事务里
 *
 *   ① `user_word_progress` —— SM-2 调度结果（EF / 间隔 / 连续次数 / 到期日 / 成熟度）
 *   ② `word_study_log`      —— 当天的打卡计数（日历的唯一数据源）
 *   ③ 两者的计数必须能对上：`progress.correctCount` 与 `log.correctCount` 是
 *      同一个事实的两种视角。分开写就会出现"学了 10 个、日志记了 8 个"，
 *      而这种差异**不会报错**，只会让日历与统计页互相矛盾。
 *
 * ## 评分映射走 `@qz/core` 的 `gradeFromOutcome`
 *
 * 不在页面或这里写死 `5 / 3 / 1`：映射一改，SM-2 的节奏就变，
 * 而"同一个动作在不同入口给出不同评分"是最难发现的一类不一致。
 *
 * ## 四类反馈对应用户的四种真实状态
 *
 *   · 四选一答对 `right`      → 3（通过线）
 *   · 拼写**只差一点** `vague` → 3（过了通过线，但间隔涨得慢）
 *   · 拼错了 / 选错了 `wrong`  → 1（回炉，明天见）
 *   · 完全没写出来 `unknown`   → 1（与 wrong 同分，但语义不同，留给以后做区分）
 */
@Injectable()
export class VocabAnswerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly books: VocabBookService,
    private readonly quiz: VocabQuizService,
  ) {}

  async answer(userId: string, dto: VocabAnswerDto): Promise<VocabAnswerResult> {
    const row = await this.prisma.word.findUnique({ where: { id: dto.wordId }, select: WORD_SELECT });
    if (!row) {
      throw new BizException(
        ErrorCode.NotFound,
        { wordId: dto.wordId },
        '这个词条不存在，请下拉刷新今日计划',
      );
    }

    // ⚠️ 顺序关键：先读进度（拿 repetitions）→ 再定题型 → 再出题 → 最后写库。
    //    题型走 `resolveType`（带当天锁，见 `vocab-quiz.ts` 文件头"同一轮里必须锁住"），
    //    绝不能在这里现算 —— 现算会让"改正重答"被换题。
    const existing = await this.prisma.userWordProgress.findUnique({
      where: { userId_wordId: { userId, wordId: row.id } },
    });
    const type = await this.quiz.resolveType(row as WordRow, userId);
    const question = await this.quiz.buildOne(row as WordRow, { type });
    if (!question) {
      // 词条缺释义 / 词库太小凑不出选项。**不能悄悄判对或判错**：
      // 那会污染复习计划，用户以后还会"复习"这个根本没法答的词
      throw new BizException(
        ErrorCode.ParamInvalid,
        { wordId: dto.wordId },
        '这个词条的内容还不完整，本题无法作答，跳过它继续吧',
      );
    }

    const submitted = pickSubmitted(dto, question);
    const verdict = judge(question, submitted);
    const grade = gradeOf(verdict.correct, verdict.nearMiss);
    const saved = await this.persist(userId, row as WordRow, verdict.correct, grade, type, Boolean(existing));
    const [today, active] = await Promise.all([this.dayLog(userId), this.books.activeBook(userId)]);

    return {
      correct: verdict.correct,
      type: question.type,
      answerKey: question.answerKey,
      answerText: question.answer,
      submitted,
      nearMiss: verdict.nearMiss,
      word: toWordDetail(row as WordRow),
      schedule: {
        intervalDays: saved.intervalDays,
        dueDate: saved.dueAt.toISOString(),
        state: saved.state,
      },
      today,
      remaining: {
        newLeft: Math.max(0, (active?.dailyNew ?? 0) - today.newCount),
        reviewLeft: Math.max(0, (active?.dailyReview ?? 0) - today.reviewCount),
      },
    };
  }

  /**
   * 事务：进度 + 当天日志一起成功或一起失败（见文件头 ③）
   *
   * `hadProgress` 由调用方传（它在读 `existing` 时已经知道了）——
   * 在这里再查一次不仅多一次往返，更要紧的是"读"与"写"之间多了一个窗口。
   *
   * `type` 是**本题的题型**：新词首次作答时要把当天锁一并写进去，
   * 否则下一次作答会因为"库里没锁"而重新抽取，题型当场变化（见 `vocab-quiz.ts`）。
   */
  private async persist(
    userId: string,
    row: WordRow,
    correct: boolean,
    grade: Grade,
    type: VocabQuestionType,
    hadProgress: boolean,
  ) {
    const now = new Date();
    // ⚠️ 必须用 bizDayDate 而不是 bizDayStart：`day` 是 @db.Date 列，
    // 详见 `@qz/core` 里 bizDayDate 的说明（用错会让打卡日历整体错一天，且不报错）
    const day = bizDayDate(now);

    const existing = hadProgress
      ? await this.prisma.userWordProgress.findUnique({
          where: { userId_wordId: { userId, wordId: row.id } },
        })
      : null;
    const isNew = !existing;
    const current = existing
      ? {
          easeFactor: existing.easeFactor,
          intervalDays: existing.intervalDays,
          repetitions: existing.repetitions,
        }
      : INITIAL_SRS_STATE;
    const next = review(current, grade, now);
    // 首次学才需要写"所属词书"；已有进度不能改它（那是首次学习的归属快照）
    const firstBookId = isNew ? await this.resolveBookId(row.id) : null;

    // ⚠️ `nearMiss` **不计入答对**。拼写是四六级作文与翻译的基本功，
    // 把 `acess` 记成答对，用户会一直拼错下去。它只体现在 `grade` 更低上。
    const bump = {
      newCount: isNew ? 1 : 0,
      reviewCount: isNew ? 0 : 1,
      correctCount: correct ? 1 : 0,
      wrongCount: correct ? 0 : 1,
    };

    // 题型锁的补写：已有进度且**今天已锁**时不覆盖（那正是要保护的"重试不换题"）；
    // 其余情况写本题的题型。新词在 create 分支里写（见下）。
    const lockPatch =
      existing?.typeLockDay && isSameBizDay(existing.typeLockDay, day)
        ? {}
        : { typeLock: type, typeLockDay: day };

    await this.prisma.$transaction([
      this.prisma.wordStudyLog.upsert({
        where: { userId_day: { userId, day } },
        update: {
          newCount: { increment: bump.newCount },
          reviewCount: { increment: bump.reviewCount },
          correctCount: { increment: bump.correctCount },
          wrongCount: { increment: bump.wrongCount },
        },
        create: { userId, day, ...bump },
      }),
      this.prisma.userWordProgress.upsert({
        where: { userId_wordId: { userId, wordId: row.id } },
        update: {
          easeFactor: next.easeFactor,
          intervalDays: next.intervalDays,
          repetitions: next.repetitions,
          // 题型锁：`resolveType` 已经写过一次，这里只在"当天还没锁"时补写，
          // 避免把当天的锁覆盖成另一个题型（那会让重试换题，正是要防的缺陷）
          ...lockPatch,
          dueDate: next.dueAt,
          state: next.state,
          lastGrade: grade,
          lastReviewAt: now,
          correctCount: { increment: bump.correctCount },
          wrongCount: { increment: bump.wrongCount },
        },
        create: {
          userId,
          wordId: row.id,
          bookId: firstBookId,
          easeFactor: next.easeFactor,
          intervalDays: next.intervalDays,
          repetitions: next.repetitions,
          // 新词首次作答：把本题的题型锁一并写入，否则下一次作答会重新抽题（换题）
          typeLock: type,
          typeLockDay: day,
          dueDate: next.dueAt,
          state: next.state,
          lastGrade: grade,
          lastReviewAt: now,
          correctCount: bump.correctCount,
          wrongCount: bump.wrongCount,
        },
      }),
    ]);

    return next;
  }

  /**
   * 首次学它时所属的词书（只写一次，之后不再改）。
   *
   * 一个词可能同时在四级与六级的词表里，所以这里取 `level` 最小的那本 ——
   * 排序规则固定，同一批数据永远得到同一个答案（不做"取第一条"，
   * 那取决于数据库的返回顺序，换台机器就可能变）。
   */
  private async resolveBookId(wordId: string): Promise<string | null> {
    const link = await this.prisma.wordBookWord.findFirst({
      where: { wordId },
      orderBy: { book: { level: 'asc' } },
      select: { bookId: true },
    });
    return link?.bookId ?? null;
  }

  /** 当天的打卡计数（读回写入后的值，而不是本地累加 —— 避免与库里的值漂移） */
  private async dayLog(userId: string) {
    const log = await this.prisma.wordStudyLog.findUnique({
      where: { userId_day: { userId, day: bizDayDate() } },
    });
    return {
      newCount: log?.newCount ?? 0,
      reviewCount: log?.reviewCount ?? 0,
      correctCount: log?.correctCount ?? 0,
      wrongCount: log?.wrongCount ?? 0,
    };
  }
}

/**
 * 按**题型**取这次提交的原文。
 *
 * 选择题取 `choice`、拼写/填空取 `text` —— 这个映射必须与
 * `vocab-question.ts` 的 `judge` 逐项对齐。取错的表现是"拼写题把单词
 * 当成选项 key 判错"，静默且难查，所以在这里显式写出来而不是用 `??` 兜。
 *
 * 缺字段时给空串：空串一定判错（拼不出来 / 没选），
 * 而不是抛异常 —— 用户网络抖一下丢掉一个字段，不该看到 500。
 */
function pickSubmitted(dto: VocabAnswerDto, question: Question): string {
  if (question.type === 'spelling' || question.type === 'cloze') return dto.text ?? '';
  return dto.choice ?? '';
}

/**
 * 三种反馈 → SM-2 评分。
 *
 * 与 `gradeFromOutcome` 是同一套取值（known=5 / vague=3 / unknown=1），
 * 这里只是把"拼写差一点"映射到 `vague` —— 不在这里写死 3/1，
 * 否则改评分策略要翻遍全仓。
 */
function gradeOf(correct: boolean, nearMiss: boolean): Grade {
  if (correct) return gradeFromOutcome('right');
  if (nearMiss) return gradeFromOutcome('vague');
  return gradeFromOutcome('wrong');
}

/**
 * 两个日期是不是**同一个学习日**（见 `vocab-quiz.ts` 同名函数的说明：
 * 直接比 `Date` 会因为 UTC 零点与本地零点而**总是判不相等**，于是锁每天失效）。
 */
function isSameBizDay(a: Date, b: Date): boolean {
  return bizDayDate(a).getTime() === bizDayDate(b).getTime();
}
