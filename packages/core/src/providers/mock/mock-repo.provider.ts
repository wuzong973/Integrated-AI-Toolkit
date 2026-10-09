/**
 * Mock 仓库解读 Provider（红线 10：演示数据必须能被认出来）
 *
 * 与 `MockDocParseProvider`（返回【演示模式】示例文本）同一先例：
 * DeepWiki 未部署时回退到这里，产物**通篇标注演示性质**，
 * 配合响应头 `X-Provider: mock` 与界面"演示模式"角标，
 * 用户不会把演示内容当成真实的仓库分析。
 *
 * 结构与真实产物同形（标题 + 分节 Markdown），是为了让
 * 执行页 / 结果页的渲染链路在演示期就被走通 —— 但每一段都明说"示例"。
 */
import type { RepoExplanation, RepoProvider } from '../repo.types';

export class MockRepoProvider implements RepoProvider {
  readonly name = 'mock-repo';

  async explain(repoUrl: string, _opts?: { language?: string }): Promise<RepoExplanation> {
    const url = String(repoUrl ?? '').trim() || '（未提供仓库地址）';
    const markdown = [
      '# 【演示模式】仓库解读示例',
      '',
      `> 目标仓库：${url}`,
      '',
      '说明：当前未部署 DeepWiki 服务（缺少 `DEEPWIKI_BASE_URL`），',
      '**本文档由演示数据生成，不是对该仓库的真实分析**。',
      '部署 deepwiki-open 并配置环境变量后，这里会输出真实的架构与功能解读。',
      '',
      '## 核心功能（示例）',
      '',
      '- 这一节在真实场景中会总结仓库的主要能力与适用场景。',
      '- 演示数据不含任何真实结论，请勿引用。',
      '',
      '## 架构概览（示例）',
      '',
      '- 这一节在真实场景中会给出模块划分、依赖关系与数据流。',
      '- 演示数据不含任何真实结论，请勿引用。',
      '',
      '## 使用方式（示例）',
      '',
      '- 这一节在真实场景中会整理安装、配置与上手步骤。',
      '- 演示数据不含任何真实结论，请勿引用。',
      '',
    ].join('\n');
    return { markdown, title: '【演示模式】仓库解读示例' };
  }
}
