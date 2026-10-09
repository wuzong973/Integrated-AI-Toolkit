"""结构化日志（与 Node 端 AppLogger 同构：单行 JSON + service + traceId）。"""
from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

# Windows 控制台默认不是 UTF-8，中文日志会变乱码；统一按 UTF-8 输出。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]


class _ServiceFilter(logging.Filter):
    """给每条记录补上 service 字段，否则 formatter 只能拿到默认值。"""

    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def filter(self, record: logging.LogRecord) -> bool:
        record.service = self._service
        return True


class JsonFormatter(logging.Formatter):
    """单行 JSON，便于容器日志采集端直接解析。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(record.created)),
            "level": record.levelname.lower(),
            "service": getattr(record, "service", "qz-service"),
            "message": record.getMessage(),
        }
        trace_id = getattr(record, "traceId", None)
        if trace_id:
            payload["traceId"] = trace_id
        if record.exc_info:
            payload["trace"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging(level: str = "INFO", service: str = "qz-service") -> logging.Logger:
    """返回带 JSON formatter 的 logger；重复调用幂等（覆盖旧 handler）。"""
    logger = logging.getLogger(service)
    logger.setLevel(level)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(_ServiceFilter(service))
    logger.handlers = [handler]
    logger.propagate = False
    return logger
