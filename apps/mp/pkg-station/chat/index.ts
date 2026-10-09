/**
 * 订单会话（任务清单 M3-19 站内沟通）
 *
 * ## 后端契约（以代码为准：`apps/api/src/modules/notification/conversation.controller.ts`）
 *   `POST /conversations`                `{ orderId }` → 建 / 取会话（幂等）
 *   `GET  /conversations`                我的会话列表（对方昵称、最后一条摘要、未读数）
 *   `GET  /conversations/:id/messages`   消息，`createdAt` **升序**分页；读取本身把对方的未读置为已读
 *   `POST /conversations/:id/messages`   `{ content }` → 落库 + 更新摘要 + 给对方建一条未读通知
 * 四个方法已在 `utils/notification-api.ts` 封成 `conversationApi`，本页**只调不改**。
 *
 * ## 只做轮询，不接 WebSocket
 * 后端本期就是轮询口径（取舍见 `conversation.service.ts` 文件头），站内信已经承担
 * "人不在线也要能看到"这件事；长连接要配网关升级、心跳重连，不是首版该有的复杂度。
 * 本页节奏：`onShow` 补一拍 + 前台每 5 秒一拍，`onHide` / `onUnload` **必须清定时器**。
 *
 * ## 三种进入方式
 *  ① `?orderId=`          —— 订单详情「联系对方」：`conversationApi.open(orderId)` 建/取；
 *  ② `?conversationId=`   —— 消息中心「某人给你发来一条消息」：那条通知的 `refId` 是
 *                            **会话 id 而不是订单 id**，所以只能从会话列表里定位这一条；
 *  ③ 什么都没带 / 只带 `taskId` —— 没有可谈的单：如实说明 + 「去我的订单」引导（保留原页行为）。
 *
 * ## ⚠️ 一条会话 = 一对用户，不是一笔订单
 * `conversation` 的唯一键是 `(participant_a, participant_b)`：同一对用户为第二笔订单再
 * `open` 一次，拿回来的还是原来那条会话（`orderId` 仍是第一次那笔）。所以顶部的订单摘要
 * 只能当"这条会话因哪一单而起"，**不能当成"当前正在谈的订单"**。
 *
 * 视觉：蓝绿主题（`th-chat`，圆角 28）· 反向流线 + 光斑；气泡左右分侧、跨自然日插时间分隔。
 */
import type { ConversationItem, MessageItem, OrderItem } from '../../utils/api';
import { conversationApi, orderApi } from '../../utils/api';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { orderStatusText } from '../../utils/order-status';
import { toastError } from '../../utils/request';

/** 页面阶段：首屏骨架 / 会话 / 没带订单的引导 / 错误重试 */
type Stage = 'loading' | 'chat' | 'guide' | 'error';

/** 气泡 = 接口字段里界面上用得着的四个 + 两个时间展示派生 */
interface Bubble {
  id: string;
  mine: boolean;
  content: string;
  timeText: string;
  dayText: string;
  /** 与上一条是否跨了自然日（跨了才插日期分隔） */
  showDay: boolean;
}

/** 订单摘要卡字段（金额按项目纪律以「分」存储，展示时才换算成元） */
interface OrderBrief {
  orderNo: string;
  amountYuan: string;
  statusText: string;
  title: string;
}

/** 前台轮询间隔：后端没有推送，5 秒是"看起来跟得上"与"不打扰服务端"的折中 */
const POLL_MS = 5000;
/** 一屏消息条数（后端 `pageSize` 上限 50，见 `MessageListQuerySchema`） */
const MSG_PAGE = 20;
/**
 * 定位 `?conversationId=` 时翻的会话列表页大小（同样受后端 50 上限约束）。
 * 超出 50 条会话的老用户会定位不到 —— 那种情况进错误态，不猜一条会话出来。
 */
const CONVERSATION_PAGE = 50;
/**
 * 单条正文上限：后端 `MESSAGE_MAX_LEN` 在小程序侧的**镜像常量**
 * （小程序 import 不到 `apps/api`，只能留一份）。这里只用来省一次往返，
 * 服务端才是唯一权威：超了照样 40001，页面如实 toast 后端原文案。
 */
const MESSAGE_MAX = 500;

Page({
  data: {
    stage: 'loading' as Stage,
    error: '',
    /** 进入时带的三个参数：决定走 open / 定位 / 引导哪条路 */
    orderId: '',
    conversationId: '',
    taskId: '',
    peerName: '对方',
    bubbles: [] as Bubble[],
    order: null as OrderBrief | null,
    input: '',
    sending: false,
    /** 滚动锚点：新消息进来时把列表置底（`id="msg_<消息 id>"`） */
    scrollIntoView: '',
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',
  },

  /** 上一次拿到的最后一条消息 id（不放 data：它只用来判"要不要重画"，不参与渲染） */
  lastId: '',
  /** 前台轮询定时器（onHide / onUnload 必须清） */
  pollTimer: null as ReturnType<typeof setInterval> | null,

  onLoad(query: Record<string, string>) {
    const orderId = query?.orderId ?? '';
    const conversationId = query?.conversationId ?? '';
    this.setData({ orderId, conversationId, taskId: query?.taskId ?? '' });
    void this.enter();
  },

  onShow() {
    fxEnableTilt(this);
    // 会话还没建起来时不拉（enter() 会拉）；已建起来才"补一拍 + 起轮询"
    if (!this.data.conversationId) return;
    void this.pollTick();
    this.startPolling();
  },

  onHide() {
    fxDisableTilt();
    this.stopPolling();
  },

  onUnload() {
    fxDisableTilt();
    this.stopPolling();
  },

  /** 进入会话：按带进来的参数建/取会话；什么都没带就停在引导态（一个请求也不发） */
  async enter() {
    const { orderId, conversationId } = this.data;
    if (!orderId && !conversationId) {
      this.setData({ stage: 'guide', error: '' });
      return;
    }
    this.setData({ stage: 'loading', error: '' });
    try {
      const conv = orderId
        ? await conversationApi.open(orderId)
        : await findConversation(conversationId);
      if (!conv) {
        this.setData({
          stage: 'error',
          error: '没找到这条会话：它可能不属于你，或者这条提醒对应的那笔交易已经看不到了。',
        });
        return;
      }
      this.setData({
        conversationId: conv.id,
        // 会话的 orderId 是"起于哪一单"；按订单进来时两者一致
        orderId: conv.orderId ?? orderId,
        peerName: conv.peer.nickname,
        stage: 'chat',
      });
      wx.setNavigationBarTitle({ title: `与 ${conv.peer.nickname} 的会话` });
      await this.refresh();
      this.startPolling();
      void this.loadOrder(); // 摘要是辅助信息：拉不到也只是少一张卡
    } catch (e) {
      this.setData({ stage: 'error', error: (e as Error).message || '会话加载失败' });
    }
  },

  /**
   * 拉最近一屏并整屏覆盖（服务端是唯一真相）。
   *
   * 内容没变就直接 return：每 5 秒重排一次整屏会把用户往上看的滚动位置顶回底部。
   * 有新消息才置底 —— 交易沟通一屏量级，本期不做"你在上面看历史时不抢你的屏"。
   */
  async refresh() {
    const list = await tailMessages(this.data.conversationId);
    const bubbles = toBubbles(list);
    const lastId = bubbles.length ? bubbles[bubbles.length - 1].id : '';
    if (lastId === this.lastId && bubbles.length === this.data.bubbles.length) return;
    this.lastId = lastId;
    this.setData({ bubbles, scrollIntoView: lastId ? `msg_${lastId}` : '' });
  },

  /** 轮询的一拍：发送中不打断（刚追加的气泡马上会被自己覆盖掉），失败静默等下一拍 */
  async pollTick() {
    if (this.data.sending || this.data.stage !== 'chat') return;
    try {
      await this.refresh();
    } catch {
      // 后台轮询失败不改界面：已经在屏上的内容仍然可读，5 秒后再试
    }
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.pollTick(), POLL_MS);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  /** 订单摘要（`GET /orders/:id`）：失败只是少一张卡，不挡会话 */
  async loadOrder() {
    const id = this.data.orderId;
    if (!id) return;
    try {
      const o: OrderItem = await orderApi.detail(id);
      this.setData({
        order: {
          orderNo: o.orderNo,
          amountYuan: (o.amount / 100).toFixed(2),
          statusText: orderStatusText(o.status),
          title: o.task?.title || '驿站任务订单',
        },
      });
    } catch {
      this.setData({ order: null });
    }
  },

  onRetry() {
    void this.enter();
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ input: e.detail.value });
  },

  /**
   * 发送：正文交给服务端落库与送审（M4-05）。
   *
   * 成功后把**服务端返回的那条**挂到末尾（`createdAt` 用它给的，不是本地猜的时间），
   * 输入框立刻清空；下一次轮询拉到的是同一屏内容，会整屏覆盖，不会留下重复气泡。
   * 失败一律如实 toast：送审不通过（40051）后端文案已经说清"改什么、下一步做什么"，
   * 绝不在这里显示"发送成功"。
   */
  async onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.sending || !this.data.conversationId) return;
    if (text.length > MESSAGE_MAX) {
      wx.showToast({ title: `单条消息不超过 ${MESSAGE_MAX} 字`, icon: 'none' });
      return;
    }
    this.setData({ sending: true });
    try {
      const sent = await conversationApi.send(this.data.conversationId, text);
      this.setData({ input: '' });
      this.appendBubble(sent);
    } catch (e) {
      toastError(e);
    } finally {
      this.setData({ sending: false });
    }
  },

  /** 追加一条气泡（按需插日期分隔）并置底 */
  appendBubble(m: MessageItem) {
    const bubbles = this.data.bubbles.slice();
    bubbles.push(toBubble(m, bubbles[bubbles.length - 1]));
    this.lastId = m.id;
    this.setData({ bubbles, scrollIntoView: `msg_${m.id}` });
  },

  /** 摘要卡：会话因这一单而起，点回订单详情（详情页在另一条任务手里，这里只跳过去） */
  onOpenOrder() {
    const id = this.data.orderId;
    if (id) wx.navigateTo({ url: `/pkg-station/order-detail/index?id=${id}` });
    else wx.navigateTo({ url: '/pkg-station/order-list/index' });
  },

  /** 引导态主操作：去我的订单（订单列表是分包页，可 navigateTo） */
  onGoOrders() {
    wx.navigateTo({ url: '/pkg-station/order-list/index' });
  },

  /* ---------- 指针视差（装饰层动，内容不动） ---------- */
  onFxStart(e: WechatMiniprogram.TouchEvent) {
    fxStart(this, e);
  },
  onFxMove(e: WechatMiniprogram.TouchEvent) {
    fxMove(this, e);
  },
  onFxEnd() {
    fxEnd(this);
  },
});

// ---------- 纯函数（页面文件不在 vitest 收集范围内：`vitest.config.ts` 只收
// tests/** 与 *.spec.ts，而本任务不允许新增 utils 文件，所以时间与分页口径都留在这里，
// 未做单测覆盖。逻辑刻意写成"给一个值、回一个字符串"，不碰 wx） ----------

/**
 * 最近一屏消息。
 *
 * ⚠️ `GET /conversations/:id/messages` 是**升序**分页（第 1 页是最早的一屏），
 * 而会话要看的恰恰是"最近在谈什么"。所以先读第 1 页拿 `total`，再按 total 反算末页，
 * 取回真正的最后 `MSG_PAGE` 条。两次往返之间对方若又发了消息，末页号会差一点，
 * 下一拍轮询（5 秒）自愈 —— 比"一次拉满 50 条上限却仍然拿不到最新的"更稳。
 * 更早的历史本期不做上翻加载：交易沟通要的是当前上下文，不是档案。
 */
async function tailMessages(conversationId: string): Promise<MessageItem[]> {
  const first = await conversationApi.messages(conversationId, { page: 1, pageSize: MSG_PAGE });
  if (first.total <= first.pageSize) return first.list;
  const lastPage = Math.ceil(first.total / first.pageSize);
  const tail = await conversationApi.messages(conversationId, {
    page: lastPage,
    pageSize: first.pageSize,
  });
  return tail.list;
}

/**
 * 从「我的会话列表」里定位一条会话（`?conversationId=` 进来时用）。
 *
 * 后端**没有** `GET /conversations/:id`，而这里要的是对方昵称，只能从列表拿；
 * 列表只翻一页（`CONVERSATION_PAGE` 条），定位不到就返回 null → 进错误态，不猜。
 */
async function findConversation(id: string): Promise<ConversationItem | null> {
  if (!id) return null;
  const page = await conversationApi.list({ page: 1, pageSize: CONVERSATION_PAGE });
  return page.list.find((c) => c.id === id) ?? null;
}

/** 一组消息 → 气泡（相邻两条跨了自然日才插分隔） */
function toBubbles(list: MessageItem[]): Bubble[] {
  const out: Bubble[] = [];
  for (const m of list) out.push(toBubble(m, out[out.length - 1]));
  return out;
}

/**
 * 单条消息 → 气泡。
 *
 * 左右朝向用服务端算好的 `mine`（`toMessageItem()` 比的是 `senderId === 当前用户`），
 * 不在本地拿 `getUser()` 的 id 去比 —— 那样游客态、token 刷新态都会把气泡分错边。
 */
function toBubble(m: MessageItem, prev?: Bubble): Bubble {
  const dayText = dayLabel(m.createdAt);
  return {
    id: m.id,
    mine: m.mine,
    content: m.content,
    timeText: clockOf(m.createdAt),
    dayText,
    showDay: !prev || prev.dayText !== dayText,
  };
}

/** 补零（`pad(5) → '05'`） */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO → 本地 `HH:mm`；解析失败返回空串（宁可不显示，也不在气泡上写 Invalid Date） */
function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * ISO → 日期分隔文案：`今天` / `昨天` / `9月19日` / `2025年12月2日`。
 *
 * 跨年才带年份，是为了让 `showDay` 的"文案相等 ⟺ 同一天"成立：
 * 不带年份时 `2025-09-19` 与 `2026-09-19` 会撞成同一句"9月19日"，
 * 跨了两年的两条消息就会被漏掉一条分隔。解析失败退回日期前缀。
 */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const gap = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (gap === 0) return '今天';
  if (gap === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
