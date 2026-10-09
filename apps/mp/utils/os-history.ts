/**
 * 聊天记录（`pkg-os/history` 页）的纯逻辑与类型。
 *
 * ## 为什么不并进 `utils/os.ts`
 *
 * `utils/os.ts` 已到 257/300 行（ESLint `max-lines`），`pages/os/index.ts` 更是
 * 贴着 296/300 —— 而"会话时间怎么写、记录怎么按日期分段"这些**纯函数**
 * 本来就与对话渲染无关：放这里能被单测直接打靶，也不挤占页面预算。
 *
 * ## 数据来源与顺序约定
 *
 *   · `GET /os/sessions`            → 后端 `updatedAt desc`（最近活跃在前）
 *   · `GET /os/sessions/:id/messages` → 后端 `createdAt asc`（正序）
 *
 * 后端的顺序**本地再排一次**（见 `buildLog`）：客户端不该假定服务端排序永不变化，
 * 而"记录倒着显示"这种错在真机上很难第一时间看出来。
 */
import type { OsMessageItem, OsSessionItem } from './api-types';
import { toCardView, type ChatMessage, type MsgKind, type MsgRole } from './os';

/**
 * 单次最多渲染的记录条数（只取**最近** N 条）。
 *
 * 为什么要有上限：一个会话可以攒到几百条消息，一次性 `setData` 会把低端机
 * 卡住（要求 5）。取 80 是"够翻看一段完整对话"与"渲染开销可控"的折中 ——
 * 规模更大的翻阅应该由本页的「会话列表」承担，而不是把整段历史铺平。
 */
export const LOG_LIMIT = 80;

/** 被截断时的如实提示：不能装作"这就是全部记录"（红线 9） */
export const TRUNCATE_TIP = `仅显示最近 ${LOG_LIMIT} 条，更早的记录暂未展示`;

/** 会话列表行（在 `OsSessionItem` 之上补纯展示字段） */
export interface SessionRow extends OsSessionItem {
  /** 最近活跃时间文案 */
  timeText: string;
}

/**
 * 记录行。
 *
 * 在 `ChatMessage` 之上补的全是**纯展示字段** —— WXML 里不能调函数，
 * 凡是"要算一下才能显示"的东西都必须在进 `setData` 之前算好
 *（模板表达式出错时不报错，只会静默渲染成空白）。
 */
export interface LogRow extends ChatMessage {
  /** `HH:mm` */
  timeText: string;
  /** 该行上方的日期分隔标题（今天 / 昨天 / 9月18日 …） */
  dayText: string;
  /** 是否在这一行上方画日期分隔（同一天只在首条显示） */
  showDay: boolean;
  /** 「我」/ 助手名 / 「系统」 */
  roleLabel: string;
}

const MS_MIN = 60_000;
const DAY_MS = 86_400_000;

/** ISO 串 → Date；读不出时间返回 null（而不是把 `Invalid Date` 往下传） */
function parseDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 两个时刻相隔的**自然日**数（按本地日历算，不是 24 小时整除） */
function dayGap(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / DAY_MS);
}

/**
 * 会话的最近活跃时间：`刚刚` / `30 分钟前` / `今天 08:00` / `昨天 20:15` /
 * `09-16 10:00` / `2025-12-31`。
 *
 * 分级是为了**信息密度**：越近的越精确到相对时间，越远的越省地方。
 * 时间读不出来时如实说"时间未知"，不铺一串 `Invalid Date`。
 */
export function formatSessionTime(iso: string, now: Date = new Date()): string {
  const d = parseDate(iso);
  if (!d) return '时间未知';

  const diff = now.getTime() - d.getTime();
  // 负数（客户端时钟比服务端慢时会出现）也归到"刚刚"，不显示"−3 分钟前"
  if (diff < MS_MIN) return '刚刚';
  if (diff < 60 * MS_MIN) return `${Math.floor(diff / MS_MIN)} 分钟前`;

  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const gap = dayGap(d, now);
  if (gap === 0) return `今天 ${hm}`;
  if (gap === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 记录里的日期分隔标题：`今天` / `昨天` / `前天` / `9月18日` / `2025年9月18日` */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = parseDate(iso);
  if (!d) return '时间未知';

  const gap = dayGap(d, now);
  if (gap === 0) return '今天';
  if (gap === 1) return '昨天';
  if (gap === 2) return '前天';

  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 后端会话 → 列表行（只补一个时间文案，其余原样透出） */
export function toSessionRows(items: OsSessionItem[], now: Date = new Date()): SessionRow[] {
  return items.map((s) => ({ ...s, timeText: formatSessionTime(s.updatedAt, now) }));
}

/** 时间戳；读不出时间的排到最后（稳定排序保证它们之间仍按原顺序） */
function sortKey(m: OsMessageItem): number {
  const d = parseDate(m.createdAt);
  return d ? d.getTime() : Number.MAX_SAFE_INTEGER;
}

/** 后端 role → 渲染角色白名单（表外一律按助手，避免样式落空） */
function toRole(v: string): MsgRole {
  return v === 'user' || v === 'system' ? v : 'assistant';
}

/** 后端 contentType → 渲染形态白名单 */
function toKind(v: string): MsgKind {
  return v === 'card' || v === 'buttons' || v === 'file' ? v : 'text';
}

function roleLabel(role: string, agentName?: string): string {
  if (role === 'user') return '我';
  if (role === 'system') return '系统';
  return agentName || '青智 OS';
}

/**
 * 后端消息 → 可渲染的记录行（**时间正序**）。
 *
 * 两件必须做的事：
 *   ① **排序** —— 后端给的是 `createdAt asc`，这里仍排一次；
 *   ② **只取最近 `LOG_LIMIT` 条** —— 全量铺开会让低端机掉帧，
 *      截断了就由 `truncated` 如实告诉用户（不能装作这就是全部记录）。
 *
 * 返回的 `rows` 已按天分好段（`showDay` / `dayText`），模板里不用再判断。
 */
export function buildLog(
  items: OsMessageItem[],
  options: { limit?: number; now?: Date } = {},
): { rows: LogRow[]; truncated: boolean } {
  const limit = options.limit ?? LOG_LIMIT;
  const now = options.now ?? new Date();

  const sorted = [...items].sort((a, b) => sortKey(a) - sortKey(b));
  const truncated = sorted.length > limit;
  // 取**最近**的 N 条（而不是最早 N 条）：用户想看的是刚刚聊过什么
  const kept = truncated ? sorted.slice(-limit) : sorted;

  let lastDay = '';
  const rows = kept.map((m) => {
    const dayText = dayLabel(m.createdAt, now);
    const showDay = dayText !== lastDay;
    lastDay = dayText;

    const d = parseDate(m.createdAt);
    return {
      id: m.id,
      role: toRole(m.role),
      agentName: m.agentName,
      kind: toKind(m.kind),
      content: m.content,
      createdAt: m.createdAt,
      // 卡片也要转成视图对象：状态文案 / 能否点击 / 参数摘要都要提前算好
      ...(m.cards?.length ? { cards: m.cards.map(toCardView) } : {}),
      timeText: d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '',
      dayText,
      showDay,
      roleLabel: roleLabel(m.role, m.agentName),
    };
  });

  return { rows, truncated };
}
