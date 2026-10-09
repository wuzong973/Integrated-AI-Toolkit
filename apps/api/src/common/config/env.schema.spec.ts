import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

/** 只填没有默认值的必填项，其余走 schema 默认值 */
const REQUIRED = {
  DATABASE_URL: 'mysql://qz:pwd@localhost:3306/qingzhi',
  JWT_SECRET: 'a'.repeat(32),
};

describe('validateEnv（启动期环境变量强校验）', () => {
  it('必填项齐全时通过，并补齐默认值', () => {
    const env = validateEnv({ ...REQUIRED });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.API_PREFIX).toBe('/api/v1');
    expect(env.PROVIDER_MODE).toBe('hybrid');
  });

  it('缺失项报错时把变量名全部列出，而不是只报第一个', () => {
    expect(() => validateEnv({})).toThrowError(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });

  it('JWT_SECRET 太短直接拒绝（弱密钥不允许启动）', () => {
    expect(() => validateEnv({ ...REQUIRED, JWT_SECRET: '123' })).toThrowError(/JWT_SECRET/);
  });

  it('PORT 之类由字符串转数字（.env 里全是字符串）', () => {
    const env = validateEnv({ ...REQUIRED, PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  describe('超时 vs 总预算（跨字段约束，配错拒绝启动）', () => {
    it('单次超时大于总预算时拒绝启动（否则重试与降级都形同虚设）', () => {
      // 实测指纹：这样配会让第一次尝试吃掉全部预算，作业跑满整个预算后失败，
      // 且日志里没有任何降级记录 —— 极难归因，所以在启动期就拦下。
      expect(() =>
        validateEnv({ ...REQUIRED, LLM_TIMEOUT_MS: '25000', LLM_TOTAL_BUDGET_MS: '20000' }),
      ).toThrowError(/LLM_TIMEOUT_MS\(25000ms\) > LLM_TOTAL_BUDGET_MS\(20000ms\)/);
    });

    it('相等也允许（此时单次调用可跑满整个预算）', () => {
      const env = validateEnv({
        ...REQUIRED,
        LLM_TIMEOUT_MS: '25000',
        LLM_TOTAL_BUDGET_MS: '25000',
      });
      expect(env.LLM_TIMEOUT_MS).toBe(25000);
    });

    it('默认值本身满足约束，且仍在跨端上限内', () => {
      const env = validateEnv({ ...REQUIRED });
      expect(env.LLM_TIMEOUT_MS).toBeLessThanOrEqual(env.LLM_TOTAL_BUDGET_MS);
      expect(env.ASR_TIMEOUT_MS).toBeLessThanOrEqual(env.ASR_TOTAL_BUDGET_MS);
    });

    it('ASR 侧受同一约束', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, ASR_TIMEOUT_MS: '30000', ASR_TOTAL_BUDGET_MS: '25000' }),
      ).toThrowError(/ASR_TIMEOUT_MS\(30000ms\) > ASR_TOTAL_BUDGET_MS\(25000ms\)/);
    });

    it('服务端预算超过客户端超时余量时拒绝启动（A2 超时倒挂）', () => {
      // 为什么必须拦：预算比客户端超时大时，用户 30s 后看到"请求超时"以为失败，
      // 而服务端仍在跑、还会落库扣费 —— 客户端判失败、服务端判成功。
      expect(() => validateEnv({ ...REQUIRED, LLM_TOTAL_BUDGET_MS: '40000' })).toThrowError(
        /LLM_TOTAL_BUDGET_MS\(40000ms\) 大于客户端超时余量\(25000ms\)/,
      );
    });

    it('ASR 预算同样受客户端超时约束', () => {
      expect(() => validateEnv({ ...REQUIRED, ASR_TOTAL_BUDGET_MS: '40000' })).toThrowError(
        /ASR_TOTAL_BUDGET_MS\(40000ms\) 大于客户端超时余量\(25000ms\)/,
      );
    });

    it('刚好贴上限（25000）允许通过', () => {
      const env = validateEnv({
        ...REQUIRED,
        LLM_TOTAL_BUDGET_MS: '25000',
        LLM_TIMEOUT_MS: '12000',
      });
      expect(env.LLM_TOTAL_BUDGET_MS).toBe(25000);
    });
  });

  describe('LOG_MASK_SENSITIVE（红线：生产必须脱敏）', () => {
    it('未设置时默认开启', () => {
      expect(validateEnv({ ...REQUIRED }).LOG_MASK_SENSITIVE).toBe(true);
    });

    it.each(['false', '0', 'no', 'off', 'FALSE'])('"%s" 判为关闭', (raw) => {
      expect(validateEnv({ ...REQUIRED, LOG_MASK_SENSITIVE: raw }).LOG_MASK_SENSITIVE).toBe(false);
    });

    it.each(['true', '1', 'yes', 'on', 'TRUE'])('"%s" 判为开启', (raw) => {
      expect(validateEnv({ ...REQUIRED, LOG_MASK_SENSITIVE: raw }).LOG_MASK_SENSITIVE).toBe(true);
    });

    it('非法取值直接报错，不静默按默认值跑', () => {
      expect(() => validateEnv({ ...REQUIRED, LOG_MASK_SENSITIVE: 'maybe' })).toThrowError(
        /LOG_MASK_SENSITIVE/,
      );
    });
  });
});
