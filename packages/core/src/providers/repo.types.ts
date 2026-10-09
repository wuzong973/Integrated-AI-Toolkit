/**
 * 仓库解读 Provider（deepwiki-open，MIT，自托管部署，只调 REST）
 *
 * ## 为什么只有一个方法
 *
 * deepwiki-open 的 REST 形态随版本差异较大（`/api/wiki/ask` 的返回结构
 * 在不同 commit 之间变过多次）。本平台对它的需求只有一个：
 * **给一个 GitHub 仓库 URL，换回一份仓库解读文档**。
 * 接口只暴露这个最小面，把"哪个端点、怎么解析"全部关进实现里 ——
 * 换版本或换实现时调用方零改动。
 *
 * ## 产物形态
 *
 * `markdown` 是一份完整的仓库解读文档（核心功能 / 架构 / 使用方式），
 * 由调用方（repo 工具 runner）落成可下载的 .md 产物；
 * `title` 可选，是文档标题（实现拿得到就给，拿不到由调用方用仓库名兜底）。
 */
export interface RepoExplanation {
  markdown: string;
  title?: string;
}

export interface RepoProvider {
  readonly name: string;
  /**
   * 生成仓库解读。
   *
   * 实现必须是**真实的远端调用**；不可用时抛错（带指引），
   * 绝不返回"看起来像解读"的占位文本（红线 9）。
   * `language` 为文档语言（BCP-47 风格，如 `zh` / `en`），实现可按需忽略。
   */
  explain(repoUrl: string, opts?: { language?: string }): Promise<RepoExplanation>;
}
