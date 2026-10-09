"""python -m services.media 的入口。"""
from __future__ import annotations

import logging

from services.media.handlers import build_handlers, preflight
from services.media.routes import ROUTES
from services.media.settings import load_settings
from services.shared.http import serve


def main() -> None:
    settings = load_settings()
    logger = logging.getLogger("qz-media")

    # 配置体检要在启动时做：依赖缺失不会让服务起不来，只会让对应请求都 501，
    # 那是运维最难定位的一类故障（端口通、健康检查绿、功能全挂）。
    for problem in preflight(settings):
        logger.warning(problem)

    serve(
        settings,
        ROUTES,
        handlers=build_handlers(settings),
        health_extra=lambda: settings.health_config,
    )


if __name__ == "__main__":
    main()
