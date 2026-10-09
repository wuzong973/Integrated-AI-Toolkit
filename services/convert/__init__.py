"""services/convert —— 文档转换隔离服务（ADR-05）。

## 为什么必须独立部署

LibreOffice 是 **MPL-2.0 + LGPL** 混合，Pandoc 是 **GPL-2.0**，ConvertX 是 **AGPL-3.0**。
本项目的红线是"GPL / AGPL 组件不得进 `apps/` 或 `services/` 主工程"，
所以它们**不以库的形式被链接**，而是：
  1. 独立部署成一台（或一个容器）只有这几个二进制的服务；
  2. 主工程只通过 HTTP 把文件丢过去、拿结果回来（`CONVERT_SERVICE_URL`）；
  3. 主工程侧对它的失败有明确降级：未配置或不可用 → 50362（不是 500、不是假成功）。

这样 GPL 的传染性止步于进程边界，主工程的许可结论不受影响。

## 本服务自身的许可位置

注意 `services/convert/` 是**主仓库里的一层适配代码**，它自己不包含任何 GPL 代码 ——
它只是调用外部命令。真正的 GPL 二进制由部署方安装（见 `docs/compliance/OPEN_SOURCE_LICENSES.md`），
不随仓库分发。
"""
from __future__ import annotations
