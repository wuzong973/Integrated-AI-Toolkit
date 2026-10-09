import { Injectable } from '@nestjs/common';
import { BizException, ErrorCode, bizDayStart, type SelectWordBookDto } from '@qz/core';

import { PrismaService } from '../../infra/prisma/prisma.service';

import type { VocabBookItem } from './dto/vocab.dto';

/**
 * 记单词 · 词书（选书 / 我的进度）
 *
 * ## 「同一时刻只有一本 isActive」的落地位置
 *
 * 这条约束在库里只是两列（`is_active` + `@@unique([userId, bookId])`），
 * 没有任何数据库约束能表达"每个用户至多一本 active"。所以**只在 `selectBook` 一处**
 * 做"先全关、再开一本"，且放在同一个事务里 —— 分两步写会让中途失败的请求
 * 留下"两本都 active"或"一本都不 active"的状态，而后者会让用户打开学习页时
 * 发现自己没有词书，只能重新选一次。
 *
 * ## 词书的 `status=planned` 不给选
 *
 * `planned` 是"词表还没灌完"（见 `scripts/db/gen-words.mjs` 回写 `status` 的逻辑）。
 * 允许选中它，用户进去只会看到一个空词书，且**看不出这是"还没上线"**
 * —— 那正是红线 9 与 `audit:mp`（"骨架页误导文案"）要拦的东西。所以这里拒绝，
 * 并在错误信息里说清"哪本可用"。
 */
@Injectable()
export class VocabBookService {
  constructor(private readonly prisma: PrismaService) {}

  /** 词书列表（含"我的进度"）。未登录用户看不到进度，但本接口要求登录，故始终带进度 */
  async listBooks(userId: string): Promise<VocabBookItem[]> {
    const books = await this.prisma.wordBook.findMany({
      orderBy: [{ level: 'asc' }, { code: 'asc' }],
    });
    const members = await this.prisma.userWordBook.findMany({ where: { userId } });
    const memberMap = new Map(members.map((m) => [m.bookId, m]));

    const bookIds = books.map((b) => b.id);
    // 进度按 `progress.bookId`（首次学它时所属词书）聚合 —— 这正是该列存在的理由
    const [byState, dueRows] = await Promise.all([
      this.prisma.userWordProgress.groupBy({
        by: ['bookId', 'state'],
        where: { userId, bookId: { in: bookIds } },
        _count: { _all: true },
      }),
      this.prisma.userWordProgress.groupBy({
        by: ['bookId'],
        where: { userId, bookId: { in: bookIds }, dueDate: { lte: bizDayStart() } },
        _count: { _all: true },
      }),
    ]);

    const learned = new Map<string, number>();
    const mastered = new Map<string, number>();
    for (const row of byState) {
      const key = row.bookId ?? '';
      learned.set(key, (learned.get(key) ?? 0) + row._count._all);
      if (row.state === 'mastered') {
        mastered.set(key, (mastered.get(key) ?? 0) + row._count._all);
      }
    }
    const due = new Map(dueRows.map((r) => [r.bookId ?? '', r._count._all]));

    return books.map((book) => {
      const member = memberMap.get(book.id);
      return {
        code: book.code,
        name: book.name,
        desc: book.desc ?? '',
        level: book.level,
        category: book.category,
        wordCount: book.wordCount,
        status: book.status,
        selected: Boolean(member),
        isActive: Boolean(member?.isActive),
        learned: learned.get(book.id) ?? 0,
        due: due.get(book.id) ?? 0,
        mastered: mastered.get(book.id) ?? 0,
      };
    });
  }

  /** 当前正在学的词书 + 每日目标；没有选中任何一本时返回 null */
  async activeBook(userId: string) {
    return this.prisma.userWordBook.findFirst({
      where: { userId, isActive: true },
      include: { book: true },
    });
  }

  /**
   * 选为当前词书（可顺带改每日目标）。
   *
   * 返回列表而不是"成功"两个字：界面选完之后立刻要重画词书卡上的
   * "正在学 / 已学 32 / 今日待复习 8"，让它自己再发一次请求只会白闪一下。
   */
  async selectBook(userId: string, dto: SelectWordBookDto): Promise<VocabBookItem[]> {
    const book = await this.prisma.wordBook.findUnique({ where: { code: dto.code } });
    if (!book) {
      throw new BizException(
        ErrorCode.NotFound,
        { code: dto.code },
        `没有找到词书「${dto.code}」，请刷新后重试`,
      );
    }
    if (book.status !== 'active') {
      throw new BizException(
        ErrorCode.IllegalStateTransition,
        { code: book.code, status: book.status },
        `「${book.name}」的词表还在建设中，暂时不能选；先选一本已有的词书吧`,
      );
    }

    const daily = {
      ...(dto.dailyNew === undefined ? {} : { dailyNew: dto.dailyNew }),
      ...(dto.dailyReview === undefined ? {} : { dailyReview: dto.dailyReview }),
    };

    await this.prisma.$transaction([
      // 先关掉所有已激活的：这两步必须在一个事务里，见文件头说明
      this.prisma.userWordBook.updateMany({
        where: { userId, isActive: true, bookId: { not: book.id } },
        data: { isActive: false },
      }),
      this.prisma.userWordBook.upsert({
        where: { userId_bookId: { userId, bookId: book.id } },
        update: { isActive: true, ...daily },
        create: { userId, bookId: book.id, isActive: true, ...daily },
      }),
    ]);

    return this.listBooks(userId);
  }
}