import { BizException, ErrorCode, type PracticeSubmitDto } from '@qz/core';

/**
 * 提交入参的解析与校验（纯函数，不含 IO）
 *
 * 单独成文件的两个理由：`practice-submit.service.ts` 贴着 300 行红线，
 * 且这几个函数是**唯一能报参数错的地方** —— 集中在一处才看得清
 * "到底有哪些拒绝理由"，而散在 service 里时新增一条很容易漏掉对应的文案。
 */

/** 服务端查出来的目标句（`submitSpeak` 需要的那几列） */
export interface SpeakTargetRow {
  id: string;
  en: string;
  zh: string;
  speakable: boolean;
}

/**
 * 校验"口语提交"的入参，返回音频。
 *
 * ## 为什么分成"有没有音频"和"句子能不能读"两步
 *
 * 两者对应**完全不同的用户动作**：前者是"没录上"（重录一次即可），
 * 后者是"这句话本来就不该出现在口语队列里"（该换一句）。
 * 合成一条错误文案会让后者看起来像前者，用户会一直重录而问题不在他。
 *
 * ## ⚠️ `speakable` 的判据是"含引号或太短"
 *
 * 见 `scripts/db/gen-sentences.mjs` 的 `isSpeakable`：含 `"` 的句子（对话引用）
 * 让 ASR 与对齐都不可靠 —— 用户不会读出引号，而目标句里有，
 * 那一个词就永远对不上。这是**在导入时就算好的字段**，不在请求时判
 * （否则每次提交都要扫一遍字符串，而 2 万条句子里绝大多数不会被朗读）。
 */
export function requireSpeakableUpload(
  dto: PracticeSubmitDto,
  row: SpeakTargetRow | null,
): { row: SpeakTargetRow; audio: Buffer } {
  if (!row) throw notFound('句子');
  if (!dto.audioBase64) {
    throw new BizException(ErrorCode.ParamInvalid, undefined, '没有收到录音，请按住按钮再读一次');
  }
  if (!row.speakable) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      { refId: row.id },
      '这句话不适合朗读（含引号或太短），换一句吧',
    );
  }
  return { row, audio: decodeAudio(dto.audioBase64) };
}

/**
 * 音频解码（base64 → Buffer），带三重校验。
 *
 * ## ① 容错 `data:` 前缀
 *
 * 小程序 `wx.getFileSystemManager().readFile({ encoding: 'base64' })` 给的是
 * **不带前缀**的，但手测 curl 时习惯带上。只支持一种会让另一种报"音频格式不对"，
 * 而真实原因只是多了 22 个字符。
 *
 * ## ② 空内容
 *
 * `Buffer.from('', 'base64')` 返回长度为 0 的 buffer 而**不抛错** ——
 * 不拦的话会把一个 0 字节的文件发给 ASR，上游报一个看不懂的错。
 *
 * ## ③ 太短
 *
 * 小程序录到 0.1 秒也会给一个合法 mp3 头（约 200 字节）。
 * 提前拦掉能省一次 ASR 调用与一次额度，且给用户的提示
 * （"按住按钮把整句读完再松手"）比上游的报错有用得多。
 */
export function decodeAudio(base64: string): Buffer {
  const comma = base64.indexOf(',');
  const pure = base64.startsWith('data:') && comma > 0 ? base64.slice(comma + 1) : base64;
  const buf = Buffer.from(pure, 'base64');
  if (buf.length === 0) {
    throw new BizException(ErrorCode.ParamInvalid, undefined, '录音内容为空，请重新录一次');
  }
  if (buf.length < MIN_AUDIO_BYTES) {
    throw new BizException(
      ErrorCode.ParamInvalid,
      { bytes: buf.length },
      '录音太短了，按住按钮把整句读完再松手',
    );
  }
  return buf;
}

/** 最短录音（约 0.3s 的 16kbps mp3）—— 低于它几乎必然是人声为空 */
export const MIN_AUDIO_BYTES = 600;

/**
 * 统一的"目标不存在"错误。
 *
 * 三处（句子 / 口语 / 作文）都用它，避免文案分叉 ——
 * 分叉的结果是同一个"题库里没这条"，在不同入口显示三句不同的话，
 * 而排障的人会以为是三个不同的问题。
 */
export function notFound(what: string): BizException {
  return new BizException(ErrorCode.NotFound, undefined, `这个${what}不存在，请下拉刷新练习列表`);
}
