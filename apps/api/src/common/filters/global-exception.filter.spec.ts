import { describe, expect, it } from 'vitest';

import { normalizeHttpMessage } from './global-exception.filter';

/**
 * 起因（2026-09-18 交付可用性排查）：
 * 路由未注册时 NestJS 抛的 `NotFoundException`，其 message 是框架原话
 * `Cannot POST /api/v1/station/tasks`，被 `replyHttp` 原样透传 →
 * 小程序 `toastError` 把这串英文弹给用户。
 *
 * 这组用例锁死两件事：
 *   ① 框架句式**必须**被替换（防再次外泄内部路由结构）；
 *   ② 业务自己写的 message **必须**原样保留（替换会丢信息）。
 */
describe('normalizeHttpMessage（对外不外泄框架原话）', () => {
  it('路由未注册的 404 → 换成用户文案', () => {
    expect(normalizeHttpMessage(404, 'Cannot POST /api/v1/station/tasks')).toBe(
      '该功能尚未开放，敬请期待',
    );
    expect(normalizeHttpMessage(404, 'Cannot GET /api/v1/orders')).toBe('该功能尚未开放，敬请期待');
  });

  it('方法不匹配的 405 也归一化（不再回显路径）', () => {
    expect(normalizeHttpMessage(405, 'Cannot DELETE /api/v1/user/me')).toBe(
      '请求方式不正确，请升级小程序后重试',
    );
  });

  it('大小写与多余空白不影响识别', () => {
    expect(normalizeHttpMessage(404, 'cannot post /x')).toBe('该功能尚未开放，敬请期待');
  });

  it('业务自己写的 message 原样保留（这些是刻意给用户看的）', () => {
    const cases = [
      '任务不存在或已下架',
      '工具不存在：does_not_exist',
      '「AI 解题讲解」正在建设中，敬请期待',
      '昵称至少 2 个字；头像格式不支持',
    ];
    for (const msg of cases) expect(normalizeHttpMessage(404, msg)).toBe(msg);
  });

  it('只匹配整句开头的框架句式，句中提到 Cannot 不误伤', () => {
    const msg = '提交失败：Cannot parse your input, 请检查格式';
    expect(normalizeHttpMessage(400, msg)).toBe(msg);
  });

  it('空字符串不炸（防御性）', () => {
    expect(normalizeHttpMessage(404, '')).toBe('');
  });
});
