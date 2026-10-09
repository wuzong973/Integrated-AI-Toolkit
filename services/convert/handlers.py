"""services/convert 的能力实现。

## 协议

`POST /convert/document`（multipart/form-data）
  - `file`    待转换文档（必填）
  - `target`  目标格式，如 `pdf` / `docx` / `md`（必填）
  - `source`  源格式，缺省时**从文件名后缀推断**

`GET /convert/capabilities`
  按引擎列出全部转换路径，并标注**本机实测**是否可用。

## 为什么源格式要从文件名推断、又允许显式覆盖

LibreOffice 与 Pandoc 都按扩展名选解复用器：把 `.docx` 存成无后缀的临时文件
会让它们猜错格式并给出与真实原因无关的报错。所以落盘时保留后缀；
同时允许调用方显式传 `source`，覆盖"文件名不可信"的场景（例如上传方改了名）。
"""
from __future__ import annotations

from typing import Dict, List, Tuple
from urllib.parse import quote

from services.shared.cli import workdir
from services.shared.http import Handler, Request, Response, ServiceError
from services.shared.multipart import parse_form

from .converters import (
    PANDOC,
    SOFFICE,
    SUPPORTED_SOURCES,
    Engines,
    build_engines,
    content_type_for,
    find,
    run_pandoc,
    run_soffice,
)
from .settings import ConvertSettings


def build_handlers(settings: ConvertSettings) -> Dict[Tuple[str, str], Handler]:
    engines = build_engines(settings)
    return {
        ("GET", "/convert/capabilities"): lambda req: handle_capabilities(engines),
        ("POST", "/convert/document"): lambda req: handle_document(engines, req),
    }


def handle_capabilities(engines: Engines) -> Response:
    """列出转换矩阵与本机可用性。

    单独提供这个只读端点，是为了让"为什么转换失败"能在**不发文件**的前提下问清楚：
    `curl /convert/capabilities` 一发就知道这台机器有没有装引擎。
    """
    return Response(payload={
        "engines": {
            SOFFICE: engines.soffice.available,
            PANDOC: engines.pandoc.available,
        },
        "availableEngines": engines.available_engines(),
        "conversions": engines.capabilities(),
    })


def handle_document(engines: Engines, req: Request) -> Response:
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()

    target = (form.get("target") or "").strip().lower().lstrip(".")
    source = (form.get("source") or "").strip().lower().lstrip(".")
    if not source:
        source = _extension_of(part.filename)

    conversion = find(source, target)
    engine = engines.get(conversion.engine)

    with workdir("qz-convert-") as root:
        # 保留后缀：两个引擎都靠它选解析器
        staged = root / f"input.{conversion.source}"
        staged.write_bytes(part.data)

        if conversion.engine == SOFFICE:
            produced = run_soffice(engine, staged, conversion.target, root)
        else:
            produced = run_pandoc(engine, staged, conversion.target, root)

        return Response(
            raw=produced.read_bytes(),
            content_type=content_type_for(conversion.target),
            headers={
                "X-Output-Filename": quote(
                    f"{_stem(part.filename)}.{conversion.target}"
                ),
                "X-Output-Content-Type": content_type_for(conversion.target),
                "X-Convert-Engine": conversion.engine,
                "X-Convert-From": conversion.source,
                "X-Convert-To": conversion.target,
                "X-Input-Bytes": str(part.size),
            },
        )


def health_config(settings: ConvertSettings) -> dict:
    engines = build_engines(settings)
    return {
        **settings.health_config,
        "sofficeAvailable": engines.soffice.available,
        "pandocAvailable": engines.pandoc.available,
    }


def _extension_of(filename: str) -> str:
    name = (filename or "").strip()
    if "." not in name:
        raise ServiceError(
            f"无法从文件名推断源格式（收到 {name!r}）",
            code=40021,
            hint=f"请在表单里显式传 `source`；支持：{', '.join(sorted(SUPPORTED_SOURCES))}",
        )
    return name.rsplit(".", 1)[-1].lower()


def _stem(filename: str) -> str:
    name = (filename or "output").strip() or "output"
    return name.rsplit(".", 1)[0] if "." in name else name
