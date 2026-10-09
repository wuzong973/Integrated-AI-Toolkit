"""侧车服务的公共 HTTP 骨架。

## 为什么是标准库而不是 FastAPI

骨架阶段必须"零依赖即可启动并通过 /health 冒烟"（任务清单 M0-21）。
进入实现阶段后这里做了**向后兼容的扩展**：路由表仍是「已定义能力」的唯一清单
（`routes.py` 的 `ROUTES`），但允许为其中一部分路径注册真实 handler。

没有换成 FastAPI 的原因：
  1. 侧车真正的依赖是 ffmpeg / soffice 这类**系统级二进制**，不是 Web 框架 ——
     换个框架不会让任何一个能力变得可用，只会凭空多一层必装依赖；
  2. "零依赖也能起来"有实打实的运维价值：服务器上 `python -m services.media`
     就能拉起并自报健康状况；换 FastAPI 后没装依赖时**连 /health 都没有**，
     排障反而变难（连"服务在不在"都问不出来）。

## 红线 10：能力未实现必须显式可辨

| 情形 | 状态码 | 响应头 |
|---|---|---|
| 已注册 handler 且成功 | 200 | `X-Provider: real` + `X-Capability: <能力名>` |
| 已在 ROUTES 定义但未实现 | 501（code 50341） | `X-Provider: mock` |
| 路径根本不存在 | 404（code 40401） | `X-Provider: mock` |

`X-Service-Stage` 由 `SERVICE_STAGE` 决定（默认 `skeleton`）。
把能力做出来之后**要把这个值改掉**，否则"已完成的服务"在监控里仍显示为骨架。
"""
from __future__ import annotations

import json
import traceback
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Mapping, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from .config import BaseSettings
from .logging import setup_logging

# 路由表：(HTTP 方法, 路径) -> 能力说明（含任务编号）。未实现的走 501 兜底。
RouteTable = Mapping[Tuple[str, str], str]

# handler 表：同样的键 -> 真实处理函数。键不出现在 RouteTable 里会被忽略并告警。
HandlerTable = Mapping[Tuple[str, str], "Handler"]

TASK_LIST_DOC = "docs/product/青智校园_开发任务清单.md"

CODE_OK = 200
CODE_BAD_REQUEST = 40001
CODE_NOT_IMPLEMENTED = 50341
CODE_NOT_FOUND = 40401
CODE_INTERNAL = 50001


class ServiceError(Exception):
    """能力级错误。

    带上完整的状态码与错误码，由框架统一序列化 —— 而不是让每个 handler 自己
    拼 HTTP 响应（那样 `X-Provider` 之类的公共头很容易漏，红线 10 就破了）。
    """

    def __init__(self, message: str, *, status: int = 400, code: int = CODE_BAD_REQUEST,
                 hint: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.hint = hint

    @classmethod
    def unavailable(cls, message: str, *, hint: str = "") -> "ServiceError":
        """能力依赖不可用（缺少二进制 / 缺少依赖包）—— 用 501 而不是 500。

        501 的语义是"我认识这个端点，但服务端还不具备这个能力"，正是这里的实情；
        500 会让人以为是代码 bug 而去查日志。前端也因此能区分
        "服务崩了" 与 "这个能力这台机器上装不了"。
        """
        return cls(message, status=501, code=CODE_NOT_IMPLEMENTED, hint=hint)


@dataclass(frozen=True)
class Request:
    """已解析的请求。handler 只依赖它，不直接碰 socket。"""

    method: str
    path: str
    query: Mapping[str, list]
    headers: Mapping[str, str]
    body: bytes

    def param(self, name: str, default: str = "") -> str:
        values = self.query.get(name) or []
        return str(values[0]) if values else default

    def header(self, name: str, default: str = "") -> str:
        for key, value in self.headers.items():
            if key.lower() == name.lower():
                return value
        return default

    def json(self) -> dict:
        if not self.body:
            return {}
        try:
            payload = json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ServiceError(f"请求体不是合法 JSON：{e}", code=CODE_BAD_REQUEST) from e
        if not isinstance(payload, dict):
            raise ServiceError("请求体必须是 JSON 对象", code=CODE_BAD_REQUEST)
        return payload


@dataclass
class Response:
    """处理结果。`payload` 与 `raw` 二选一：前者走 JSON，后者原样回二进制。"""

    status: int = CODE_OK
    payload: Optional[dict] = None
    raw: Optional[bytes] = None
    content_type: str = "application/json; charset=utf-8"
    headers: dict = field(default_factory=dict)


#: handler 签名
Handler = Callable[[Request], Response]


def make_handler(
    settings: BaseSettings,
    routes: RouteTable,
    handlers: Optional[HandlerTable] = None,
    health_extra: Optional[Callable[[], dict]] = None,
) -> type[BaseHTTPRequestHandler]:
    """生成服务专属的请求处理器类。"""
    logger = setup_logging(settings.log_level, f"qz-{settings.service_name}")
    known = sorted(f"{method} {path}" for method, path in routes)
    table = dict(handlers or {})
    max_body = settings.max_body_bytes

    # 注册了但没在 ROUTES 里登记的能力说明会被静默忽略 → 这里主动报警。
    # 反向（在 ROUTES 里但没有 handler）是正常的，就是"还没实现"。
    for method, path in sorted(table):
        if (method, path) not in routes:
            logger.warning(f"handler 未在 ROUTES 登记，已忽略：{method} {path}")

    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.1 才支持 keep-alive；代价是每个响应必须自带 Content-Length，
        # 下面 _write 统一负责，不留"忘了写长度导致客户端挂住"的坑。
        protocol_version = "HTTP/1.1"
        server_version = f"qz-{settings.service_name}/{settings.version}"
        sys_version = ""

        def log_message(self, fmt: str, *args) -> None:  # noqa: A003
            logger.info(fmt % args)

        # ---------- 响应写出 ----------

        def _write(self, status: int, body: bytes, content_type: str,
                   provider: str, extra: Optional[dict] = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Provider", provider)
            self.send_header("X-Service-Stage", settings.stage)
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, payload: dict, provider: str = "real",
                  extra: Optional[dict] = None) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._write(status, body, "application/json; charset=utf-8", provider, extra)

        # ---------- 入口 ----------

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] == "/health":
                self._json(200, self._health())
                return
            self._dispatch("GET", b"")

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        def do_POST(self) -> None:  # noqa: N802
            try:
                body = self._read_body()
            except ServiceError as e:
                self._json(e.status, self._error_payload(e), provider="mock")
                return
            self._dispatch("POST", body)

        def _read_body(self) -> bytes:
            raw = self.headers.get("Content-Length") or "0"
            try:
                length = int(raw)
            except ValueError as e:
                raise ServiceError("Content-Length 不是整数", code=CODE_BAD_REQUEST) from e
            if length < 0:
                raise ServiceError("Content-Length 为负", code=CODE_BAD_REQUEST)
            if length > max_body:
                raise ServiceError(
                    f"请求体超过上限（{length} > {max_body} 字节）。"
                    f"上限由 SIDECAR_MAX_BODY_MB 控制。",
                    status=413,
                    code=CODE_BAD_REQUEST,
                )
            return self.rfile.read(length) if length else b""

        # ---------- 健康检查 ----------

        def _health(self) -> dict:
            payload = {
                "status": "ok",
                "service": settings.service_name,
                "version": settings.version,
                "stage": settings.stage,
                "implemented": sorted(f"{m} {p}" for m, p in table),
                "pending": sorted(f"{m} {p}" for m, p in routes if (m, p) not in table),
            }
            if health_extra is not None:
                payload["config"] = health_extra()
            return payload

        # ---------- 分发 ----------

        def _dispatch(self, method: str, body: bytes) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            handler = table.get((method, path))

            if handler is None:
                if (method, path) in routes:
                    self._json(501, {
                        "code": CODE_NOT_IMPLEMENTED,
                        "message": f"能力尚未实现：{routes[(method, path)]}",
                        "hint": f"端点已在设计中定义，实现进度见 {TASK_LIST_DOC}",
                        "provider": "mock",
                    }, provider="mock")
                    return
                self._json(404, {
                    "code": CODE_NOT_FOUND,
                    "message": "接口不存在",
                    "routes": known,
                }, provider="mock")
                return

            request = Request(
                method=method,
                path=path,
                query=parse_qs(parsed.query, keep_blank_values=True),
                headers=dict(self.headers.items()),
                body=body,
            )
            try:
                result = handler(request)
            except ServiceError as e:
                self._json(e.status, self._error_payload(e), provider="mock")
                return
            except Exception as e:  # noqa: BLE001 —— 兜住一切，避免连接被直接掐断
                # 未预期异常必须留下堆栈：否则线上只看到 500 而无从下手。
                logger.error(f"{method} {path} 处理失败：{e}\n{traceback.format_exc()}")
                self._json(500, {
                    "code": CODE_INTERNAL,
                    "message": "服务内部错误",
                    "detail": str(e),
                }, provider="mock")
                return

            self._respond(method, path, result)

        def _respond(self, method: str, path: str, result: Response) -> None:
            if result.raw is not None:
                self._write(result.status, result.raw, result.content_type, "real",
                            {"X-Capability": f"{method} {path}", **result.headers})
                return
            self._json(result.status, result.payload or {}, "real",
                       {"X-Capability": f"{method} {path}", **result.headers})

        def _error_payload(self, e: ServiceError) -> dict:
            payload = {"code": e.code, "message": str(e)}
            if e.hint:
                payload["hint"] = e.hint
            return payload

    return Handler


def serve(
    settings: BaseSettings,
    routes: RouteTable,
    handlers: Optional[HandlerTable] = None,
    health_extra: Optional[Callable[[], dict]] = None,
) -> None:
    """启动服务，Ctrl+C 优雅退出。"""
    logger = setup_logging(settings.log_level, f"qz-{settings.service_name}")
    handler = make_handler(settings, routes, handlers, health_extra)
    server = ThreadingHTTPServer((settings.host, settings.port), handler)
    implemented = len(handlers or {})
    logger.info(
        f"{settings.service_name} 已启动：http://{settings.host}:{settings.port}"
        f"（{settings.stage} 阶段；已实现 {implemented}/{len(routes)} 个能力）"
    )
    logger.info(f"健康检查：curl {settings.health_url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("收到中断信号，正在关闭…")
    finally:
        server.shutdown()
        server.server_close()
