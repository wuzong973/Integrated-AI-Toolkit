"""AI 服务配置：公共字段 + AI 专属模型参数（与 .env 对齐）。"""
from __future__ import annotations

from dataclasses import dataclass

from services.shared.config import BaseSettings, base_settings, env_int, env_str

DEFAULT_PORT = 8000


@dataclass(frozen=True)
class AiSettings(BaseSettings):
    """AI 服务配置。模型白名单见设计文档 2.8.4（许可受限的模型一律不用）。"""

    rembg_model: str = "u2net"
    vocal_separation_engine: str = "demucs"
    whisper_model: str = "small"
    gpu_concurrency: int = 1

    @property
    def health_config(self) -> dict:
        """/health 里回显的生效配置，便于联调时一眼看出用的是哪套模型。"""
        return {
            "rembgModel": self.rembg_model,
            "vocalSeparationEngine": self.vocal_separation_engine,
            "whisperModel": self.whisper_model,
            "gpuConcurrency": self.gpu_concurrency,
        }


def load_settings() -> AiSettings:
    base = base_settings("ai", "AI_HOST", "AI_PORT", DEFAULT_PORT)
    return AiSettings(
        service_name=base.service_name,
        host=base.host,
        port=base.port,
        log_level=base.log_level,
        version=base.version,
        stage=base.stage,
        rembg_model=env_str("REMBG_MODEL", "u2net"),
        vocal_separation_engine=env_str("VOCAL_SEPARATION_ENGINE", "demucs"),
        whisper_model=env_str("WHISPER_MODEL", "small"),
        gpu_concurrency=env_int("GPU_CONCURRENCY", 1),
    )
