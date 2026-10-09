"""python -m services.convert 的入口。"""
from __future__ import annotations

import logging

from services.convert.handlers import build_handlers, health_config
from services.convert.routes import ROUTES
from services.convert.settings import load_settings
from services.shared.http import serve


def main() -> None:
    settings = load_settings()
    logger = logging.getLogger("qz-convert")

    # 引擎缺失不是"启动失败"的理由：只要有一个引擎在，服务就有价值
    # （装了 Pandoc 没装 LibreOffice，md↔docx 这条链照样能用）。
    # 但要**在启动日志里说清楚哪些不可用**，否则运维只会看到能力矩阵里一片红。
    from services.convert.converters import PANDOC, SOFFICE, build_engines

    engines = build_engines(settings)
    for name, engine in ((SOFFICE, engines.soffice), (PANDOC, engines.pandoc)):
        if not engine.available:
            logger.warning("%s 未找到，相关转换路径在本机不可用", name)

    serve(
        settings,
        ROUTES,
        handlers=build_handlers(settings),
        health_extra=lambda: health_config(settings),
    )


if __name__ == "__main__":
    main()
