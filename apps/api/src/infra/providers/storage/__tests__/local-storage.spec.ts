import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalStorageProvider, signLocalToken, verifyLocalToken } from '../local-storage.provider';

const SECRET = 'test-secret';

describe('local 存储令牌（签名与过期）', () => {
  it('签名后可校验，载荷完整还原', () => {
    const token = signLocalToken(
      { k: 'uploaded/u1/202609/a.png', op: 'put', exp: Date.now() + 60_000 },
      SECRET,
    );
    const payload = verifyLocalToken(token, SECRET);

    expect(payload?.k).toBe('uploaded/u1/202609/a.png');
    expect(payload?.op).toBe('put');
  });

  it('换一个密钥即校验失败（不可伪造）', () => {
    const token = signLocalToken({ k: 'a.png', op: 'get', exp: Date.now() + 60_000 }, SECRET);
    expect(verifyLocalToken(token, 'other-secret')).toBeNull();
  });

  it('篡改载荷会让签名失效', () => {
    const token = signLocalToken({ k: 'a.png', op: 'get', exp: Date.now() + 60_000 }, SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ k: 'b.png', op: 'get', exp: Date.now() + 60_000 }),
    ).toString('base64url');
    expect(verifyLocalToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it('过期令牌校验失败', () => {
    const token = signLocalToken({ k: 'a.png', op: 'get', exp: Date.now() - 1000 }, SECRET);
    expect(verifyLocalToken(token, SECRET)).toBeNull();
  });

  it('畸形令牌不抛错，返回 null', () => {
    for (const bad of ['', 'nodot', '.', 'a.b', 'x.y.z']) {
      expect(verifyLocalToken(bad, SECRET)).toBeNull();
    }
  });
});

describe('LocalStorageProvider（读写与路径穿越防护）', () => {
  let dir: string;
  let provider: LocalStorageProvider;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qz-local-storage-'));
    provider = new LocalStorageProvider({
      baseDir: dir,
      baseUrl: 'http://localhost:3000/api/v1',
      secret: SECRET,
      presignExpire: 900,
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('写入后可读取、可判断存在、可删除', async () => {
    const key = 'uploaded/u1/202609/hello.txt';
    expect(await provider.exists(key)).toBe(false);

    await provider.putObject(key, Buffer.from('hello 青智'));
    expect(await provider.exists(key)).toBe(true);
    expect((await provider.getObject(key)).toString('utf8')).toBe('hello 青智');

    await provider.deleteObject(key);
    expect(await provider.exists(key)).toBe(false);
  });

  it('presignPut 返回带令牌的上传地址，且载荷绑定对象键', async () => {
    const r = await provider.presignPut('uploaded/u1/202609/a.png', 'image/png');
    expect(r.uploadUrl).toMatch(/^http:\/\/localhost:3000\/api\/v1\/files\/local\/.+/);
    expect(r.headers['Content-Type']).toBe('image/png');
    expect(r.expiresIn).toBe(900);

    const token = r.uploadUrl.split('/files/local/')[1];
    expect(verifyLocalToken(token, SECRET)?.k).toBe('uploaded/u1/202609/a.png');
    expect(verifyLocalToken(token, SECRET)?.op).toBe('put');
  });

  it('presignGet 生成 op=get 的下载地址', async () => {
    const url = await provider.presignGet('uploaded/u1/202609/a.png');
    const token = url.split('/files/local/')[1];
    expect(verifyLocalToken(token, SECRET)?.op).toBe('get');
  });

  it('路径穿越被阻断（上传端点会收到外部传入的键）', async () => {
    for (const evil of ['../../etc/passwd', '..\\..\\windows\\system32', 'a/../../../b']) {
      await expect(provider.putObject(evil, Buffer.from('x'))).rejects.toThrow(
        /非法|越出|ENOENT|EACCES/,
      );
    }
  });
});
