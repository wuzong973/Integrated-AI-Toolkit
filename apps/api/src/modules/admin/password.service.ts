import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt 默认成本参数。
 *
 * N=2^14 / r=8 / p=1 是 scrypt 的常见起手档位（约 16MB 内存、单次几十毫秒）。
 * `maxmem` 必须显式给：Node 默认上限 32MB，而它按 `128 * N * r` 校验，
 * 将来把 N 提高一倍就会撞上限并抛错 —— 显式带上，改参数时不会踩到这条隐规则。
 */
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

/**
 * 管理员密码哈希（任务清单 M0-23）
 *
 * ## 为什么用 scrypt 而不是 bcrypt / argon2
 *
 * 两者都要装原生依赖（`bcrypt` 需要编译、`argon2` 同样是原生模块），
 * 而 `node:crypto` 里就带着 scrypt，**零依赖**。项目本来就要求
 * "引入新依赖先登记 `OPEN_SOURCE_LICENSES.md`"，能不引就不引。
 * 安全强度上 scrypt 与 bcrypt 同级（都是抗 GPU 的内存硬函数），够用。
 *
 * ## 为什么参数要存进哈希串
 *
 * 存成 `scrypt$N$r$p$salt$hash`：日后调高成本参数时，**旧哈希仍按它自己的
 * 参数校验通过**，新密码才用新参数。若参数写死在代码里，改一次参数
 * 全部管理员立刻登不上（而且报错是"密码错误"，排查方向完全被误导）。
 *
 * ## 校验必须用 timingSafeEqual
 *
 * 用 `===` 比较哈希会在第一个不同字节处提前返回，把"前几个字节对不对"
 * 泄漏成时间差，理论上可被逐字节爆破。`timingSafeEqual` 是常数时间比较。
 * 它要求两侧**长度相等**，长度不等时会抛错 —— 所以先比长度、长度不同直接判否。
 */
@Injectable()
export class PasswordService {
  /** 生成哈希（存入 `admin_account.password_hash`） */
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scrypt(plain, salt, KEY_LENGTH, DEFAULT_PARAMS);
    const { N, r, p } = DEFAULT_PARAMS;
    return [PREFIX, N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
  }

  /**
   * 校验明文是否匹配哈希。
   *
   * 任何格式异常（不是本服务产出的串、字段缺失、数字解析失败）都返回 `false`
   * 而不是抛异常 —— 调用方只关心"能不能登录"，抛异常会让一条脏数据
   * 变成 500，把"这个人登不上"升级成"整个登录接口报错"。
   */
  async verify(plain: string, stored: string): Promise<boolean> {
    const parsed = parseHash(stored);
    if (!parsed) return false;
    if (!plain) return false;

    try {
      const derived = await scrypt(plain, parsed.salt, parsed.hash.length, parsed.params);
      return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
    } catch {
      return false;
    }
  }
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

/** 解析 `scrypt$N$r$p$salt$hash`；任何异常返回 null */
function parseHash(stored: string): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isPositiveInt(N) || !isPositiveInt(r) || !isPositiveInt(p)) return null;

  const salt = Buffer.from(parts[4]!, 'base64');
  const hash = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || hash.length === 0) return null;

  return { params: { N, r, p, maxmem: 128 * N * r * 2 }, salt, hash };
}

function isPositiveInt(v: number): boolean {
  return Number.isInteger(v) && v > 0;
}
