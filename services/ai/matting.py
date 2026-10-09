"""抠图（rembg）—— 模型白名单在这里是**代码级强制**的。

## 为什么要这么写

设计文档 2.8.4 要求：抠图只能用许可允许商用的模型。
`rembg` 支持一堆模型，其中 isnet / birefnet 系的多为 Research Only / Non-commercial ——
一旦被换上去，**代码照跑、效果更好、没有任何报错**，只是许可结论不成立了。

这种风险不可能靠"文档里写一句"来防，所以：
  1. `WHITELIST` 是唯一允许的集合，来源是 `docs/compliance/OPEN_SOURCE_LICENSES.md`；
  2. `REMBG_MODEL` 超白名单时**直接拒绝服务**（fail-fast），而不是回退到 u2net ——
     静默回退会让运维以为"我换的模型生效了"，实际跑的是另一个，排查时对不上号；
  3. 白名单外的模型在 `resolve_model()` 里被拦截的原因会明确回给调用方，
     包含"被拦的是哪个模型、允许的有哪些"。

## 依赖缺失时怎么办

`rembg` 是可选依赖（onnxruntime + 模型权重，几百 MB），没装时**绝不假装成功**：
返回 501 + 明确的安装指引，让"这个能力在这台机器上不可用"一眼可辨（红线 10）。
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Optional

from services.shared.http import ServiceError

logger = logging.getLogger("qz-ai")

#: 允许的抠图模型。**改这个集合前必须先改
#: `docs/compliance/OPEN_SOURCE_LICENSES.md` 并确认权重许可能商用。**
WHITELIST = frozenset({"u2net"})

#: 一度被考虑、但**不可**使用的模型（写在这里是为了让后来者少查一次资料）。
BLOCKED = {
    "isnet-general-use": "权重许可为 Research Only",
    "birefnet-general": "权重许可非商用",
    "birefnet-general-lite": "权重许可非商用",
}


@dataclass(frozen=True)
class MattingResult:
    data: bytes
    model: str
    width: int
    height: int


def resolve_model(configured: str) -> str:
    """校验配置的模型名，返回生效值。超白名单一律 fail-fast。"""
    model = (configured or "").strip() or "u2net"
    if model in WHITELIST:
        return model

    reason = BLOCKED.get(model)
    detail = f"（{reason}）" if reason else ""
    raise ServiceError(
        f"抠图模型 {model!r} 不在白名单内{detail}",
        status=501,
        code=50341,
        hint=f"允许的模型：{', '.join(sorted(WHITELIST))}；"
             f"变更白名单须同步 docs/compliance/OPEN_SOURCE_LICENSES.md",
    )


def dependency_error() -> Optional[str]:
    """返回 rembg 不可用的原因；可用则返回 None。"""
    try:
        import rembg  # noqa: F401
    except ImportError as e:
        return str(e)
    return None


def ready() -> bool:
    return dependency_error() is None


def remove_background(data: bytes, model: str) -> MattingResult:
    """执行抠图，返回带 alpha 通道的 PNG。"""
    resolve_model(model)  # 先卡白名单，再决定要不要装依赖

    reason = dependency_error()
    if reason:
        raise ServiceError.unavailable(
            "抠图依赖未安装，本机无法执行抠图",
            hint="pip install -r services/ai/requirements.txt"
                 "（首次调用会下载 u2net 权重，约 176MB）",
        )

    from PIL import Image  # 随 rembg 一起安装
    from rembg import new_session, remove

    try:
        session = _session(model)
        output = remove(data, session=session)
    except Exception as e:  # noqa: BLE001 —— rembg 的异常类型不稳定，统一转成 422
        raise ServiceError(f"抠图失败：{e}", code=42204) from e

    with Image.open(io.BytesIO(output)) as image:
        width, height = image.size

    return MattingResult(data=output, model=model, width=width, height=height)


_CACHED_SESSION: dict = {}


def _session(model: str):
    """按模型缓存 session。

    每次请求都 `new_session()` 会重新加载一遍 ONNX 权重（u2net 约 176MB），
    单次耗时以秒计 —— 对"用户等着出图"的场景不可接受。
    """
    if model not in _CACHED_SESSION:
        from rembg import new_session

        logger.info("加载抠图模型 %s（首次调用需下载权重）", model)
        _CACHED_SESSION[model] = new_session(model)
    return _CACHED_SESSION[model]
