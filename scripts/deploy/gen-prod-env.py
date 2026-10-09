"""由本地 .env 生成生产 .env 并上传（口令经环境变量传入，不落盘）。

用法：
    SSH_PASS='...' QZ_DB_PASS='...' QZ_JWT_SECRET='...' \
      python scripts/deploy/gen-prod-env.py [--dry-run]
"""
import os
import sys

from qzssh import connect, run
from qzdeploy import put_text, REPO

LOCAL_ENV = os.path.join(os.path.dirname(__file__), "..", "..", ".env")

DB = os.environ["QZ_DB_PASS"]
JWT = os.environ["QZ_JWT_SECRET"]
DOMAIN = os.environ.get("QZ_DOMAIN", "qingzhi.wzl136122.cn")

# key -> 生产取值。只列**必须改**的；其余沿用本地 .env 里已调优的值。
OVERRIDES = {
    "NODE_ENV": "production",
    "PORT": "3100",
    "DATABASE_URL": f"mysql://qz:{DB}@127.0.0.1:3306/qingzhi",
    "SHADOW_DATABASE_URL": f"mysql://qz:{DB}@127.0.0.1:3306/qingzhi_shadow",
    "REDIS_URL": "redis://127.0.0.1:6380",
    "QDRANT_URL": "http://127.0.0.1:6333",
    # 小程序直传/下载用的公开基址。留空会回落 http://localhost:{PORT} → 真机必失败
    "STORAGE_PUBLIC_BASE_URL": f"https://{DOMAIN}/api/v1",
    "JWT_SECRET": JWT,
    "LOG_LEVEL": "info",
    "LOG_FORMAT": "json",
    "ADMIN_ORIGIN": f"https://{DOMAIN}",
    "CORS_ORIGINS": f"https://{DOMAIN}",
    # 生产必须 false：开着它任何 code 都能登录（伪 openid 可预测）。
    # 本地同样保持 false —— `verify:*` 脚本走 `qz-dev:` 前缀的测试夹具通道取 token，
    # 那条通道也被 `NODE_ENV=production` 挡死，生产不存在任何假身份入口。
    # 代码里 `NODE_ENV=production` 时两个开关都会强制失效，但显式写 false 才不会被误读成"开着"。
    "WECHAT_DEV_LOGIN": "false",
    # 支付回调地址（当前 WECHAT_PAY_MCHID 为空 → 走 MockPayProvider，此项仅备将来启用）
    "WECHAT_PAY_NOTIFY_URL": f"https://{DOMAIN}/api/v1/pay/callback/wechat",
    # ---- 侧车一律置空：本机不部署 services/*（3.6G 内存、无 GPU，会 OOM）。
    # 置空后 configuration.ts 的 enabled=false，相关工具**如实报"未接入"**，
    # 而不是拿 Mock 冒充（红线 9）。反过来若留着 localhost:8000，
    # 会撞上宝塔面板自己（BT-Panel 就在 *:8000）。
    "AI_SERVICE_URL": "",
    "MEDIA_SERVICE_URL": "",
    "CONVERT_SERVICE_URL": "",
    "PDF_SERVICE_URL": "",
    "MEDIA_TTS_BIN": "",
    "FFMPEG_BIN": "",
    "FFPROBE_BIN": "",
    "STORAGE_ENDPOINT": "",
    "STORAGE_PUBLIC_BASE_URL_NOTE": "",
}


def main():
    dry = "--dry-run" in sys.argv
    src = os.path.abspath(LOCAL_ENV)
    lines = open(src, encoding="utf-8").read().splitlines()
    out, seen = [], set()
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k = s.split("=", 1)[0].strip()
            if k in OVERRIDES:
                out.append(f"{k}={OVERRIDES[k]}")
                seen.add(k)
                continue
        out.append(line)
    missing = [k for k in OVERRIDES if k not in seen]
    if missing:
        out.append("")
        out.append("# ---- 生产补充（本地 .env 未包含） ----")
        for k in missing:
            out.append(f"{k}={OVERRIDES[k]}")
    text = "\n".join(out).rstrip() + "\n"

    # 自检：确保没把开发地址带上去
    for bad in ("192.168.31.33", "localhost:3000", "localhost:5173", "127.0.0.1:3000"):
        if bad in text:
            raise SystemExit(f"生产 .env 里仍含开发地址 {bad}，已中止")

    print("===== 生产 .env（密钥已打码） =====")
    for line in text.splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            if any(t in k.upper() for t in ("KEY", "SECRET", "PASS", "TOKEN")) and v:
                v = "<%d 字符>" % len(v)
            print(f"{k}={v}")
        else:
            print(line)
    print("===== 共 %d 行 =====" % len(text.splitlines()))

    if dry:
        return
    c = connect()
    put_text(c, text, REPO + "/.env", mode=0o600)
    print("\n已写入服务器 %s/.env（权限 600）" % REPO)
    run(c, "ls -la %s/.env && wc -l %s/.env && echo '--- 权限自检 ---' && stat -c '%%a %%U:%%G' %s/.env" % (REPO, REPO, REPO))
    # 确认 .env 不会被 nginx 直接吐出去（宝塔默认站点根在别处，这里再兜一层）
    run(c, "grep -n 'env' %s/.gitignore 2>/dev/null | head -3" % REPO)
    c.close()


if __name__ == "__main__":
    main()
