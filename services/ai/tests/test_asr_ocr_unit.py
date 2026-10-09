"""ASR / OCR 的**纯逻辑**单测：不加载真实模型、不需要第三方依赖。

需要真实依赖的端到端用例标 `@pytest.mark.slow`（pytest.ini 默认排除）。
fixture（1x1 PNG / 极短 WAV）全部在代码内生成 bytes，仓库里不放二进制文件。
"""
from __future__ import annotations

import io
import math
import struct
import wave

import pytest

from services.ai import asr, ocr
from services.shared.http import ServiceError

# ---------- fixture（代码内生成，不建二进制文件） ----------

#: 1x1 透明 PNG 的完整字节（合法图片，能被 PIL 解码）
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63fcffff3f0300050001ff9bdcf92d0000000049454e44ae426082"
)


def tiny_wav_bytes() -> bytes:
    """0.2 秒 440Hz 正弦波的合法 WAV（16bit 单声道 16kHz）。"""
    sample_rate = 16000
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / sample_rate)))
        for i in range(sample_rate // 5)
    )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(frames)
    return buf.getvalue()


# ---------- asr.resolve_model：白名单是服务端纪律 ----------


@pytest.mark.parametrize("model", ["tiny", "base", "small", "medium", "large-v3"])
def test_asr_whitelist_pass(model: str) -> None:
    assert asr.resolve_model(model) == model


def test_asr_distil_prefix_pass() -> None:
    # distil 系按前缀放行，大小写与空白不敏感
    assert asr.resolve_model("distil-large-v3") == "distil-large-v3"
    assert asr.resolve_model("  Distil-Medium.EN ") == "distil-medium.en"


@pytest.mark.parametrize("model", ["large", "gpt2", "huge", "whisper-small", ""])
def test_asr_whitelist_rejects_unknown(model: str) -> None:
    with pytest.raises(ServiceError) as err:
        asr.resolve_model(model)
    # 报错要带上"允许的有哪些"，而不是只说"不行"
    assert "tiny" in str(err.value.hint)


def test_asr_dependency_error_is_none_or_str() -> None:
    # 不假设本机装没装依赖，只锁"返回类型"契约：可用=None，不可用=给人看的一句话
    reason = asr.dependency_error()
    assert reason is None or isinstance(reason, str)


# ---------- asr.normalize_language：与 TS 侧语义对齐 ----------


@pytest.mark.parametrize("raw", ["auto", "AUTO", "", "  ", None])
def test_asr_language_auto_means_none(raw) -> None:
    assert asr.normalize_language(raw) is None


def test_asr_language_bcp47_truncated() -> None:
    assert asr.normalize_language("zh-CN") == "zh"
    assert asr.normalize_language("en_US") == "en"


def test_asr_language_plain_code_passes_through() -> None:
    assert asr.normalize_language("ja") == "ja"


# ---------- 依赖缺失时的降级：501 + 人话（monkeypatch，不碰真实依赖） ----------


def test_asr_transcribe_returns_501_when_dependency_missing(monkeypatch) -> None:
    monkeypatch.setattr(asr, "dependency_error", lambda: "未安装 faster-whisper（模拟）")
    with pytest.raises(ServiceError) as err:
        asr.transcribe(tiny_wav_bytes(), "a.wav", "tiny", "zh")
    assert err.value.status == 501
    assert err.value.code == 50341
    assert "pip install" in err.value.hint


def test_ocr_recognize_returns_501_when_dependency_missing(monkeypatch) -> None:
    monkeypatch.setattr(ocr, "dependency_error", lambda: "未安装 paddleocr（模拟）")
    with pytest.raises(ServiceError) as err:
        ocr.recognize(PNG_1X1)
    assert err.value.status == 501
    assert err.value.code == 50341


# ---------- ocr.map_result：paddle 原始结构 → 对外结构（纯函数） ----------


def test_ocr_map_result_maps_blocks_and_fulltext() -> None:
    raw = [
        [
            ([[10, 20], [110, 20], [110, 40], [10, 40]], ("你好", 0.98)),
            ([[10, 50], [110, 50], [110, 70], [10, 70]], ("world", 0.91)),
        ]
    ]
    out = ocr.map_result(raw)
    assert out.blocks == [
        {"text": "你好", "box": [[10.0, 20.0], [110.0, 20.0], [110.0, 40.0], [10.0, 40.0]]},
        {"text": "world", "box": [[10.0, 50.0], [110.0, 50.0], [110.0, 70.0], [10.0, 70.0]]},
    ]
    assert out.full_text == "你好\nworld"
    assert out.language == "chi_sim+eng"


def test_ocr_map_result_skips_blank_and_malformed_lines() -> None:
    raw = [
        [
            ([[0, 0], [1, 0], [1, 1], [0, 1]], ("  ", 0.9)),  # 空文本行
            "not-a-line",  # 畸形行
            ([[0, 0], [1, 0], [1, 1], [0, 1]], ("文字", 0.9)),
        ]
    ]
    out = ocr.map_result(raw)
    assert [b["text"] for b in out.blocks] == ["文字"]


def test_ocr_map_result_degrades_box_on_bad_coords() -> None:
    # 坐标畸形时退化为无坐标块，不编造位置
    raw = [[([[1], ["x"]], ("文字", 0.9))]]
    out = ocr.map_result(raw)
    assert out.blocks == [{"text": "文字"}]


def test_ocr_map_result_handles_none_and_empty() -> None:
    assert ocr.map_result(None).blocks == []
    assert ocr.map_result([]).full_text == ""


# ---------- handler 层：参数缺失走 400，不触发模型加载 ----------


def _request(body: bytes, content_type: str):
    from services.shared.http import Request

    return Request(method="POST", path="/ai/ocr", query={}, headers={"Content-Type": content_type}, body=body)


def _settings(whisper_model: str = "small"):
    """构造测试用的 AiSettings（基类字段无默认值，必须显式给）。"""
    from services.ai.settings import AiSettings

    return AiSettings(
        service_name="ai", host="127.0.0.1", port=8000, log_level="info",
        whisper_model=whisper_model,
    )


def _multipart(fields: dict) -> tuple:
    boundary = "----qzpytest"
    parts = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def test_handle_ocr_without_file_is_400() -> None:
    from services.ai.handlers import handle_ocr

    body, ctype = _multipart({"lang": "zh"})
    with pytest.raises(ServiceError) as err:
        handle_ocr(_settings(), _request(body, ctype))
    assert err.value.status == 400
    assert "缺少文件字段" in str(err.value)


def test_handle_asr_without_file_is_400() -> None:
    from services.ai.handlers import handle_asr

    body, ctype = _multipart({"language": "zh"})
    with pytest.raises(ServiceError) as err:
        handle_asr(_settings(), _request(body, ctype))
    assert err.value.status == 400


def test_handle_asr_with_bad_model_is_rejected() -> None:
    from services.ai.handlers import handle_asr

    boundary = "----qzpytest"
    file_part = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode() + tiny_wav_bytes() + f"\r\n--{boundary}--\r\n".encode()

    with pytest.raises(ServiceError):
        handle_asr(
            _settings(whisper_model="tiny"),
            _request(file_part, f"multipart/form-data; boundary={boundary}"),
        )


# ---------- 端到端（slow：需要真实依赖与模型权重） ----------


@pytest.mark.slow
def test_transcribe_with_real_model() -> None:
    if asr.dependency_error():
        pytest.skip("本机未安装 faster-whisper")
    result = asr.transcribe(tiny_wav_bytes(), "a.wav", "tiny", None)
    assert isinstance(result.text, str)
    assert isinstance(result.segments, list)


@pytest.mark.slow
def test_recognize_with_real_engine() -> None:
    if ocr.dependency_error():
        pytest.skip("本机未安装 paddleocr")
    out = ocr.recognize(PNG_1X1)
    assert isinstance(out.blocks, list)
    assert out.language == "chi_sim+eng"
