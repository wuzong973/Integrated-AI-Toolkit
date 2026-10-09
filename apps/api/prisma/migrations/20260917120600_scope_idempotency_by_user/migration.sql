-- 幂等键的唯一约束从「全局」改为「按用户分区」
--
-- 背景（实测发现的缺陷）：`tool_job.idempotency_key` 原先是**全局唯一**，
-- 而 `JobService` 的回读只按 key 查、不带 userId。后果是：
-- 用户 B 使用与用户 A 相同的 Idempotency-Key 时，会拿到 A 的 jobId，
-- 且 B 自己的请求被静默丢弃（reused=true，不执行、不扣费），随后访问该 jobId 会得到 403。
--
-- 幂等键的语义本来就该是「同一用户的同一请求只执行一次」，
-- 把它做成全局唯一等于让所有用户共享一个键空间 —— 既错，又难排查。
--
-- 前置校验（已在执行前确认，均为 0 条，因此建唯一索引不会失败）：
--   SELECT user_id, idempotency_key, COUNT(*) FROM tool_job
--   WHERE idempotency_key IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1;
--
-- 注：MySQL 的唯一索引允许多个 NULL，因此未带幂等键的作业不受影响。

DROP INDEX `tool_job_idempotency_key_key` ON `tool_job`;

CREATE UNIQUE INDEX `tool_job_user_id_idempotency_key_key` ON `tool_job`(`user_id`, `idempotency_key`);
