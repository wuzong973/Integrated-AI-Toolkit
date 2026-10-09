"""转换服务端点注册表：(方法, 路径) -> 能力说明。

本表是「已定义能力」的唯一清单来源，与是否实现无关：
  - 出现在本表且已注册 handler → 真实处理（`X-Provider: real`）
  - 出现在本表但未写 handler   → 501 + code 50341（`X-Provider: mock`）
  - 完全不在本表               → 404
"""
from __future__ import annotations

IMPLEMENTED = {
    ("GET", "/convert/capabilities"),
    ("POST", "/convert/document"),
}

ROUTES = {
    ("GET", "/convert/capabilities"): "转换能力矩阵与本机可用性（ADR-05）",
    ("POST", "/convert/document"): "文档格式转换：docx/doc/ppt/xlsx → pdf，md/html ↔ docx（ADR-05）",
}
