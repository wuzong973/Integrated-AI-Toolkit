import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskStatus } from '@qz/core';

import { StationService } from '../station.service';

/**
 * 驿站只读接口的单测（M3 只读切片）
 *
 * 重点不是"能查出数据"，而是两条容易写错、错了又不容易发现的规则：
 *   ① **默认只返回已发布** —— 大厅里出现 draft/reviewing 是产品事故，
 *      用户会看到别人没写完的草稿；
 *   ② **字段映射的容错** —— `skillTags` 是 JSON 列（不同 MySQL 客户端可能返回字符串）、
 *      `creditScore` 在 UserProfile 而非 User 上、可空字段不能变成 `null` 泄漏给前端。
 */

interface TaskRow {
  id: string;
  taskNo: string;
  publisherId: string;
  categoryId: string;
  title: string;
  description: string;
  budget: number;
  budgetType: string;
  deadline: Date | null;
  location: string | null;
  skillTags: unknown;
  status: string;
  source: string;
  applyCount: number;
  viewCount: number;
  createdAt: Date;
  publisher?: {
    id: string;
    nickname: string | null;
    profile: { creditScore: number } | null;
  } | null;
}

function makeRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't1',
    taskNo: 'QZ-0001',
    publisherId: 'u1',
    categoryId: 'design',
    title: '招新海报设计',
    description: '一套招新物料',
    budget: 20000,
    budgetType: 'fixed',
    deadline: null,
    location: null,
    skillTags: ['海报设计'],
    status: TaskStatus.Published,
    source: 'manual',
    applyCount: 0,
    viewCount: 0,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    publisher: { id: 'u1', nickname: '王同学', profile: { creditScore: 88 } },
    ...over,
  };
}

/** 假的 Prisma：实现 where 过滤、排序、分页，让断言反映真实查询语义 */
function makePrisma(rows: TaskRow[]) {
  let updateFails = false;
  const updates: { id: string }[] = [];

  const match = (row: TaskRow, where: Record<string, unknown>): boolean => {
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.categoryId !== undefined && row.categoryId !== where.categoryId) return false;

    const or = where.OR as { title?: { contains: string }; description?: { contains: string } }[];
    if (or) {
      const hit = or.some(
        (cond) =>
          (cond.title?.contains && row.title.includes(cond.title.contains)) ||
          (cond.description?.contains && row.description.includes(cond.description.contains)),
      );
      if (!hit) return false;
    }
    return true;
  };

  const fake = {
    task: {
      findMany: async ({
        where,
        skip,
        take,
      }: {
        where: Record<string, unknown>;
        skip: number;
        take: number;
      }) => rows.filter((r) => match(r, where)).slice(skip, skip + take),
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => match(r, where)).length,
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where }: { where: { id: string } }) => {
        if (updateFails) throw new Error('数据库连接中断');
        updates.push({ id: where.id });
        return rows.find((r) => r.id === where.id);
      },
    },
  };

  return {
    prisma: fake as never,
    updates,
    failNextUpdate: () => {
      updateFails = true;
    },
  };
}

const baseQuery = { page: 1, size: 20 };

describe('StationService 任务大厅（只读）', () => {
  let rows: TaskRow[];
  let db: ReturnType<typeof makePrisma>;
  let service: StationService;

  beforeEach(() => {
    rows = [
      makeRow({ id: 't1', status: TaskStatus.Published, categoryId: 'design' }),
      makeRow({
        id: 't2',
        taskNo: 'QZ-0002',
        status: TaskStatus.Published,
        categoryId: 'video',
        title: '毕业视频剪辑',
        description: '剪成 5 分钟',
      }),
      makeRow({
        id: 't3',
        taskNo: 'QZ-0003',
        status: TaskStatus.Draft,
        title: '还没写完的草稿',
      }),
      makeRow({
        id: 't4',
        taskNo: 'QZ-0004',
        status: TaskStatus.Assigned,
        title: '已被接走的活',
      }),
    ];
    db = makePrisma(rows);
    service = new StationService(db.prisma);
  });

  it('⭐ 不传状态时默认只返回已发布（草稿与已接单不入大厅）', async () => {
    const res = await service.listTasks({ ...baseQuery });

    expect(res.total).toBe(2);
    expect(res.list.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('显式传状态时按状态查（服务方工作台要看 assigned）', async () => {
    const res = await service.listTasks({ ...baseQuery, status: TaskStatus.Assigned });

    expect(res.total).toBe(1);
    expect(res.list[0].id).toBe('t4');
  });

  it('按分类筛选', async () => {
    const res = await service.listTasks({ ...baseQuery, categoryId: 'video' });
    expect(res.total).toBe(1);
    expect(res.list[0].title).toBe('毕业视频剪辑');
  });

  it('关键词同时匹配标题与描述，且草稿不会因命中关键词而泄漏', async () => {
    const byTitle = await service.listTasks({ ...baseQuery, keyword: '海报' });
    expect(byTitle.list.map((t) => t.id)).toEqual(['t1']);

    const byDesc = await service.listTasks({ ...baseQuery, keyword: '5 分钟' });
    expect(byDesc.list.map((t) => t.id)).toEqual(['t2']);

    // "草稿"只出现在 draft 那条上 → 若过滤失效这里会返回 t3
    const draft = await service.listTasks({ ...baseQuery, keyword: '草稿' });
    expect(draft.total).toBe(0);
  });

  it('分页：skip/take 生效，total 仍是过滤后的总数', async () => {
    const first = await service.listTasks({ page: 1, size: 1 });
    const second = await service.listTasks({ page: 2, size: 1 });

    expect(first.list).toHaveLength(1);
    expect(second.list).toHaveLength(1);
    expect(first.list[0].id).not.toBe(second.list[0].id);
    expect(first.total).toBe(2);
  });
});

describe('StationService 字段映射', () => {
  it('可空字段缺失时不写 null，publisher.creditScore 取自 UserProfile', async () => {
    const row = makeRow({ deadline: null, location: null });
    const { prisma } = makePrisma([row]);
    const service = new StationService(prisma);

    const task = await service.getTask('t1');

    expect(task.deadline).toBeUndefined();
    expect(task.location).toBeUndefined();
    expect(task.publisher).toEqual({ id: 'u1', nickname: '王同学', creditScore: 88 });
  });

  it('deadline 转 ISO 字符串（前端直接 new Date 也能解析）', async () => {
    const row = makeRow({ deadline: new Date('2026-10-01T12:00:00.000Z') });
    const { prisma } = makePrisma([row]);
    const service = new StationService(prisma);

    expect((await service.getTask('t1')).deadline).toBe('2026-10-01T12:00:00.000Z');
  });

  it('skillTags 是 JSON 列：数组正常解析，异常值降级为空数组', async () => {
    const asArray = makePrisma([makeRow({ skillTags: ['摄影', '修图'] })]);
    expect((await new StationService(asArray.prisma).getTask('t1')).skillTags).toEqual([
      '摄影',
      '修图',
    ]);

    const mixed = makePrisma([makeRow({ skillTags: ['摄影', 42, null, '修图'] })]);
    expect((await new StationService(mixed.prisma).getTask('t1')).skillTags).toEqual([
      '摄影',
      '修图',
    ]);

    const broken = makePrisma([makeRow({ skillTags: null })]);
    expect((await new StationService(broken.prisma).getTask('t1')).skillTags).toEqual([]);

    // 注意：这里**不**尝试解析"被序列化成字符串的 JSON"。
    // core 的 asStringArray 明确定义为"非数组一律降级为空数组"（禁止强转是写进文件头的纪律），
    // 而 Prisma 的 MySQL Json 列读出来就是已解析的值，不会出现字符串形态。
    // 为一个不存在的情况加解析分支，只会让"数据异常"被静默掩盖成"看起来正常的空数组"。
  });

  it('缺少 profile 时信用分回落为 0，昵称为空时用"同学"兜底', async () => {
    const row = makeRow({ publisher: { id: 'u9', nickname: null, profile: null } });
    const { prisma } = makePrisma([row]);

    const task = await new StationService(prisma).getTask('t1');
    expect(task.publisher).toEqual({ id: 'u9', nickname: '同学', creditScore: 0 });
  });

  it('没有发布者关联时不产生 publisher 字段（而不是 publisher: null）', async () => {
    const { prisma } = makePrisma([makeRow({ publisher: null })]);
    const task = await new StationService(prisma).getTask('t1');
    expect(task.publisher).toBeUndefined();
  });
});

describe('StationService 任务详情', () => {
  it('不存在的任务抛 404 语义的业务异常', async () => {
    const { prisma } = makePrisma([makeRow()]);
    const service = new StationService(prisma);

    await expect(service.getTask('nope')).rejects.toMatchObject({ code: 40401 });
  });

  it('详情会累加浏览量', async () => {
    const db2 = makePrisma([makeRow()]);
    await new StationService(db2.prisma).getTask('t1');
    expect(db2.updates).toEqual([{ id: 't1' }]);
  });

  it('浏览量累加失败不能让用户看不到详情（统计是尽力而为）', async () => {
    const db2 = makePrisma([makeRow()]);
    db2.failNextUpdate();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const task = await new StationService(db2.prisma).getTask('t1');

    expect(task.id).toBe('t1');
    warn.mockRestore();
  });
});

/**
 * 示例数据标记（排查报告 P2-7 / 红线 10）
 *
 * `seed.ts` 写入 4 条示例任务（`QZ-DEMO-0001..0004`），而小程序的任务大厅
 * **不渲染 `taskNo`** —— 用户看到的是 4 条完全像真实任务的数据：
 * 有发布者昵称、有报名人数、有预算。这与"假数据冒充功能"是同一类问题。
 *
 * 修法是把判定放在**服务端**（判据只维护一份：`@qz/core` 的 `isDemoTaskNo`），
 * 客户端只负责"看到 isDemo 就显示角标"。
 */
describe('StationService —— 示例数据必须可辨识（红线 10）', () => {
  const listWith = (row: TaskRow) =>
    new StationService(makePrisma([row]).prisma).listTasks({ page: 1, size: 20 } as never);
  const detailWith = (row: TaskRow) =>
    new StationService(makePrisma([row]).prisma).getTask(row.id);

  it('编号带 QZ-DEMO- 前缀 → isDemo 为 true', async () => {
    const { list } = await listWith(
      makeRow({ id: 'd1', taskNo: 'QZ-DEMO-0001', status: TaskStatus.Published }),
    );
    expect(list[0].isDemo).toBe(true);
  });

  it('真实编号 → isDemo 为 false（不能把正常数据误标成演示）', async () => {
    const { list } = await listWith(
      makeRow({ id: 'r1', taskNo: 'QZ-20260918-0001', status: TaskStatus.Published }),
    );
    expect(list[0].isDemo).toBe(false);
  });

  it('详情接口同样带 isDemo（列表标了、详情没标 = 点进去就失去提示）', async () => {
    const task = await detailWith(
      makeRow({ id: 'd2', taskNo: 'QZ-DEMO-0002', status: TaskStatus.Published }),
    );
    expect(task.isDemo).toBe(true);
  });
});
