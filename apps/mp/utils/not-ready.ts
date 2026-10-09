/**
 * 「功能开发中」提示 —— 未接入功能的统一出口。
 *
 * ## 为什么要有这个文件
 *
 * 项目红线：**不许用假数据冒充功能**。但驿站模块的写操作后端**整个不存在** ——
 * 实测（2026-09-18）只有 `GET /station/tasks` 与 `GET /station/tasks/:id` 是真的，
 * 其余全部 404：
 *
 *   ❌ GET  /station/categories      ❌ POST /station/tasks        （发布）
 *   ❌ POST /station/parse           ❌ POST /station/tasks/:id/apply（报名）
 *   ❌ GET  /station/match           ❌ 全部 /orders/*             （订单/担保支付/交付验收）
 *
 * 骨架页原本的做法是**不调任何接口就弹一句"已提交，等待验收"** ——
 * 用户以为操作成功了，实际什么都没发生。这比报错更难排查。
 *
 * ## 集中一处的好处
 *
 *   ① 文案一致（散在多个页面里必然漂移）；
 *   ② 后端就绪后可以一次 grep 到**所有**占位点，逐个换成真实调用。
 *
 * 用法：`showNotReady('订单交付')` —— 不要自己写 showModal。
 */
export function showNotReady(feature: string, hint?: string): void {
  wx.showModal({
    title: `${feature}功能开发中`,
    content:
      hint ??
      '该功能已规划但尚未上线。现在点击不会产生任何真实操作，我们会在开放后第一时间通知你。',
    showCancel: false,
    confirmText: '知道了',
  });
}
