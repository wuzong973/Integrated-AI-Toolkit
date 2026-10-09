-- 全文检索索引表（M4-07 搜索升级；ADR-13 改用 MySQL 后全文检索走 FULLTEXT）
--
-- ## 为什么单开一张索引表，而不是给 task / service 各加 FULLTEXT 索引
--
-- 1. 搜索要跨实体：任务标题、服务名称、知识库文档需要放在同一个相关度排序里比较。
--    分散在多张表上的 FULLTEXT 索引没法一起算相关度，只能各查各的再手工合并，
--    相关度也就失去了可比性。
-- 2. 索引字段形状不同：各业务表的正文列类型不一（TEXT / VARCHAR / JSON 字符串），
--    在业务表上直接建索引会把搜索的取舍（分词、字段取舍）反向绑死业务表结构。
-- 3. 可由 `SearchProvider.index()` 单向写入，业务表本身不需要感知搜索的存在。
--
-- ## ⚠️ `WITH PARSER ngram` 不是可选项
--
-- MySQL 默认的全文分词器按**空格**切词。中文正文没有空格，
-- 结果是把整段话当成一个"词" —— 检索"摄影"时匹配不到"校园摄影服务"，
-- 而这条查询**不会报错**，只是永远返回空。表现为"搜索功能上线了但搜不出东西"。
--
-- ngram 解析器按 n-gram（默认 2-gram）切分中文，是 MySQL 上做中文全文检索的标准做法。
-- 代价是索引体积变大、短查询（单字）效果差，需保证 `ngram_token_size`（默认 2）一致。

CREATE TABLE `search_index` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `type`       VARCHAR(32)  NOT NULL COMMENT '实体类型，如 task / service / knowledge',
  `ref_id`     VARCHAR(64)  NOT NULL COMMENT '业务表主键（字符串形式，兼容 uuid 与自增）',
  `title`      VARCHAR(255) NOT NULL DEFAULT '' COMMENT '标题，相关度权重高',
  `body`       TEXT         NOT NULL COMMENT '可检索的正文（由各实体的字段拼接而来）',
  `updated_at` DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_search_type_ref` (`type`, `ref_id`),
  KEY `idx_search_type_updated` (`type`, `updated_at`),
  FULLTEXT KEY `ft_search_title_body` (`title`, `body`) WITH PARSER ngram
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci
  COMMENT = '全文检索索引（由 SearchProvider 单向写入，业务表不感知）';
