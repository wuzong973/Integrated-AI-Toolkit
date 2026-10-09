/**
 * 个人信息编辑页的字段规则与提交体构造。
 *
 * ## 为什么单独成文件而不是写在页面里
 *
 * 手机号格式规则在这里是 `packages/core` 的 `CHINA_MOBILE_PATTERN` 的**第二份实现** ——
 * 小程序 import 不到 `@qz/core`（微信开发者工具解析不到，见 `utils/gpa.ts` 与
 * `utils/date-calc.ts` 的同款说明）。两处实现必须有漂移守卫，而守卫要能 import 到
 * 这一份，所以规则放在这里而不是埋在页面的 `Page({})` 里（测试拿不到 Page 内部）。
 *
 * ⚠️ 服务端仍是唯一权威：这里只负责"别让用户白填一次"，
 * 真正的拦截在 `UpdateProfileSchema`。改号段时两处都要改，
 * 漏改的表现为"界面放行、保存报参数错误"，`tests/mp/profile-fields.spec.ts` 会拦这件事。
 */
import type { ProfileUpdatePayload } from './api-types';

/** 中国大陆手机号（core 的 `CHINA_MOBILE_PATTERN` 镜像） */
export const CHINA_MOBILE_RE = /^1[3-9]\d{9}$/;

/** 只允许数字，且必须是 11 位 */
export function phoneError(value: string): string | null {
  const v = value.trim();
  if (!v) return null; // 空值交给"不提交这个字段"处理
  if (!CHINA_MOBILE_RE.test(v)) return '手机号要填 11 位大陆号码，检查一下有没有多填或少填';
  return null;
}

export interface GenderOption {
  value: GenderValue;
  label: string;
}

/**
 * 性别取值。与 core 的 `Gender` 枚举一一对应 —— 小程序 import 不到 core，
 * 所以这里是第二份，由 `tests/mp/profile-fields.spec.ts` 做漂移守卫。
 *
 * `unspecified` 是一个**主动选择**，和"从没填过"（表单里是空串）不同：
 * 选了它之后界面不再提示补全。
 */
export type GenderValue = 'male' | 'female' | 'unspecified';

export const GENDER_OPTIONS: GenderOption[] = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
  { value: 'unspecified', label: '不想说' },
];

const GENDER_VALUES = new Set<string>(GENDER_OPTIONS.map((o) => o.value));

/** 表单当前值（全部是字符串，未填即空串） */
export interface ProfileForm {
  nickname: string;
  avatar: string;
  bio: string;
  college: string;
  grade: string;
  gender: string;
  phone: string;
}

export const EMPTY_FORM: ProfileForm = {
  nickname: '',
  avatar: '',
  bio: '',
  college: '',
  grade: '',
  gender: '',
  phone: '',
};

/** 提交体直接用 `api-types` 里那个类型，避免同一份契约出现两种形状 */
export type ProfilePayload = ProfileUpdatePayload;

/**
 * 纯文本字段。`gender` 刻意不在这里 —— 它的提交体类型是三个字面量的联合，
 * 和"表单里可能是空串（还没选过）"对不上，所以单独走一条收窄过的分支。
 */
const TEXT_FIELDS = ['nickname', 'avatar', 'bio', 'college', 'grade', 'phone'] as const;

/**
 * 只把**改动过**的字段放进提交体。
 *
 * ⚠️ 这条不是省流量，是防一类具体的错：`user.phone` 是 `@unique`，
 * 如果把没动过的手机号一起发回去、而它恰好被别的账号占着（例如数据迁移过），
 * 用户只是改了个昵称却会看到"该手机号已被其他账号绑定"。
 * 昵称同理：全量回发会把服务端刚改过的值覆盖回去。
 */
export function buildProfilePayload(original: ProfileForm, next: ProfileForm): ProfilePayload {
  const out: ProfilePayload = {};
  for (const key of TEXT_FIELDS) {
    const before = (original[key] ?? '').trim();
    const after = (next[key] ?? '').trim();
    if (before !== after) out[key] = after;
  }
  // 空串 = 从没选过，服务端不接受，不发；选过之后也只能换成三个值之一，不会退回空串
  const gender = (next.gender ?? '').trim();
  if (GENDER_VALUES.has(gender) && gender !== (original.gender ?? '').trim()) {
    out.gender = gender as GenderValue;
  }
  return out;
}

/** 有没有改动（决定保存按钮是否可点） */
export function isDirty(original: ProfileForm, next: ProfileForm): boolean {
  return Object.keys(buildProfilePayload(original, next)).length > 0;
}
