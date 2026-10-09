"""侧车服务的公共配置读取（标准库实现，不引入 pydantic / python-dotenv）。

与 Node 端保持一致的三件事：
  1) 环境变量是唯一来源，默认值与 .env.example 对齐；
  2) 布尔值显式支持 true/false、1/0、yes/no、on/off —— 不用 bool("false")，
     它恒为 True，会让 LOG_MASK_SENSITIVE=false 静默失效；
  3) 骨架阶段允许 .env 缺失（回退默认值），实现阶段由调用方决定是否收紧。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPO_ROOT / ".env"

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}

_env_loaded = False


def load_env_file(path: Path = ENV_FILE) -> None:
    """把仓库根 .env 注入 os.environ；已存在的真实环境变量优先，不覆盖。"""
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_str(key: str, default: str = "") -> str:
    load_env_file()
    return os.environ.get(key) or default


def env_int(key: str, default: int) -> int:
    raw = env_str(key)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def env_bool(key: str, default: bool) -> bool:
    raw = env_str(key).lower()
    if raw in _TRUTHY:
        return True
    if raw in _FALSY:
        return False
    return default


def env_float(key: str, default: float) -> float:
    raw = env_str(key)
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


@dataclass(frozen=True)
class BaseSettings:
    """所有侧车服务的公共字段。"""

    service_name: str
    host: str
    port: int
    log_level: str
    version: str = "0.1.0"
    stage: str = "skeleton"

    @property
    def health_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/health"

    @property
    def max_body_bytes(self) -> int:
        """单次请求体上限。

        侧车的入参是**整段音视频二进制**（后端把 Buffer 直接 POST 过来），
        所以默认给到 512MB —— 压缩视频的工具本来就可能传几百 MB。
        上限存在的意义是**防止一个畸形 Content-Length 把服务 OOM 掉**，
        不是用来卡正常业务的；真卡住了请调 SIDECAR_MAX_BODY_MB，
        而不是去改 handler。
        """
        return env_int("SIDECAR_MAX_BODY_MB", 512) * 1024 * 1024


def base_settings(service_name: str, host_key: str, port_key: str, default_port: int) -> BaseSettings:
    """按「服务名 + 环境变量键」装配公共配置。"""
    return BaseSettings(
        service_name=service_name,
        host=env_str(host_key, "0.0.0.0"),
        port=env_int(port_key, default_port),
        log_level=env_str("LOG_LEVEL", "info").upper(),
        # 骨架阶段是 skeleton；能力落地后必须显式改掉这个值，
        # 否则"已经做完的服务"在监控与响应头里仍显示为未完成。
        stage=env_str("SERVICE_STAGE", "skeleton"),
    )
