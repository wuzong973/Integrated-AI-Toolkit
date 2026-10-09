import { Injectable } from '@nestjs/common';
import { bizDayDate, bizDayStart } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type { VocabQuestionType, VocabTodayResult } from './dto/vocab.dto';
import { VocabBookService } from './vocab-book.service';
import { VocabQuizService } from './vocab-quiz';
import { WORD_SELECT, type WordRow } from './vocab-word';

/**
 * 今日队列（记单词的主流程）
 *
 * ## 计划 = 词书上的 `daily_new` / `daily_review` 减去"今天已经做过多少"
 *
 * 已做量来自 `word_study_log`（打卡日历的唯一数据源，见 schema 说明）——
 * 不另存一份"今日进度"，否则必然出现"日志说做了 10 个、进度说 8 个"这种
 * 谁都查不出来的不一致。刷新页面得到的是**剩余量**，不是重新发一遍计划。
 *
 * ## 到期判定用 `dueDate <= 今天零点`
 *
 * `dueDate` 写库时就是 `bizDayStart(复习时刻) + 间隔天数`（见 `@qz/core` 的 `review`），
 * 永远是"日零点"这种对齐值。所以直接比零点即可，不必去算"今天 23:59:59"。
 */
export const PLAN_EXTRA = 10;

@Injectable()
export class VocabPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly books: VocabBookService,
    private readonly quiz: VocabQuizService,
  ) {}

  async today(userId: string): Promise<VocabTodayResult> {
    // 读今天已做量必须用 `bizDayDate()` —— `word_study_log.day` 是 `@db.Date` 列，
    // 写入走的是 `bizDayDate()`。两者的 UTC 折算必须一致，否则读出来永远是 0，
    // 表现是"计划永远满额、刷新也不会减少"（见 `@qz/core` 的 `bizDayDate` 说明）。
    const day = bizDayDate();
    const active = await this.books.activeBook(userId);
    const totals = await this.totals(userId);

    if (!active) {
      // 还没选词书：把列表一起给出去，省掉一次"发现没有词书 → 再请求一次列表"
      return {
        book: null,
        needsBook: true,
        books: await this.books.listBooks(userId),
        emptyReason: '',
        dailyNew: 0,
        dailyReview: 0,
        newCards: [],
        reviewCards: [],
        today: ZERO_DAY,
        totals,
      };
    }

    const book = active.book;
    const log = await this.prisma.wordStudyLog.findUnique({
      where: { userId_day: { userId, day } },
    });
    const today = {
      newCount: log?.newCount ?? 0,
      reviewCount: log?.reviewCount ?? 0,
      correctCount: log?.correctCount ?? 0,
      wrongCount: log?.wrongCount ?? 0,
    };
    const newQuota = Math.max(0, active.dailyNew - today.newCount);
    const reviewQuota = Math.max(0, active.dailyReview - today.reviewCount);

    const [newRows, reviewRows] = await Promise.all([
      newQuota > 0 ? this.pickNew(userId, book.id, newQuota) : Promise.resolve([]),
      reviewQuota > 0 ? this.pickReview(userId, book.id, reviewQuota) : Promise.resolve([]),
    ]);
    // 题型由 `resolveType` 定（带**当天锁**，见 `vocab-quiz.ts` 文件头"同一轮里必须锁住"）。
    // ⚠️ 必须在这里**先定完再出题**：题型是逐词独立的，现算会让"同一次学习里重试"换题。
    // ⚠️ 新词此刻还没有进度行，`resolveType` 写不了锁 —— 所以这里补一个"当天题型"缓存，
    //    并由 `answer` 在第一次作答时把锁一并落库（`persist` 的 create 分支）。
    //    没有这一步，新词答对一次后 `repetitions` 变了，重试就会被换题。
    const typeMap = new Map<string, VocabQuestionType>();
    await Promise.all(
      [...newRows, ...reviewRows].map(async (r) => {
        typeMap.set(r.id, await this.quiz.resolveType(r, userId));
      }),
    );
    // 多取 PLAN_EXTRA 个再截断：释义为空 / 凑不出四个选项的词会被剔掉，
    // 不预多取的话队列会比计划少，用户看到"计划 10 个、实际 7 个"却不知道为什么
    const [newCards, reviewCards] = await Promise.all([
      this.quiz.buildCards(newRows, true, (r) => typeMap.get(r.id) ?? 'meaning').then((c) => c.slice(0, newQuota)),
      this.quiz
        .buildCards(reviewRows, false, (r) => typeMap.get(r.id) ?? 'meaning')
        .then((c) => c.slice(0, reviewQuota)),
    ]);

    return {
      book: { code: book.code, name: book.name },
      needsBook: false,
      books: [],
      emptyReason: this.explainEmpty(book, newCards.length + reviewCards.length, newQuota, reviewQuota),
      dailyNew: active.dailyNew,
      dailyReview: active.dailyReview,
      newCards,
      reviewCards,
      today,
      totals,
    };
  }

  /** 还没学过的词：按词书内的学习顺序（`seq`，脚本按难度+字母排好）取 */
  private async pickNew(userId: string, bookId: string, quota: number): Promise<WordRow[]> {
    const rows = await this.prisma.wordBookWord.findMany({
      where: { bookId, word: { progress: { none: { userId } } } },
      orderBy: { seq: 'asc' },
      take: quota + PLAN_EXTRA,
      select: { word: { select: WORD_SELECT } },
    });
    return rows.map((r) => r.word as WordRow);
  }

  /**
   * 到期复习的词。
   *
   * 筛选条件是"**这个词属于当前词书**"（`word.books`），不是
   * `progress.bookId = 当前词书`：一个词可能同时在四级与六级词表里，
   * 而 `progress.bookId` 记的是"首次学它时的那本"。按后者过滤会让
   * 用户从四级换到六级后，这个词在六级里**永远不会出现**（却是他要背的词）。
   */
  private async pickReview(userId: string, bookId: string, quota: number): Promise<WordRow[]> {
    const rows = await this.prisma.userWordProgress.findMany({
      where: {
        userId,
        dueDate: { lte: bizDayStart() },
        word: { books: { some: { bookId } } },
      },
      // 越早到期的越先复习；同一到期日的按 wordId 兜底，保证顺序稳定（可复现、可测）
      orderBy: [{ dueDate: 'asc' }, { wordId: 'asc' }],
      take: quota + PLAN_EXTRA,
      select: { word: { select: WORD_SELECT } },
    });
    return rows.map((r) => r.word as WordRow);
  }

  /** 我的全局累计（三处口径一致，供今日页与统计页共用） */
  async totals(userId: string): Promise<{ learned: number; mastered: number; due: number }> {
    const day = bizDayStart();
    const [learned, mastered, due] = await Promise.all([
      this.prisma.userWordProgress.count({ where: { userId } }),
      this.prisma.userWordProgress.count({ where: { userId, state: 'mastered' } }),
      this.prisma.userWordProgress.count({ where: { userId, dueDate: { lte: day } } }),
    ]);
    return { learned, mastered, due };
  }

  /**
   * 队列空的时候**必须说清是哪一种空**。
   *
   * 三种"空"对用户的意义完全不同：今天已经学完了 / 这本词书还没上线 / 词条不够出题。
   * 统一回一句"暂无数据"，用户会以为功能坏了而反复下拉刷新。
   */
  private explainEmpty(
    book: { name: string; wordCount: number },
    cardCount: number,
    newQuota: number,
    reviewQuota: number,
  ): string {
    if (cardCount > 0) return '';
    if (book.wordCount < 4) {
      return `「${book.name}」的词表还在建设中（当前 ${book.wordCount} 个词），暂时开不了学习`;
    }
    if (newQuota <= 0 && reviewQuota <= 0) {
      return '今天的计划已经完成了，明天再来巩固吧';
    }
    return '这本词书今天没有要学的词了，可以换一本或调大每日目标';
  }
}

const ZERO_DAY = { newCount: 0, reviewCount: 0, correctCount: 0, wrongCount: 0 };