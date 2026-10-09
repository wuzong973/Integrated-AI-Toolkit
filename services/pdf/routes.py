"""PDF 服务端点注册表：(方法, 路径) -> 能力说明。

本表是「**已定义能力**」的唯一清单来源，与是否实现无关：
  - 出现在本表且已注册 handler  → 真实处理（`X-Provider: real`）
  - 出现在本表但未写 handler    → 501 + code 50341（`X-Provider: mock`）
  - 完全不在本表                → 404

实现写在 `handlers.py`，装配见 `__main__.py`。
"""
from __future__ import annotations

# 已实现（handler 注册在 services/pdf/handlers.py，子进程调用 PyMuPDF CLI；
# parse-docling 走进程内 docling 引擎，见 docling_parse.py）
IMPLEMENTED = {
    ("GET", "/pdf/capabilities"),
    ("POST", "/pdf/merge"),
    ("POST", "/pdf/split"),
    ("POST", "/pdf/compress"),
    ("POST", "/pdf/text"),
    ("POST", "/pdf/parse-docling"),
}

ROUTES = {
    ("GET", "/pdf/capabilities"): "PDF 引擎可用性（本机实测）",
    ("POST", "/pdf/merge"): "合并多个 PDF（merge_pdf）",
    ("POST", "/pdf/split"): "按页/按范围拆分，ZIP 回传（split_pdf）",
    ("POST", "/pdf/compress"): "优化压缩，越压越大时明确拒绝（compress_pdf）",
    ("POST", "/pdf/text"): "抽取文本，带分页与总字数（parse_document）",
    ("POST", "/pdf/parse-docling"): "docling 解析：版面/表格/阅读顺序，输出 Markdown（parse_document）",
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
