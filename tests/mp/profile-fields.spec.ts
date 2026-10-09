import { describe, expect, it } from 'vitest';

import { CHINA_MOBILE_PATTERN, UpdateProfileSchema } from '../../packages/core/src/validators';
import { Gender } from '../../packages/core/src/enums';
import {
  buildProfilePayload,
  CHINA_MOBILE_RE,
  EMPTY_FORM,
  GENDER_OPTIONS,
  isDirty,
  phoneError,
  type ProfileForm,
} from '../../apps/mp/utils/profile-fields';

/**
 * 个人资料字段的漂移守卫与提交体构造（小程序侧）。
 *
 * ## 为什么必须有这个文件
 *
 * 小程序 import 不到 `@qz/core`（微信开发者工具解析不到），所以手机号正则和性别取值
 * 在小程序侧是**第二份实现**。第二份实现本身不是问题，"没人看着它漂移"才是：
 * 漂移的表现为界面放行了、服务端回 40001，用户觉得"我明明填对了"。
 * 这里把两份实现放在同一张样本表上对跑，任何一侧改动都会在这里变红。
 *
 * ## 顺带钉住 buildProfilePayload 的一条真实陷阱
 *
 * `user.phone` 是 `@unique`。如果提交体把没动过的字段也带上，
 * 用户只改昵称却会吃到"该手机号已被其他账号绑定"——
 * 这条在真实数据迁移后必然发生，所以单独有用例。
 */

const SAMPLES = [
  '13800001234',
  '19912345678',
  '1380000123',
  '138000012345',
  '12345678901',
  '10800001234',
  '8613800001234',
  '1380000123a',
  '',
  ' 13800001234',
  '13800001234 ',
];

describe('手机号规则：小程序侧与 core 必须同判', () => {
  it('每张样本上两份实现的判定完全一致', () => {
    for (const s of SAMPLES) {
      expect(CHINA_MOBILE_RE.test(s)).toBe(CHINA_MOBILE_PATTERN.test(s));
    }
  });

  it('字面量本身也一致（改了一处忘了另一处时，这条先红）', () => {
    expect(CHINA_MOBILE_RE.source).toBe(CHINA_MOBILE_PATTERN.source);
  });

  it('phoneError 的文案只在非法值时出现，且空值不报（空值交给"不提交该字段"）', () => {
    expect(phoneError('')).toBeNull();
    expect(phoneError('13800001234')).toBeNull();
    expect(phoneError('1380000123')).toMatch(/11 位/);
  });

  it('界面放行的号码，经提交链路送到服务端 schema 一定也放行（否则用户白填一次）', () => {
    // 关键是走**完整链路**：`phoneError` 判的是 trim 后的值，而真正发出去的是
    // `buildProfilePayload` trim 过的值。带空格的样本正好卡在这两步之间 ——
    // 只比 `phoneError` 与 schema 会得出"界面放行、服务端拒"的假结论。
    const base: ProfileForm = { ...EMPTY_FORM, phone: '' };
    for (const s of SAMPLES) {
      if (phoneError(s) !== null) continue;
      const sent = buildProfilePayload(base, { ...base, phone: s }).phone;
      if (sent === undefined) continue; // 空值不提交，服务端根本看不到
      expect(UpdateProfileSchema.safeParse({ phone: sent }).success).toBe(true);
    }
  });
});

describe('性别取值集合', () => {
  it('选项值与 core 的 Gender 枚举一一对应（顺序无关）', () => {
    expect([...GENDER_OPTIONS.map((o) => o.value)].sort()).toEqual(
      [...Object.values(Gender)].sort(),
    );
  });
});

describe('buildProfilePayload：只发改动过的字段', () => {
  const base: ProfileForm = {
    nickname: '青智同学1234',
    avatar: 'https://api.test/files/public/f1',
    bio: '',
    college: '计算机学院',
    grade: '2023',
    gender: 'female',
    phone: '13800001234',
  };

  it('什么都没改 → 空对象（而不是把七个字段原样发回去）', () => {
    expect(buildProfilePayload(base, { ...base })).toEqual({});
    expect(isDirty(base, { ...base })).toBe(false);
  });

  it('⭐ 只改昵称时**不得**带上手机号：phone 是 @unique，带上就可能撞别人的号', () => {
    const next = { ...base, nickname: '新昵称' };
    expect(buildProfilePayload(base, next)).toEqual({ nickname: '新昵称' });
  });

  it('改动过的字段才进提交体，且值被 trim 过', () => {
    const next = { ...base, grade: ' 2024 ', bio:  ' 会做 PPT ' };
    expect(buildProfilePayload(base, next)).toEqual({ grade: '2024', bio: '会做 PPT' });
  });

  it('清空一个字段是"改动"，要发空串而不是不发（否则删不掉）', () => {
    const next = { ...base, college: '' };
    expect(buildProfilePayload(base, next)).toEqual({ college: '' });
    expect(isDirty(base, next)).toBe(true);
  });
});
