"""转换服务配置。"""
from __future__ import annotations

from dataclasses import dataclass

from services.shared.config import BaseSettings, base_settings, env_float, env_str

DEFAULT_PORT = 8002


@dataclass(frozen=True)
class ConvertSettings(BaseSettings):
    #: 留空 / 不在 PATH 时按名字查找。**必须是外部安装的那份**，
    #: 绝不能把 LibreOffice 装进仓库目录（GPL 组件不入库，见 __init__.py）。
    soffice_bin: str = "soffice"
    pandoc_bin: str = "pandoc"
    #: 单次转换的墙钟上限。LibreOffice 冷启动本身就要 5~15 秒，
    #: 大文档转换更久，所以默认给到 120 秒而不是几十秒。
    timeout_sec: float = 120.0

    @property
    def health_config(self) -> dict:
        return {
            "sofficeBin": self.soffice_bin,
            "pandocBin": self.pandoc_bin,
            "timeoutSec": self.timeout_sec,
        }


def load_settings() -> ConvertSettings:
    base = base_settings("convert", "CONVERT_HOST", "CONVERT_PORT", DEFAULT_PORT)
    return ConvertSettings(
        service_name=base.service_name,
        host=base.host,
        port=base.port,
        log_level=base.log_level,
        version=base.version,
        stage=base.stage,
        soffice_bin=env_str("SOFFICE_BIN", "soffice"),
        pandoc_bin=env_str("PANDOC_BIN", "pandoc"),
        timeout_sec=env_float("CONVERT_TIMEOUT_SEC", 120.0),
    )
