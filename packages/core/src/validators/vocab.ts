import { z } from 'zod';

/**
 * 记单词 / 四六级词汇训练（任务清单 M4-15）共享校验
 *
 * 单独成文件而不是塞进 `validators/index.ts`：那份已经贴着 300 行红线，
 * 追加进去只会让下一次改动直接变红（理由同 `os-run.ts` / `admin.ts`）。
 * 由 `validators/index.ts` 统一 `export *` 转出，调用方仍从 `@qz/core` 取。
 */

/**
 * 发音音色（**英文**，四六级听力只考美音与英音）。
 *
 * ⚠️ 取值必须与侧车白名单（`services/media/handlers.py` 的 `TTS_VOICES`）逐字一致 ——
 * 这里放开而侧车拒绝，用户会看到"选了音色却报错"；反过来则是有音色用不上。
 * 中文音色**故意不给**：用中文音色读英文单词是"能出声、读不对"，
 * 听不出差别的人会照着错的音背，比没有发音更糟。
 */
export const VOCAB_VOICES = [
  'en-US-AriaNeural',
  'en-US-GuyNeural',
  'en-GB-SoniaNeural',
  'en-GB-RyanNeural',
] as const;
export type VocabVoice = (typeof VOCAB_VOICES)[number];

/** 默认音色：美音女声（四六级听力以美音为主） */
export const VOCAB_DEFAULT_VOICE: VocabVoice = 'en-US-AriaNeural';

/**
 * 每日目标的上下限。
 *
 * 下限 5：设成 1~2 个的话，"今日计划"和"没有计划"在体验上没区别。
 * 上限不为难人：新学 60 / 复习 200 已经是一天的极限，再大只会让数字变得不可信
 * （计划里永远显示"还剩 380 个"，第二天就没人看了）。
 */
export const DAILY_NEW_MIN = 5;
export const DAILY_NEW_MAX = 60;
export const DAILY_REVIEW_MIN = 10;
export const DAILY_REVIEW_MAX = 200;

/** 选词书（同时可以改每日目标；不传则保留原值） */
export const SelectWordBookSchema = z.object({
  code: z.string().min(1, '缺少词书 code').max(20),
  dailyNew: z.number().int().min(DAILY_NEW_MIN).max(DAILY_NEW_MAX).optional(),
  dailyReview: z.number().int().min(DAILY_REVIEW_MIN).max(DAILY_REVIEW_MAX).optional(),
});
export type SelectWordBookDto = z.infer<typeof SelectWordBookSchema>;

/**
 * 提交一题的作答。
 *
 * ⚠️ 只传**用户提交的原文**，不传"我答对了" —— 对错由服务端自己算
 * （出题与判卷共用同一个确定性函数，见 `vocab-options.ts`）。
 * 让客户端上报对错的话，抓包改一个字段就能把 SM-2 的调度刷成任意形状，
 * 而复习计划一旦被污染就再也对不上账。
 *
 * ## 为什么是 `choice` + `text` 两个可选字段，而不是一个 `answer` 字符串
 *
 * 选择题提交的是**选项 key**（`a`~`d`），拼写/填空提交的是**用户输入**。
 * 合并成一个字段的话，服务端就得靠"这个字符串长不长、像不像 key"来猜题型 ——
 * 而猜错的表现是"拼写题把一个单词当成选项 key 判错"，静默且难查。
 * 分成两个字段之后，由**题型**决定用哪个，判据与出题时完全对齐。
 *
 * 两者都必填会逼客户端为每种题型都造一个假值；都不填则是空提交。
 * 所以用 `refine` 要求"至少有一个"，具体用哪个由服务端按题型取。
 */
export const VocabAnswerSchema = z
  .object({
    wordId: z.string().min(1, '缺少 wordId').max(64),
    /** 选择题：选项 key */
    choice: z
      .string()
      .regex(/^[a-d]$/, 'choice 只能是 a/b/c/d')
      .optional(),
    /**
     * 拼写 / 填空：用户输入。
     *
     * 40 已是单词长度的数倍（最长的英语单词约 30 个字母），
     * 留些余量是为了让"用户乱输入一长串"被**校验层**挡住，
     * 而不是带着一长串去跑编辑距离。
     */
    text: z.string().max(40, '答案太长了').optional(),
  })
  .refine((v) => v.choice !== undefined || v.text !== undefined, {
    message: '缺少作答内容（choice 或 text 至少填一个）',
  });
export type VocabAnswerDto = z.infer<typeof VocabAnswerSchema>;

/** 发音请求（音色可选，默认美音女声） */
export const VocabAudioQuerySchema = z.object({
  voice: z.enum(VOCAB_VOICES).optional(),
});
export type VocabAudioQueryDto = z.infer<typeof VocabAudioQuerySchema>;