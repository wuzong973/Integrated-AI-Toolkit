"""docling 文档解析引擎（MIT 许可）—— 版面/表格/阅读顺序理解，输出 Markdown。

## 为什么是 docling，以及它与 PyMuPDF 的关系

`/pdf/text`（legacy）用 PyMuPDF 取纯文本：快，但理解不了版面 ——
双栏论文会被按"左右交错"读出来，表格会碎成一行行数字。
docling（MIT，可直接进依赖，与 AGPL 的 PyMuPDF 完全不同一层）
带版面/表格/阅读顺序理解，产出结构化 Markdown。两者**并存不替换**：
`DOC_PARSER_PROVIDER` 由主工程装配时选择，本模块只服务
`POST /pdf/parse-docling`，不碰 legacy 的任何行为。

## 依赖缺失时怎么办

与 services/ai 的 asr / ocr 同一个纪律：未安装时返回 **501 与安装指引**
（红线 10），绝不返回空文本假装成功。

## 为什么"加载 + 解析"要模块级缓存

DocumentConverter 的模型权重以秒计（首次还要下载约数百 MB），
每个请求重建会把"解析 3 秒"变成"解析 3 秒 + 加载 10 秒"。
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from services.shared.cli import workdir
from services.shared.http import ServiceError

logger = logging.getLogger("qz-pdf")

#: docling 原生支持的输入格式（按扩展名分流，全部来自 MIT 依赖，无许可边界问题）
FORMAT_BY_EXT = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".pptx": "pptx",
    ".html": "html",
    ".htm": "html",
}

#: Markdown 预览的默认长度（meta.mdPreview，给日志/界面"先看一眼"用，不替代全文）
MD_PREVIEW_CHARS = 800

#: 模型/管线产物的落盘目录（首次解析自动下载，约数百 MB）
DEFAULT_ARTIFACTS_PATH = "./data/models/docling"

_lock = threading.Lock()
_converter: Optional[object] = None


@dataclass(frozen=True)
class ParseOptions:
    """解析参数。目前只有 Markdown 预览长度，留出扩展位避免改签名。"""

    md_preview_chars: int = MD_PREVIEW_CHARS


@dataclass(frozen=True)
class ParsedOutput:
    """docling 的解析产物（`build_payload` 之前，不掺协议字段）。"""

    text: str          # 全文 Markdown（表格带结构、阅读顺序已还原）
    pages: List[dict]  # [{"index": 0, "text": ...}]，index 从 0 开始（与 /pdf/text 一致）
    page_count: int    # 引擎报的页数；非分页格式（docx/html）可能为 0
    format: str        # pdf / docx / pptx / html
    preview_chars: int


def artifacts_path() -> str:
    """模型产物目录。**只读环境变量**：它是侧车自己的运行时配置（同 PYMUPDF_BIN），不进主工程的 env.schema。"""
    return os.environ.get("DOCLING_ARTIFACTS_PATH", "").strip() or DEFAULT_ARTIFACTS_PATH


def dependency_error() -> Optional[str]:
    """依赖是否就绪；返回 `None` 表示可用，否则返回**给人看**的原因（与 asr/ocr 同款）。"""
    try:
        import docling  # noqa: F401
    except Exception as e:  # pragma: no cover - 取决于运行环境
        return f"未安装 docling（{e}）"
    return None


def resolve_format(filename: str) -> str:
    """按扩展名分流格式；认不出当场报 400，不让引擎"猜成 PDF"后给出莫名其妙的错。"""
    ext = Path(filename or "").suffix.lower()
    fmt = FORMAT_BY_EXT.get(ext)
    if fmt is None:
        raise ServiceError(
            f"「{filename or '(未命名)'}」不是 docling 支持的格式（收到 {ext or '无后缀'}）",
            code=40012,
            hint=f"支持：{', '.join(sorted(FORMAT_BY_EXT))}；"
            "其它格式请先用「文档格式转换」，或改用 legacy 引擎（仅 .pdf）",
        )
    return fmt


def parse(data: bytes, filename: str, opts: Optional[ParseOptions] = None) -> ParsedOutput:
    """把一份文档交给 docling 解析，返回 Markdown 全文与按页文本。"""
    options = opts or ParseOptions()

    reason = dependency_error()
    if reason:
        raise ServiceError.unavailable(
            f"docling 文档解析不可用：{reason}",
            hint=(
                "安装：pip install docling（MIT，见 services/pdf/requirements.txt）。"
                f"模型约数百 MB，首次解析自动下载到 {artifacts_path()}"
            ),
        )
    fmt = resolve_format(filename)
    if not data:
        raise ServiceError("上传的文件是空的", code=40011)

    converter = _get_converter()
    # docling 按扩展名选管线，落盘必须保留真实后缀（与 handlers._dump 同一纪律）
    suffix = Path(filename).suffix.lower() or ".pdf"
    with workdir("qz-pdf-docling-") as tmp:
        src = tmp / f"input{suffix}"
        src.write_bytes(data)
        converted = _convert(converter, src)

    if not converted.markdown.strip():
        raise ServiceError(
            "docling 没有从这份文档里解出任何内容",
            status=422,
            code=42217,
            hint="扫描件/图片型 PDF 需要先 OCR；损坏文件请重新导出后再试",
        )

    # 页号是 1 起的版面来源；index 仍从 0 起，与 /pdf/text 的页对象对齐
    pages = [
        {"index": i, "text": text}
        for i, (_, text) in enumerate(sorted(converted.pages.items()))
    ]
    return ParsedOutput(
        text=converted.markdown,
        pages=pages,
        page_count=converted.page_count,
        format=fmt,
        preview_chars=options.md_preview_chars,
    )


def build_payload(out: ParsedOutput, filename: str) -> dict:
    """映射成响应体。**纯函数**：与 /pdf/text 同构（text/pages/pageCount/chars），
    多带 `meta.format` / `meta.mdPreview` 增量字段，对老调用方向后兼容。"""
    return {
        "filename": filename,
        "pageCount": out.page_count or len(out.pages) or 1,
        "chars": len(out.text),
        "pages": list(out.pages),
        "text": out.text,
        "meta": {
            "engine": "docling",
            "format": out.format,
            "mdPreview": out.text[: out.preview_chars],
        },
    }


# ---------- docling 交互（类型与版本差异全部关在这一段里） ----------


@dataclass(frozen=True)
class _Converted:
    """docling ConversionResult 的最小投影，不让 docling 类型漏进 parse 主流程。"""

    markdown: str
    pages: Dict[int, str]
    page_count: int


def _get_converter() -> object:
    """按需加载并缓存 DocumentConverter（权重加载秒级，不能每个请求重建）。"""
    global _converter
    with _lock:
        if _converter is None:
            path = artifacts_path()
            os.makedirs(path, exist_ok=True)
            # docling 在 import 期读该变量决定模型目录：必须**先设再 import**
            os.environ.setdefault("DOCLING_ARTIFACTS_PATH", path)
            from docling.document_converter import DocumentConverter

            logger.info("加载 docling 引擎（模型目录 %s，首次运行自动下载，约数百 MB）", path)
            _converter = DocumentConverter()
        return _converter


def _convert(converter: object, src: Path) -> _Converted:
    """跑一次转换。docling 对损坏文件的异常类型不稳定，统一转 422。"""
    try:
        result = converter.convert(str(src))
    except Exception as e:  # noqa: BLE001
        raise ServiceError(
            f"docling 解析失败：{e}", status=422, code=42216,
            hint="确认文件本身能打开；个别加密/损坏文档引擎不支持",
        ) from e

    status = str(getattr(result, "status", ""))
    if "FAILURE" in status.upper():
        raise ServiceError(
            f"docling 解析失败（{status}）", status=422, code=42216,
            hint="确认文件本身能打开；加密文档请先解除密码",
        )

    doc = getattr(result, "document", None)
    markdown = ""
    if doc is not None:
        try:
            markdown = doc.export_to_markdown() or ""
        except Exception as e:  # noqa: BLE001
            raise ServiceError(
                f"Markdown 导出失败：{e}", status=422, code=42216,
            ) from e

    return _Converted(
        markdown=markdown,
        pages=_page_texts(doc) if doc is not None else {},
        page_count=len(getattr(result, "pages", None) or {}),
    )


def _page_texts(doc: object) -> Dict[int, str]:
    """按版面来源页归组正文与表格。

    docling ≥2.x 的 `iterate_items()` 产出 (条目, 层级) 元组、条目带 `prov`
    （版面来源，含页码）；个别版本只给条目本身，这里两种都兼容。
    每页文本是 best-effort：单条目解析失败只跳过 —— 全文 Markdown 才是主产物。
    """
    try:
        entries = list(doc.iterate_items())
    except Exception:  # noqa: BLE001 —— 版本差异统一降级为"无分页"
        return {}

    grouped: Dict[int, List[str]] = {}
    for entry in entries:
        item = entry[0] if isinstance(entry, tuple) else entry
        text = _item_text(item)
        if not text:
            continue
        grouped.setdefault(_item_page(item), []).append(text)
    return {page: "\n\n".join(chunks) for page, chunks in grouped.items()}


def _item_text(item: object) -> str:
    """取一个条目的文本；表格等无 `.text` 的条目尽力导出，失败就跳过。"""
    text = getattr(item, "text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()

    export = getattr(item, "export_to_markdown", None)
    if export is None:
        return ""
    try:
        rendered = export()
    except Exception:  # noqa: BLE001 —— 单个表格导不出不放大成整次失败
        return ""
    return rendered.strip() if isinstance(rendered, str) else ""


def _item_page(item: object) -> int:
    """条目所属页号；无版面来源（docx/html 这类流式格式）时归到第 0 组。"""
    for p in getattr(item, "prov", None) or []:
        no = getattr(p, "page_no", None)
        if isinstance(no, int):
            return no
    return 0
