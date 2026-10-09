"""转换引擎（LibreOffice / Pandoc）的调用封装与能力矩阵。

## 能力矩阵是"声明"不是"保证"

`CONVERSIONS` 说明"这两条路我们支持"，**能不能真正执行取决于这台机器装了什么**。
两者必须分开表达，否则会出现最糟的一种状态：接口自报支持、调用时才失败。

所以对外提供 `capabilities()`：按**当前机器实测**返回可用/不可用的转换对，
运维和调用方都能一眼看出"这个环境缺什么"。
"""
from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from services.shared.cli import CliError, resolve_binary, run
from services.shared.http import ServiceError

SOFFICE = "soffice"
PANDOC = "pandoc"


@dataclass(frozen=True)
class Conversion:
    """一条支持的转换路径。"""

    source: str
    target: str
    engine: str


#: 支持的转换矩阵。加新格式时**只改这里**，handler 与能力查询会自动跟上。
CONVERSIONS: Tuple[Conversion, ...] = (
    # LibreOffice：版面类文档 → PDF（保版面是它最强的地方）
    Conversion("doc", "pdf", SOFFICE),
    Conversion("docx", "pdf", SOFFICE),
    Conversion("odt", "pdf", SOFFICE),
    Conversion("rtf", "pdf", SOFFICE),
    Conversion("txt", "pdf", SOFFICE),
    Conversion("html", "pdf", SOFFICE),
    Conversion("ppt", "pdf", SOFFICE),
    Conversion("pptx", "pdf", SOFFICE),
    Conversion("xls", "pdf", SOFFICE),
    Conversion("xlsx", "pdf", SOFFICE),
    Conversion("doc", "docx", SOFFICE),
    Conversion("docx", "odt", SOFFICE),
    # Pandoc：轻量标记语言之间的往返（不经过 PDF，避免依赖 LaTeX 发行版）
    Conversion("md", "docx", PANDOC),
    Conversion("md", "html", PANDOC),
    Conversion("md", "txt", PANDOC),
    Conversion("html", "docx", PANDOC),
    Conversion("html", "md", PANDOC),
    Conversion("txt", "docx", PANDOC),
    Conversion("docx", "md", PANDOC),
    Conversion("docx", "html", PANDOC),
    Conversion("docx", "txt", PANDOC),
    Conversion("odt", "docx", PANDOC),
)

#: 允许的上传扩展名 = 出现在矩阵左侧的全部格式
SUPPORTED_SOURCES: Set[str] = {c.source for c in CONVERSIONS}


def content_type_for(ext: str) -> str:
    return mimetypes.guess_type(f"x.{ext}")[0] or "application/octet-stream"


def find(source: str, target: str) -> Conversion:
    src = (source or "").strip().lower().lstrip(".")
    dst = (target or "").strip().lower().lstrip(".")
    for item in CONVERSIONS:
        if item.source == src and item.target == dst:
            return item

    available = sorted({c.target for c in CONVERSIONS if c.source == src})
    if not available:
        raise ServiceError(
            f"不支持的源格式 {src!r}",
            code=40020,
            hint=f"支持：{', '.join(sorted(SUPPORTED_SOURCES))}",
        )
    raise ServiceError(
        f"{src} 不支持转换为 {dst}",
        code=40020,
        hint=f"{src} 可以转为：{', '.join(available)}",
    )


# ==================== 引擎 ====================


class Engine:
    """外部转换程序的定位与可用性。"""

    def __init__(self, name: str, configured: str, fallbacks: Tuple[str, ...], timeout_sec: float):
        self.name = name
        self._configured = configured
        self._fallbacks = fallbacks
        self.timeout_sec = timeout_sec

    @property
    def binary(self) -> Optional[str]:
        return resolve_binary(self._configured, *self._fallbacks)

    @property
    def available(self) -> bool:
        return self.binary is not None

    def require(self) -> str:
        path = self.binary
        if path:
            return path
        raise ServiceError.unavailable(
            f"{self.name} 未安装，该转换路径在本机不可用",
            hint=f"安装 {self.name} 后设置对应环境变量指向可执行文件；"
                 f"注意许可：{self.name} 不得打进主工程，只能独立部署（ADR-05）",
        )


class Engines:
    """两个引擎的集合，附带"哪些转换当前可用"的实测结果。"""

    def __init__(self, soffice: Engine, pandoc: Engine) -> None:
        self.soffice = soffice
        self.pandoc = pandoc

    def get(self, engine: str) -> Engine:
        if engine == SOFFICE:
            return self.soffice
        if engine == PANDOC:
            return self.pandoc
        raise ServiceError(f"未知转换引擎 {engine!r}", code=50002)

    def capabilities(self) -> Dict[str, List[Dict[str, object]]]:
        """按引擎分组列出矩阵，并标注本机是否具备该引擎。"""
        groups: Dict[str, List[Dict[str, object]]] = {}
        for item in CONVERSIONS:
            groups.setdefault(item.engine, []).append({
                "source": item.source,
                "target": item.target,
                "available": self.get(item.engine).available,
            })
        return groups

    def available_engines(self) -> List[str]:
        return [e.name for e in (self.soffice, self.pandoc) if e.available]


def build_engines(settings) -> Engines:
    return Engines(
        # Windows 上 `soffice` 是 .exe，某些发行版只装了 `soffice.com`；
        # 两个名字都给，少一次"我明明装了却说找不到"。
        Engine(SOFFICE, settings.soffice_bin, ("soffice", "soffice.com", "libreoffice"),
               settings.timeout_sec),
        Engine(PANDOC, settings.pandoc_bin, ("pandoc",), settings.timeout_sec),
    )


# ==================== 执行 ====================


def run_soffice(engine: Engine, source: Path, target_ext: str, outdir: Path) -> Path:
    """用 LibreOffice 转换。产物名 = 源文件主名 + 目标扩展名。"""
    binary = engine.require()

    # ⚠️ 必须给每个进程独立的用户配置目录：
    # LibreOffice 默认共用一个 profile，并发调用时会互相抢占并**随机失败**
    # （报错通常是含糊的 "source file could not be loaded"）。
    # 用 -env:UserInstallation 指到本次的临时目录即可完全隔离。
    profile = outdir / "profile"
    profile.mkdir(parents=True, exist_ok=True)

    args = [
        binary,
        f"-env:UserInstallation={profile.resolve().as_uri()}",
        "--headless", "--norestore", "--nolockcheck", "--nodefault",
        "--convert-to", target_ext,
        "--outdir", str(outdir),
        str(source),
    ]
    try:
        run(args, timeout=engine.timeout_sec)
    except CliError as e:
        raise ServiceError(
            f"LibreOffice 转换失败：{e}",
            code=42210,
            hint=e.detail,
        ) from e

    produced = outdir / f"{source.stem}.{target_ext}"
    if not produced.is_file():
        # LibreOffice 常见行为：退出码为 0 但什么都没产出（过滤器不认这个组合）。
        # 不检查的话会把"空产物"当成成功返回，比直接报错糟得多。
        raise ServiceError(
            f"LibreOffice 未产出 .{target_ext} 文件（退出码为 0 但没有结果）",
            code=42210,
            hint="通常是该格式组合在当前 LibreOffice 版本下不被支持",
        )
    return produced


def run_pandoc(engine: Engine, source: Path, target_ext: str, outdir: Path) -> Path:
    """用 Pandoc 转换。

    Pandoc 不需要显式指定输入格式：它按扩展名自行推断；
    但显式给出能避免"文件名没有扩展名"时的误判。
    """
    binary = engine.require()
    produced = outdir / f"{source.stem}_converted.{target_ext}"

    args = [
        binary,
        str(source),
        "--from", _pandoc_reader(source.suffix.lstrip(".")),
        "--to", _pandoc_writer(target_ext),
        "-o", str(produced),
    ]
    try:
        run(args, timeout=engine.timeout_sec)
    except CliError as e:
        raise ServiceError(
            f"Pandoc 转换失败：{e}",
            code=42211,
            hint=e.detail,
        ) from e

    if not produced.is_file():
        raise ServiceError("Pandoc 未产出输出文件", code=42211)
    return produced


_PANDOC_READERS = {
    "md": "markdown", "markdown": "markdown", "html": "html", "htm": "html",
    "txt": "markdown", "docx": "docx", "odt": "odt", "rtf": "rtf",
}

_PANDOC_WRITERS = {
    "docx": "docx", "html": "html", "htm": "html", "md": "markdown",
    "markdown": "markdown", "txt": "plain",
}


def _pandoc_reader(ext: str) -> str:
    return _PANDOC_READERS.get(ext, ext or "markdown")


def _pandoc_writer(ext: str) -> str:
    writer = _PANDOC_WRITERS.get(ext)
    if writer is None:
        raise ServiceError(f"Pandoc 不支持输出 .{ext}", code=40020)
    return writer
