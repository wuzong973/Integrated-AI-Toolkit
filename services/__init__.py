"""青智校园 · Python 侧车服务集合。

以仓库根为工作目录运行（npm 脚本已如此配置）：
    python -m services.ai      # OCR / ASR / 抠图 / 人声分离
    python -m services.media   # FFmpeg 音视频处理

分层：
    shared/   公共配置、结构化日志、HTTP 骨架（两个服务共用，勿复制粘贴）
    ai/       AI 能力服务
    media/    媒体处理服务
"""
