"""图表渲染的**纯逻辑**单测：不启动 chromium、不需要 playwright 可用。

需要真实渲染的端到端用例标 `@pytest.mark.slow`（pytest.ini 默认排除）。
"""
from __future__ import annotations

import json

import pytest

from services.media import handlers, render
from services.shared.http import Request, ServiceError


def make_request(payload: dict) -> Request:
    """构造 handle_render_diagram 的入参（Request 是纯 dataclass，可直接实例化）。"""
    return Request(
        method="POST",
        path="/media/render-diagram",
        query={},
        headers={},
        body=json.dumps(payload).encode("utf-8"),
    )


# ---------- handler 校验：未知 kind / 空 code / 非法 format → 400 ----------


@pytest.mark.parametrize("kind", ["", "flowchart", "svg", "Mermaid2"])
def test_handler_rejects_unknown_kind(kind: str) -> None:
    with pytest.raises(ServiceError) as err:
        handlers.handle_render_diagram(make_request({"kind": kind, "code": "x"}))
    assert err.value.code == 40011
    # 报错要带上"允许的有哪些"，而不是只说"不行"
    assert "mermaid" in str(err.value)


def test_handler_rejects_empty_code() -> None:
    with pytest.raises(ServiceError) as err:
        handlers.handle_render_diagram(make_request({"kind": "mermaid", "code": "   "}))
    assert err.value.code == 40011


def test_handler_rejects_bad_format() -> None:
    with pytest.raises(ServiceError) as err:
        handlers.handle_render_diagram(
            make_request({"kind": "mermaid", "code": "x", "format": "svg"})
        )
    assert err.value.code == 40011


def test_handler_passes_kind_code_to_renderer(monkeypatch: pytest.MonkeyPatch) -> None:
    # 不真渲染：替换 render_diagram，锁"handler 校验放行后把参数原样交给渲染器"的契约
    captured: dict = {}

    def fake_render(kind: str, code: str, fmt: str = "png") -> bytes:
        captured.update(kind=kind, code=code, fmt=fmt)
        return b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

    monkeypatch.setattr(render, "render_diagram", fake_render)

    resp = handlers.handle_render_diagram(
        make_request({"kind": "markmap", "code": " # a\n## b"})
    )
    assert captured == {"kind": "markmap", "code": " # a\n## b", "fmt": "png"}
    assert resp.raw is not None and resp.raw[:8] == b"\x89PNG\r\n\x1a\n"
    assert resp.content_type == "image/png"
    assert resp.headers["X-Output-Filename"] == "diagram.png"
    assert resp.headers["X-Diagram-Kind"] == "markmap"


# ---------- 依赖指引文案：人话 + 可执行命令，装什么一眼可见 ----------


def test_playwright_missing_hint_contains_install_command() -> None:
    msg = render.playwright_missing_error()
    assert "pip install playwright" in msg
    assert "playwright install chromium" in msg
    # 中文字体是渲染中文不变成方块的硬前提，指引里必须提到
    assert "字体" in msg


def test_chromium_missing_hint_contains_install_command() -> None:
    msg = render.chromium_missing_error("可执行文件不存在（/x/y）")
    assert "playwright install chromium" in msg
    assert "/x/y" in msg


def test_dependency_error_contract() -> None:
    # 不假设本机装没装依赖，只锁"返回类型"契约：可用=None，不可用=给人看的一句话
    reason = render.dependency_error()
    assert reason is None or isinstance(reason, str)


# ---------- 模板与 vendor：文件必须在库、必须本地化（禁止 CDN 回潮） ----------


def test_template_files_exist() -> None:
    for kind in render.SUPPORTED_KINDS:
        assert (render.TEMPLATES_DIR / f"{kind}.html").is_file()


def test_templates_expose_render_entry_and_container() -> None:
    for kind in render.SUPPORTED_KINDS:
        html = (render.TEMPLATES_DIR / f"{kind}.html").read_text(encoding="utf-8")
        # playwright 侧的调用契约：window.render(code) + #graph 截图目标
        assert "window.render" in html
        assert 'id="graph"' in html


def test_templates_reference_vendor_locally_not_cdn() -> None:
    for kind in render.SUPPORTED_KINDS:
        html = (render.TEMPLATES_DIR / f"{kind}.html").read_text(encoding="utf-8")
        assert "vendor/" in html
        # 库已本地化入库；任何 http(s) 的 <script src> 都意味着离线/内网会静默失效
        for line in html.splitlines():
            if "<script src=" in line:
                assert "src=\"vendor/" in line


def test_vendor_bundles_exist_and_nonempty() -> None:
    expected = ("mermaid.min.js", "d3.min.js", "markmap-lib.js", "markmap-view.js")
    for name in expected:
        f = render.TEMPLATES_DIR / "vendor" / name
        assert f.is_file(), f"缺少本地化 JS：{name}"
        # 各库真实体积都在几十 KB 以上；小于它说明下载到的是 jsdelivr 的报错文本
        assert f.stat().st_size > 10_000, f"{name} 疑似未成功下载（{f.stat().st_size} 字节）"


# ---------- 真渲染（slow）：本机装好 playwright + chromium 后跑 ----------


MERMAID_CODE = "mindmap\n  root((思维导图))\n    分支A\n    分支B"
MARKMAP_CODE = "# root\n## 分支A\n## 分支B"


@pytest.mark.slow
@pytest.mark.parametrize(
    ("kind", "code"),
    [("mermaid", MERMAID_CODE), ("markmap", MARKMAP_CODE)],
)
def test_render_diagram_produces_png(kind: str, code: str) -> None:
    png = render.render_diagram(kind, code)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png) > 1000  # 真图不会只有几十字节
