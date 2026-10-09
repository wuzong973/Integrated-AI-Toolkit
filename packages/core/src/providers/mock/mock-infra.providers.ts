import { BizException, ErrorCode } from '../../errors';
import { describeHits, scanLexicon } from '../../moderation';
import type {
  DocConvertInput,
  DocConvertProvider,
  DocConvertResult,
  EmbeddingProvider,
  ModerationProvider,
  ModerationResult,
  NotifyInput,
  NotifyProvider,
  PayCallbackPayload,
  PayProvider,
  PrepayInput,
  PrepayResult,
  PresignResult,
  QueueJob,
  QueueProvider,
  SearchHit,
  SearchProvider,
  SmsProvider,
  StorageProvider,
  VectorMatch,
  VectorPoint,
  VectorProvider,
} from '../types';

/** Mock 对象存储：内存实现，便于本地无 MinIO 时跑通链路 */
export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock-storage';
  private readonly store = new Map<string, Buffer>();

  async presignPut(
    objectKey: string,
    _contentType: string,
    expiresIn = 900,
  ): Promise<PresignResult> {
    return {
      uploadUrl: `http://localhost:3000/mock-upload/${encodeURIComponent(objectKey)}`,
      headers: { 'x-mock-provider': 'mock-storage' },
      objectKey,
      expiresIn,
    };
  }

  async presignGet(objectKey: string) {
    return `http://localhost:3000/mock-download/${encodeURIComponent(objectKey)}`;
  }

  async putObject(objectKey: string, body: Buffer) {
    this.store.set(objectKey, body);
  }
  async getObject(objectKey: string) {
    const v = this.store.get(objectKey);
    if (!v) throw new Error(`mock-storage: 对象不存在 ${objectKey}`);
    return v;
  }
  async deleteObject(objectKey: string) {
    this.store.delete(objectKey);
  }
  async exists(objectKey: string) {
    return this.store.has(objectKey);
  }
}

/** Mock Embedding：确定性伪向量（相同文本得到相同向量） */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-embedding';
  readonly dimension = 64;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dimension).fill(0) as number[];
      for (let i = 0; i < t.length; i++) v[i % this.dimension] += t.charCodeAt(i) % 97;
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/**
 * Mock 向量库：**进程内**实现，用余弦相似度做暴力检索。
 *
 * ## 它有什么用
 *
 * 让"没有部署 Qdrant 也能把 RAG 链路（切片 → 入库 → 检索 → 带引用回答）
 * 完整跑通并单测"。这是本项目一贯的做法：Provider 未就绪时不是让功能报错，
 * 而是给一个**行为正确但不可用于生产**的实现，并如实打标。
 *
 * ## 它为什么不能用于生产
 *
 * · 数据只在内存里，**进程重启即丢**（Qdrant 会持久化）；
 * · 暴力遍历 O(n)，几千条以上就会拖垮接口（Qdrant 有 HNSW 索引）；
 * · 没有并发控制，多实例部署时各存各的。
 *
 * 名字以 `mock-` 开头 → 会被 `MockMarkerMiddleware` 打上 `X-Provider: mock`，
 * 界面显示"演示模式"（红线 10：Mock 必须可辨，绝不允许静默返回假数据）。
 */
export class MockVectorProvider implements VectorProvider {
  readonly name = 'mock-vector';
  private points: VectorPoint[] = [];
  /** 已声明的维度（0 = 尚未声明）；与 MockEmbeddingProvider 的 64 维对应 */
  private dimension = 0;

  async ensureCollection(dimension: number): Promise<void> {
    if (this.dimension !== 0 && this.dimension !== dimension) {
      throw new Error(
        `mock-vector: 集合维度不一致（已有 ${this.dimension}，传入 ${dimension}）—— ` +
          '维度写错不会报错，只会让所有相似度变成垃圾，故这里主动失败',
      );
    }
    this.dimension = dimension;
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    // 同 id 覆盖：先删同 id 的旧点，再追加，语义与 Qdrant 的 upsert 一致
    const incoming = new Set(points.map((p) => p.id));
    this.points = [...this.points.filter((p) => !incoming.has(p.id)), ...points];
  }

  async search(
    vector: number[],
    topK: number,
    scoreThreshold?: number,
  ): Promise<VectorMatch[]> {
    return this.points
      .map((p) => ({ id: p.id, payload: p.payload, score: cosine(vector, p.vector) }))
      .filter((m) => scoreThreshold === undefined || m.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteByDocument(documentId: string): Promise<void> {
    this.points = this.points.filter((p) => p.payload.documentId !== documentId);
  }
}

/** 余弦相似度（两个零向量返回 0 而不是 NaN） */
function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Mock 通知：只记录不真发 */
export class MockNotifyProvider implements NotifyProvider {
  readonly name = 'mock-notify';
  readonly sent: NotifyInput[] = [];
  async send(input: NotifyInput) {
    this.sent.push(input);
    return { delivered: ['in_app'], failed: [] };
  }
}

/**
 * Mock 支付：模拟预支付、回调与退款。
 *
 * ## 它让什么跑通
 *
 * 在没有微信支付商户资质（`WECHAT_PAY_*` 三项全空）时，把
 * 「下单 → 发起支付 → 回调 → 订单状态更新」整条链路跑通，并可自动化验证。
 *
 * ## 真实替换点在哪
 *
 * 回调报文用**简化 JSON**（真实微信是 AES-GCM 加密的 XML），所以
 * `parseCallback` 是接真实支付时最主要的替换点 —— 换成 `WechatPayProvider` 后，
 * `OrderPayService` 一行都不用改（它只依赖 `PayProvider` 这个接口，红线 9）。
 *
 * ## 为什么 payNo 是确定性的
 *
 * 用 `mock_${orderNo}` 而不是随机数：同一订单重复发起支付会得到**同一个**流水号，
 * 这样"回调重复投递"的幂等分支才真正测得到
 * （随机流水号会让每次回调看起来都像一笔新支付，幂等逻辑永远走不到）。
 */
export class MockPayProvider implements PayProvider {
  readonly name = 'mock-pay';

  async prepay(input: PrepayInput): Promise<PrepayResult> {
    return {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: `mock${input.orderNo.slice(-8)}`,
      package: `prepay_id=mock_${input.orderNo}`,
      signType: 'RSA',
      paySign: 'MOCK_SIGNATURE',
    };
  }

  async refund(orderNo: string) {
    return { refundId: `mock_refund_${orderNo}` };
  }

  verifyCallback() {
    return true; // Mock 环境下默认通过；真实实现**必须**验签（文档 6.12.1）
  }

  /**
   * 解析 Mock 回调报文（期望格式）：
   *   { "orderNo": "QZ...", "payNo": "mock_pay_...", "amountCents": 5000, "success": true }
   *
   * `success: false` 可显式传入，用来测"支付失败"分支。
   */
  parseCallback(rawBody: string): PayCallbackPayload {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new BizException(ErrorCode.ParamInvalid, undefined, 'Mock 支付回调报文不是合法 JSON');
    }

    const orderNo = String(body.orderNo ?? '');
    const payNo = String(body.payNo ?? '');
    const amountCents = Number(body.amountCents);
    if (!orderNo || !payNo || !Number.isInteger(amountCents)) {
      throw new BizException(
        ErrorCode.ParamInvalid,
        { got: body },
        'Mock 支付回调缺少 orderNo / payNo / amountCents',
      );
    }

    return {
      orderNo,
      payNo,
      amountCents,
      success: body.success !== false,
      raw: body,
    };
  }
}

/**
 * Mock 文档转换：**故意抛错，而不是返回原文件**。
 *
 * 这一条与其它 Mock 的取舍不同，值得单独说明：
 * 压缩、转格式这类 Mock 返回"看起来像那么回事"的产物，是为了让本地无依赖时
 * 链路能跑通；但转换不一样 —— 用户要的是**另一种格式**，
 * 返回原文件等于给了一个后缀不对、打不开的东西。
 * 与其这样，不如显式失败，让人去把 `CONVERT_SERVICE_URL` 配起来（红线 10）。
 */
export class MockConvertProvider implements DocConvertProvider {
  readonly name = 'mock-convert';

  async convert(input: DocConvertInput): Promise<DocConvertResult> {
    throw new BizException(
      ErrorCode.ConvertServiceUnavailable,
      { target: input.target, filename: input.filename },
      '文档转换服务未配置，请设置 CONVERT_SERVICE_URL 后再试（ADR-05）',
    );
  }
}

/** Mock 短信 */export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock-sms';
  readonly outbox: { phone: string; code: string }[] = [];
  async send(phone: string, _templateCode: string, params: Record<string, string>) {
    // eslint-disable-next-line no-console
    console.warn(`[mock-sms] 验证码短信 ${phone}: ${JSON.stringify(params)}`);
    this.outbox.push({ phone, code: params.code ?? '' });
  }
}

/** Mock 搜索：内存子串匹配 */
export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock-search';
  private readonly docs = new Map<string, Record<string, unknown>[]>();
  async index(type: string, doc: Record<string, unknown>) {
    const arr = this.docs.get(type) ?? [];
    arr.push(doc);
    this.docs.set(type, arr);
  }
  async search(query: string, opts?: { type?: string; page?: number; size?: number }) {
    const type = opts?.type ?? 'all';
    const pool = type === 'all' ? [...this.docs.values()].flat() : (this.docs.get(type) ?? []);
    const hits: SearchHit[] = pool
      .filter((d) => JSON.stringify(d).includes(query))
      .map((d) => ({
        id: String(d.id ?? ''),
        type,
        title: String(d.title ?? ''),
        snippet: String(d.title ?? '').slice(0, 60),
        score: 1,
        raw: d,
      }));
    const size = opts?.size ?? 20;
    return { list: hits.slice(0, size), total: hits.length };
  }
}

/**
 * Mock 内容安全：用**同一份校园词库**做字面预检（M4-05）。
 *
 * ## 为什么不是自己一份短词表
 *
 * 真实链路（`WechatModerationProvider`）的第一道判据就是 `CAMPUS_LEXICON` 的本地预检。
 * Mock 若自带另一份词表，就会出现"本地放行、线上拦截"（或反过来）——
 * 这类偏差最难查，因为两边看起来都"正常工作了"。
 * 共用一份词库后，Mock 与真实实现的前半段**行为完全一致**。
 *
 * ⚠️ 它挡不住变体、谐音与图片 —— 那是**合规缺口**，不是降级优化。
 * `/health` 的 `mockProviders` 里能看到它，就是给运维的最后一道提醒。
 */
export class MockModerationProvider implements ModerationProvider {
  readonly name = 'mock-moderation';

  async checkText(text: string): Promise<ModerationResult> {
    const hits = scanLexicon(text);
    if (hits.size === 0) return { pass: true, action: 'pass' };

    return {
      pass: false,
      labels: [...hits.keys()],
      action: 'reject',
      reason: `命中本地词库：${describeHits(hits)}`,
    };
  }

  /**
   * 图片：Mock **不给结论**。
   *
   * 返回 `pass:true` 会是一条**假结论** —— 它等于宣称"这张图我审过了、没问题"，
   * 而 Mock 根本没有审图能力（红线 10：不许用假数据冒充功能）。
   * 真实实现走的 `mediaCheckAsync` 是异步接口，结论回来之前一律不放行，
   * Mock 沿用同一语义：`pass:false + action:'review'`。
   */
  async checkImage(_buffer: Buffer): Promise<ModerationResult> {
    return {
      pass: false,
      action: 'review',
      reason: 'Mock 不提供图片审核能力，需接入真实内容安全接口',
    };
  }
}

/** Mock 队列：内存实现（文档 A5：起步用 Redis Stream，此处为无依赖降级） */
export class MockQueueProvider implements QueueProvider {
  readonly name = 'mock-queue';
  private readonly handlers = new Map<string, ((job: QueueJob<unknown>) => Promise<void>)[]>();
  private readonly counters = new Map<string, number>();

  async enqueue<T>(name: string, payload: T, opts?: { delayMs?: number }): Promise<string> {
    const id = `mock_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);

    const run = async () => {
      const list = this.handlers.get(name) ?? [];
      for (const h of list) {
        try {
          await h({ id, name, payload, attempts: 0, maxAttempts: opts ? 3 : 3 });
        } finally {
          this.counters.set(name, Math.max(0, (this.counters.get(name) ?? 1) - 1));
        }
      }
    };

    if (opts?.delayMs) setTimeout(() => void run(), opts.delayMs);
    else void run();

    return id;
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): void {
    const arr = this.handlers.get(name) ?? [];
    arr.push(handler as (job: QueueJob<unknown>) => Promise<void>);
    this.handlers.set(name, arr);
  }

  async depth(name: string): Promise<number> {
    return this.counters.get(name) ?? 0;
  }
}
