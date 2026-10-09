"""docling 解析的**纯逻辑**单测：不安装 docling 也能跑、不触发模型下载。

需要真实引擎的端到端用例标 `@pytest.mark.slow`（pytest.ini 默认排除）；
fixture（最小合法 PDF）在代码内生成，仓库里不放二进制文件。
"""
from __future__ import annotations

import io

import pytest

from services.pdf import docling_parse
from services.shared.http import ServiceError

# ---------- fixture（代码内生成，不建二进制文件） ----------


def minimal_pdf_bytes(text: str = "Hello docling") -> bytes:
    """一个只含一行文字的最小合法 PDF（手写对象表 + 校正过的 xref 偏移）。"""
    stream = f"BT /F1 12 Tf 20 50 Td ({text}) Tj ET".encode()
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100]"
        b" /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(bodies, start=1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    xref_at = out.tell()
    out.write(f"xref\n0 {len(bodies) + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(
        f"trailer\n<< /Size {len(bodies) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_at}\n%%EOF\n".encode()
    )
    return out.getvalue()


class _Prov:
    def __init__(self, page_no: int) -> None:
        self.page_no = page_no


class _Item:
    """docling 条目的最小替身（只含 _page_texts 用到的属性）。"""

    def __init__(self, text: str, page_no: int | None) -> None:
        self.text = text
        self.prov = [_Prov(page_no)] if page_no is not None else []


class _Doc:
    def __init__(self, items: list) -> None:
        self._items = items

    def iterate_items(self):
        # docling ≥2.x 的产出形状：(条目, 层级) 元组
        return [(item, 0) for item in self._items]


# ---------- resolve_format：扩展名分流是服务端纪律 ----------


@pytest.mark.parametrize("filename,fmt", [
    ("a.pdf", "pdf"), ("b.DOCX", "docx"), ("c.pptx", "pptx"),
    ("d.html", "html"), ("e.htm", "html"),
])
def test_resolve_format_accepts_supported(filename: str, fmt: str) -> None:
    assert docling_parse.resolve_format(filename) == fmt


@pytest.mark.parametrize("filename", ["f.txt", "g", "", "h.doc", "i.xlsx"])
def test_resolve_format_rejects_unknown(filename: str) -> None:
    with pytest.raises(ServiceError) as err:
        docling_parse.resolve_format(filename)
    # 报错要带上"支持哪些"，而不是只说"不行"
    assert ".pdf" in str(err.value.hint)


def test_parse_rejects_empty_body(monkeypatch) -> None:
    # 依赖检查在空体检查之前：必须桩掉它，否则没装 docling 的机器上这里会先 501
    monkeypatch.setattr(docling_parse, "dependency_error", lambda: None)
    with pytest.raises(ServiceError) as err:
        docling_parse.parse(b"", "a.pdf")
    assert err.value.status == 400


# ---------- 依赖缺失时的降级：501 + 人话（monkeypatch，不碰真实依赖） ----------


def test_parse_returns_501_when_dependency_missing(monkeypatch) -> None:
    monkeypatch.setattr(docling_parse, "dependency_error", lambda: "未安装 docling（模拟）")
    with pytest.raises(ServiceError) as err:
        docling_parse.parse(minimal_pdf_bytes(), "a.pdf")
    assert err.value.status == 501
    assert err.value.code == 50341
    assert "pip install docling" in err.value.hint


def test_dependency_error_is_none_or_str() -> None:
    # 不假设本机装没装依赖，只锁"返回类型"契约：可用=None，不可用=给人看的一句话
    reason = docling_parse.dependency_error()
    assert reason is None or isinstance(reason, str)


# ---------- _page_texts：版面来源页归组（docling 版本差异的收口处） ----------


def test_page_texts_groups_by_provenance_page() -> None:
    doc = _Doc([_Item("第一页", 1), _Item("第二页", 2), _Item("还是第二页", 2)])
    assert docling_parse._page_texts(doc) == {1: "第一页", 2: "第二页\n\n还是第二页"}


def test_page_texts_skips_blank_and_untyped_items() -> None:
    doc = _Doc([_Item("   ", 1), "not-an-item", _Item("正文", 1), _Item("无来源", None)])
    assert docling_parse._page_texts(doc) == {1: "正文", 0: "无来源"}


def test_page_texts_degrades_when_iterate_breaks() -> None:
    class Broken:
        def iterate_items(self):
            raise RuntimeError("版本不兼容")

    assert docling_parse._page_texts(Broken()) == {}


# ---------- build_payload：响应映射是纯函数 ----------


def _output(text: str = "# 标题\n\n正文") -> docling_parse.ParsedOutput:
    return docling_parse.ParsedOutput(
        text=text,
        pages=[{"index": 0, "text": "标题"}, {"index": 1, "text": "正文"}],
        page_count=2,
        format="pdf",
        preview_chars=4,
    )


def test_build_payload_keeps_legacy_shape() -> None:
    payload = docling_parse.build_payload(_output(), "论文.pdf")
    assert payload["filename"] == "论文.pdf"
    assert payload["pageCount"] == 2
    assert payload["chars"] == len("# 标题\n\n正文")
    assert payload["pages"][0] == {"index": 0, "text": "标题"}
    assert payload["text"].startswith("# 标题")


def test_build_payload_metas_are_incremental_only() -> None:
    # meta 是增量字段：老调用方读不到也不受影响
    payload = docling_parse.build_payload(_output(), "论文.pdf")
    assert payload["meta"]["engine"] == "docling"
    assert payload["meta"]["format"] == "pdf"
    assert payload["meta"]["mdPreview"] == "# 标题\n\n正文"[:4]


def test_build_payload_falls_back_page_count() -> None:
    # 非分页格式（docx/html）引擎可能不报页数：回退到 pages 数，再退 1
    out = docling_parse.ParsedOutput(
        text="正文", pages=[], page_count=0, format="docx", preview_chars=10,
    )
    assert docling_parse.build_payload(out, "a.docx")["pageCount"] == 1


# ---------- handler 层：参数缺失走 400，不触发引擎加载 ----------


def _request(body: bytes, content_type: str):
    from services.shared.http import Request

    return Request(
        method="POST", path="/pdf/parse-docling", query={},
        headers={"Content-Type": content_type}, body=body,
    )


def _multipart(fields: dict) -> tuple:
    boundary = "----qzpytest"
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields.items()
    ]
    return b"".join(parts) + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def test_handle_parse_docling_without_file_is_400() -> None:
    from services.pdf.handlers import handle_parse_docling

    # 只有非文件字段（没有 filename 的 part）→ files 为空 → 缺文件字段报 400
    body, ctype = _multipart({"lang": "zh"})
    with pytest.raises(ServiceError) as err:
        handle_parse_docling(_request(body, ctype))
    assert err.value.status == 400
    assert "缺少文件字段" in str(err.value)


def test_handle_parse_docling_with_unknown_ext_is_400(monkeypatch) -> None:
    from services.pdf import docling_parse as dp
    from services.pdf.handlers import handle_parse_docling

    # 依赖检查在格式分流之前：桩掉它才能在本机没装 docling 时也测到 400 分支
    monkeypatch.setattr(dp, "dependency_error", lambda: None)

    boundary = "----qzpytest"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n'
        f"Content-Type: text/plain\r\n\r\nhello\r\n--{boundary}--\r\n"
    ).encode()
    with pytest.raises(ServiceError) as err:
        handle_parse_docling(_request(body, f"multipart/form-data; boundary={boundary}"))
    assert err.value.status == 400


def _file_request(filename: str, data: bytes):
    from services.shared.http import Request

    boundary = "----qzpytest"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: application/pdf\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    return Request(
        method="POST", path="/pdf/parse-docling", query={},
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, body=body,
    )


def test_handle_parse_docling_maps_payload(monkeypatch) -> None:
    from services.pdf import handlers

    out = docling_parse.ParsedOutput(
        text="正文", pages=[{"index": 0, "text": "正文"}],
        page_count=1, format="pdf", preview_chars=10,
    )
    monkeypatch.setattr(handlers.docling_parse, "parse", lambda data, filename, opts=None: out)

    resp = handlers.handle_parse_docling(_file_request("a.pdf", b"%PDF-fake"))
    assert resp.payload["text"] == "正文"
    assert resp.payload["meta"]["engine"] == "docling"


def _settings():
    """构造测试用的 PdfSettings（基类字段无默认值，必须显式给）。"""
    from services.pdf.settings import PdfSettings

    return PdfSettings(service_name="pdf", host="127.0.0.1", port=8003, log_level="info")


def test_route_tables_stay_in_sync() -> None:
    # 路由表漂移只在启动时对账（build_handlers 里 raise）；这里把同一不变量锁进单测：
    # parse-docling 必须同时出现在 ROUTES / IMPLEMENTED / handler 表三处。
    from services.pdf import routes
    from services.pdf.handlers import build_handlers

    handlers = build_handlers(_settings())
    assert routes.audit(handlers) == []
    assert ("POST", "/pdf/parse-docling") in handlers
    assert ("POST", "/pdf/parse-docling") in routes.ROUTES


# ---------- 端到端（slow：需要真实 docling 引擎与模型权重） ----------


@pytest.mark.slow
def test_parse_real_pdf() -> None:
    if docling_parse.dependency_error():
        pytest.skip("本机未安装 docling")
    out = docling_parse.parse(minimal_pdf_bytes(), "hello.pdf")
    assert out.format == "pdf"
    # 引擎返回的是 Markdown；最小 PDF 只有一行文字，全文必须非空且含关键词
    assert "docling" in out.text
    assert docling_parse.build_payload(out, "hello.pdf")["chars"] > 0
