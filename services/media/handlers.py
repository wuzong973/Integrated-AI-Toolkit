"""services/media 的能力实现（probe / transcode / compress / cut / subtitle
+ audio-cut / audio-denoise / render-diagram）。

## 协议

除 `render-diagram`（结构化代码入参，收 **JSON body**）外一律 `multipart/form-data`：
  - `file`  —— 待处理媒体（必填）
  - 其余字段 —— 标量参数（格式、起止秒、目标体积……）

响应：
  - `probe` 返回 JSON；
  - 其余返回**二进制产物**，并带上 `X-Output-Filename` / `X-Output-Content-Type` /
    `X-Duration-Ms` / `X-Encoder` 头，调用方无需自己推断扩展名、耗时与实际编码器。

## 为什么参数校验这么啰嗦

ffmpeg 对脏入参的报错**极难理解**（`-t -3` 只会给你一行 "Invalid argument"）。
所以所有标量都在进 CLI 之前用 `Form.require_*` 卡死，错误信息里直接写清
"哪个参数、允许的范围、实际收到什么"，让排障不必再去翻 ffmpeg 源码。
"""
from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Dict, Iterator, List, Tuple
from urllib.parse import quote

from services.shared.cli import run, workdir
from services.shared.http import Handler, Request, Response, ServiceError
from services.shared.multipart import FilePart, parse_form

from . import render
from .ffmpeg import FORMATS, Ffmpeg, TargetFormat
from .routes import audit
from .settings import MediaSettings

#: 默认质量（CRF / CQ 语义）。23 是 x264 的公认甜点，其他编码器按比例换算。
DEFAULT_CRF = 23
#: 音频码率（kbps）—— 压缩时要从总预算里先扣掉它
DEFAULT_AUDIO_KBPS = 96
#: 压缩目标体积的下限：比这小的情况应该走"截取"而不是"压缩"
MIN_TARGET_BYTES = 64 * 1024
#: 视频码率下限。低于此值编码器只会产出糊成一片的成品，
#: 与其交付这种东西，不如如实告诉调用方"这个体积做不到"。
MIN_VIDEO_BPS = 80_000


# ---------- 文本转语音（edge-tts） ----------
#: 音色**白名单**。不放开成任意字符串：拼错时服务端会静默回落到默认音色
#:（很可能是英文），用户听到"读得不对"却无从判断原因。
TTS_VOICES = (
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunjianNeural",
    # 英文音色：记单词的四六级发音要用它。
    # 用中文音色读英文单词是"能出声、读不对"—— 而听不出差别的人会照着错的音背，
    # 比"没有发音"更糟。美音 / 英音各留男女声（四六级听力两种口音都会出现）。
    "en-US-AriaNeural",
    "en-US-GuyNeural",
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
)
DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural"
#: 单次合成上限。超长文本 edge-tts 会失败，而失败前已经等了很久 —— 提前拒绝更省事。
MAX_TTS_CHARS = 3000
#: 合成是**分钟级**（长文本要多次请求微软服务），别按 ffmpeg 那套 30 秒来衡量
TTS_TIMEOUT_SEC = 180.0


def handle_tts(ff: Ffmpeg, req: Request, tts_bin: str) -> Response:
    """文本转语音（edge-tts CLI → mp3）。

    ## 为什么这个 handler 仍然收 `ff`

    它自己不做转码，但要**用 ffprobe 读出产音频的时长**（结果页要显示）。
    合成本身由 edge-tts 完成。

    ## edge-tts 是 LGPLv3 —— 处置方式与 PyMuPDF（AGPL）相同

    装在**仓库之外**的独立 venv，这里只以**子进程**调它的 CLI，**绝不 import**。
    未配置时返回 501 并给出安装指引，而不是静默降级成"返回空音频"。
    """
    if not tts_bin.strip():
        raise ServiceError.unavailable(
            "语音合成引擎（edge-tts）未安装",
            hint=(
                "edge-tts 为 LGPLv3，必须装在仓库之外的独立 venv，"
                "再把 MEDIA_TTS_BIN 指向它的可执行文件。"
            ),
        )

    form = parse_form(req.body, req.header("Content-Type"))
    text = form.get("text", "").strip()
    voice = form.get("voice", "").strip() or DEFAULT_TTS_VOICE
    rate = form.get("rate", "").strip()

    if not text:
        raise ServiceError("缺少待朗读的文本（字段名 text）", code=40011)
    if len(text) > MAX_TTS_CHARS:
        raise ServiceError(
            f"文本过长（{len(text)} 字，上限 {MAX_TTS_CHARS}）—— 请分段后再合成",
            code=40011,
        )
    if voice not in TTS_VOICES:
        raise ServiceError(f"voice 只能是 {'、'.join(TTS_VOICES)}，收到 {voice!r}", code=40011)

    with workdir("qz-media-tts-") as tmp:
        out = tmp / "out.mp3"
        args = [tts_bin, "--voice", voice, "--text", text, "--write-media", str(out)]
        if rate:
            args += ["--rate", rate]
        run(args, timeout=TTS_TIMEOUT_SEC)
        if not out.is_file():
            raise ServiceError("edge-tts 未产出音频文件", code=42202)
        info = ff.probe(out)
        return _binary(
            out,
            FORMATS["mp3"],
            getattr(info, "duration_ms", 0) or 0,
            {"X-Tts-Voice": voice, "X-Tts-Chars": str(len(text))},
        )


def handle_render_diagram(req: Request) -> Response:
    """图表渲染：Mermaid / markmap 源码 → PNG（playwright 截图）。

    ## 为什么收 JSON 而不是 multipart

    其他端点的入参主体是**二进制文件**，multipart 是自然选择；
    这里的入参是一段**结构化代码**（kind + code），用 JSON 语义更清楚，
    也免去调用方为一段文本拼 FormData。产物仍是二进制 PNG，
    与其他端点一样带 `X-Output-Filename` 头。

    ## 失败语义

      · kind/format 非法、code 为空 → 400（调用方该改参数）；
      · playwright/chromium 未装 → 501 + 安装指引（这台机器装不了，不是代码 bug）；
      · 图表语法错误 / 超时 → 422，侧车错误原文带回（排查要靠它）。
    """
    payload = req.json()
    kind = str(payload.get("kind") or "").strip().lower()
    code = str(payload.get("code") or "")
    fmt = str(payload.get("format") or "png").strip().lower()

    if kind not in render.SUPPORTED_KINDS:
        raise ServiceError(
            f"kind 只能是 {', '.join(render.SUPPORTED_KINDS)}，收到 {kind!r}", code=40011,
        )
    if not code.strip():
        raise ServiceError("缺少图表代码（字段 code）", code=40011)

    png = render.render_diagram(kind, code, fmt)
    return Response(
        raw=png,
        content_type="image/png",
        headers={
            "X-Output-Filename": quote("diagram.png"),
            "X-Diagram-Kind": kind,
            "X-Output-Bytes": str(len(png)),
        },
    )


def build_handlers(settings: MediaSettings) -> Dict[Tuple[str, str], Handler]:
    """装配 handler 表。键必须与 `routes.ROUTES` 完全一致（框架会告警校验）。"""
    ff = Ffmpeg(settings.ffmpeg_bin, settings.ffprobe_bin, timeout_sec=settings.timeout_sec)

    handlers = {
        ("POST", "/media/probe"): lambda req: handle_probe(ff, req),
        ("POST", "/media/transcode"): lambda req: handle_transcode(ff, req),
        ("POST", "/media/compress"): lambda req: handle_compress(ff, req),
        ("POST", "/media/cut"): lambda req: handle_cut(ff, req),
        ("POST", "/media/audio-cut"): lambda req: handle_audio_cut(ff, req),
        ("POST", "/media/audio-denoise"): lambda req: handle_audio_denoise(ff, req),
        ("POST", "/media/subtitle"): lambda req: handle_subtitle(ff, req),
        # TTS 额外需要二进制路径，用闭包带上（其余 handler 只依赖 ff）
        ("POST", "/media/tts"): lambda req: handle_tts(ff, req, settings.tts_bin),
        # 图表渲染不依赖 ffmpeg，收 JSON body（见 handle_render_diagram 说明）
        ("POST", "/media/render-diagram"): lambda req: handle_render_diagram(req),
    }

    # 启动即对账：handler 与 IMPLEMENTED 声明漂移时不会有任何运行时报错，
    # 只会静默地"少报/多报"能力，所以必须在启动日志里说出来。
    for problem in audit(handlers):
        logging.getLogger("qz-media").warning("能力清单不一致：%s", problem)

    return handlers


def preflight(settings: MediaSettings) -> List[str]:
    """启动前的依赖体检（与 `services/ai` 的 preflight 同一纪律）。

    配置/依赖错了却不报错是最难查的一类：服务健康、端口通、日志干净，
    但每一个渲染请求都 501。所以启动时就说出来，运维一眼能看到装什么。
    """
    problems: List[str] = []

    reason = render.dependency_error()
    if reason:
        problems.append(f"图表渲染依赖未就绪，/media/render-diagram 将返回 501：{reason}")

    return problems


# ==================== 能力实现 ====================


def handle_probe(ff: Ffmpeg, req: Request) -> Response:
    """读取媒体信息（时长 / 分辨率 / 码率 / 编码）。"""
    part = parse_form(req.body, req.header("Content-Type")).file()
    with _staged(part) as src:
        info = ff.probe(src)

    return Response(payload={
        "durationSec": round(info.duration_sec, 3),
        "width": info.width,
        "height": info.height,
        "bitrate": info.bitrate,
        "sizeBytes": info.size_bytes,
        "format": info.format,
        "videoCodec": info.video_codec,
        "audioCodec": info.audio_codec,
        "hasVideo": info.has_video,
        "hasAudio": info.has_audio,
    })


def handle_transcode(ff: Ffmpeg, req: Request) -> Response:
    """音视频格式转换。"""
    form = parse_form(req.body, req.header("Content-Type"))
    target = _target_format(form.get("format"))
    part = form.file()

    with _staged(part) as src:
        out = src.with_name(f"output.{target.ext}")

        # 纯音频目标没有"编码器候选"的概念（每种容器就一个），直接执行。
        if target.kind == "audio":
            args = ["-i", src.name, "-vn", "-c:a", target.audio_encoder]
            if target.audio_encoder in ("libmp3lame", "aac", "libopus"):
                args += ["-b:a", f"{DEFAULT_AUDIO_KBPS}k"]
            result = ff.run_ffmpeg(args + [out.name], cwd=src.parent)
            return _binary(out, target, result.duration_ms,
                           {"X-Encoder": target.audio_encoder})

        encoder, result = ff.run_with_encoder(
            target.video_encoders,
            "视频",
            lambda enc: _video_args(target, enc, src.name, out.name),
            cwd=src.parent,
        )
        return _binary(out, target, result.duration_ms, {"X-Encoder": encoder})


def handle_compress(ff: Ffmpeg, req: Request) -> Response:
    """把视频压到目标体积。

    体积 → 码率的换算：`视频码率 = 目标字节×8 ÷ 时长 − 音频码率`。
    单遍处理（不做 two-pass）：two-pass 要把视频解码两遍，
    在"用户在小程序里等结果"的场景下，代价明显高于它带来的那点精度收益。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    target_bytes = form.require_int("targetSizeBytes", minimum=MIN_TARGET_BYTES)
    crf = form.require_int("crf", default=DEFAULT_CRF, minimum=0, maximum=51)

    with _staged(part) as src:
        info = ff.probe(src)
        if info.duration_sec <= 0:
            raise ServiceError(
                "无法读取媒体时长，无法按目标体积压缩",
                code=42201,
                hint="文件可能已损坏。可先调 /media/probe 确认",
            )

        budget_bps = int(target_bytes * 8 / info.duration_sec)
        audio_bps = DEFAULT_AUDIO_KBPS * 1000 if info.has_audio else 0
        video_bps = budget_bps - audio_bps
        if video_bps < MIN_VIDEO_BPS:
            achievable = int((MIN_VIDEO_BPS + audio_bps) * info.duration_sec / 8)
            raise ServiceError(
                f"目标体积过小：按 {info.duration_sec:.0f} 秒时长，"
                f"最小约需 {achievable // 1024} KB",
                code=42203,
                hint="请降低分辨率，或先用 /media/cut 截取片段",
            )

        out = src.with_name("output.mp4")
        encoder, result = ff.run_with_encoder(
            FORMATS["mp4"].video_encoders,
            "视频",
            lambda enc: _compress_args(enc, crf, video_bps, info.has_audio, src.name, out.name),
            cwd=src.parent,
        )
        return _binary(out, FORMATS["mp4"], result.duration_ms, {
            "X-Encoder": encoder,
            "X-Target-Bytes": str(target_bytes),
            "X-Video-Bitrate": str(video_bps),
        })


def handle_cut(ff: Ffmpeg, req: Request) -> Response:
    """裁剪片段。

    默认**流复制**（`-c copy`）：秒级完成、零画质损失，代价是切点会对齐到
    最近的关键帧（实际时长可能与请求值差几百毫秒）。需要帧级精确时
    传 `mode=encode` 重编码 —— 慢，但切点是准的。
    两种模式的**实际**时长都会随响应头返回，调用方不必猜。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    start = form.require_float("startSec", default=0.0, minimum=0.0)
    end = form.require_float("endSec", minimum=0.0)
    mode = form.get("mode", "copy")

    if end <= start:
        raise ServiceError(f"结束时间必须大于开始时间（收到 {start} → {end}）", code=40011)
    if mode not in ("copy", "encode"):
        raise ServiceError(f"mode 只能是 copy 或 encode，收到 {mode!r}", code=40011)

    with _staged(part) as src:
        info = ff.probe(src)
        if info.duration_sec and start >= info.duration_sec:
            raise ServiceError(
                f"开始时间 {start}s 超出媒体时长 {info.duration_sec:.2f}s", code=40011
            )
        # 请求越过末尾时按末尾截断，而不是报错 —— 用户把滑块拖到最右端是常见操作
        end = min(end, info.duration_sec) if info.duration_sec else end

        out = src.with_name("output.mp4")
        lead: List[str] = ["-ss", f"{start}", "-i", src.name, "-t", f"{end - start}"]

        if mode == "copy":
            result = ff.run_ffmpeg(
                [*lead, "-c", "copy", "-avoid_negative_ts", "make_zero",
                 "-movflags", "+faststart", out.name],
                cwd=src.parent,
            )
            encoder = "copy"
        else:
            encoder, result = ff.run_with_encoder(
                FORMATS["mp4"].video_encoders,
                "视频",
                lambda enc: [*lead, "-map", "0:v:0", "-map", "0:a:0?",
                             "-c:v", enc, *_quality_args(enc, DEFAULT_CRF),
                             "-c:a", "aac", "-movflags", "+faststart", out.name],
                cwd=src.parent,
            )

        cut_info = ff.probe(out)
        return _binary(out, FORMATS["mp4"], result.duration_ms, {
            "X-Encoder": encoder,
            "X-Cut-Duration-Sec": f"{cut_info.duration_sec:.3f}",
            "X-Cut-Mode": mode,
        })



# ==================== 音频类（2026-09-19 起） ====================

#: 降噪档位 → afftdn（FFT 去噪）的降噪量 dB。越大越"干净"，但细节损失也越多。
#: 刻意用 **afftdn** 而不是 `anlmdn`：后者对长音频慢一个数量级，
#: 而两者在"人声更清楚"这个用户目标上的差距，远小于等待时间的差距。
DENOISE_DB = {"light": 8, "medium": 14, "strong": 22}

#: 音频裁剪允许的输出容器（与转码的音频目标保持一致，避免出现"能转却不能裁"的怪象）
AUDIO_EXTS = {"mp3": "libmp3lame", "m4a": "aac", "wav": "pcm_s16le", "aac": "aac", "flac": "flac"}


def handle_audio_cut(ff: Ffmpeg, req: Request) -> Response:
    """音频裁剪。

    与视频裁剪（`/media/cut`）分开成两个端点，是刻意的：
    音频要的是"保留原始音质"—— 重编码一次就会多一代损耗，
    所以这里默认**按容器直接流复制**（`-c copy`），只有容器不支持时才重编码为 m4a。
    `/media/cut` 面向视频，它输出 .mp4，把音频塞进去会得到"能播但后缀不对"的产物。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    start = form.require_float("startSec", default=0.0, minimum=0.0)
    end = form.require_float("endSec", minimum=0.0)
    fmt = form.get("format", "").strip().lower()

    if end <= start:
        raise ServiceError(f"结束时间必须大于开始时间（收到 {start} → {end}）", code=40011)

    src_ext = Path(part.filename or "").suffix.lower().lstrip(".")
    ext = fmt or (src_ext if src_ext in AUDIO_EXTS else "m4a")
    if ext not in AUDIO_EXTS:
        raise ServiceError(
            f"音频裁剪只支持 {', '.join(sorted(AUDIO_EXTS))}，收到 {ext}", code=40011,
        )

    with _staged(part) as src:
        info = ff.probe(src)
        if info.duration_sec and start >= info.duration_sec:
            raise ServiceError(
                f"开始时间 {start}s 超出音频时长 {info.duration_sec:.2f}s", code=40011,
            )
        end = min(end, info.duration_sec) if info.duration_sec else end

        out = src.with_name(f"output.{ext}")
        lead: List[str] = ["-ss", f"{start}", "-i", src.name, "-t", f"{end - start}", "-vn"]
        encoder = "copy"
        # 同容器流复制最快且零损耗；跨容器必须重编码（copy 会产出打不开的文件）
        if ext == src_ext:
            result = ff.run_ffmpeg([*lead, "-c:a", "copy", out.name], cwd=src.parent)
        else:
            encoder = AUDIO_EXTS[ext]
            args = [*lead, "-c:a", encoder]
            if encoder in ("libmp3lame", "aac"):
                args += ["-b:a", f"{DEFAULT_AUDIO_KBPS}k"]
            result = ff.run_ffmpeg([*args, out.name], cwd=src.parent)

        return _audio_response(out, ext, result.duration_ms, {"X-Encoder": encoder,
                                                              "X-Cut-From": f"{start}",
                                                              "X-Cut-To": f"{end}"})


def handle_audio_denoise(ff: Ffmpeg, req: Request) -> Response:
    """音频降噪（afftdn）。

    ## 为什么不做"人声分离"

    用户说"降噪"时，要的是**保留一条完整音轨**（只是更干净）；
    人声/伴奏分离是另一件事（要 Demucs 这类模型，`separate_vocals` 走 `services/ai`）。
    把降噪包装成分离来卖，是最容易翻车的那种"功能叫对了、结果不对"。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    strength = form.get("strength", "medium").strip().lower() or "medium"
    if strength not in DENOISE_DB:
        raise ServiceError(
            f"strength 只能是 {', '.join(DENOISE_DB)}，收到 {strength!r}", code=40011,
        )

    src_ext = Path(part.filename or "").suffix.lower().lstrip(".")
    ext = src_ext if src_ext in AUDIO_EXTS else "m4a"

    with _staged(part) as src:
        out = src.with_name(f"output-denoised.{ext}")
        encoder = AUDIO_EXTS[ext] if ext != src_ext else "copy"
        args: List[str] = [
            "-i", src.name,
            "-af", f"afftdn=nr={DENOISE_DB[strength]}:nf=-25",
            "-vn",
        ]
        if encoder == "copy":
            # 同容器 + 滤镜必须重编码（滤镜意味着要解码），copy 会静默丢掉滤镜
            encoder = AUDIO_EXTS[ext] if ext in AUDIO_EXTS else "aac"
        args += ["-c:a", encoder]
        if encoder in ("libmp3lame", "aac"):
            args += ["-b:a", f"{DEFAULT_AUDIO_KBPS}k"]
        result = ff.run_ffmpeg([*args, out.name], cwd=src.parent)

        return _audio_response(out, ext, result.duration_ms, {
            "X-Encoder": encoder,
            "X-Denoise-Strength": strength,
        })


def _audio_response(out: Path, ext: str, duration_ms: int,
                    extra: Dict[str, str] | None = None) -> Response:
    """音频产物响应（与 `_binary` 同构，但音频的 MIME/后缀不来自 TargetFormat）。"""
    if not out.is_file():
        raise ServiceError("ffmpeg 未产出输出文件", code=42202)

    content_type = {
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav",
        "aac": "audio/aac", "flac": "audio/flac",
    }.get(ext, "application/octet-stream")

    headers = {
        "X-Output-Filename": quote(out.name),
        "X-Output-Content-Type": content_type,
        "X-Duration-Ms": str(duration_ms),
    }
    headers.update(extra or {})
    return Response(raw=out.read_bytes(), content_type=content_type, headers=headers)


def handle_subtitle(ff: Ffmpeg, req: Request) -> Response:
    """烧录字幕。

    ⚠️ 字幕文件的路径必须**相对**：ffmpeg 的 `subtitles` 滤镜把 `:` 当参数分隔符，
    Windows 绝对路径（`C:/...`）得转义成 `C\\:/...` 才能用。
    这里改成"把输入与字幕放进同一个临时目录、以相对名调用"，
    从根上绕开这个坑 —— 顺带也回避了本机用户名含引号（`w'w'w`）的问题。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    srt = form.get("srt")
    if not srt.strip():
        raise ServiceError("缺少字幕内容（字段 `srt`）", code=40011)

    with _staged(part) as src:
        src.with_name("sub.srt").write_text(srt, encoding="utf-8")
        out = src.with_name("output.mp4")

        # force_style 是一层兜底：ffmpeg 默认字体在 Windows 上不带中文字形，
        # 不指定的话烧出来的中文全是方块。
        vf = "subtitles=sub.srt:force_style='FontName=Microsoft YaHei,FontSize=20'"
        encoder, result = ff.run_with_encoder(
            FORMATS["mp4"].video_encoders,
            "视频",
            lambda enc: ["-i", src.name, "-vf", vf,
                         "-c:v", enc, *_quality_args(enc, DEFAULT_CRF),
                         "-c:a", "copy", "-movflags", "+faststart", out.name],
            cwd=src.parent,
        )
        return _binary(out, FORMATS["mp4"], result.duration_ms, {"X-Encoder": encoder})


# ==================== 内部工具 ====================


@contextlib.contextmanager
def _staged(part: FilePart) -> Iterator[Path]:
    """把上传的字节落到临时目录，并在退出时清理。

    外部程序只认文件路径，所以"字节进、字节出"在接口上成立，在内部必须落盘。
    保留原扩展名是因为 ffmpeg **会按扩展名猜容器**：把 .mp4 写成 .bin
    会让解复用器选错，报出的错跟真实原因毫无关系。
    """
    with workdir("qz-media-") as root:
        suffix = Path(part.filename or "input").suffix or ".bin"
        path = root / f"input{suffix}"
        path.write_bytes(part.data)
        yield path


def _target_format(raw: str) -> TargetFormat:
    key = (raw or "").strip().lower().lstrip(".")
    if not key:
        raise ServiceError("缺少目标格式（字段 `format`）", code=40011)
    target = FORMATS.get(key)
    if target is None:
        raise ServiceError(
            f"不支持的目标格式 {key!r}",
            code=40011,
            hint=f"可选：{', '.join(sorted(FORMATS))}",
        )
    return target


def _video_args(target: TargetFormat, encoder: str, src_name: str, out_name: str) -> List[str]:
    """视频/动图目标的完整参数（编码器由调用方选定后传进来）。"""
    if target.palette_filter:
        # GIF 必须走调色板两遍，直接用默认调色会得到满是噪点的成品
        vf = ("fps=12,scale=480:-1:flags=lanczos,"
              "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse")
        return ["-i", src_name, "-vf", vf, "-c:v", encoder, "-loop", "0", "-an", out_name]

    args: List[str] = ["-i", src_name, "-map", "0:v:0", "-map", "0:a:0?",
                       "-c:v", encoder, *target.extra_args,
                       *_quality_args(encoder, DEFAULT_CRF)]
    if target.audio_encoder:
        args += ["-c:a", target.audio_encoder]
    return args + ["-movflags", "+faststart", out_name]


def _compress_args(encoder: str, crf: int, video_bps: int, has_audio: bool,
                   src_name: str, out_name: str) -> List[str]:
    args: List[str] = [
        "-i", src_name,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", encoder,
        *_quality_args(encoder, crf),
        "-b:v", f"{video_bps // 1000}k",
        "-maxrate", f"{int(video_bps * 1.5) // 1000}k",
        "-bufsize", f"{video_bps * 2 // 1000}k",
    ]
    if has_audio:
        args += ["-c:a", "aac", "-b:a", f"{DEFAULT_AUDIO_KBPS}k"]
    return args + ["-movflags", "+faststart", out_name]


def _quality_args(encoder: str, crf: int) -> List[str]:
    """把统一的"质量"语义翻译成各编码器自己的参数。

    同一个 23 在不同编码器上含义完全不同：x264 是 CRF，nvenc 是 CQ，
    AMF 要拆成 qp_i/qp_p，mpeg4 只有 qscale，而 openh264 压根没有质量档
    （只能给码率）。这段映射就是"别让上层关心这些"的那层。
    """
    if encoder in ("libx264", "libx265"):
        return ["-preset", "veryfast", "-crf", str(crf)]
    if encoder.endswith("_nvenc"):
        return ["-preset", "p4", "-cq", str(crf)]
    if encoder.endswith("_amf"):
        return ["-rc", "cqp", "-qp_i", str(crf), "-qp_p", str(crf)]
    if encoder.endswith("_qsv"):
        return ["-global_quality", str(crf)]
    if encoder == "libvpx-vp9":
        return ["-deadline", "good", "-cpu-used", "4", "-crf", str(crf)]
    if encoder == "libopenh264":
        return ["-b:v", "2M"]
    if encoder == "gif":
        # 画质由 palettegen/paletteuse 决定，编码器本身没有质量档；
        # 传 `-qscale` 之类会被当成无效选项直接报错。
        return []
    # mpeg4 等老编码器：qscale 越小越好，量程 1~31
    return ["-qscale:v", str(max(2, min(31, round(crf / 2))))]


def _binary(out: Path, target: TargetFormat, duration_ms: int,
            extra: Dict[str, str] | None = None) -> Response:
    if not out.is_file():
        raise ServiceError("ffmpeg 未产出输出文件", code=42202)

    headers = {
        # 文件名可能含中文，而响应头只能是 ASCII → 用 URL 编码。
        # 不做这步会直接抛 UnicodeEncodeError，把一次成功的处理变成 500。
        "X-Output-Filename": quote(f"output.{target.ext}"),
        "X-Output-Content-Type": target.content_type,
        "X-Duration-Ms": str(duration_ms),
    }
    headers.update(extra or {})
    return Response(raw=out.read_bytes(), content_type=target.content_type, headers=headers)
