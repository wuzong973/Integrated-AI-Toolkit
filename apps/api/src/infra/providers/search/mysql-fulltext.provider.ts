import { BizException, ErrorCode, type SearchHit, type SearchProvider } from '@qz/core';

import type { AppLogger } from '../../../common/logger/logger.service';
import type { PrismaService } from '../../prisma/prisma.service';

/** `search_index` 的查询行 */
interface IndexRow {
  type: string;
  ref_id: string;
  title: string;
  body: string;
  score: number;
}

interface CountRow {
  total: bigint | number;
}

/**
 * 搜索 Provider —— MySQL FULLTEXT（M4-07 / ADR-13）。
 *
 * ## 选型结论：先用 MySQL FULLTEXT，不引入新组件
 *
 * ADR-13 把数据库改成 MySQL 时就已经确定了全文检索走 FULLTEXT 这条路。
 * 之所以先不上 Meilisearch / ES：本阶段的数据量与检索需求
 * （驿站任务、服务、知识库文档）用 FULLTEXT 完全够，
 * 而引入一个搜索中间件意味着**多一个必须同步的数据副本 + 一套同步失败时的补偿逻辑**。
 * 接口（`SearchProvider`）保持与实现无关，将来要换只换 driver。
 *
 * ## ⚠️ 中文必须用 ngram 解析器
 *
 * MySQL 默认分词器按空格切词，中文正文会被当成一个整词，
 * 检索"摄影"匹配不到"校园摄影服务" —— **不报错，永远返回空**。
 * 建表 SQL 里已带 `WITH PARSER ngram`（见迁移 `20260919120000_add_search_index`）。
 *
 * ## 表不存在时给出可执行的提示，而不是抛 SQL 原文
 *
 * 这条最容易踩：`SEARCH_DRIVER=mysql` 但迁移没跑。此时 MySQL 会抛
 * `Table 'x.search_index' doesn't exist`，而这句话在业务日志里
 * 完全看不出"该去跑迁移"。所以这里把它翻译成明确的动作指引。
 */
export class MysqlFulltextSearchProvider implements SearchProvider {
  readonly name = 'mysql-fulltext';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: { timeoutMs: number },
    private readonly logger: AppLogger,
  ) {}

  /** 写入/更新索引。按 `(type, ref_id)` 幂等 upsert —— 重放同一条不会产生重复行 */
  async index(type: string, doc: Record<string, unknown>): Promise<void> {
    const refId = String(doc.id ?? '');
    if (!refId) {
      throw new BizException(ErrorCode.ParamInvalid, { type }, '索引文档缺少 id 字段');
    }

    const title = toText(doc.title ?? doc.name);
    const body = buildBody(doc);

    await this.guard(() =>
      this.prisma.$executeRaw`
        INSERT INTO search_index (type, ref_id, title, body, updated_at)
        VALUES (${type}, ${refId}, ${title}, ${body}, NOW(3))
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          body = VALUES(body),
          updated_at = VALUES(updated_at)
      `,
    );
  }

  /**
   * 检索。
   *
   * 用**自然语言模式**（不带 `IN BOOLEAN MODE`）而不是布尔模式，理由是安全与稳健：
   * 布尔模式下 `+ - * " ( )` 都是操作符，用户输入的 `C++`、`"引号` 会被解析成
   * 语法而不是内容，轻则查不到、重则直接语法错误。自然语言模式把输入当纯文本，
   * ngram 分词照常生效，还自带相关度排序。
   */
  async search(
    query: string,
    opts?: { type?: string; page?: number; size?: number },
  ): Promise<{ list: SearchHit[]; total: number }> {
    const keyword = query.trim();
    if (!keyword) return { list: [], total: 0 };

    const size = clampInt(opts?.size, 20, 1, 100);
    const page = clampInt(opts?.page, 1, 1, 1000);
    const offset = (page - 1) * size;
    // type 缺省即"全类型"；用 null 表示，SQL 里用 IS NULL 判空而不是拼字符串
    const type = opts?.type && opts.type !== 'all' ? opts.type : null;

    const rows = await this.guard(() =>
      this.prisma.$queryRaw<IndexRow[]>`
        SELECT type, ref_id, title, body,
               MATCH(title, body) AGAINST (${keyword}) AS score
        FROM search_index
        WHERE MATCH(title, body) AGAINST (${keyword})
          AND (${type} IS NULL OR type = ${type})
        ORDER BY score DESC
        LIMIT ${size} OFFSET ${offset}
      `,
    );

    const counted = await this.guard(() =>
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS total
        FROM search_index
        WHERE MATCH(title, body) AGAINST (${keyword})
          AND (${type} IS NULL OR type = ${type})
      `,
    );

    return {
      list: rows.map((row) => toHit(row, keyword)),
      total: Number(counted[0]?.total ?? 0),
    };
  }

  /**
   * 统一兜底：超时保护 + 把"表不存在"翻译成可执行的指引。
   *
   * 超时是必须的：FULLTEXT 查询的耗时取决于索引与数据量，
   * 一旦某个查询退化成全表扫描，**它会一直占着连接直到 MySQL 自己超时**，
   * 而调用方（小程序请求）只有 30 秒 —— 前端早已断开，后端还在等。
   * 这里主动切断，把"卡住"变成"快速失败"，至少日志里能留下真实原因。
   *
   * 其它错误原样抛出并记日志 —— 把它们也包装成"请跑迁移"会掩盖真实问题
   * （比如连接池耗尽），那种误导比不包装更贵。
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new BizException(
            ErrorCode.ConvertServiceUnavailable,
            { provider: this.name, timeoutMs: this.cfg.timeoutMs },
            '检索超时，请缩小关键词范围后重试',
          ),
        );
      }, this.cfg.timeoutMs);
      // 不让这个定时器拖住进程退出（脚本与测试里很关键）
      timer.unref?.();
    });

    try {
      return await Promise.race([run(), timeout]);
    } catch (e) {
      if (e instanceof BizException) throw e;

      const message = (e as Error)?.message ?? '';
      if (message.includes('search_index') && /doesn't exist|does not exist/i.test(message)) {
        throw new BizException(
          ErrorCode.ConvertServiceUnavailable,
          { provider: this.name },
          '全文检索索引未初始化，请先执行数据库迁移（add_search_index）',
        );
      }
      this.logger.warn(`全文检索失败：${message}`, 'MysqlFulltextSearchProvider');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 命中行 → 客户端结构 */
function toHit(row: IndexRow, keyword: string): SearchHit {
  return {
    id: row.ref_id,
    type: row.type,
    title: row.title,
    snippet: makeSnippet(row.body, keyword),
    score: Number(row.score ?? 0),
    raw: { refId: row.ref_id },
  };
}

/**
 * 截取命中词周围的片段。
 *
 * 直接返回正文前 N 字是最省事的做法，但**检索词经常不在开头** ——
 * 那样用户会看到一段看不出为什么匹配的摘要，进而怀疑搜索坏了。
 */
function makeSnippet(body: string, keyword: string, window = 80): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= window) return text;

  const at = text.indexOf(keyword.slice(0, Math.min(keyword.length, 8)));
  if (at < 0) return `${text.slice(0, window)}…`;

  const start = Math.max(0, at - Math.floor(window / 3));
  const end = Math.min(text.length, start + window);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** 可检索正文 = 除 id/title 外的全部字符串字段拼接 */
function buildBody(doc: Record<string, unknown>): string {
  return Object.entries(doc)
    .filter(([key]) => key !== 'id' && key !== 'title' && key !== 'name')
    .map(([, value]) => toText(value))
    .filter(Boolean)
    .join(' ');
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
