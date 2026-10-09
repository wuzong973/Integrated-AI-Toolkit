import { Injectable } from '@nestjs/common';
import { addDays, bizDayDate, bizDayKey } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type { PracticeDayStat, PracticeTodayResult } from './dto/practice.dto';
import { PracticeQueueService } from './practice-queue.service';

/**
 * 练习统计（打卡日历 + 连续天数 + 各模块正确率）
 *
 * ## 与词汇统计（`vocab-stats.service.ts`）**不合并**
 *
 * 两者口径不同：词汇的日历记的是"学了几个词"，练习中心记的是"句子/口语/作文各几题"。
 * 硬塞进一张表要引入一个 `kind` 列再加一堆 nullable 计数列，
 * 且"某天学了 20 个词、练了 3 句口语"到底算不算"打卡成功"这件事
 * 在两个模块里答案不一样。分开两张表，各自的口径各自清楚。
 *
 * ## 日历必须**补零**
 *
 * 与词汇统计同一条纪律：只返回有记录的日子，客户端拼出来的日历会把
 * 9-01 与 9-05 挨在一起，看起来像"连续学了五天"。空档只有显示成空档才有意义。
 *
 * ## 连续天数：**跨模块合并**
 *
 * 与日历不同，streak 判的是"今天有没有学" —— 只练了 3 句口语也算学了。
 * 按模块各算一个 streak 会让用户看到"句子连续 5 天、口语连续 0 天"，
 * 而他真正关心的是"我坚持了几天"。
 */
@Injectable()
export class PracticeStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PracticeQueueService,
  ) {}

  async today(userId: string): Promise<PracticeTodayResult> {
    const [modules, today, totals, logs, streak] = await Promise.all([
      Promise.all(
        PracticeQueueService.MODULE_ORDER.map((m) => this.queue.plan(userId, m)),
      ),
      this.queue.dayStat(userId),
      this.queue.totals(userId),
      this.prisma.practiceStudyLog.findMany({
        where: {
          userId,
          day: { gte: bizDayDate(addDays(new Date(), -(CALENDAR_DAYS - 1))) },
        },
        orderBy: { day: 'asc' },
      }),
      // 连续天数要看到比日历窗口更远（连续 30 天很常见），单独查一次
      this.prisma.practiceStudyLog.findMany({
        where: { userId, day: { gte: bizDayDate(addDays(new Date(), -MAX_STREAK_DAYS)) } },
        select: { day: true },
      }),
    ]);

    return {
      modules,
      today,
      totals,
      calendar: fillCalendar(logs),
      streak: countStreak(new Set(streak.map((r) => bizDayKey(r.day)))),
    };
  }
}

/** 日历展示天数 */
const CALENDAR_DAYS = 30;

/** 连续天数的回溯上限（理由同 `vocab-stats.service.ts`：不设上限查询会无限变长） */
const MAX_STREAK_DAYS = 400;

/** 最近 `CALENDAR_DAYS` 天，缺的补零 */
function fillCalendar(
  logs: {
    day: Date;
    sentenceCount: number;
    speakCount: number;
    writeCount: number;
    passCount: number;
    failCount: number;
  }[],
): PracticeDayStat[] {
  const byDay = new Map(logs.map((l) => [bizDayKey(l.day), l]));
  const now = new Date();
  const out: PracticeDayStat[] = [];
  for (let i = CALENDAR_DAYS - 1; i >= 0; i--) {
    const key = bizDayKey(addDays(now, -i));
    const log = byDay.get(key);
    out.push({
      day: key,
      sentenceCount: log?.sentenceCount ?? 0,
      speakCount: log?.speakCount ?? 0,
      writeCount: log?.writeCount ?? 0,
      passCount: log?.passCount ?? 0,
      failCount: log?.failCount ?? 0,
    });
  }
  return out;
}

/**
 * 连续打卡天数（跨模块合并）。
 *
 * 今天没学时从**昨天**起算：早上打开统计页时今天还没开始练，
 * 若直接从今天往前数就会永远是 0，用户看到"连续 0 天"会以为昨天白练了。
 *
 * ⚠️ "有记录"的判据是**当天做过任何一题**（三个计数之和 > 0），
 * 不是"有行"。`practice_study_log` 的行只在第一次提交时才创建，
 * 所以有行必然有题；但将来若加了"预建今日行"的逻辑，这个判据还能挡住它。
 */
function countStreak(studiedKeys: Set<string>): number {
  let cursor = new Date();
  if (!studiedKeys.has(bizDayKey(cursor))) cursor = addDays(cursor, -1);

  let streak = 0;
  while (streak < MAX_STREAK_DAYS && studiedKeys.has(bizDayKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
