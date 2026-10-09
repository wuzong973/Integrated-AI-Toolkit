"""语音转文字（faster-whisper，M4-03）—— 自托管实现。

## 为什么选 faster-whisper

`SiliconflowAsrProvider` 的 `/audio/transcriptions` 端点**不提供时间戳**（实测），
需要逐句时间轴（字幕烧录等）只能自部署。faster-whisper 是 CTranslate2 后端的
Whisper 重实现（MIT 许可），CPU 上比 openai/whisper 快数倍，`int8` 量化后
`small` 模型约 460MB 内存即可跑。

## 依赖缺失时怎么办

与抠图 / 分离同一个纪律：未安装时**返回 501 与安装指引**（红线 10），
绝不返回空文本假装成功。

## 为什么整段串行 + 模块级缓存

与 `separation.py` 同样的理由：模型加载以秒计（首次还要从 HuggingFace 拉权重），
每次请求重建会把"转写 30 秒"变成"转写 30 秒 + 加载 10 秒"；CPU 推理会吃满核心，
并发跑只会互相拖慢 —— 所以"加载 + 推理"整段持锁串行。
"""
from __future__ import annotations

import io
import logging
import threading
from dataclasses import dataclass
from typing import Dict, List, Optional

from services.shared.http import ServiceError

logger = logging.getLogger("qz-ai")

#: 精确匹配的模型白名单。收录标准： faster-whisper 官方发布 + 权重许可允许商用
#: （Whisper 模型权重是 MIT，distil-whisper 同样 MIT，见 OPEN_SOURCE_LICENSES.md）。
WHITELIST = frozenset({"tiny", "base", "small", "medium", "large-v3"})

#: `distil` 系模型按前缀放行（distil-large-v3 / distil-medium.en / distil-small.en）。
#: 它们是 Whisper 的蒸馏版，同为 MIT 许可 —— 数量不多但都在涨，前缀比逐个列举好维护。
DISTIL_PREFIX = "distil-"

#: 输入体积上限（与 separation 同一量纲）。10MB 约等于 10 分钟 128kbps 的 mp3，
#: CPU 转写比实时慢，超过这个时长的音频该走云端或先裁剪。
MAX_INPUT_BYTES = 10 * 1024 * 1024

_lock = threading.RLock()
_models: Dict[str, object] = {}


@dataclass(frozen=True)
class Segment:
    """一句转写结果"""

    start: float
    end: float
    text: str


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    segments: List[Segment]
    model: str
    language: str


def resolve_model(raw: str) -> str:
    """把配置/请求里的模型名收敛到白名单内的具体模型（fail-fast，不静默回退）。"""
    key = (raw or "").strip().lower()
    if key in WHITELIST or key.startswith(DISTIL_PREFIX):
        return key

    raise ServiceError(
        f"不支持的语音转文字模型 {raw!r}",
        code=40011,
        hint=f"可选：{', '.join(sorted(WHITELIST))}，或 {DISTIL_PREFIX}* 系蒸馏模型",
    )


def normalize_language(raw: Optional[str]) -> Optional[str]:
    """把请求里的语言参数收敛成 faster-whisper 认的取值。

    返回 `None` 表示**不传语言参数**，由模型自动检测 —— 与 TS 侧
    `normalizeAsrLanguage` 的语义一致（小程序「自动识别」选项的值是 `auto`）。
    """
    key = (raw or "").strip().lower()
    if not key or key == "auto":
        return None
    # zh-CN / en_US → zh / en（faster-whisper 只认 ISO 639-1 两字母码）
    return key.replace("_", "-").split("-")[0]


def dependency_error() -> Optional[str]:
    """依赖是否就绪；返回 `None` 表示可用，否则返回**给人看**的原因。

    用"试导入"而不是查 `pip list`（与 separation 相同的纪律）。
    """
    try:
        import faster_whisper  # noqa: F401
    except Exception as e:  # pragma: no cover - 取决于运行环境
        return f"未安装 faster-whisper（{e}）"
    return None


def transcribe(data: bytes, filename: str, model: str, language: Optional[str]) -> TranscriptionResult:
    """跑一次转写，返回整段文本与逐句时间轴。"""
    reason = dependency_error()
    if reason:
        raise ServiceError.unavailable(
            f"语音转文字不可用：{reason}",
            hint="安装：pip install -r services/ai/requirements.txt",
        )
    resolved = resolve_model(model)
    if len(data) > MAX_INPUT_BYTES:
        raise ServiceError(
            f"音频过大（{len(data) // 1024 // 1024}MB），上限 {MAX_INPUT_BYTES // 1024 // 1024}MB",
            code=40011,
            hint="可先用「音频裁剪」截取片段，或压缩成更低的码率",
        )

    lang = normalize_language(language)
    with _lock:
        whisper = _get_model(resolved)
        logger.info(
            "开始转写：%s（%d 字节，模型 %s，语言 %s）",
            filename or "(未命名)", len(data), resolved, lang or "自动检测",
        )
        # faster-whisper 返回的是**惰性生成器**：不立即消费的话，
        # 真正的推理会推迟到锁外的迭代时刻 —— 串行纪律就破了。必须在这里转成 list。
        segments_iter, info = whisper.transcribe(io.BytesIO(data), language=lang)
        segments = [Segment(s.start, s.end, s.text.strip()) for s in segments_iter]

    text = "".join(s.text for s in segments).strip()
    return TranscriptionResult(
        text=text, segments=segments, model=resolved, language=info.language or ""
    )


def _get_model(model: str):
    """按模型名缓存 WhisperModel（加载权重需要几秒，重建会把耗时翻倍）。"""
    with _lock:
        cached = _models.get(model)
        if cached is None:
            from faster_whisper import WhisperModel

            logger.info("加载 ASR 模型 %s（首次调用需从 HuggingFace 下载权重）", model)
            cached = WhisperModel(model, device="cpu", compute_type="int8")
            _models[model] = cached
        return cached
