"""multipart/form-data 解析（标准库实现，不引入 python-multipart）。

## 为什么侧车需要 multipart

侧车的接口天然是"**一个二进制文件 + 若干标量参数**"：
`cut` 要视频 + 起止秒，`convert` 要文件 + 目标格式，`matting` 要图片 + 模型名。

可选方案只有两个：
  - 标量塞 query、二进制当 body —— 但字幕文本（SRT）动辄几十 KB，
    塞进请求行会撞上 `http.server` 64KB 的 readline 上限；
  - 二进制 base64 进 JSON —— 体积凭空 +33%，而这里传的是几百 MB 的视频。

所以用 multipart：二进制不做编码、标量随文件一起走，且是 HTTP 上的通用约定，
以后换任何语言/框架实现调用方都不用改协议。
"""
from __future__ import annotations

from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
from typing import Dict, List

from .http import ServiceError

#: 单个文本字段的长度上限（SRT 字幕、提示词这类都在此范围内）
MAX_FIELD_CHARS = 512 * 1024


@dataclass(frozen=True)
class FilePart:
    """一个上传的文件分片。"""

    name: str           # 表单字段名，如 "file"
    filename: str       # 原始文件名，可为空
    content_type: str
    data: bytes

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass(frozen=True)
class Form:
    """解析结果：文本字段 + 文件分片。"""

    fields: Dict[str, str]
    files: List[FilePart]

    def get(self, name: str, default: str = "") -> str:
        return self.fields.get(name, default)

    def file(self, name: str = "file") -> FilePart:
        """取指定字段名的文件；缺失时报 400 而不是抛 KeyError。"""
        for part in self.files:
            if part.name == name:
                return part
        available = ", ".join(sorted(p.name for p in self.files)) or "(无)"
        raise ServiceError(f"缺少文件字段 `{name}`；本次上传的字段有：{available}",
                           code=40010)

    def require_int(self, name: str, *, default: int | None = None,
                    minimum: int | None = None, maximum: int | None = None) -> int:
        """读取整数字段，越界或非法一律 400。

        子进程入参一旦拿到脏数据（负数的时长、0 秒的起点）会产生
        **难以解释的 ffmpeg 报错**，所以在进入 CLI 之前就先卡住。
        """
        raw = self.fields.get(name)
        if raw is None or raw == "":
            if default is None:
                raise ServiceError(f"缺少必填参数 `{name}`", code=40011)
            value = default
        else:
            try:
                value = int(float(raw))
            except ValueError as e:
                raise ServiceError(f"参数 `{name}` 必须是数字，收到 {raw!r}", code=40011) from e

        if minimum is not None and value < minimum:
            raise ServiceError(f"参数 `{name}` 不能小于 {minimum}（收到 {value}）", code=40011)
        if maximum is not None and value > maximum:
            raise ServiceError(f"参数 `{name}` 不能大于 {maximum}（收到 {value}）", code=40011)
        return value

    def require_float(self, name: str, *, default: float | None = None,
                      minimum: float | None = None) -> float:
        raw = self.fields.get(name)
        if raw is None or raw == "":
            if default is None:
                raise ServiceError(f"缺少必填参数 `{name}`", code=40011)
            value = default
        else:
            try:
                value = float(raw)
            except ValueError as e:
                raise ServiceError(f"参数 `{name}` 必须是数字，收到 {raw!r}", code=40011) from e
        if minimum is not None and value < minimum:
            raise ServiceError(f"参数 `{name}` 不能小于 {minimum}（收到 {value}）", code=40011)
        return value


def parse_form(body: bytes, content_type: str) -> Form:
    """解析 multipart 请求体。"""
    if "multipart/form-data" not in content_type.lower():
        raise ServiceError(
            f"本端点要求 multipart/form-data，收到 {content_type or '(空)'}",
            code=40012,
            hint="请把二进制作为 `file` 字段上传，标量参数作为同表单的普通字段",
        )

    # 借用 email 模块解析：multipart 是 MIME 的子集，用标准库实现
    # 比手写边界扫描可靠得多（边界出现在文件内容里的场景不需要自己处理）。
    envelope = f"MIME-Version: 1.0\r\nContent-Type: {content_type}\r\n\r\n".encode("utf-8")
    try:
        message = BytesParser(policy=policy.default).parsebytes(envelope + body)
    except Exception as e:  # noqa: BLE001 —— 解析器可能抛多种内部异常，统一转 400
        raise ServiceError(f"multipart 解析失败：{e}", code=40012) from e

    if not message.is_multipart():
        raise ServiceError("multipart 解析失败：请求体不是多部分内容", code=40012)

    fields: Dict[str, str] = {}
    files: List[FilePart] = []

    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition") or ""
        if not name:
            continue
        filename = part.get_filename() or ""
        payload = part.get_payload(decode=True) or b""

        if filename:
            files.append(FilePart(
                name=name,
                filename=filename,
                content_type=part.get_content_type(),
                data=payload,
            ))
            continue

        charset = part.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        if len(text) > MAX_FIELD_CHARS:
            raise ServiceError(f"文本字段 `{name}` 超过 {MAX_FIELD_CHARS} 字符上限", code=40013)
        fields[name] = text

    return Form(fields=fields, files=files)
