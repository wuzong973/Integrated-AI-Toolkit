"""services/ai 的能力实现。

## 当前实现范围

| 端点 | 状态 | 原因 |
|---|---|---|
| `/ai/matting` | ✅ 已实现 | 决策已定：自部署 rembg + 白名单模型（文档 2.8.4） |
| `/ai/separation` | ✅ 已实现 | Demucs `htdemucs`（MIT，权重约 80MB）。CPU 可跑，有 GPU 自动加速（M4-02） |
| `/ai/asr` | ✅ 已实现 | faster-whisper 自托管（MIT，`WHISPER_MODEL` 白名单，CPU int8）。后端经 `ASR_PROVIDER=selfhost` 切入；默认仍走硅基流动 |
| `/ai/ocr` | ✅ 已实现 | PaddleOCR 自托管（Apache-2.0，中英文模型）。后端经 `OCR_PROVIDER=selfhost` 切入；默认仍走硅基流动 VLM |
| `/ai/inpaint` | ⏸ 501 | **决策未定**：自部署 vs 云服务，且需前置版权声明链路（文档 6.7.2） |
| `/ai/parse-document` | ⏸ 501 | **决策未定**：自部署（PyMuPDF/unstructured）vs 云服务 |
| `/ai/enhance` | ⏸ 501 | ⚠️ **已被后端绕过**：增强走 Sharp。保留在 ROUTES 里只是历史登记，不应再被调用 |

把"未实现"和"已实现"分开写在同一张表里，是为了让下一个接手的人**不必读代码**
就知道哪些是决策问题、哪些是工程量问题 —— 这两类活的排期方式完全不同。
"""
from __future__ import annotations

import base64
from typing import Dict, List, Tuple
from urllib.parse import quote

from services.shared.cli import workdir
from services.shared.http import Handler, Request, Response, ServiceError
from services.shared.multipart import parse_form

from . import asr, matting, ocr, separation
from .settings import AiSettings


def build_handlers(settings: AiSettings) -> Dict[Tuple[str, str], Handler]:
    """装配 handler 表。键必须与 `routes.ROUTES` 一致。"""
    return {
        ("POST", "/ai/matting"): lambda req: handle_matting(settings, req),
        ("POST", "/ai/separation"): lambda req: handle_separation(settings, req),
        ("POST", "/ai/asr"): lambda req: handle_asr(settings, req),
        ("POST", "/ai/ocr"): lambda req: handle_ocr(settings, req),
    }


def preflight(settings: AiSettings) -> List[str]:
    """启动前的配置体检，返回"该让运维看见"的问题列表。

    配置错了却不报错是最难查的一类：`REMBG_MODEL=birefnet-general`
    会让**每一个**抠图请求都失败，但服务本身健康、端口通、日志干净。
    所以启动时就说出来。
    """
    problems: List[str] = []

    try:
        matting.resolve_model(settings.rembg_model)
    except ServiceError as e:
        problems.append(f"REMBG_MODEL 配置非法：{e}")

    reason = matting.dependency_error()
    if reason:
        problems.append(f"抠图依赖未安装，/ai/matting 将返回 501：{reason}")

    try:
        separation.resolve_model(settings.vocal_separation_engine)
    except ServiceError as e:
        problems.append(f"VOCAL_SEPARATION_ENGINE 配置非法：{e}")

    sep_reason = separation.dependency_error()
    if sep_reason:
        problems.append(f"人声分离依赖未安装，/ai/separation 将返回 501：{sep_reason}")

    try:
        asr.resolve_model(settings.whisper_model)
    except ServiceError as e:
        problems.append(f"WHISPER_MODEL 配置非法：{e}")

    asr_reason = asr.dependency_error()
    if asr_reason:
        problems.append(f"ASR 依赖未安装，/ai/asr 将返回 501：{asr_reason}")

    ocr_reason = ocr.dependency_error()
    if ocr_reason:
        problems.append(f"OCR 依赖未安装，/ai/ocr 将返回 501：{ocr_reason}")

    return problems


def handle_matting(settings: AiSettings, req: Request) -> Response:
    """抠图：返回透明背景 PNG。"""
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()

    # 允许调用方按次指定模型，但仍受白名单约束 ——
    # 白名单是**服务端**的纪律，不能让一个请求参数把它绕过去。
    model = matting.resolve_model(form.get("model") or settings.rembg_model)

    result = matting.remove_background(part.data, model)

    return Response(
        raw=result.data,
        content_type="image/png",
        headers={
            "X-Output-Filename": quote("output_nobg.png"),
            "X-Matting-Model": result.model,
            "X-Output-Width": str(result.width),
            "X-Output-Height": str(result.height),
            "X-Input-Bytes": str(part.size),
        },
    )


def handle_separation(settings: AiSettings, req: Request) -> Response:
    """人声 / 伴奏分离：一次返回多条轨道。

    ## 为什么产物是 base64 JSON，而不是 zip 或 multipart

    产物天然是"多个文件"，而一个 HTTP 响应体只能装一个。三条路：

      · **zip** —— 后端（Node）没有内置解压，要么引依赖、要么手写 zip 解析器；
      · **multipart** —— 标准库拼得出来，但解析方同样得自己写；
      · **base64 JSON** —— 后端 `Buffer.from(x, 'base64')` 一行搞定。

    音频在侧车里已压成 192kbps mp3，base64 膨胀 33% 后仍在"内网传输"的合理范围，
    所以选了实现风险最低的那条 —— 这条链路上"解不开包"的代价远大于"多传几 MB"。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    model = separation.resolve_model(form.get("model") or settings.vocal_separation_engine)
    stems = form.get("stems", "2").strip() or "2"

    with workdir("qz-ai-sep-") as tmp:
        result = separation.separate(part.data, part.filename or "input.mp3", model, stems, tmp)

    return Response(
        payload={
            "model": result.model,
            "durationSec": round(result.duration_sec, 2),
            "stems": [
                {
                    "name": s.name,
                    "contentType": s.content_type,
                    "sizeBytes": len(s.data),
                    "dataBase64": base64.b64encode(s.data).decode("ascii"),
                }
                for s in result.stems
            ],
        },
        headers={"X-Separation-Model": result.model, "X-Stem-Count": str(len(result.stems))},
    )


def handle_asr(settings: AiSettings, req: Request) -> Response:
    """语音转文字：faster-whisper，返回整段文本 + 逐句时间轴。

    `model` 允许按次指定但仍受白名单约束（与抠图同一纪律）；
    `language` 缺省或 `auto` 时不传，由模型自动检测。
    """
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()
    model = asr.resolve_model(form.get("model") or settings.whisper_model)

    result = asr.transcribe(part.data, part.filename or "audio", model, form.get("language") or None)

    return Response(
        payload={
            "text": result.text,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text} for s in result.segments
            ],
        },
        headers={
            "X-Asr-Model": result.model,
            "X-Detected-Language": result.language,
        },
    )


def handle_ocr(settings: AiSettings, req: Request) -> Response:
    """文字识别：PaddleOCR 中英文模型，逐行返回文本块（含 4 点坐标）。"""
    form = parse_form(req.body, req.header("Content-Type"))
    part = form.file()

    result = ocr.recognize(part.data)

    return Response(
        payload={
            "blocks": result.blocks,
            "fullText": result.full_text,
            "language": result.language,
        },
        headers={"X-Ocr-Engine": "paddleocr"},
    )


def health_config(settings: AiSettings) -> dict:
    """`/health` 回显：一眼看出四个模型能力能不能用、用的是哪个模型。"""
    reason = matting.dependency_error()
    sep_reason = separation.dependency_error()
    asr_reason = asr.dependency_error()
    ocr_reason = ocr.dependency_error()
    return {
        **settings.health_config,
        "mattingReady": reason is None,
        "mattingDependencyError": reason or "",
        "mattingWhitelist": sorted(matting.WHITELIST),
        "separationReady": sep_reason is None,
        "separationDependencyError": sep_reason or "",
        "separationWhitelist": sorted(separation.WHITELIST),
        "asrReady": asr_reason is None,
        "asrDependencyError": asr_reason or "",
        "asrWhitelist": sorted(asr.WHITELIST) + [asr.DISTIL_PREFIX + "*"],
        "ocrReady": ocr_reason is None,
        "ocrDependencyError": ocr_reason or "",
    }
