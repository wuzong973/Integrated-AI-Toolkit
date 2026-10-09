"""python -m services.ai 的入口。"""
from __future__ import annotations

import logging

from services.ai.handlers import build_handlers, health_config, preflight
from services.ai.routes import ROUTES
from services.ai.settings import load_settings
from services.shared.http import serve


def main() -> None:
    settings = load_settings()
    logger = logging.getLogger("qz-ai")

    # 配置体检要在启动时做：配置错误不会让服务起不来，只会让每个请求都失败，
    # 那是运维最难定位的一类故障（端口通、健康检查绿、功能全挂）。
    for problem in preflight(settings):
        logger.warning(problem)

    serve(
        settings,
        ROUTES,
        handlers=build_handlers(settings),
        health_extra=lambda: health_config(settings),
    )


if __name__ == "__main__":
    main()
