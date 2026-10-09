"""PyMuPDF CLI 的调用封装（唯一允许的 AGPL 交互方式：独立进程 + 命令行）。

## 为什么这一层必须"薄"

我们对 PyMuPDF 只做三件事：**传文件路径、传参数、读产物**。
任何"用 Python 逻辑弥补引擎不足"的尝试都会把 AGPL 的边界往里推 ——
一旦在这里 import fitz，本服务就变成了 AGPL 衍生物，`requirements.txt`
也必须写上 `pymupdf`，那正是 B 级清单禁止的形态。

所以这里只有"拼命令 + 收产物"，连结果校验都放在 handler 层做。

## 两种解析方式

`PYMUPDF_BIN` 指向**装了 PyMuPDF 的 Python 解释器**，我们追加 `-m pymupdf`：
    <PYMUPDF_BIN> -m pymupdf join -output out.pdf in1 in2

留空则退化为直接找 PATH 上的 `pymupdf` 命令（pip 装完通常会生成它）：
    pymupdf join -output out.pdf in1 in2

两种都走 `services.shared.cli.run`：列表参数 + `shell=False`，
Windows 上含引号的用户路径不会被吃掉或注入。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence

from services.shared.cli import CliError, resolve_binary, run
from services.shared.http import ServiceError

#: 走解释器方式时固定追加的模块名
MODULE_ARGS = ("-m", "pymupdf")

#: PyMuPDF 各子命令（只列我们用到的；加能力时在此扩表，handler 跟着加）
MERGE = "join"
COMPRESS = "clean"
SPLIT = "clean"
TEXT = "gettext"
SHOW = "show"


@dataclass(frozen=True)
class Engine:
    """一次装配、多处复用。`available` 是**本机实测**结果，不是配置声明。"""

    pymupdf_bin: str
    timeout_sec: float

    @property
    def available(self) -> bool:
        return self._resolve() is not None

    @property
    def describe(self) -> str:
        """给 /health 与报错信息用的一句话（能看出到底找的是哪个）。"""
        found = self._resolve()
        if not found:
            return "未找到（设置 PYMUPDF_BIN 指向装了 PyMuPDF 的 python.exe）"
        return found

    def _resolve(self) -> Optional[str]:
        if self.pymupdf_bin.strip():
            # 配置的是解释器：必须是真实存在的文件，且要求它带 -m pymupdf 可用
            return self.pymupdf_bin.strip()
        # 退化：PATH 上直接有 pymupdf 命令
        return resolve_binary("pymupdf")

    def _prefix(self) -> List[str]:
        found = self._resolve()
        if not found:
            raise ServiceError.unavailable(
                "PDF 引擎（PyMuPDF）未安装",
                hint=(
                    "PyMuPDF 为 AGPL 组件，必须独立安装、以子进程调用（不入库）。"
                    "安装后把 .env 里的 PYMUPDF_BIN 指向装了它的 python.exe。"
                ),
            )
        return [found, *MODULE_ARGS] if self.pymupdf_bin.strip() else [found]

    def run(self, args: Sequence[str]) -> "CliResult":
        """执行一次 PyMuPDF 子命令。失败转成 422（输入/文档问题）或 503（引擎问题）。"""
        try:
            return run([*self._prefix(), *args], timeout=self.timeout_sec)
        except CliError as e:
            # PyMuPDF 对损坏/加密文档的报错是有信息量的，原样带回；
            # 但"可执行文件不存在/超时"属于环境问题，文案要引导运维而不是用户。
            if "不存在" in e.message or "超时" in e.message:
                raise ServiceError(
                    e.message,
                    status=503,
                    code=50345,
                    hint="PDF 引擎不可用，请检查 PYMUPDF_BIN 配置",
                ) from e
            raise ServiceError(
                f"PDF 处理失败：{e.message}",
                status=422,
                code=42210,
                hint=e.detail,
            ) from e

    # ---------- 四个能力的命令拼装 ----------

    def version(self) -> Optional[str]:
        """探测引擎是否真的能跑起来（用于 /health 如实展示）。

        ⚠️ CLI **没有** `--version`（实测会直接报 unrecognized arguments），
        所以用 `-h`：它能跑通就说明解释器与模块都在，且不产生任何副作用。
        """
        try:
            out = run([*self._prefix(), "-h"], timeout=15).stdout_text
            return "pymupdf" in out.lower() or "MuPDF" in out
        except (CliError, ServiceError):
            return None

    def page_count(self, src: Path) -> int:
        """读总页数。

        用 `show`：它的首行是 `'file', pages: 5, objects: 23, 3.1 KB, PDF 1.7, ...`，
        一次子进程就能拿到，**不需要**靠"clean -pages N-N 二分探测"那种又慢又脆的做法。
        """
        out = self.run([SHOW, str(src)]).stdout_text
        m = re.search(r"pages:\s*(\d+)", out)
        if not m:
            raise ServiceError(
                "无法从引擎输出中解析页数", status=422, code=42214, hint=out[:400],
            )
        return int(m.group(1))

    def merge(self, inputs: Sequence[Path], output: Path) -> None:
        """合并多个 PDF。

        `join` 的每个输入支持 `filename[,password[,pages]]`；
        我们不透传密码/页选 —— 那是另一个产品能力，混进来会让参数空间失控。
        """
        args = [MERGE, "-output", str(output), *[str(p) for p in inputs]]
        self.run(args)

    def clean(self, src: Path, dst: Path, *, pages: Optional[str] = None) -> None:
        """优化重写（压缩）；给 `pages` 时产出子 PDF（拆分的底层实现）。

        `-garbage=4` 是最高档的回收（会重建交叉引用表、去重对象），
        `-compress` 压缩内容流，`-sanitize` 清理内容流里的冗余指令。
        `-linear` 不加：它面向"网页边下边看"，会让文件略变大，与压缩目标相反。
        """
        args = [
            COMPRESS,
            "-compress",
            "-garbage",
            "4",
            "-sanitize",
            *([] if pages is None else ["-pages", pages]),
            str(src),
            str(dst),
        ]
        self.run(args)

    def gettext(self, src: Path, output_txt: Path) -> None:
        """抽取文本。**默认输出用换页符（\\f）分页**，handler 据此还原页序。

        刻意**不加** `-skip-empty`：跳过空页会让"第 N 页"与实际页码错位，
        而调用方需要页码对得上原文（引用、定位都靠它）。
        """
        args = [TEXT, "-mode", "layout", "-output", str(output_txt), str(src)]
        self.run(args)
