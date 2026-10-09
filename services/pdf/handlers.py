"""services/pdf 的四个能力实现。

## 协议

一律 `multipart/form-data`（与 media / ai 侧车同一套约定）：

| 端点 | 字段 | 响应 |
|---|---|---|
| `/pdf/merge` | `file`（可重复） | 二进制 PDF + `X-Output-*` |
| `/pdf/split` | `file` + `ranges`（可选） | 二进制 ZIP + `X-Output-*` |
| `/pdf/compress` | `file` | 二进制 PDF + `X-Original-Bytes` / `X-Output-Bytes` |
| `/pdf/text` | `file` | JSON `{ text, pages:[{index,text}], chars, pageCount }` |
| `/pdf/parse-docling` | `file`（.pdf/.docx/.pptx/.html） | 同 `/pdf/text` + `meta.format` / `meta.mdPreview` |

## 三条刻意的取舍

1. **压缩后更大就拒绝，而不是把大文件还给用户。**
   PDF 压缩不是有损重编码：对一个已经优化过的文档，
   `clean` 的产出完全可能比原文件还大。把更大的文件交出去，
   用户看到"压缩成功、体积反而变大"，比报错更糟。
2. **拆分回 ZIP。** 侧车协议是"一次一个产物"，而拆分的本质是多个产物。
   打包成 ZIP 是唯一不需要改协议的做法（`zipfile` 是标准库，无许可问题）。
3. **文本按 `\\f` 还原分页。** PyMuPDF 的 `gettext` 默认用换页符分页，
   我们据此还原"第 N 页"，页码与原文对得上 —— 引用与定位都依赖这一点。
   刻意不加 `-skip-empty`，否则空页会被跳过、页码错位。
"""
from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import quote

from services.shared.cli import workdir
from services.shared.http import Handler, Request, Response, ServiceError
from services.shared.multipart import FilePart, parse_form

from . import docling_parse
from .engine import Engine
from .routes import audit
from .settings import PdfSettings

#: 拆分时"每页一个文件"的默认行为
SPLIT_EVERY_PAGE = "page"
#: 拆分时按自定义范围（如 `1-3,5,8-10`）
SPLIT_BY_RANGES = "ranges"

#: 合法的范围写法：`1`、`1-3`、`5-N`（N = 最后一页）
_RANGE_RE = re.compile(r"^\s*(\d+)(?:\s*-\s*(\d+|N))?\s*$")


def build_handlers(settings: PdfSettings) -> Dict[Tuple[str, str], Handler]:
    engine = Engine(settings.pymupdf_bin, timeout_sec=settings.timeout_sec)
    handlers: Dict[Tuple[str, str], Handler] = {
        ("GET", "/pdf/capabilities"): lambda req: handle_capabilities(engine),
        ("POST", "/pdf/merge"): lambda req: handle_merge(engine, req),
        ("POST", "/pdf/split"): lambda req: handle_split(engine, req),
        ("POST", "/pdf/compress"): lambda req: handle_compress(engine, req),
        ("POST", "/pdf/text"): lambda req: handle_text(engine, req),
        ("POST", "/pdf/parse-docling"): lambda req: handle_parse_docling(req),
    }

    # 启动即对账：两张表漂移不会有任何运行时报错，只会静默说谎
    for problem in audit(handlers):
        raise RuntimeError(f"services/pdf 路由表漂移：{problem}")

    return handlers


def health_config(settings: PdfSettings) -> dict:
    engine = Engine(settings.pymupdf_bin, timeout_sec=settings.timeout_sec)
    docling_reason = docling_parse.dependency_error()
    return {
        **settings.health_config,
        "engineAvailable": engine.available,
        "enginePath": engine.describe,
        "engineResponsive": engine.version(),
        "doclingReady": docling_reason is None,
        "doclingDependencyError": docling_reason or "",
        "doclingArtifactsPath": docling_parse.artifacts_path(),
    }


# ---------- capabilities ----------


def handle_capabilities(engine: Engine) -> Response:
    """让"为什么 PDF 失败"能在**不发文件**的前提下问清楚。"""
    return Response(
        payload={
            "engine": engine.available,
            "enginePath": engine.describe,
            "capabilities": {
                "merge": engine.available,
                "split": engine.available,
                "compress": engine.available,
                "text": engine.available,
                # 刻意如实声明：PDF → Word/PPT 需要重新排版，本引擎做不到，
                # 那条路在 services/convert（LibreOffice），本机没装就如实不可用
                "convertToOffice": False,
            },
        }
    )


# ---------- merge ----------


def handle_merge(engine: Engine, req: Request) -> Response:
    form = parse_form(req.body, req.header("Content-Type"))
    files = [f for f in form.files if f.name == "file"]

    if len(files) < 2:
        raise ServiceError(
            "合并至少需要 2 个 PDF 文件" if files else "缺少待合并的 PDF 文件（字段名 file）",
            code=40011,
        )
    _assert_pdfs(files)

    base = _safe_stem(files[0].filename) or "merged"
    out_name = f"{base}-合并.pdf"

    with workdir("qz-pdf-merge-") as tmp:
        inputs = [_dump(tmp, f, i) for i, f in enumerate(files)]
        output = tmp / "out.pdf"
        engine.merge(inputs, output)
        data = output.read_bytes()

    return _pdf_response(data, out_name, extra={
        "X-Input-Count": str(len(files)),
        "X-Input-Bytes": str(sum(len(f.data) for f in files)),
    })


# ---------- split ----------


def handle_split(engine: Engine, req: Request) -> Response:
    form = parse_form(req.body, req.header("Content-Type"))
    src = form.file()
    _assert_pdfs([src])

    mode = form.get("mode", SPLIT_EVERY_PAGE).strip() or SPLIT_EVERY_PAGE
    ranges_field = form.get("ranges", "").strip()
    if mode not in (SPLIT_EVERY_PAGE, SPLIT_BY_RANGES):
        raise ServiceError(
            f"mode 只支持 {SPLIT_EVERY_PAGE} / {SPLIT_BY_RANGES}，实际收到「{mode}」", code=40011,
        )
    if mode == SPLIT_BY_RANGES and not ranges_field:
        raise ServiceError("mode=ranges 时必须给 ranges（如 1-3,5,8-N）", code=40011)

    base = _safe_stem(src.filename) or "split"
    with workdir("qz-pdf-split-") as tmp:
        src_path = _dump(tmp, src, 0)
        page_count = engine.page_count(src_path)

        if mode == SPLIT_EVERY_PAGE:
            groups = [(str(i), str(i)) for i in range(1, page_count + 1)]
        else:
            groups = _parse_ranges(ranges_field, page_count)

        if len(groups) < 2:
            raise ServiceError(
                f"拆分至少要产生 2 份；按当前参数只有 {len(groups)} 份"
                + ("" if mode == SPLIT_EVERY_PAGE else "（检查 ranges 是否写成了单一范围）"),
                code=42211,
            )

        out_dir = tmp / "parts"
        out_dir.mkdir()
        names: List[str] = []
        for label, spec in groups:
            part = out_dir / f"{base}-p{label}.pdf"
            engine.clean(src_path, part, pages=spec)
            names.append(part.name)

        data = _zip_dir(out_dir, names)
        out_name = f"{base}-拆分({len(names)}份).zip"

    return _pdf_response(data, out_name, content_type="application/zip", extra={
        "X-Part-Count": str(len(names)),
        "X-Page-Count": str(page_count),
    })


# ---------- compress ----------


def handle_compress(engine: Engine, req: Request) -> Response:
    form = parse_form(req.body, req.header("Content-Type"))
    src = form.file()
    _assert_pdfs([src])

    base = _safe_stem(src.filename) or "compressed"
    out_name = f"{base}-压缩.pdf"

    with workdir("qz-pdf-compress-") as tmp:
        src_path = _dump(tmp, src, 0)
        output = tmp / "out.pdf"
        engine.clean(src_path, output)
        data = output.read_bytes()

    if len(data) >= len(src.data):
        # 这是"压缩"语义下唯一诚实的失败方式：PDF 优化不是有损重编码，
        # 对已优化的文档完全可能压不出收益。把更大的文件交出去，
        # 用户看到的是"压缩成功但变大"——比明确告诉他压不动糟得多。
        raise ServiceError(
            f"这份 PDF 已经优化过，压缩后反而大了"
            f"（{len(src.data)} → {len(data)} 字节），已按原样保留未做改动",
            status=422,
            code=42212,
            hint="可改用「PDF 拆分」取其中部分页，或对扫描件先做图片压缩",
        )

    return _pdf_response(data, out_name, extra={
        "X-Original-Bytes": str(len(src.data)),
        "X-Output-Bytes": str(len(data)),
    })


# ---------- text ----------


def handle_text(engine: Engine, req: Request) -> Response:
    form = parse_form(req.body, req.header("Content-Type"))
    src = form.file()
    _assert_pdfs([src])

    with workdir("qz-pdf-text-") as tmp:
        src_path = _dump(tmp, src, 0)
        out_txt = tmp / "out.txt"
        engine.gettext(src_path, out_txt)
        raw = out_txt.read_text(encoding="utf-8", errors="replace")

    # gettext 以 \f 分页；去掉每页尾部的换页符再按它切，页码与原文对齐
    pages = [p.strip("\f").rstrip() for p in raw.split("\f")]
    if pages and pages[-1] == "":
        pages.pop()
    text = "\n\n".join(f"【第 {i + 1} 页】\n{p}" for i, p in enumerate(pages) if p.strip())

    if not text.strip():
        raise ServiceError(
            "这份 PDF 里没有可提取的文字（可能是扫描件/图片型 PDF）",
            status=422,
            code=42213,
            hint="扫描件需要先 OCR，可改用「OCR 文字识别」",
        )

    return Response(
        payload={
            "filename": src.filename,
            "pageCount": len(pages),
            "chars": len(text),
            # 页对象：index 从 0 开始（与 core 的 DocParseResult 约定一致）
            "pages": [{"index": i, "text": p} for i, p in enumerate(pages)],
            "text": text,
        }
    )


# ---------- docling ----------


def handle_parse_docling(req: Request) -> Response:
    """docling 引擎的文档解析：版面/表格/阅读顺序理解，输出 Markdown。

    与 `/pdf/text`（legacy，PyMuPDF 取文本）**并存不替换**：主工程用
    `DOC_PARSER_PROVIDER` 装配二选一，这里不碰 legacy 的任何行为。
    依赖未安装时由 `docling_parse.parse` 返回 501 与安装指引（红线 10）。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    src = form.file()

    out = docling_parse.parse(src.data, src.filename or "")
    return Response(payload=docling_parse.build_payload(out, src.filename or ""))


# ---------- helpers ----------


def _assert_pdfs(files: List[FilePart]) -> None:
    """按扩展名拦截明显不是 PDF 的输入。

    只做"防呆"不做"校验"：真正的合法性由 PyMuPDF 判断（它会对损坏文件报错），
    这里拦的是"把 .docx 传给 PDF 工具"这类能在进入子进程**之前**就给出的清晰提示。
    """
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext and ext != ".pdf":
            raise ServiceError(
                f"「{f.filename}」不是 PDF 文件（收到 {ext}）", code=40012,
                hint="本服务只接受 .pdf；其它格式请先用「文档格式转换」",
            )


def _dump(tmp: Path, f: FilePart, index: int) -> Path:
    """把上传的字节落盘。**必须保留 .pdf 后缀**：引擎按扩展名识别输入。"""
    name = f"{index:02d}-{_safe_name(f.filename) or 'input'}.pdf"
    path = tmp / name
    path.write_bytes(f.data)
    return path


def _parse_ranges(spec: str, page_count: int) -> List[Tuple[str, str]]:
    """把 `1-3,5,8-N` 解析成 [(label, pagesSpec), ...]，越界项**静默丢弃**。"""
    groups: List[Tuple[str, str]] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = _RANGE_RE.match(chunk)
        if not m:
            raise ServiceError(
                f"ranges 里的「{chunk}」不是合法写法（应为 1、1-3 或 8-N）", code=40011,
            )
        start = int(m.group(1))
        end_raw = m.group(2)
        # 三种写法的语义必须分清：
        #   `4`   → 只取第 4 页（**不是**"第 4 页到末页"）
        #   `4-N` → 第 4 页到末页
        #   `4-6` → 第 4~6 页（超出总页数时截断）
        # 实测踩过：把裸数字也当成"到末页"，`1-2,4` 会产出 4-5 这种子 PDF。
        if end_raw is None:
            end = start
        elif end_raw == "N":
            end = page_count
        else:
            end = min(int(end_raw), page_count)
        if start < 1 or start > page_count or end < start:
            continue  # 越界范围直接丢：比让整个请求失败更符合"选了不存在的页"的直觉
        label = str(start) if start == end else f"{start}-{end}"
        groups.append((label, label))

    if not groups:
        raise ServiceError(
            f"ranges 没有命中任何页（文档共 {page_count} 页）", status=422, code=42215,
        )
    return groups


def _zip_dir(folder: Path, names: List[str]) -> bytes:
    """把拆分产物打包。ZIP 是标准库，无许可问题；用 ZIP_DEFLATED 让它本身也小一点。"""
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            zf.write(folder / name, arcname=name)
    return buf.getvalue()


def _pdf_response(
    data: bytes, filename: str, *, content_type: str = "application/pdf",
    extra: Dict[str, str] | None = None,
) -> Response:
    headers = {"X-Output-Filename": quote(filename), "X-Duration-Ms": "0"}
    if extra:
        headers.update(extra)
    return Response(raw=data, content_type=content_type, headers=headers)


def _safe_stem(filename: str | None) -> str:
    stem = Path(filename or "").stem.strip()
    return stem[:60]


def _safe_name(filename: str | None) -> str:
    """文件名里只留安全字符（临时文件名，不进响应）。"""
    cleaned = re.sub(r"[^\w\u4e00-\u9fa5.-]+", "_", _safe_stem(filename))
    return cleaned.strip("._") or "input"
