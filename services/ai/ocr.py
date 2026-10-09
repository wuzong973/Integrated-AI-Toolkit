"""OCR 文字识别（PaddleOCR，M1-11）—— 自托管实现。

## 为什么是 PaddleOCR

云端方案（`VlmOcrProvider`，硅基流动 VLM）偶发"HTTP 200 + 一长串重复字符"的
假成功，且按次计费。自托管 PaddleOCR（Apache-2.0）在本机 CPU 上单张秒级、
结果确定性可复现，`lang='ch'` 一个模型同时覆盖中文与英文 —— 校园场景够用。

## 依赖缺失时怎么办

与抠图 / 分离 / ASR 同一个纪律：未安装时**返回 501 与安装指引**（红线 10）。

## 为什么 box 要逐点转 float

PaddleOCR 返回的坐标是 numpy 标量（`np.float32`），`json.dumps` 无法序列化 ——
不转的话这个错误要等到响应序列化那一刻才爆，排查时离案发现场已经很远。
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional

from services.shared.http import ServiceError

logger = logging.getLogger("qz-ai")

#: PaddleOCR 的语言包。`ch` 是"中英文混合"模型，与返回值 `chi_sim+eng` 的语义对齐
#: （项目场景固定中英，不做多语言配置 —— 配置与返回值各说各话比少一个配置更糟）。
PADDLE_LANG = "ch"

#: 结果里对外声明的语言（与 `VlmOcrProvider` 的输出对齐，下游无感切换）
RESULT_LANGUAGE = "chi_sim+eng"

_engine_cache: Dict[str, object] = {}


@dataclass(frozen=True)
class OcrLine:
    """一行识别结果"""

    text: str
    box: Optional[List[List[float]]]


@dataclass(frozen=True)
class OcrOutput:
    blocks: List[dict]
    full_text: str
    language: str


def dependency_error() -> Optional[str]:
    """依赖是否就绪；返回 `None` 表示可用，否则返回**给人看**的原因。"""
    try:
        import paddleocr  # noqa: F401
    except Exception as e:  # pragma: no cover - 取决于运行环境
        return f"未安装 paddleocr / paddlepaddle（{e}）"
    return None


def recognize(data: bytes) -> OcrOutput:
    """识别一张图片里的文字，返回逐行文本块（含 4 点坐标）与拼好的全文。"""
    reason = dependency_error()
    if reason:
        raise ServiceError.unavailable(
            f"OCR 不可用：{reason}",
            hint="安装：pip install -r services/ai/requirements.txt"
                 "（CPU 版 paddlepaddle，安装源见该文件内的注释）",
        )

    image = _to_ndarray(data)
    with _engine_lock_guard():
        engine = _get_engine()
        logger.info("开始 OCR（%d 字节）", len(data))
        raw = engine.ocr(image, cls=True)

    return map_result(raw)


def _to_ndarray(data: bytes):
    """把上传字节解码成 PaddleOCR 吃的 ndarray；解不开就 400，不让堆栈裸奔。"""
    try:
        import numpy as np
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            return np.asarray(image.convert("RGB"))
    except ServiceError:
        raise
    except Exception as e:  # noqa: BLE001 —— PIL/cv2 的异常类型不稳定，统一转 422
        raise ServiceError(f"图片无法解析：{e}", code=42204) from e


def map_result(raw) -> OcrOutput:
    """把 PaddleOCR 的原始返回映射成对外结构（纯函数，单测不加载模型）。

    输入形状：`[[box, (text, confidence)], ...]`（外层 list 对应多页，本项目单图单页）。
    """
    blocks: List[dict] = []
    texts: List[str] = []
    for page in raw or []:
        for line in page or []:
            parsed = _parse_line(line)
            if parsed is None:
                continue
            block: Dict[str, object] = {"text": parsed.text}
            if parsed.box is not None:
                block["box"] = parsed.box
            blocks.append(block)
            texts.append(parsed.text)

    return OcrOutput(blocks=blocks, full_text="\n".join(texts), language=RESULT_LANGUAGE)


def _parse_line(line) -> Optional[OcrLine]:
    """解析一行；畸形行跳过而不是让整次识别 500。"""
    if not isinstance(line, (list, tuple)) or len(line) < 2:
        return None
    box_raw, text_raw = line[0], line[1]
    if not isinstance(text_raw, (list, tuple)) or not text_raw:
        return None
    text = str(text_raw[0]).strip()
    if not text:
        return None

    box: Optional[List[List[float]]] = None
    if isinstance(box_raw, (list, tuple)) and len(box_raw) >= 4:
        try:
            box = [[float(p[0]), float(p[1])] for p in box_raw[:4]]
        except (TypeError, ValueError, IndexError):
            box = None  # 坐标畸形时退化为无坐标块，不编造位置
    return OcrLine(text=text, box=box)


def _engine_lock_guard():
    """占位上下文管理器：留出与 separation 相同的"串行推理"扩展点。

    PaddleOCR 的 CPU 推理本身受 GIL 与内部线程池约束，当前并发压力下
    不需要显式锁；真要加时改这一个函数即可，调用方语义不变。
    """
    from contextlib import nullcontext

    return nullcontext()


def _get_engine():
    """按语言包缓存 PaddleOCR 引擎（首次调用要下载模型，秒级耗时不能每次重建）。"""
    cached = _engine_cache.get(PADDLE_LANG)
    if cached is None:
        from paddleocr import PaddleOCR

        logger.info("加载 OCR 引擎（lang=%s，首次调用需下载模型）", PADDLE_LANG)
        cached = PaddleOCR(use_angle_cls=True, lang=PADDLE_LANG, show_log=False)
        _engine_cache[PADDLE_LANG] = cached
    return cached
