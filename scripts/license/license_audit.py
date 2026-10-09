#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
依赖 License 自动核查（任务清单 M0-22，文档 2.10.2）

用途：批量核查依赖仓库的 Star / License / 归档状态 / 最后提交时间，
      输出可直接粘贴进 docs/compliance/OPEN_SOURCE_LICENSES.md 的台账草稿。

用法：
    python scripts/license/license_audit.py                    # 核查内置清单
    python scripts/license/license_audit.py --json out.json    # 输出 JSON
    GITHUB_TOKEN=xxx python scripts/license/license_audit.py   # 提高配额（60/h -> 5000/h）

⚠️ 限流须知（文档 2.10.3）：
    未认证 Core API 配额仅 60 次/小时，核查 60+ 仓库会被耗尽，生产化使用务必配置 token。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# 需要核查的依赖清单（与 docs/compliance/OPEN_SOURCE_LICENSES.md 对应）
DEPENDENCIES = [
    # --- A 级：可直接使用 ---
    "gitbrent/PptxGenJS",
    "presenton/presenton",
    "youzan/vant-weapp",
    "Tencent/tdesign-miniprogram",
    "nestjs/nest",
    "fastapi/fastapi",
    "SYSTRAN/faster-whisper",
    "PaddlePaddle/PaddleOCR",
    "danielgatis/rembg",
    "facebookresearch/demucs",
    "deezer/spleeter",
    # 说明：pgvector 已于数据库迁移至 MySQL 后移除（MySQL 无内置向量类型）。
    #       M4-06 知识库 RAG 因此必须外接向量库，Qdrant 由"扩容期可选项"升级为必需项。
    "qdrant/qdrant",
    "apache/apisix",
    "mermaid-js/mermaid",
    # --- B 级：必须隔离部署 ---
    "C4illin/ConvertX",
    "pipipi-pikachu/PPTist",
    "jgm/pandoc",
    "LibreOffice/core",
    "Stirling-Tools/Stirling-PDF",
    "langgenius/dify",
    # --- C 级：仅参考，不引入代码 ---
    "CorentinTh/it-tools",
    "SmileSnail5470/PowerTools",
    "langflow-ai/langflow",
    "FoundationAgents/MetaGPT",
    "langchain-ai/langgraph",
    # --- 高风险 ---
    "n8n-io/n8n",
    "Anjok07/ultimatevocalremovergui",
    # --- 基础组件（需按构建选择许可） ---
    "FFmpeg/FFmpeg",
    "opendatalab/MinerU",
]

# 需要人工复核的 License 标识（GitHub 自动识别不出，不等于没有许可证）
NEEDS_MANUAL_REVIEW = {"NOASSERTION", None, ""}
# 高风险传染性许可
RISKY_LICENSES = {"GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0"}


def fetch_repo(full_name: str, token: str | None) -> dict:
    url = f"https://api.github.com/repos/{full_name}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "qingzhi-campus-license-audit",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.load(resp)


def classify(license_id: str | None) -> str:
    if license_id in NEEDS_MANUAL_REVIEW:
        return "需人工核查（GitHub 无法自动识别）"
    if license_id in RISKY_LICENSES:
        return "高风险：必须独立服务 + 只调 API（不链接/不修改/不分发）"
    if license_id in {"MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "MPL-2.0"}:
        return "A 级：可直接使用（需保留版权声明）"
    return f"未知许可（{license_id}）：视为不可用"


def audit(full_name: str, token: str | None) -> dict:
    try:
        d = fetch_repo(full_name, token)
    except urllib.error.HTTPError as e:
        return {"repo": full_name, "error": f"HTTP {e.code}", "note": "核查失败，请稍后重试"}
    except Exception as e:  # noqa: BLE001
        return {"repo": full_name, "error": str(e), "note": "核查失败"}

    lic = (d.get("license") or {}).get("spdx_id")
    return {
        "repo": d.get("full_name", full_name),
        "stars": d.get("stargazers_count"),
        "license": lic,
        "archived": d.get("archived"),
        "pushedAt": (d.get("pushed_at") or "")[:10],
        "language": d.get("language"),
        "verdict": classify(lic),
        "needsManualReview": lic in NEEDS_MANUAL_REVIEW,
        "risky": lic in RISKY_LICENSES,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="依赖 License 核查（M0-22）")
    parser.add_argument("--json", help="把结果写入指定 JSON 文件")
    parser.add_argument("--sleep", type=float, default=2.0, help="每次请求间隔秒数（尊重限流）")
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("提示：未设置 GITHUB_TOKEN，配额仅 60 次/小时，仓库较多时会被限流。\n", file=sys.stderr)

    results = []
    for i, repo in enumerate(DEPENDENCIES, 1):
        r = audit(repo, token)
        results.append(r)
        flag = "⚠️ " if r.get("needsManualReview") or r.get("risky") else "✅"
        print(f"{flag} [{i:>2}/{len(DEPENDENCIES)}] {r['repo']:<42} "
              f"{str(r.get('license')):<14} {r.get('stars', '-'):>7}★  {r.get('pushedAt', '-')}")
        if r.get("archived"):
            print(f"      ⚠️ 该仓库已归档（archived=true），长期维护需评估替代方案")
        if i < len(DEPENDENCIES):
            time.sleep(args.sleep)

    risky = [r for r in results if r.get("risky")]
    manual = [r for r in results if r.get("needsManualReview")]
    archived = [r for r in results if r.get("archived")]

    print("\n" + "=" * 78)
    print(f"合计核查 {len(results)} 个依赖")
    print(f"  高风险许可（需隔离）: {len(risky)}")
    print(f"  需人工核查 License  : {len(manual)}")
    print(f"  已归档（停更）      : {len(archived)}")
    print("=" * 78)
    print("\n红线提醒（文档 2.12.3）：")
    print("  1) License 不明确的一律不作为生产依赖")
    print("  2) 标注 Research Only / Non-commercial 的模型权重一律不用")
    print("  3) AGPL/GPL 组件一律独立服务 + 只调 API")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "results": results},
                      f, ensure_ascii=False, indent=2)
        print(f"\n已写入 {args.json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
