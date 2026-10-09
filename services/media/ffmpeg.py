"""FFmpeg / ffprobe 适配层。

## 只用 CLI，不链接 libav*

FFmpeg 必须是 LGPL 构建（`scripts/license/check-ffmpeg-license.sh` 断言
`-buildconf` 里不出现 `--enable-gpl`）。本模块一律以子进程方式调用，
不 import 任何 Python 绑定 —— 绑定会把 ffmpeg 的动态库链进进程，
那样 LGPL 的"可替换性"就没了，许可结论也不再成立。

## 编码器不能写死

本机这份 LGPL 构建**关掉了 libx264 / libx265**（GPL 组件），
所以"转 mp4 就用 libx264"这种写法在这里会直接报 unknown encoder。
改法不是硬编码成 mpeg4（画质差很多），而是**运行时读 `-encoders` 挑**：
有 libx264 就用它，没有就退到硬件编码（nvenc/amf/qsv），再退到 openh264/mpeg4。
这样同一份代码在开发机和生产服务器上都能跑，且永远选到当前可用的最好那个。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

from services.shared.cli import CliError, CliResult, resolve_binary, run
from services.shared.http import ServiceError

#: 硬件编码器的名字后缀。用于判定"失败后能不能降级到软件编码器重试"。
HARDWARE_SUFFIXES = ("_nvenc", "_amf", "_qsv", "_vaapi", "_videotoolbox", "_mf")


def is_hardware(encoder: str) -> bool:
    """是否为硬件编码器。

    ⚠️ 判据只能是后缀，不能靠"名字里有没有 GPU 字样" ——
    nvenc 名里没有 GPU，而纯软件的 `libvpx` 名里也没有。
    """
    return encoder.endswith(HARDWARE_SUFFIXES)


@dataclass(frozen=True)
class MediaInfo:
    """探测结果（对齐 packages/core 的 VideoInfo）。"""

    duration_sec: float
    width: int
    height: int
    bitrate: int
    size_bytes: int
    format: str
    video_codec: str
    audio_codec: str
    has_video: bool
    has_audio: bool


@dataclass(frozen=True)
class TargetFormat:
    """一个输出目标的全部知识：容器、MIME、可选编码器、容器专属参数。"""

    ext: str
    content_type: str
    kind: str  # video | audio | image
    video_encoders: Tuple[str, ...] = ()
    audio_encoder: str = ""
    extra_args: Tuple[str, ...] = ()
    #: 需要 palettegen/paletteuse 两遍滤镜（GIF 专用）
    palette_filter: bool = False


FORMATS: dict = {
    # 容器     扩展名  MIME              类型    视频编码器候选（按画质/性能排序）
    "mp4": TargetFormat("mp4", "video/mp4", "video",
                        ("libx264", "h264_nvenc", "h264_amf", "h264_qsv", "libopenh264", "mpeg4"),
                        "aac"),
    "webm": TargetFormat("webm", "video/webm", "video",
                         ("libvpx-vp9", "libvpx"), "libopus", ("-b:v", "0")),
    "gif": TargetFormat("gif", "image/gif", "image",
                        # ⚠️ 只能是 `gif`：gif muxer 不接受 H.264/MPEG-4 流
                        # （实测报 "gif muxer supports only codec gif for type video"）。
                        # 画质与体积由前面的 palettegen/paletteuse 滤镜决定，
                        # 所以质量参数对它是空操作。
                        ("gif",), "", palette_filter=True),
    "mp3": TargetFormat("mp3", "audio/mpeg", "audio", (), "libmp3lame"),
    "wav": TargetFormat("wav", "audio/wav", "audio", (), "pcm_s16le"),
    "aac": TargetFormat("aac", "audio/aac", "audio", (), "aac"),
    "flac": TargetFormat("flac", "audio/flac", "audio", (), "flac"),
}


class Ffmpeg:
    """一次装配、多处复用的 ffmpeg 调用器。"""

    def __init__(self, ffmpeg_bin: str, ffprobe_bin: str, *, timeout_sec: float) -> None:
        self._ffmpeg_cfg = ffmpeg_bin
        self._ffprobe_cfg = ffprobe_bin
        self._timeout = timeout_sec

    # ---------- 可执行文件 ----------

    @property
    def ffmpeg(self) -> Optional[str]:
        return resolve_binary(self._ffmpeg_cfg, "ffmpeg")

    @property
    def ffprobe(self) -> Optional[str]:
        return resolve_binary(self._ffprobe_cfg, "ffprobe")

    def require_ffmpeg(self) -> str:
        path = self.ffmpeg
        if not path:
            raise ServiceError.unavailable(
                "未找到 ffmpeg 可执行文件，媒体能力不可用",
                hint="设置 FFMPEG_BIN 为 LGPL 构建的绝对路径（不要用 GPL 构建）",
            )
        return path

    def require_ffprobe(self) -> str:
        path = self.ffprobe
        if not path:
            raise ServiceError.unavailable(
                "未找到 ffprobe 可执行文件，媒体探测不可用",
                hint="FFPROBE_BIN 通常与 FFMPEG_BIN 同目录",
            )
        return path

    # ---------- 编码器能力 ----------

    @lru_cache(maxsize=8)
    def _encoders(self, binary: str) -> frozenset:
        result = run([binary, "-hide_banner", "-encoders"], timeout=30)
        names = set()
        for line in result.stdout_text.splitlines():
            # 形如 " V....D libx264              H.264 / AVC ..."
            match = re.match(r"^\s*[A-Z.]{6}\s+(\S+)", line)
            if match:
                names.add(match.group(1))
        return frozenset(names)

    def encoders(self) -> frozenset:
        binary = self.require_ffmpeg()
        try:
            return self._encoders(binary)
        except CliError as e:
            raise ServiceError.unavailable(
                f"无法读取 ffmpeg 编码器列表：{e}",
                hint="先用 `ffmpeg -encoders` 确认这份构建是否可用",
            ) from e

    def pick_encoder(self, candidates: Sequence[str], kind: str) -> str:
        """按优先级挑一个"当前构建里有"的编码器。

        ⚠️ 它只回答"编进来了没有"，不回答"这台机器现在能不能用"。
        需要真实执行的地方请用 `run_with_encoder()` —— 那里补了硬件编码器
        的失败降级；本方法仅用于"先把名字挑出来做日志/响应头"的场景。
        """
        available = self.encoders()
        for name in candidates:
            if name in available:
                return name
        raise ServiceError.unavailable(
            f"本机 ffmpeg 缺少可用的{kind}编码器（候选：{', '.join(candidates)}）",
            hint="安装带该编码器的 ffmpeg 构建，或在 FORMATS 表中调整候选顺序",
        )

    # ---------- 探测 ----------

    def probe(self, path: Path) -> MediaInfo:
        binary = self.require_ffprobe()
        args = [
            binary, "-hide_banner", "-loglevel", "error",
            "-print_format", "json", "-show_format", "-show_streams", str(path),
        ]
        try:
            result = run(args, timeout=min(self._timeout, 120))
        except CliError as e:
            raise ServiceError(f"媒体探测失败：{e}。{e.detail}", code=42201) from e

        try:
            payload = json.loads(result.stdout_text or "{}")
        except json.JSONDecodeError as e:
            raise ServiceError("ffprobe 返回的 JSON 无法解析", code=42201) from e

        streams = payload.get("streams") or []
        fmt = payload.get("format") or {}
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

        return MediaInfo(
            duration_sec=_to_float(fmt.get("duration") or (video or {}).get("duration")),
            width=int(video.get("width") or 0) if video else 0,
            height=int(video.get("height") or 0) if video else 0,
            bitrate=int(_to_float(fmt.get("bit_rate"))),
            size_bytes=int(_to_float(fmt.get("size"))),
            format=str(fmt.get("format_name") or ""),
            video_codec=str((video or {}).get("codec_name") or ""),
            audio_codec=str((audio or {}).get("codec_name") or ""),
            has_video=video is not None,
            has_audio=audio is not None,
        )

    # ---------- 执行 ----------

    def run_ffmpeg(self, args: Sequence[str], *, cwd: Path, timeout: Optional[float] = None):
        binary = self.require_ffmpeg()
        full: List[str] = [binary, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args]
        try:
            return run(full, timeout=timeout or self._timeout, cwd=cwd)
        except CliError as e:
            raise ServiceError(
                f"ffmpeg 处理失败：{e}",
                code=42202,
                hint=e.detail,
            ) from e

    def run_with_encoder(
        self,
        candidates: Sequence[str],
        kind: str,
        build_args: Callable[[str], List[str]],
        *,
        cwd: Path,
        timeout: Optional[float] = None,
    ) -> Tuple[str, CliResult]:
        """按候选顺序挑编码器执行，**硬件编码器失败时自动降级**。

        为什么只看 `-encoders` 还不够：那张表说明"这份构建编进了这个编码器"，
        但不保证"这台机器现在能用它"。典型失败场景是驱动版本不匹配、
        显存被占满、或输入是 10bit 而该编码器只吃 8bit —— 此时 ffmpeg
        会以非零码退出，而**换一个软件编码器就能过**。

        降级只对**硬件**编码器生效：软件编码器失败基本等于输入本身有问题
        （损坏文件、不支持的像素格式），那种情况重试三次只是把排障时间
        拖长三倍，还得不到新信息，所以直接失败。
        """
        available = self.encoders()
        usable = [name for name in candidates if name in available]
        if not usable:
            raise ServiceError.unavailable(
                f"本机 ffmpeg 缺少可用的{kind}编码器（候选：{', '.join(candidates)}）",
                hint="安装带该编码器的 ffmpeg 构建，或在 FORMATS 表中调整候选顺序",
            )

        last: Optional[ServiceError] = None
        for index, encoder in enumerate(usable):
            try:
                result = self.run_ffmpeg(build_args(encoder), cwd=cwd, timeout=timeout)
                return encoder, result
            except ServiceError as e:
                last = e
                remaining = usable[index + 1:]
                if not is_hardware(encoder) or not remaining:
                    raise
                self._logger_fallback(encoder, remaining[0], e)

        raise last if last else ServiceError("ffmpeg 处理失败", code=42202)

    def _logger_fallback(self, failed: str, next_encoder: str, error: ServiceError) -> None:
        logging.getLogger("qz-media").warning(
            "编码器 %s 执行失败（%s），降级到 %s 重试", failed, error, next_encoder
        )


def _to_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
