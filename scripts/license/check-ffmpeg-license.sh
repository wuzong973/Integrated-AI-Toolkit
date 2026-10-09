#!/usr/bin/env bash
# FFmpeg 许可断言（任务清单 M0-22，文档 2.7）
#
# 背景：FFmpeg 默认预编译二进制多为 GPL 构建（含 libx264 等 GPL-only 组件），
#       一旦启用会要求整个项目以 GPL 开源。本项目必须使用 LGPL 构建。
#
# ## 判定口径（2026-09-19 修正）
#
# FFmpeg 的许可语义是：**不加 `--enable-gpl` 就是 LGPL**，而不是必须显式写 `--enable-lgpl`。
# 原先只认显式的 `--enable-lgpl`，于是把 BtbN 的 `win64-lgpl` 构建
#（配置里没有 `--enable-gpl`，且 `--disable-libx264/--disable-libx265`）
# 误判成"无法确认" —— 合规的构建反而要人工放行。
#
# 现在：**出现 `--enable-gpl` 才是失败**；未出现即视为 LGPL，并打印证据供核对。
#
# 用法：bash scripts/license/check-ffmpeg-license.sh
# CI 中若检测到 GPL 构建则构建失败。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../../.env"

# 优先用 .env 里的 FFMPEG_BIN（本机未把 ffmpeg 装进 PATH），否则按 PATH 查找
if [ -z "${FFMPEG_BIN:-}" ] && [ -f "$ENV_FILE" ]; then
  FFMPEG_BIN="$(grep -E '^FFMPEG_BIN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
fi
FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

if ! command -v "$FFMPEG_BIN" >/dev/null 2>&1 && [ ! -x "$FFMPEG_BIN" ]; then
  echo "⚠️  未检测到 ffmpeg（查找路径：$FFMPEG_BIN），跳过许可检查"
  echo "   若项目需要 FFmpeg，请安装 LGPL 构建并在 .env 里设 FFMPEG_BIN。"
  exit 0
fi

echo "---- 使用 ffmpeg：$FFMPEG_BIN"
"$FFMPEG_BIN" -version 2>&1 | head -1 || true

BUILD_CONF="$("$FFMPEG_BIN" -buildconf 2>&1 || true)"

echo "---- 许可相关构建配置 ----"
echo "$BUILD_CONF" | grep -oE "\-\-enable-(gpl|lgpl|version3)|\-\-disable-lib(x264|x265|xvid|xavs2)" | sort -u || echo "（未匹配到许可相关配置项）"

if echo "$BUILD_CONF" | grep -q -- "--enable-gpl"; then
  echo ""
  echo "❌ FFmpeg 为 GPL 构建，违反本项目许可策略，构建中止。"
  echo "   处置：改用 LGPL 构建（不含 --enable-gpl），并通过子进程调用 CLI。"
  echo "   参考：设计文档 2.7.2 本项目的强制要求。"
  exit 1
fi

echo ""
echo "✅ 未启用 GPL 组件 —— FFmpeg 的默认许可即 LGPL，通过许可检查。"
echo "   （如上线前需更强的证据，请核对上面的 --disable-lib* 清单是否覆盖了所有 GPL-only 组件。）"
exit 0
