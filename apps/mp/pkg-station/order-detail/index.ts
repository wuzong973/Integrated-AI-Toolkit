/**
 * 订单详情（文档 6.6.3）
 *
 * 关键：按角色与状态动态渲染操作按钮（避免出现"不该有的按钮"，M3-18 验收）
 * 状态机约束见 @qz/core 的 order.ts（本页只做展示与调用，不做状态判断逻辑）
 * 视觉：装饰层随指针视差（utils/fx.ts），内容区不跟随。
 *
 * ## 验收与评价是同一个动作（M3-16 / 文档 6.6.4）
 *
 * 以前这里是一句 `wx.showModal` 确认 + **写死 5 星**：既没有真的收集用户意见，
 * 又把"放款"和"打分"绑死成一个不可见的默认值（服务者的信用分就按那个 5 星涨上去了）。
 * 现在弹层里可以打星、写正文、贴标签、选匿名；
 * **不选星就只放款**（后端 `rating` 可选，与 `assertReviewInput` 的口径一致：
 * 写了正文却不打星会被服务端拒，所以那种组合在本地就不发出去）。
 */
import type { OrderItem } from '../../utils/api';
import { orderApi } from '../../utils/api';
import { pickFile, uploadFile } from '../../utils/file-transfer';
import { fxDisableTilt, fxEnableTilt, fxEnd, fxMove, fxStart } from '../../utils/fx';
import { ORDER_STEPS, orderStatusText } from '../../utils/order-status';
import { toastError } from '../../utils/request';

/** 常用评价标签（用词与后端 `AcceptReviewSchema` 的示例一致；每项 ≤20 字、最多 10 个） */
const REVIEW_TAGS = ['按时交付', '质量好', '沟通顺畅', '态度专业', '响应快'];
/** 标签最多选 3 个（超过 3 个的标签对信用判断没有增量信息，只会把卡片区撑乱） */
const TAG_MAX = 3;
/** 评价正文上限，与后端 `AcceptReviewSchema.content` 一致 */
const CONTENT_MAX = 500;
/** 星级文案（下标即星数，0 是"还没选"） */
const RATING_LABEL = ['', '很差', '一般', '还行', '满意', '非常满意'];
const STARS = [1, 2, 3, 4, 5];

/** 标签的可渲染形态：WXML 里算不出"选没选"，选中态必须在 TS 里落成字段 */
type TagView = { name: string; on: boolean };

/** 验收时附带的评价内容（后端 AcceptReviewSchema 的宽版字段，全部可选） */
interface ReviewBody {
  rating?: number;
  content?: string;
  tags?: string[];
  isAnonymous?: boolean;
}

const tagViews = (picked: string[]): TagView[] =>
  REVIEW_TAGS.map((name) => ({ name, on: picked.includes(name) }));

/**
 * 拼评价 body。
 *
 * 没选星 → 返回空对象：后端据此**只放款、不写评价**（这是有意支持的一条路径，
 * 不是"评价丢了"）。选了星才把正文 / 标签 / 匿名一起带上。
 */
function reviewBody(rating: number, content: string, tags: string[], anon: boolean): ReviewBody {
  if (!rating) return {};
  const text = content.trim().slice(0, CONTENT_MAX);
  return {
    rating,
    ...(text ? { content: text } : {}),
    ...(tags.length ? { tags: tags.slice(0, TAG_MAX) } : {}),
    ...(anon ? { isAnonymous: true } : {}),
  };
}

Page({
  data: {
    orderId: '',
    order: null as (OrderItem & { statusText: string; amountYuan: string }) | null,
    steps: ORDER_STEPS,
    /** 当前状态在 steps 中的索引（-1 表示异常状态） */
    stepIndex: -1,
    /** 角色：buyer / provider */
    role: 'buyer',
    loading: true,
    error: '',
    /** 装饰层视差位移（由 utils/fx.ts 写入） */
    fxStyle: '',

    /* ---------- 验收 + 评价弹层 ---------- */
    /** 弹层是否展开（展开时页面锁不住底部操作栏，靠遮罩收掉） */
    rvOpen: false,
    stars: STARS,
    /** 0 = 还没选星（此时"提交评价"不可用，只能直接放款） */
    rvRating: 0,
    rvRatingText: '还没打分',
    rvContent: '',
    rvTags: [] as string[],
    rvTagViews: tagViews([]),
    rvAnonymous: false,
    /** 提交中：既防连点重复放款，也让按钮能显示 loading */
    rvSubmitting: false,
  },

  onLoad(query: Record<string, string>) {
    const orderId = query.id || '';
    const role = (query.role as 'buyer' | 'provider') || 'buyer';
    this.setData({ orderId, role });
    void this.loadOrder(orderId);
  },

  onShow() {
    // 真机上开启陀螺仪倾斜视差；开发者工具无传感器时会静默跳过
    fxEnableTilt(this);
  },

  onHide() {
    fxDisableTilt();
  },

  onUnload() {
    fxDisableTilt();
  },

  async loadOrder(orderId: string) {
    if (!orderId) {
      this.setData({ loading: false, error: '缺少订单 ID' });
      return;
    }

    try {
      const order = await orderApi.detail(orderId);
      const statusText = orderStatusText(order.status);
      this.setData({
        order: { ...order, statusText, amountYuan: (order.amount / 100).toFixed(2) },
        stepIndex: ORDER_STEPS.indexOf(statusText),
        loading: false,
        error: '',
      });
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '订单加载失败' });
    }
  },

  /** 发起支付（担保交易，ADR-07） */
  async onPay() {
    try {
      const payParams = await orderApi.pay(this.data.orderId);
      // 真实实现：wx.requestPayment({ ...payParams })
      wx.showModal({
        title: '担保支付',
        content: '资金将进入平台托管账户，你确认验收后才会放款给服务者。当前为演示模式。',
        confirmText: '模拟支付',
        success: async (res) => {
          if (!res.confirm) return;
          wx.showToast({ title: '支付成功（演示）', icon: 'success' });
          setTimeout(() => void this.loadOrder(this.data.orderId), 700);
        },
      });
      void payParams;
    } catch (e) {
      toastError(e);
    }
  },

  /**
   * 提交交付物（服务者）。
   *
   * ## 这里曾经有过两次"假"
   *
   * ① 最早写"文件上传在 M1-13 接入"—— 其实 M1-13 后端早已实现，
   *    客户端上传也在 `utils/file-transfer.ts` 里就绪；
   * ② 后来改成**不调用任何接口**就弹"已提交，等待验收" ——
   *    而 `POST /orders/:id/deliver` 当时实测 404。这属于红线 10 明令禁止的"假成功"，
   *    比直接报错更难排查。
   *
   * ## 现在的真实链路
   *
   * 选文件 → 上传（presign → 直传 → confirm）→ 拿 fileId → 提交交付物。
   * 每一步都真调用、真失败、真报错，不再有"点了没反应"或"假装成功"。
   */
  async onDeliver() {
    try {
      const picked = await pickFile('file');
      if (!picked) return; // 用户取消了选择

      wx.showLoading({ title: '上传中', mask: true });
      const file = await uploadFile(picked);
      await orderApi.deliver(this.data.orderId, [file.id], '交付物');
      wx.hideLoading();

      wx.showToast({ title: '已提交，等待验收', icon: 'success' });
      setTimeout(() => void this.loadOrder(this.data.orderId), 700);
    } catch (e) {
      wx.hideLoading();
      toastError(e);
    }
  },

  /* ---------- 验收 + 评价弹层（M3-16） ---------- */

  /** 「确认验收」不再直接放款：先开弹层，让用户有机会顺手评价（也可以只放款） */
  onOpenReview() {
    this.setData({ rvOpen: true });
  },

  /** 关闭弹层：清空草稿，避免下次打开还留着上一条订单的内容 */
  onCloseReview() {
    if (this.data.rvSubmitting) return;
    this.setData({
      rvOpen: false,
      rvRating: 0,
      rvRatingText: '还没打分',
      rvContent: '',
      rvTags: [],
      rvTagViews: tagViews([]),
      rvAnonymous: false,
    });
  },

  /** 点星星（1~5）；再点同一颗星不取消——取消评价走「直接放款」按钮，语义更清楚 */
  onPickStar(e: WechatMiniprogram.TouchEvent) {
    const rating = Number(e.currentTarget.dataset.star);
    this.setData({ rvRating: rating, rvRatingText: RATING_LABEL[rating] ?? '' });
  },

  onContentInput(e: WechatMiniprogram.Input) {
    this.setData({ rvContent: e.detail.value });
  },

  onToggleTag(e: WechatMiniprogram.TouchEvent) {
    const name = e.currentTarget.dataset.name as string;
    const picked = this.data.rvTags;
    if (!picked.includes(name) && picked.length >= TAG_MAX) {
      wx.showToast({ title: `最多选 ${TAG_MAX} 个标签`, icon: 'none' });
      return;
    }
    const rvTags = picked.includes(name) ? picked.filter((t) => t !== name) : [...picked, name];
    this.setData({ rvTags, rvTagViews: tagViews(rvTags) });
  },

  onToggleAnonymous() {
    this.setData({ rvAnonymous: !this.data.rvAnonymous });
  },

  /** 只放款、不评价（后端允许无 rating，这是正常路径，不是"跳过必填项"） */
  onAcceptOnly() {
    void this.submitAccept({});
  },

  /**
   * 放款 + 评价一次提交。
   *
   * 没选星时**不发半截评价** —— 服务端 `assertReviewInput` 会直接拒
   * （"填写评价内容需要先给出星级"），所以这里本地先拦下并说清下一步。
   */
  onAcceptWithReview() {
    if (!this.data.rvRating) {
      wx.showToast({ title: '先点星级，或改用「直接放款」', icon: 'none', duration: 2500 });
      return;
    }
    void this.submitAccept(
      reviewBody(this.data.rvRating, this.data.rvContent, this.data.rvTags, this.data.rvAnonymous),
    );
  },

  /**
   * 提交验收。失败**如实** toast 服务端原文（状态冲突 / 内容违规 / 网络都会走这里），
   * 绝不出现"评价没写上也提示成功"。
   */
  async submitAccept(review: ReviewBody) {
    if (this.data.rvSubmitting) return;
    this.setData({ rvSubmitting: true });
    try {
      await orderApi.accept(this.data.orderId, review);
      const hasReview = review.rating !== undefined;
      this.setData({ rvSubmitting: false });
      this.onCloseReview();
      wx.showToast({
        title: hasReview ? '已验收并完成评价' : '已验收，资金已放款',
        icon: 'success',
      });
      setTimeout(() => void this.loadOrder(this.data.orderId), 700);
    } catch (e) {
      this.setData({ rvSubmitting: false });
      toastError(e);
    }
  },

  /** 弹层内的卡片：拦截点击冒泡，否则点卡片空白处会把弹层关掉 */
  noop() {},

  /**
   * 要求修改（≤3 次）：待验收 → 服务中回退（M3-14）。
   *
   * 后端 `POST /orders/:id/revision` 会把修改意见写进订单时间线并送审；
   * 次数超限 / 状态不符时服务端报错，页面如实 toast，不做静默兜底。
   */
  onRequestRevision() {
    wx.showModal({
      title: '要求修改',
      editable: true,
      placeholderText: '请说明需要修改的地方（最多 3 次）',
      success: async (res) => {
        if (!res.confirm) return;
        const reason = (res.content ?? '').trim();
        if (reason.length < 2) {
          wx.showToast({ title: '请填写具体的修改意见', icon: 'none' });
          return;
        }
        try {
          await orderApi.revision(this.data.orderId, reason);
          wx.showToast({ title: '已退回，等待服务者修改', icon: 'success' });
          setTimeout(() => void this.loadOrder(this.data.orderId), 700);
        } catch (e) {
          toastError(e);
        }
      },
    });
  },

  /** 申请退款 */
  onRefund() {
    wx.showModal({
      title: '申请退款',
      editable: true,
      placeholderText: '请说明退款原因',
      success: async (res) => {
        if (!res.confirm || !res.content) return;
        try {
          await orderApi.refund(this.data.orderId, res.content);
          wx.showToast({ title: '已提交退款申请', icon: 'success' });
          setTimeout(() => void this.loadOrder(this.data.orderId), 700);
        } catch (e) {
          toastError(e);
        }
      },
    });
  },

  onChat() {
    wx.navigateTo({ url: `/pkg-station/chat/index?orderId=${this.data.orderId}` });
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
