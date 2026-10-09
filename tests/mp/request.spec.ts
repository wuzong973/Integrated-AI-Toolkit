import { describe, expect, it } from 'vitest';

import {
  isHttpSuccess,
  networkFailMessage,
  sanitizeErrorMessage,
  stepLoading,
} from '../../apps/mp/utils/request';

/**
 * 请求层错误文案的兜底净化
 *
 * ## 起因（2026-09-18 交付可用性排查）
 *
 * 驿站发布页点「发布」时，后端返回
 * `{"code":40400,"message":"Cannot POST /api/v1/station/tasks"}`，
 * 而请求层把它原样塞进 `Error` → `toastError` 把这串英文弹给了用户。
 *
 * 后端 `normalizeHttpMessage` 已拦第一道；这里是**第二道兜底** ——
 * 旧版本后端、网关或反向代理仍可能透出框架原话。
 *
 * ⚠️ 这两道是**刻意重复**的（跨进程、跨语言，无法共享实现），
 *    所以用例也成对存在，改动一侧时另一侧必须同步。
 */
describe('sanitizeErrorMessage（不外泄框架原话）', () => {
  it('框架原话 → 换成用户文案', () => {
    expect(sanitizeErrorMessage('Cannot POST /api/v1/station/tasks')).toBe(
      '该功能尚未开放，敬请期待',
    );
    expect(sanitizeErrorMessage('Cannot GET /api/v1/orders')).toBe('该功能尚未开放，敬请期待');
    expect(sanitizeErrorMessage('cannot put /x')).toBe('该功能尚未开放，敬请期待');
  });

  it('业务文案原样保留（这些是刻意写给用户看的）', () => {
    const cases = ['任务不存在或已下架', '工具不存在：xxx', '「AI 解题讲解」正在建设中，敬请期待'];
    for (const msg of cases) expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('句中提到 Cannot 不误伤（只匹配整句开头的框架句式）', () => {
    const msg = '提交失败：Cannot parse your input, 请检查格式';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('空 / 空白文案给默认值，不会弹出空 toast', () => {
    expect(sanitizeErrorMessage(undefined)).toBe('请求失败');
    expect(sanitizeErrorMessage('')).toBe('请求失败');
    expect(sanitizeErrorMessage('   ')).toBe('请求失败');
  });
});

/**
 * 回归守卫：**必须接受整个 2xx 区间**。
 *
 * 曾经这里写死 `=== 200`，导致 NestJS `@Post()` 默认返回的 201
 * 全被当成失败（详见 docs/dev/ERROR-TRIAGE.md 第 1.5 节，P0 缺陷）。
 */
describe('isHttpSuccess（回归：不能写死 200）', () => {
  it('2xx 全部算成功，201 必须包含在内', () => {
    expect(isHttpSuccess(200)).toBe(true);
    expect(isHttpSuccess(201)).toBe(true);
    expect(isHttpSuccess(204)).toBe(true);
    expect(isHttpSuccess(299)).toBe(true);
  });

  it('非 2xx 一律算失败', () => {
    for (const s of [199, 300, 400, 401, 404, 500]) expect(isHttpSuccess(s)).toBe(false);
  });
});

/**
 * 加载浮层的引用计数
 *
 * ## 起因（2026-09-20 排查上传超时时看到的开发者工具警告）
 *
 * `showLoading` / `hideLoading` 操作的是**同一个全局浮层**，不是可嵌套的计数器。
 * 原先按"每个请求各自配对"写，于是两个并发请求里**先完成的那个就把浮层关了**：
 * 界面在还有请求在飞的时候显示"已加载完"，而它随后再 `hideLoading()` 又会命中
 * "没有正在显示的 loading" → 开发者工具报 `showLoading 与 hideLoading 必须配对使用`。
 *
 * ⭐ 所以这里断言的是**真正操作浮层的次数**（effect），而不只是深度 ——
 * 深度算对了但 effect 判断错了，浮层依旧会提前关掉。
 */
describe('stepLoading（同一全局浮层的引用计数）', () => {
  it('首个请求才真正 show，后续并发只加深不计次', () => {
    const a = stepLoading(0, 'show');
    expect(a).toEqual({ depth: 1, effect: 'show' });

    const b = stepLoading(a.depth, 'show');
    expect(b).toEqual({ depth: 2, effect: 'none' });
  });

  it('未归零前不真正 hide（后一个请求还在飞，浮层就不能关）', () => {
    const stepped = stepLoading(2, 'hide');
    expect(stepped).toEqual({ depth: 1, effect: 'none' });
  });

  it('归零那次才真正 hide', () => {
    expect(stepLoading(1, 'hide')).toEqual({ depth: 0, effect: 'hide' });
  });

  it('深度已归零还收到 hide → 什么都不做（否则会刷出误导性 SDK 警告）', () => {
    expect(stepLoading(0, 'hide')).toEqual({ depth: 0, effect: 'none' });
  });

  it('两个并发请求：全程只 show 一次、hide 一次', () => {
    let depth = 0;
    const effects: string[] = [];
    const run = (action: 'show' | 'hide') => {
      const s = stepLoading(depth, action);
      depth = s.depth;
      effects.push(s.effect);
    };
    run('show'); // 请求 A 开始
    run('show'); // 请求 B 开始
    run('hide'); // A 先回来
    run('hide'); // B 回来
    expect(effects).toEqual(['show', 'none', 'none', 'hide']);
    expect(depth).toBe(0);
  });
});

/**
 * 网络层失败文案（2026-09-20 新增）
 *
 * ## 起因
 *
 * `endpoints.ts` 的 `LOCAL_API_BASE` 是个**过期 IP**（换 Wi-Fi 后本机地址从
 * `192.168.11.x` 变成 `192.168.31.x`），所有请求 `ERR_CONNECTION_TIMED_OUT`。
 * 界面当时只弹「网络开小差了，请检查网络后重试」——
 * 这句话把排查方向带去了"网络不好 / 后端挂了"，**唯独没人去看地址配置**，
 * 而真实原因就是那一行 IP。
 *
 * ## 为什么要按环境分开
 *
 * 开发环境必须打出目标地址（一眼对上 `endpoints.ts`）；
 * 线上地址是对的，失败确实多半是网络问题，把域名弹给用户没有意义。
 */
describe('networkFailMessage（开发环境必须暴露目标地址）', () => {
  it('开发环境带出 host —— 这正是"地址过期"能一眼看出的原因', () => {
    expect(networkFailMessage('http://192.168.11.32:3000', true)).toBe('连不上 192.168.11.32:3000');
    expect(networkFailMessage('https://api.qingzhi.example.com', true)).toBe(
      '连不上 api.qingzhi.example.com',
    );
  });

  it('线上保持通用文案，不外泄内网地址', () => {
    expect(networkFailMessage('https://api.qingzhi.example.com', false)).toBe(
      '网络开小差了，请检查网络后重试',
    );
  });

  it('基址不合法时原样兜底，不抛错（这段代码本身不能成为新的崩溃点）', () => {
    expect(networkFailMessage('', true)).toBe('连不上 ');
    expect(networkFailMessage('not-a-url', true)).toBe('连不上 not-a-url');
  });
});
