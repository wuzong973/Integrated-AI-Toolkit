"""人声 / 伴奏分离（Demucs，M4-02）。

## 为什么这件事必须上模型

`services/media` 的降噪（`afftdn`）是"**一条**音轨变干净"，分离是"**把一条拆成两条**" ——
后者没有模型就只能靠中心声道相消（左右声道相减）这类近似：它对立体声里居中的
人声有一定抵消效果，但会连带削掉贝斯与军鼓，且对单声道输入完全失效。
拿它冒充"人声分离"，用户听到的是一段残缺的伴奏 —— 比直接报错更糟。

所以这里只做真分离：Demucs 的 `htdemucs`（MIT 许可，权重约 80MB）。

## 依赖缺失时怎么办

`demucs` + `torch` 合计约 1GB，且首次运行还要从 HuggingFace 拉权重。
按红线 10，未安装时**返回 501 与安装指引**，绝不返回原音频假装成功。

## 为什么整段串行

Demucs 在 CPU 上会吃满所有核心。两个请求并发跑不会更快，只会互相拖慢并可能 OOM，
所以用一把**可重入锁**把"加载模型 + 推理"整段串起来（与 `GPU_CONCURRENCY=1` 的约定一致）。
模型本身也按名字缓存 —— 加载权重要几秒，每次请求重建会把"分离 1 分钟"变成"2 分钟"。
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from services.shared.http import ServiceError

logger = logging.getLogger("qz-ai")

#: 默认模型。`htdemucs` 是 Demucs v4 的混合时域/频域模型，
#: 在"人声 vs 伴奏"上明显好于 v3 的 mdx 系列，且权重只有约 80MB（不是全量模型集的 2GB）。
DEFAULT_MODEL = "htdemucs"

#: 允许的模型白名单 —— 与抠图同一个纪律：**服务端强制**，请求参数绕不过去。
#: 收录标准：Demucs 官方发布 + 权重许可允许商用（见 OPEN_SOURCE_LICENSES.md）。
WHITELIST = frozenset({"htdemucs"})

#: `.env` 里的 `VOCAL_SEPARATION_ENGINE` 用的是"引擎"语义，这里映射到具体模型名
ENGINE_TO_MODEL = {"demucs": DEFAULT_MODEL}

#: htdemucs 的四条输出轨
SOURCES = ("drums", "bass", "other", "vocals")

#: 输入体积上限。CPU 推理大约是音频时长的 1~3 倍，
#: 与其让用户等到超时，不如一开始就说清楚"这个文件太大了"。
MAX_INPUT_BYTES = 10 * 1024 * 1024

#: 产物码率。192kbps 对"听得出区别"这件事已经足够，再高只是让传输变慢。
MP3_BITRATE = 192

_lock = threading.RLock()
_separators: Dict[str, object] = {}


@dataclass(frozen=True)
class Stem:
    """一条分离出来的轨道"""

    name: str
    data: bytes
    content_type: str = "audio/mpeg"


@dataclass(frozen=True)
class SeparationResult:
    stems: List[Stem]
    model: str
    duration_sec: float


def resolve_model(raw: str) -> str:
    """把请求里的模型/引擎名收敛到白名单内的具体模型。"""
    key = (raw or "").strip().lower()
    model = ENGINE_TO_MODEL.get(key, key)
    if model not in WHITELIST:
        raise ServiceError(
            f"不支持的人声分离模型 {raw!r}",
            code=40011,
            hint=f"可选：{', '.join(sorted(WHITELIST))}",
        )
    return model


def dependency_error() -> Optional[str]:
    """依赖是否就绪；返回 `None` 表示可用，否则返回**给人看**的原因。

    用"试导入"而不是查 `pip list`：真正的判据是"这台机器现在能不能跑"，
    而 `pip list` 会受多套 Python 环境干扰（本项目就踩过：PATH 里的解释器没装 rembg）。
    """
    try:
        import demucs.api  # noqa: F401
        import torch  # noqa: F401
    except Exception as e:  # pragma: no cover - 取决于运行环境
        return f"未安装 demucs / torch（{e}）"
    return None


def separate(data: bytes, filename: str, model: str, stems: str, workdir: Path) -> SeparationResult:
    """跑一次分离，返回若干条轨道。

    `stems` 只接受 `'2'`（人声 + 伴奏）或 `'4'`（人声/鼓/贝斯/其他）。
    """
    reason = dependency_error()
    if reason:
        raise ServiceError(
            f"人声/伴奏分离不可用：{reason}",
            code=50341,
            hint="安装：pip install demucs（含 torch，约 1GB）",
        )
    if len(data) > MAX_INPUT_BYTES:
        raise ServiceError(
            f"音频过大（{len(data) // 1024 // 1024}MB），上限 {MAX_INPUT_BYTES // 1024 // 1024}MB",
            code=40011,
            hint="可先用「音频裁剪」截取片段，或压缩成更低的码率",
        )
    if stems not in ("2", "4"):
        raise ServiceError(f"stems 只能是 2 或 4，收到 {stems!r}", code=40011)

    src = workdir / f"input{Path(filename or 'input.mp3').suffix or '.mp3'}"
    src.write_bytes(data)

    with _lock:
        separator = _get_separator(model)
        logger.info("开始分离：%s（%d 字节，%s 轨）", src.name, len(data), stems)
        _origin, separated = separator.separate_audio_file(src)
        tracks = _pick_tracks(separated, stems)
        out = [_write_stem(separator, workdir, name, tensor) for name, tensor in tracks]

    return SeparationResult(stems=out, model=model, duration_sec=_duration(separator, separated))


def _get_separator(model: str):
    """按模型缓存 Separator（加载权重需要几秒，重建会把耗时翻倍）。"""
    with _lock:
        cached = _separators.get(model)
        if cached is None:
            from demucs.api import Separator

            cached = Separator(model=model, device=_device(), progress=False)
            _separators[model] = cached
        return cached


def _device() -> str:
    """有 GPU 就用 GPU —— 同一份代码在装了显卡的机器上快一个数量级。"""
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # pragma: no cover
        return "cpu"


def _pick_tracks(separated: Dict[str, object], stems: str) -> List[Tuple[str, object]]:
    """按轨道数挑结果。

    2 轨的伴奏用 `sum(其余三轨)` 而不是"原音频减人声"：两者近似等价，
    但前者是 Demucs 官方 `--two-stems` 的做法，产物与 CLI 一致，便于对照排查。
    """
    if stems == "4":
        return [(name, separated[name]) for name in SOURCES]
    vocals = separated["vocals"]
    others = [separated[name] for name in SOURCES if name != "vocals"]
    accompaniment = others[0]
    for extra in others[1:]:
        accompaniment = accompaniment + extra
    return [("vocals", vocals), ("accompaniment", accompaniment)]


def _write_stem(separator, workdir: Path, name: str, tensor) -> Stem:
    """把一条轨道写成 mp3。

    输出 mp3 而不是 wav：wav 一分钟约 10MB，两条轨道传回后端就是几十 MB，
    而这份数据要经过 base64 进 JSON —— 不压缩的话传输成本比推理还高。
    """
    from demucs.audio import save_audio

    path = workdir / f"{name}.mp3"
    save_audio(tensor, path, separator.samplerate, bitrate=MP3_BITRATE)
    return Stem(name=name, data=path.read_bytes())


def _duration(separator, separated: Dict[str, object]) -> float:
    """估算音频时长（用于回显，不影响处理结果）。"""
    try:
        vocals = separated["vocals"]
        return float(vocals.shape[-1]) / float(separator.samplerate)
    except Exception:  # pragma: no cover
        return 0.0
