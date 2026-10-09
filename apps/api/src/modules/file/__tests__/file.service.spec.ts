import { describe, expect, it, vi } from 'vitest';
import type { PresignResult, Providers, StorageProvider } from '@qz/core';

import { FileService, buildObjectKey } from '../file.service';
import { parseEndpoint } from '../../../infra/providers/storage/minio-storage.provider';

/**
 * 内存版假对象存储：让 M0-12 的业务逻辑可以在**不起 MinIO** 的前提下单测。
 * 真实直传链路的验证另见验收记录（需 MinIO 运行）。
 */
class FakeStorage implements StorageProvider {
  readonly name = 'fake-storage';
  objects = new Set<string>();
  presigned: string[] = [];
  /** 最近一次 presignGet 收到的时效（秒）；未传记 null */
  lastGetTtl: number | null = null;

  async presignPut(
    objectKey: string,
    contentType: string,
    expiresIn = 900,
  ): Promise<PresignResult> {
    this.presigned.push(objectKey);
    return {
      uploadUrl: `https://fake.test/${objectKey}?sig=abc`,
      headers: { 'Content-Type': contentType },
      objectKey,
      expiresIn,
    };
  }

  async presignGet(objectKey: string, expiresIn?: number): Promise<string> {
    // 记下时效：头像走的是专用长时效，与下载用的 900 秒必须能区分开
    this.lastGetTtl = expiresIn ?? null;
    return `https://fake.test/${objectKey}?download=1`;
  }

  async putObject(objectKey: string): Promise<void> {
    this.objects.add(objectKey);
  }

  async getObject(): Promise<Buffer> {
    return Buffer.from('');
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }
}

/** 极简内存表，只实现 FileService 用到的那几个方法 */
class FakePrisma {
  rows: Record<string, unknown>[] = [];
  private seq = 0;

  fileAsset = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `f${++this.seq}`,
        downloadCount: 0,
        deletedAt: null,
        hash: null,
        thumbUrl: null,
        source: null,
        expireAt: null,
        createdAt: new Date('2026-09-17T10:00:00Z'),
        ...data,
      };
      this.rows.push(row);
      return row;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      return this.rows.filter((r) => matches(r, where));
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.rows.find((r) => r.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.rows.find((r) => r.id === where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as object)) {
          row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
        } else {
          row[k] = v;
        }
      }
      return row;
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      this.rows.filter((r) => matches(r, where)).length,
    aggregate: async ({ where }: { where: Record<string, unknown> }) => {
      const hit = this.rows.filter((r) => matches(r, where));
      return { _sum: { size: hit.reduce((s, r) => s + Number(r.size ?? 0), 0) } };
    },
  };
}

/** 只支持本测试用到的 where 形态：等值、null、{not:null} */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null;
    if (v && typeof v === 'object' && 'not' in (v as object)) return row[k] !== null;
    return row[k] === v;
  });
}

function makeService() {
  const storage = new FakeStorage();
  const prisma = new FakePrisma();
  const providers = { storage } as unknown as Providers;
  const config = {
    get: () => ({ storage: { presignExpire: 900 } }),
  };
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
  const service = new FileService(prisma as never, config as never, logger as never, providers);
  return { service, storage, prisma };
}

const USER = 'user-1';
const PNG = {
  filename: 'photo.png',
  size: 1024,
  contentType: 'image/png',
  scene: 'uploaded' as const,
};

describe('FileService（M0-12 文件资产）', () => {
  describe('presign 直传签名', () => {
    it('正常文件返回上传地址与 objectKey', async () => {
      const { service, storage } = makeService();
      const r = await service.presign(USER, PNG);

      expect(r.uploadUrl).toContain('fake.test');
      expect(r.expiresIn).toBe(900);
      expect(storage.presigned).toContain(r.objectKey);
    });

    it('objectKey 遵循 {scene}/{userId}/{yyyyMM}/{uuid}.{ext}', async () => {
      const { service } = makeService();
      const r = await service.presign(USER, PNG);
      const parts = r.objectKey.split('/');

      expect(parts[0]).toBe('uploaded');
      expect(parts[1]).toBe(USER);
      expect(parts[2]).toMatch(/^\d{6}$/);
      expect(parts[3]).toMatch(/^[0-9a-f-]{36}\.png$/);
    });

    it('超过大小上限时抛 FileTooLarge', async () => {
      const { service } = makeService();
      // 图片上限 20MB
      await expect(service.presign(USER, { ...PNG, size: 21 * 1024 * 1024 })).rejects.toMatchObject(
        {
          code: 40031,
        },
      );
    });

    it('不支持的类型抛 FileFormatUnsupported', async () => {
      const { service } = makeService();
      await expect(service.presign(USER, { ...PNG, filename: 'virus.exe' })).rejects.toMatchObject({
        code: 40032,
      });
    });

    it('边界值：恰好等于上限应通过', async () => {
      const { service } = makeService();
      const r = await service.presign(USER, { ...PNG, size: 20 * 1024 * 1024 });
      expect(r.objectKey).toBeTruthy();
    });
  });

  describe('confirm 确认上传', () => {
    it('对象不存在时拒绝落库（避免"有记录没文件"）', async () => {
      const { service } = makeService();
      await expect(
        service.confirm(USER, {
          objectKey: 'uploaded/x/202609/abc.png',
          filename: 'a.png',
          size: 100,
          scene: 'uploaded',
        }),
      ).rejects.toMatchObject({ code: 40033 });
    });

    it('对象存在时落库，type 存文件类别而非扩展名', async () => {
      const { service, storage, prisma } = makeService();
      const key = 'uploaded/user-1/202609/abc.pptx';
      storage.objects.add(key);

      const r = await service.confirm(USER, {
        objectKey: key,
        filename: '方案.pptx',
        size: 2048,
        scene: 'uploaded',
      });

      expect(r.type).toBe('document'); // 不是 'pptx'，与小程序图标映射对齐
      expect(r.name).toBe('方案.pptx');
      expect(prisma.rows).toHaveLength(1);
    });

    it('文件名中的路径字符被清洗', async () => {
      const { service, storage } = makeService();
      const key = 'uploaded/u/202609/x.png';
      storage.objects.add(key);

      const r = await service.confirm(USER, {
        objectKey: key,
        filename: '../../etc/passwd.png',
        size: 10,
        scene: 'uploaded',
      });

      expect(r.name).not.toContain('/');
      expect(r.name).not.toContain('..');
    });
  });

  describe('列表与归属校验', () => {
    it('只返回自己的文件', async () => {
      const { service, storage } = makeService();
      await seedOne(service, storage, USER, 'a.png');
      await seedOne(service, storage, 'user-2', 'b.png');

      const list = await service.list(USER, {});
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('a.png');
    });

    it('按场景筛选', async () => {
      const { service, storage } = makeService();
      await seedOne(service, storage, USER, 'a.png', 'uploaded');
      await seedOne(service, storage, USER, 'b.png', 'ai_generated');

      expect(await service.list(USER, { scene: 'ai_generated' })).toHaveLength(1);
    });

    it('访问他人文件抛 NoPermission（40313）', async () => {
      const { service, storage } = makeService();
      const id = await seedOne(service, storage, USER, 'a.png');

      await expect(service.detail('user-2', id)).rejects.toMatchObject({ code: 40313 });
    });

    it('不存在的文件抛 NotFound（40401）', async () => {
      const { service } = makeService();
      await expect(service.detail(USER, 'nope')).rejects.toMatchObject({ code: 40401 });
    });
  });

  describe('回收站', () => {
    it('删除是软删，默认列表不再返回', async () => {
      const { service, storage } = makeService();
      const id = await seedOne(service, storage, USER, 'a.png');

      await service.remove(USER, id);
      expect(await service.list(USER, {})).toHaveLength(0);
      expect(await service.list(USER, { trashed: true })).toHaveLength(1);
    });

    it('可从回收站恢复', async () => {
      const { service, storage } = makeService();
      const id = await seedOne(service, storage, USER, 'a.png');

      await service.remove(USER, id);
      await service.restore(USER, id);
      expect(await service.list(USER, {})).toHaveLength(1);
    });

    it('回收站中的文件不能直接下载', async () => {
      const { service, storage } = makeService();
      const id = await seedOne(service, storage, USER, 'a.png');

      await service.remove(USER, id);
      await expect(service.downloadUrl(USER, id)).rejects.toMatchObject({ code: 40401 });
    });
  });

  describe('下载与用量', () => {
    it('生成下载地址并累计下载次数', async () => {
      const { service, storage } = makeService();
      const id = await seedOne(service, storage, USER, 'a.png');

      const r = await service.downloadUrl(USER, id);
      expect(r.url).toContain('download=1');
      expect((await service.detail(USER, id)).downloadCount).toBe(1);
    });

    it('用量只统计未删除文件，并单独给出回收站数量', async () => {
      const { service, storage } = makeService();
      const a = await seedOne(service, storage, USER, 'a.png', 'uploaded', 1000);
      await seedOne(service, storage, USER, 'b.png', 'uploaded', 2000);
      await service.remove(USER, a);

      const usage = await service.storageUsage(USER);
      expect(usage.usedBytes).toBe(2000);
      expect(usage.fileCount).toBe(1);
      expect(usage.trashedCount).toBe(1);
    });
  });
});

describe('buildObjectKey / parseEndpoint', () => {
  it('objectKey 用 uuid 而非原文件名，避免中文与重名', () => {
    const k1 = buildObjectKey('uploaded', 'u1', '中文 名称.png');
    const k2 = buildObjectKey('uploaded', 'u1', '中文 名称.png');
    expect(k1).not.toBe(k2); // uuid 保证唯一
    expect(k1).not.toContain('中文');
    expect(k1.endsWith('.png')).toBe(true);
  });

  it('parseEndpoint 解析 http / https / 显式端口', () => {
    expect(parseEndpoint('http://localhost:9000')).toEqual({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
    });
    expect(parseEndpoint('https://oss-cn-hangzhou.aliyuncs.com')).toEqual({
      endPoint: 'oss-cn-hangzhou.aliyuncs.com',
      port: 443,
      useSSL: true,
    });
    expect(parseEndpoint('http://minio:9000')).toEqual({
      endPoint: 'minio',
      port: 9000,
      useSSL: false,
    });
  });

  it('parseEndpoint 对非法输入回退默认值，不抛错', () => {
    expect(parseEndpoint('not-a-url')).toEqual({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
    });
  });
});

describe('存储不可用时的错误映射', () => {
  it('连接类错误映射为 StorageUnavailable（50363），不笼统成 500', async () => {
    const { service, storage } = makeService();
    storage.presignPut = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
    };

    await expect(service.presign(USER, PNG)).rejects.toMatchObject({ code: 50363 });
  });

  it('业务异常不被错误映射吞掉（仍抛 FileTooLarge）', async () => {
    const { service } = makeService();
    await expect(service.presign(USER, { ...PNG, size: 99 * 1024 * 1024 })).rejects.toMatchObject({
      code: 40031,
    });
  });
});

/** 造一条已确认的文件记录，返回 id */
async function seedOne(
  service: FileService,
  storage: FakeStorage,
  userId: string,
  filename: string,
  scene = 'uploaded',
  size = 1024,
): Promise<string> {
  const key = `${scene}/${userId}/202609/${filename}`;
  storage.objects.add(key);
  const item = await service.confirm(userId, {
    objectKey: key,
    filename,
    size,
    scene: scene as 'uploaded',
  });
  return item.id;
}

describe('FileService.publicAvatarUrl —— 头像公开读的边界', () => {
  /**
   * 这是全项目唯一一个**无需登录**就能取文件的路径，所以它的判据必须逐条钉住：
   * 一旦 scene 白名单写漏，`verification`（学生证照片）就会变成任何人拿 id 都能看的公开对象，
   * 而这件事不会有任何报错 —— 界面照常、测试照常绿。
   */
  const PRIVATE_SCENES = ['verification', 'order_delivery', 'uploaded', 'ai_generated', 'other'];

  it('avatar 场景放行，且用的是头像专用长时效（不是下载那套 900 秒）', async () => {
    const { service, storage } = makeService();
    const id = await seedOne(service, storage, USER, 'me.png', 'avatar');

    const url = await service.publicAvatarUrl(id);

    expect(url).toContain('avatar/');
    expect(storage.lastGetTtl).toBe(30 * 24 * 60 * 60);
    expect(storage.lastGetTtl).not.toBe(900);
  });

  it('非 avatar 的每一个场景都必须 404（逐个点名，不接受"默认拒绝"一句带过）', async () => {
    for (const scene of PRIVATE_SCENES) {
      const { service, storage } = makeService();
      const id = await seedOne(service, storage, USER, 'doc.png', scene);
      await expect(service.publicAvatarUrl(id)).rejects.toThrow(/头像不存在/);
    }
  });

  it('软删（进回收站）的头像立即不可读', async () => {
    const { service, storage } = makeService();
    const id = await seedOne(service, storage, USER, 'me.png', 'avatar');

    await service.remove(USER, id);

    await expect(service.publicAvatarUrl(id)).rejects.toThrow(/头像不存在/);
  });

  it('不存在的 id 与不可读的 id 回同一句话：不告诉探测者"哪个 id 真的存在"', async () => {
    const { service } = makeService();
    await expect(service.publicAvatarUrl('does-not-exist')).rejects.toThrow(/头像不存在/);
  });
});
