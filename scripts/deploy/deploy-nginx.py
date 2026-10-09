"""部署 qingzhi.wzl136122.cn 的最终 nginx 配置（HTTPS + API + WS）。

跑法：SSH_PASS='...' python scripts/deploy/deploy-nginx.py

安全设计：
  1) **先记录**既有站点的配置 md5 与后端进程 etime —— 部署后比对，用数据证明"零干扰"，
     而不是嘴上说"我没动它"。
  2) `nginx -t` 不通过 → **自动回滚**并中止。
     这个文件写错会让整台机器的 nginx 重新加载失败，另外两个项目一起挂。
  3) 一律 `reload`（平滑）不用 `restart`（会断连接）。
"""
import os
import sys

from qzssh import connect, run
from qzdeploy import put_file, put_text, read_remote, exists

DOMAIN = os.environ.get("QZ_DOMAIN", "qingzhi.wzl136122.cn")
REPO = "/www/wwwroot/qingzhi.wzl136122.cn"
VHOST = "/www/server/panel/vhost/nginx"
CONF = f"{VHOST}/{DOMAIN}.conf"
LOCAL_CONF = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"{DOMAIN}.nginx.conf")
BACKUP = f"/root/qz-nginx-{DOMAIN}.conf.bak"

# 需要证明"没被改动"的既有资产
OTHER_CONFS = [
    f"{VHOST}/wzl136122.cn.conf",
    f"{VHOST}/lovechoice.conf",
    f"{VHOST}/lovechoice-domain.conf",
]


def md5(c, paths):
    rc, out, _ = run(c, "for f in %s; do md5sum $f 2>/dev/null; done" % " ".join(paths), quiet=True)
    return dict(
        line.split()[::-1] for line in out.strip().splitlines() if len(line.split()) == 2
    )


def main():
    c = connect()

    print("=" * 70)
    print("① 部署前基线（用于证明零干扰）")
    print("=" * 70)
    before = md5(c, OTHER_CONFS)
    for k, v in before.items():
        print("   %s  %s" % (v[:12], k))
    rc, out, _ = run(c, "ps -o pid,etime,cmd -p $(pgrep -f 'my-api|lovechoice' | head -2) --no-headers 2>/dev/null; "
                        "pm2 list 2>/dev/null | grep -E 'my-api|lovechoice-api'", quiet=True)
    print("   既有进程：")
    print("     " + out.strip().replace("\n", "\n     "))

    print("\n" + "=" * 70)
    print("② 备份当前配置并上传新配置")
    print("=" * 70)
    if exists(c, CONF):
        run(c, "cp -a %s %s && echo '已备份 → %s'" % (CONF, BACKUP, BACKUP))
    text = open(LOCAL_CONF, encoding="utf-8").read()
    put_text(c, text, CONF, mode=0o644)
    run(c, "wc -l %s" % CONF)

    print("\n" + "=" * 70)
    print("③ nginx -t（不通过则自动回滚）")
    print("=" * 70)
    rc, out, err = run(c, "nginx -t 2>&1")
    if rc != 0:
        print("✗ 配置校验失败，正在回滚…")
        if exists(c, BACKUP):
            run(c, "cp -a %s %s" % (BACKUP, CONF))
        else:
            run(c, "rm -f %s" % CONF)
        run(c, "nginx -t 2>&1 && nginx -s reload && echo '已回滚并 reload'")
        c.close()
        sys.exit(1)
    print("✓ 校验通过")

    print("\n" + "=" * 70)
    print("④ reload")
    print("=" * 70)
    run(c, "nginx -s reload && echo RELOADED")
    import time

    time.sleep(3)  # 等平滑切换完成，避免打到旧 worker 造成假失败

    print("\n" + "=" * 70)
    print("⑤ 验证")
    print("=" * 70)
    print("--- HTTP → HTTPS 跳转 ---")
    run(c, "curl -s -o /dev/null -w 'http  %s/ -> %%{http_code} -> %%{redirect_url}\\n' -H 'Host: %s' http://127.0.0.1/" % (DOMAIN, DOMAIN))
    print("--- HTTPS（本机，带 SNI） ---")
    run(c, "curl -s -o /dev/null -w 'https /          -> %%{http_code}\\n' --resolve %s:443:127.0.0.1 https://%s/; "
           "curl -s -o /dev/null -w 'https /api/v1/health -> %%{http_code}\\n' --resolve %s:443:127.0.0.1 https://%s/api/v1/health" % (DOMAIN, DOMAIN, DOMAIN, DOMAIN))
    print("--- 管理后台首页 ---")
    run(c, "curl -s --resolve %s:443:127.0.0.1 https://%s/ | head -c 400; echo" % (DOMAIN, DOMAIN))
    print("--- 证书链（本机校验） ---")
    run(c, "echo | openssl s_client -connect 127.0.0.1:443 -servername %s 2>/dev/null | "
           "openssl x509 -noout -subject -issuer -dates 2>/dev/null" % DOMAIN)
    print("--- 敏感文件必须 404/403 ---")
    # ⚠️ nginx 的 `%{http_code}` 在 Python 的 %-格式化里必须写成 `%%{`，否则 ValueError
    run(c, "for p in /.env /apps/api/.env /node_modules/x /.git/config; do "
           "curl -s -o /dev/null -w \"$p -> %%{http_code}\\n\" --resolve %s:443:127.0.0.1 https://%s$p; done" % (DOMAIN, DOMAIN))
    print("--- 既有两站点回归 ---")
    run(c, "for h in wzl136122.cn www.wzl136122.cn lovestory.wzl136122.cn %s; do "
           "curl -s -o /dev/null -w \"$h -> %%{http_code}\\n\" -H \"Host: $h\" http://127.0.0.1/; done" % DOMAIN)

    print("\n" + "=" * 70)
    print("⑥ 部署后比对（零干扰证据）")
    print("=" * 70)
    after = md5(c, OTHER_CONFS)
    same = True
    for k in before:
        mark = "一致 ✓" if before[k] == after.get(k) else "**已变化 ✗**"
        if before[k] != after.get(k):
            same = False
        print("   %-42s %s" % (k.split("/")[-1], mark))
    rc, out, _ = run(c, "pm2 list 2>/dev/null | grep -E 'my-api|lovechoice-api'", quiet=True)
    print("   既有进程仍在：")
    print("     " + out.strip().replace("\n", "\n     "))
    print("\n   → 既有站点配置%s" % ("完全未被改动 ✓" if same else "**被改动了，请检查 ✗**"))
    c.close()


if __name__ == "__main__":
    main()
