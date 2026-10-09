"""媒体服务端点注册表：(方法, 路径) -> 能力说明（含任务编号）。

本表是「**已定义能力**」的唯一清单来源，与是否实现无关：
  - 出现在本表且已注册 handler  → 真实处理（`X-Provider: real`）
  - 出现在本表但未写 handler    → 501 + code 50341（`X-Provider: mock`）
  - 完全不在本表                → 404

实现写在 `handlers.py`，装配见 `__main__.py`。

## 一处刻意的取舍：为什么没有换 FastAPI

`requirements.txt` 里列了 FastAPI，那是"进实现阶段"的原始计划。实际落地时保留了
标准库骨架 —— 侧车的真实依赖是 **ffmpeg 这个系统二进制**，换 Web 框架不会让任何
一个能力变得可用，反而会让"没装依赖时连 /health 都起不来"，排障变难。
详见 `services/shared/http.py` 的模块说明。
"""
from __future__ import annotations

# 已实现（handler 注册在 services/media/handlers.py，调用 ffmpeg/ffprobe/playwright）
IMPLEMENTED = {
    ("POST", "/media/probe"),
    ("POST", "/media/transcode"),
    ("POST", "/media/compress"),
    ("POST", "/media/cut"),
    ("POST", "/media/audio-cut"),
    ("POST", "/media/audio-denoise"),
    ("POST", "/media/subtitle"),
    ("POST", "/media/tts"),
    ("POST", "/media/render-diagram"),
}

ROUTES = {
    ("POST", "/media/transcode"): "音视频格式转换（M4-01）",
    ("POST", "/media/compress"): "视频压缩到目标体积（M4-01）",
    ("POST", "/media/cut"): "裁剪 / 拼接（M4-01）",
    ("POST", "/media/subtitle"): "字幕烧录 / 导出 srt（M4-03）",
    # ⚠️ 这两条曾漏登记在 ROUTES（只在 IMPLEMENTED 里补过），于是启动日志一直
    # 报"能力清单不一致" —— 能力其实可用，但对外声称的能力表少了两条。
    ("POST", "/media/audio-cut"): "音频裁剪（M4-03）",
    ("POST", "/media/audio-denoise"): "音频降噪（afftdn，M4-03）",
    ("POST", "/media/probe"): "读取媒体信息（时长 / 分辨率 / 码率）",
    ("POST", "/media/tts"): "文本转语音（edge-tts，中文音色，产出 mp3）",
    ("POST", "/media/render-diagram"): "图表渲染（Mermaid / markmap → PNG，playwright 截图）",
}


def audit(handlers) -> list:
    """校验 handler 表与 `IMPLEMENTED` 声明是否一致，返回问题列表。

    为什么要这道校验：两张表漂移时**不会有任何报错** ——
    写了 handler 却忘了登记 → 能力其实能用，但对外声称未实现；
    登记了却删了 handler → 对外声称已实现，实际返 501。
    两种都是"静默说谎"，只能在启动时对账。
    """
    problems = []
    registered = set(handlers)

    for method, path in sorted(registered - IMPLEMENTED):
        problems.append(f"已写 handler 但未在 IMPLEMENTED 声明：{method} {path}")
    for method, path in sorted(IMPLEMENTED - registered):
        problems.append(f"IMPLEMENTED 声明了但没有 handler：{method} {path}")
    for method, path in sorted(IMPLEMENTED - set(ROUTES)):
        problems.append(f"IMPLEMENTED 里的路径不在 ROUTES 中：{method} {path}")

    return problems
