"""AI 服务端点注册表：(方法, 路径) -> 能力说明（含任务编号）。

本表是「**已定义能力**」的唯一清单来源，与是否实现无关：
  - 出现在本表且已注册 handler → 真实处理（`X-Provider: real`）
  - 出现在本表但未写 handler   → 501 + code 50341（`X-Provider: mock`）
  - 完全不在本表               → 404

实现写在 `handlers.py`。**未实现的每一条都标注了卡在哪里**（决策 / 工程量），
因为这两类活的排期方式完全不同 —— 详见 `handlers.py` 顶部的状态表。
"""
from __future__ import annotations

# 已实现（handler 注册在 services/ai/handlers.py）
IMPLEMENTED = {
    ("POST", "/ai/matting"),
    ("POST", "/ai/separation"),
    ("POST", "/ai/asr"),
    ("POST", "/ai/ocr"),
}

ROUTES = {
    ("POST", "/ai/ocr"): "OCR 文字识别（M1-11）",
    ("POST", "/ai/asr"): "语音转文字（M4-03）",
    ("POST", "/ai/matting"): "抠图去背景（rembg 白名单模型，M1-12）",
    ("POST", "/ai/separation"): "人声/伴奏分离（Demucs htdemucs，M4-02）",
    ("POST", "/ai/enhance"): "图片增强 / 超分（M1-10）",
    ("POST", "/ai/inpaint"): "授权内容图片修复（需版权声明，M4-05）",
    ("POST", "/ai/parse-document"): "文档/论文解析（M4-06）",
}
