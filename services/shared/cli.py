"""外部命令行程序的调用封装（ffmpeg / soffice / pandoc）。

## 为什么所有侧车都从这里调子进程

1. **许可隔离**：这些程序多为 LGPL / GPL / AGPL，只能以"独立进程 + CLI"方式使用。
   用 `subprocess` 列表参数调用即与主工程解耦，不链接任何 libav*/soffice 库。
2. **参数不经过 shell**：`shell=False` + 列表参数。Windows 上用户名可能含引号
   （本机就是 `w'w'w`），走 shell 拼字符串时这类路径会被吃掉或注入，
   而列表参数由操作系统直接传给进程，不存在转义问题。
3. **失败必须带原文**：外部程序失败时最有价值的信息是它自己的 stderr。
   这里把它完整带回并截断，避免又出现"只报 500、原因不明"的排查困境。
"""
from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List, Optional, Sequence

#: stderr 回传给调用方的最大字符数（再长对排障没有边际价值，只会撑爆日志）
STDERR_LIMIT = 4000

#: Windows 上不弹控制台窗口；其他平台为 0
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _signed(code: int) -> int:
    """Windows 的负退出码会被表达成无符号 32 位整数。

    `-22`（EINVAL）打出来是 `4294967274` —— 看着像天文数字，实际只是参数非法。
    统一还原成有符号值，让报错能被人一眼读懂。
    """
    return code - 2**32 if code > 2**31 else code


class CliError(Exception):
    """子进程调用失败。携带退出码与 stderr 原文。"""

    def __init__(self, message: str, *, returncode: int = -1, stderr: str = "") -> None:
        super().__init__(message)
        self.returncode = _signed(returncode)
        self.stderr = stderr

    @property
    def detail(self) -> str:
        text = (self.stderr or "").strip()
        return text[-STDERR_LIMIT:] if text else "(无 stderr 输出)"


@dataclass(frozen=True)
class CliResult:
    stdout: bytes
    stderr: bytes
    duration_ms: int

    @property
    def stdout_text(self) -> str:
        return self.stdout.decode("utf-8", errors="replace")

    @property
    def stderr_text(self) -> str:
        return self.stderr.decode("utf-8", errors="replace")


def resolve_binary(configured: str, *fallbacks: str) -> Optional[str]:
    """把"配置的可执行文件"解析成真实路径。

    接受三种输入：留空（按候选名查 PATH）、绝对/相对路径、PATH 中的命令名。
    返回 None 表示**这台机器上没有**——调用方必须据此给出明确提示，
    而不是让 subprocess 抛一个 `FileNotFoundError` 被当成 500。
    """
    candidates: List[str] = []
    if configured and configured.strip():
        candidates.append(configured.strip())
    candidates.extend(name for name in fallbacks if name)

    for candidate in candidates:
        # 带路径分隔符的一律当路径处理：这类输入通常是想指定某个特定构建
        # （例如 LGPL 版 ffmpeg），查 PATH 反而会命中另一个 GPL 版本。
        if os.sep in candidate or (os.altsep and os.altsep in candidate):
            if Path(candidate).is_file():
                return candidate
            continue
        found = shutil.which(candidate)
        if found:
            return found
    return None


def run(
    args: Sequence[str],
    *,
    timeout: float,
    stdin: Optional[bytes] = None,
    cwd: Optional[Path] = None,
) -> CliResult:
    """执行外部程序。非零退出码抛 `CliError`（含 stderr 原文）。"""
    started = time.monotonic()
    try:
        proc = subprocess.run(  # noqa: S603 —— 参数为列表且 shell=False，无注入面
            list(args),
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            cwd=str(cwd) if cwd else None,
            shell=False,
            creationflags=_NO_WINDOW,
        )
    except FileNotFoundError as e:
        raise CliError(f"可执行文件不存在：{args[0]}") from e
    except subprocess.TimeoutExpired as e:
        raise CliError(f"执行超时（{timeout:.0f}s）：{args[0]}") from e

    duration_ms = int((time.monotonic() - started) * 1000)
    if proc.returncode != 0:
        raise CliError(
            f"{Path(args[0]).name} 退出码 {_signed(proc.returncode)}",
            returncode=proc.returncode,
            stderr=proc.stderr.decode("utf-8", errors="replace"),
        )

    return CliResult(stdout=proc.stdout, stderr=proc.stderr, duration_ms=duration_ms)


@contextlib.contextmanager
def workdir(prefix: str = "qz-sidecar-") -> Iterator[Path]:
    """临时工作目录。

    外部程序基本只接受**文件路径**而不是流（ffmpeg 的某些 muxer、
    LibreOffice 全都是这样），所以"字节进、字节出"的接口在内部必须落盘。
    统一用这个上下文管理，保证异常路径下也会清理。
    """
    path = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
