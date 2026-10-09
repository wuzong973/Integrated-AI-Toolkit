"""图表渲染：Mermaid / markmap → PNG（playwright + chromium 截图内置 HTML 模板）。

## 为什么放在 media 侧车而不是 Node 进程

playwright 要拉起一个完整的 chromium（数百 MB 依赖、启动秒级），
塞进 API 主进程会让后端的安装体积与启动时间被它绑架；
侧车本来就是"重依赖隔离层"（ffmpeg / Demucs / PyMuPDF 同理），渲染是同类。
依赖未装时本模块只返回人话指引（`dependency_error`），端点返 501，不影响其他能力。

## 为什么后台线程跑 asyncio（模块级缓存浏览器的前提）

`ThreadingHTTPServer` 每个请求一个新线程，而 playwright 的 sync API **绑定创建线程**
（greenlet 限制，跨线程复用直接报错）。要让浏览器实例全进程只启动一次，
就得让所有渲染都发生在同一条线程上 —— 所以起一条专职渲染线程跑 asyncio loop，
请求线程经 `run_coroutine_threadsafe` 投递任务并同步等结果。

## 模板与依赖

HTML 模板在 `templates/`（mermaid.html / markmap.html），JS 库已**本地化**进
`templates/vendor/`（离线/内网可用，禁止改回 CDN 引用）—— 版本与来源 URL 见各模板
文件头注释与 `requirements.txt`。
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import threading
from pathlib import Path
from typing import Optional

from services.shared.http import ServiceError

#: 模板目录（templates/mermaid.html、templates/markmap.html、templates/vendor/*.js）
TEMPLATES_DIR = Path(__file__).parent / "templates"
#: 支持的图表语法（handler 据此做 400 校验）
SUPPORTED_KINDS = ("mermaid", "markmap")
#: 支持的产物格式（当前只有 PNG）
SUPPORTED_FORMATS = ("png",)
#: 单次渲染超时（秒）。页面加载 + 库初始化 + 截图，本地实测 1~3s，给足冷启动余量
RENDER_TIMEOUT_SEC = 60.0
#: 截图清晰度。deviceScaleFactor=2 是"小程序里放大看不糊"与体积的折中
DEVICE_SCALE_FACTOR = 2

#: 安装指引（dependency_error / 501 hint 共用；中文字体缺失是最常踩的坑）
_INSTALL_HINT = (
    "pip install playwright && playwright install chromium --with-deps"
    "（--with-deps 会装系统依赖；中文字体包必须装，否则渲染出的中文全是方块）"
)

#: chromium 启动参数。--no-sandbox：容器/无特权环境里没有它起不来
_CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"]


def playwright_missing_error() -> str:
    """playwright 包未安装时的人话指引（单测直接打靶，保证 hint 不跑偏）。"""
    return f"playwright 未安装。安装：{_INSTALL_HINT}"


def chromium_missing_error(detail: str = "") -> str:
    """chromium 浏览器未就绪时的人话指引。"""
    extra = f"：{detail}" if detail else ""
    return f"chromium 浏览器未就绪{extra}。安装：{_INSTALL_HINT}"


# ---------- 依赖检查（结果进程内缓存，/health 与 preflight 都会问） ----------

_dependency: Optional[str] = None
_checked = False
_check_lock = threading.Lock()


def dependency_error() -> Optional[str]:
    """就绪检查。None = 可用；否则返回给运维看的一句话。结果进程内缓存。"""
    global _dependency, _checked
    with _check_lock:
        if not _checked:
            _checked = True
            _dependency = _probe()
        return _dependency


def _probe() -> Optional[str]:
    try:
        import playwright  # noqa: F401
    except ImportError:
        return playwright_missing_error()

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            exe = Path(p.chromium.executable_path)
        if not exe.exists():
            return chromium_missing_error(f"可执行文件不存在（{exe}）")
    except Exception as e:  # noqa: BLE001 —— playwright 自身任何异常都算"环境坏了"
        return chromium_missing_error(str(e))
    return None


# ---------- 渲染（专职线程 + 模块级浏览器缓存） ----------

_loop: Optional[asyncio.AbstractEventLoop] = None
_browser = None
#: 渲染线程的就绪/失败信号
_ready = threading.Event()
_start_error: Optional[str] = None
_started = False


def _template_path(kind: str) -> Path:
    if kind not in SUPPORTED_KINDS:
        raise ServiceError(
            f"kind 只能是 {', '.join(SUPPORTED_KINDS)}，收到 {kind!r}", code=40011,
        )
    return TEMPLATES_DIR / f"{kind}.html"


def _render_main() -> None:
    """渲染线程主体：起 asyncio loop，把 chromium 启动一次后常驻。"""
    global _loop, _browser, _start_error
    loop = asyncio.new_event_loop()
    _loop = loop
    asyncio.set_event_loop(loop)

    async def _boot() -> None:
        global _browser
        from playwright.async_api import async_playwright

        pw = await async_playwright().start()
        _browser = await pw.chromium.launch(args=_CHROMIUM_ARGS)

    try:
        loop.run_until_complete(_boot())
    except ImportError:
        _start_error = playwright_missing_error()
    except Exception as e:  # noqa: BLE001 —— 启动失败原因（缺依赖/缺字体/缺内存）原样带出
        _start_error = chromium_missing_error(str(e))
    finally:
        _ready.set()

    if _start_error is None:
        loop.run_forever()


def _ensure_started() -> Optional[str]:
    """惰性启动渲染线程（幂等）。返回启动失败原因或 None。"""
    global _started
    with _check_lock:
        if _started:
            return _start_error
        _started = True
        threading.Thread(target=_render_main, name="qz-media-render", daemon=True).start()
        # chromium 冷启动在慢盘上可能要几十秒；这是首次请求的等待上限，非常规路径
        if not _ready.wait(timeout=120.0):
            return chromium_missing_error("渲染线程启动超时（120s）")
        return _start_error


def render_diagram(kind: str, code: str, fmt: str = "png") -> bytes:
    """渲染图表为 PNG 字节。依赖未就绪 → 501；入参非法 → 400；渲染失败 → 422。"""
    if fmt not in SUPPORTED_FORMATS:
        raise ServiceError(
            f"format 只能是 {', '.join(SUPPORTED_FORMATS)}，收到 {fmt!r}", code=40011,
        )
    _template_path(kind)  # kind 白名单的统一入口（handler 也会先校验，这里是兜底）
    if not code.strip():
        raise ServiceError("缺少图表代码（字段 code）", code=40011)

    reason = dependency_error()
    if reason:
        raise ServiceError.unavailable("图表渲染引擎（playwright/chromium）未就绪", hint=reason)
    reason = _ensure_started()
    if reason:
        raise ServiceError.unavailable("图表渲染引擎启动失败", hint=reason)
    if _loop is None or _browser is None:  # pragma: no cover —— 与 _ensure_started 互斥
        raise ServiceError.unavailable("图表渲染引擎未就绪", hint=chromium_missing_error())

    template = _template_path(kind)
    fut = asyncio.run_coroutine_threadsafe(_render_page(template, code), _loop)
    try:
        return fut.result(timeout=RENDER_TIMEOUT_SEC)
    except concurrent.futures.TimeoutError as e:
        fut.cancel()
        raise ServiceError(
            f"图表渲染超时（上限 {RENDER_TIMEOUT_SEC:.0f}s）", code=42202,
        ) from e
    except ServiceError:
        raise
    except Exception as e:  # noqa: BLE001 —— mermaid/markmap 语法错误等，原文带回
        raise ServiceError(f"图表渲染失败：{e}", code=42202) from e


async def _render_page(template: Path, code: str) -> bytes:
    """打开模板页 → 注入图表代码 → 截图 #graph 容器。"""
    page = await _browser.new_page(
        viewport={"width": 1280, "height": 800},
        device_scale_factor=DEVICE_SCALE_FACTOR,
    )
    try:
        # file:// 加载本地模板（vendor 相对引用因此可用；等 load 是为了脚本就绪）
        await page.goto(template.as_uri(), wait_until="load")
        # 模板约定：window.render(code) 注入图表并在布局完成后 resolve
        await page.evaluate("code => window.render(code)", code)
        # 中文字体就绪再截图，避免首帧用兜底字体量宽
        await page.evaluate("() => document.fonts.ready.then(() => true)")
        return await page.locator("#graph").screenshot(type="png")
    finally:
        await page.close()
