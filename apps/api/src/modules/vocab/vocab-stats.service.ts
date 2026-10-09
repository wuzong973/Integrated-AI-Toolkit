import { Injectable } from '@nestjs/common';
import { addDays, bizDayDate, bizDayKey } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type { VocabDayLog, VocabStatsResult } from './dto/vocab.dto';
import { VocabBookService } from './vocab-book.service';
import { VocabPlanService } from './vocab-plan.service';

/**
 * 学习统计（打卡日历 + 连续天数 + 正确率）
 *
 * ## 日历必须**补零**，不能只出现"学过的日子"
 *
 * 只返回有记录的那几天，客户端拼出来的日历会把 9-01 与 9-05 挨在一起，
 * 看起来像"连续学了五天"。补零之后空档才真的显示为空档 —— 这是打卡日历
 * 唯一有价值的信息。
 *
 * ## 连续天数（streak）今天没学时从**昨天**起算
 *
 * 早上打开统计页时今天还没开始学，若直接从今天往前数就会永远是 0，
 * 用户看到"连续 0 天"会以为昨天白学了。所以今天没记录时游标退一天再数。
 */
@Injectable()
export class VocabStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly books: VocabBookService,
    private readonly plan: VocabPlanService,
  ) {}

  async stats(userId: string): Promise<VocabStatsResult> {
    const now = new Date();
    const start = bizDayDate(addDays(now, -(CALENDAR_DAYS - 1)));

    const [active, totals, logs, sums] = await Promise.all([
      this.books.activeBook(userId),
      this.plan.totals(userId),
      this.prisma.wordStudyLog.findMany({
        where: { userId, day: { gte: start, lte: bizDayDate(now) } },
        orderBy: { day: 'asc' },
      }),
      this.prisma.wordStudyLog.aggregate({
        where: { userId },
        _sum: { correctCount: true, wrongCount: true },
      }),
    ]);

    // 连续天数要往前看到比日历窗口更远的地方（连续 30 天以上很常见），
    // 所以单独查一次窗口更长的记录，只取日期键
    const recent = await this.prisma.wordStudyLog.findMany({
      where: { userId, day: { gte: bizDayDate(addDays(now, -MAX_STREAK_DAYS)) } },
      select: { day: true },
    });

    const correct = sums._sum.correctCount ?? 0;
    const wrong = sums._sum.wrongCount ?? 0;

    return {
      book: active ? { code: active.book.code, name: active.book.name } : null,
      streak: countStreak(new Set(recent.map((r) => bizDayKey(r.day))), now),
      totalLearned: totals.learned,
      mastered: totals.mastered,
      dueToday: totals.due,
      // 一次都没答过时是 0 而不是 100：100% 会让人以为"全对了"
      accuracy: correct + wrong === 0 ? 0 : Math.round((correct / (correct + wrong)) * 100),
      calendar: fillCalendar(logs, now),
    };
  }
}

/** 日历展示天数 */
const CALENDAR_DAYS = 30;

/**
 * 连续天数的回溯上限。
 *
 * 不设上限的话查询会随使用时长无限变长（老用户每次打开统计页都要全表扫）。
 * 一年已经远超"连续打卡"这个指标的实际意义，超出部分对用户没有区别。
 */
const MAX_STREAK_DAYS = 400;

/** 最近 `CALENDAR_DAYS` 天，缺的那几天补零（见文件头说明） */
function fillCalendar(
  logs: { day: Date; newCount: number; reviewCount: number; correctCount: number; wrongCount: number }[],
  now: Date,
): VocabDayLog[] {
  const byDay = new Map(logs.map((l) => [bizDayKey(l.day), l]));
  const out: VocabDayLog[] = [];
  for (let i = CALENDAR_DAYS - 1; i >= 0; i--) {
    const key = bizDayKey(addDays(now, -i));
    const log = byDay.get(key);
    out.push({
      day: key,
      newCount: log?.newCount ?? 0,
      reviewCount: log?.reviewCount ?? 0,
      correctCount: log?.correctCount ?? 0,
      wrongCount: log?.wrongCount ?? 0,
    });
  }
  return out;
}

/** 连续打卡天数：今天没学则从昨天起算（见文件头说明） */
function countStreak(studiedKeys: Set<string>, now: Date): number {
  let cursor = now;
  if (!studiedKeys.has(bizDayKey(cursor))) cursor = addDays(cursor, -1);

  let streak = 0;
  while (streak < MAX_STREAK_DAYS && studiedKeys.has(bizDayKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}