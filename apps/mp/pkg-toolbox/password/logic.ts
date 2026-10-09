/**
 * 密码生成（纯函数，不依赖 wx API）
 *
 * 设计取舍：
 *   · **保证每种选中字符集至少出现一次** —— 用户勾了符号却在结果里一个符号都看不到，
 *     会以为开关是坏的；先各放一个再随机补齐，最后整体洗牌抹掉"前几位永远是大写"的结构；
 *   · 随机源由入参注入（默认 `Math.random`）：本地工具够用，且纯函数可测；
 *   · 长度钳制在 4~64，勾选集为空返回 null（页面据此提示，而不是硬给一个纯小写密码）。
 */

export interface PwdOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
}

/** 四类字符集（符号只放键盘上打得出来、肉眼不混淆的那批） */
const SETS: Record<keyof Omit<PwdOptions, 'length'>, string> = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  symbol: '!@#$%^&*()-_=+[]{};:,.<>?',
};

type SetKey = keyof typeof SETS;

const SET_KEYS: SetKey[] = ['lower', 'upper', 'digit', 'symbol'];

/** 选中的字符集列表（按 fixed 顺序，方便测试） */
export function pickedSets(opts: PwdOptions): string[] {
  return SET_KEYS.filter((k) => opts[k]).map((k) => SETS[k]);
}

const MIN_LEN = 4;
const MAX_LEN = 64;

function pick(set: string, rand: () => number): string {
  return set[Math.floor(rand() * set.length)];
}

/** 生成密码；一类字符都没选返回 null */
export function generatePassword(opts: PwdOptions, rand: () => number = Math.random): string | null {
  const sets = pickedSets(opts);
  if (!sets.length) return null;
  const len = Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round(opts.length)));
  const chars: string[] = sets.slice(0, len).map((s) => pick(s, rand));
  while (chars.length < len) {
    chars.push(pick(sets[Math.floor(rand() * sets.length)], rand));
  }
  return shuffle(chars, rand).join('');
}

/** Fisher-Yates 洗牌：不洗牌的话"每种至少一个"会集中在前几位，一眼看穿结构 */
function shuffle(chars: string[], rand: () => number): string[] {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars;
}

/** 强度提示：长度与字符集丰富度一起看（本地粗评，不做熵计算） */
export function strengthLabel(opts: PwdOptions): string {
  const sets = pickedSets(opts).length;
  if (opts.length >= 14 && sets >= 3) return '极强';
  if (opts.length >= 10 && sets >= 2) return '强';
  if (opts.length >= 8 && sets >= 2) return '中';
  return '弱';
}
