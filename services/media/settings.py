"""媒体服务配置。

注意：FFmpeg 是**系统级依赖**，必须是 LGPL 构建（scripts/license/check-ffmpeg-license.sh 断言），
Python 侧只以子进程调用 CLI，绝不链接 libav*，避免 GPL 组件污染主工程。
"""
from __future__ import annotations

from dataclasses import dataclass

from services.shared.config import BaseSettings, base_settings, env_float, env_str

from . import render

DEFAULT_PORT = 8001


@dataclass(frozen=True)
class MediaSettings(BaseSettings):
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    #: edge-tts 可执行文件（装在**仓库之外**的独立 venv —— 它是 LGPLv3，
    #: 与 PyMuPDF 同一处置：独立安装 + 子进程调用，绝不 import）。留空 = 未安装。
    tts_bin: str = ""
    #: 单次 ffmpeg 调用的墙钟上限。
    #: 给到 10 分钟而不是 30 秒：转码是**分钟级**任务（一部 10 分钟的视频重编码
    #: 在 CPU 上就要几分钟），超时设短了会把正常任务判成失败。
    #: 真正的"卡死"由 ffmpeg 自己的 `-loglevel error` 与进程退出兜底。
    timeout_sec: float = 600.0

    @property
    def health_config(self) -> dict:
        return {
            "ffmpegBin": self.ffmpeg_bin,
            "ffprobeBin": self.ffprobe_bin,
            # 空串 = 未安装，`/media/tts` 会返回 501 —— 让运维在 /health 一眼看出来
            "ttsBin": self.tts_bin,
            "timeoutSec": self.timeout_sec,
            # 图表渲染（playwright/chromium）是否就绪；未就绪时 /media/render-diagram 返回 501
            "renderReady": render.dependency_error() is None,
        }


def load_settings() -> MediaSettings:
    base = base_settings("media", "MEDIA_HOST", "MEDIA_PORT", DEFAULT_PORT)
    return MediaSettings(
        service_name=base.service_name,
        host=base.host,
        port=base.port,
        log_level=base.log_level,
        version=base.version,
        stage=base.stage,
        ffmpeg_bin=env_str("FFMPEG_BIN", "ffmpeg"),
        ffprobe_bin=env_str("FFPROBE_BIN", "ffprobe"),
        # edge-tts（LGPLv3）装在仓库外的独立 venv，这里只拿它的可执行文件路径
        tts_bin=env_str("MEDIA_TTS_BIN", ""),
        timeout_sec=env_float("FFMPEG_TIMEOUT_SEC", 600.0),
    )
