"""PDF 服务配置。"""
from __future__ import annotations

from dataclasses import dataclass

from services.shared.config import BaseSettings, base_settings, env_float, env_str

DEFAULT_PORT = 8003


@dataclass(frozen=True)
class PdfSettings(BaseSettings):
    #: 装了 PyMuPDF 的 Python 解释器路径（会自动追加 `-m pymupdf`）。
    #:
    #: 留空时退化为直接查 PATH 里的 `pymupdf` 命令（某些安装方式会生成它）。
    #: **必须是外部安装的那一份** —— 绝不能把 PyMuPDF 装进仓库目录
    #: （AGPL 组件不入库，见本服务 `__init__.py` 的说明）。
    pymupdf_bin: str = ""
    #: 单次操作的墙钟上限。合并大文档 / 压缩几百页都要时间，
    #: 而 PyMuPDF 是本地计算（不像 LibreOffice 要冷启动），给 120 秒足够宽裕。
    timeout_sec: float = 120.0
    #: 单次请求允许的总字节数上限（合并多个 PDF 时按总和算）。
    #: 与 `services/shared/http.py` 的请求体上限配合，这里再卡一道是因为
    #: 拆分/合并会把文件**落盘**，盘上占用是入参的数倍。
    max_total_bytes: int = 200 * 1024 * 1024

    @property
    def health_config(self) -> dict:
        return {
            "pymupdfBin": self.pymupdf_bin or "(PATH 查找 pymupdf)",
            "timeoutSec": self.timeout_sec,
            "maxTotalBytes": self.max_total_bytes,
        }


def load_settings() -> PdfSettings:
    base = base_settings("pdf", "PDF_HOST", "PDF_PORT", DEFAULT_PORT)
    return PdfSettings(
        service_name=base.service_name,
        host=base.host,
        port=base.port,
        log_level=base.log_level,
        version=base.version,
        stage=base.stage,
        pymupdf_bin=env_str("PYMUPDF_BIN", ""),
        timeout_sec=env_float("PDF_TIMEOUT_SEC", 120.0),
    )
