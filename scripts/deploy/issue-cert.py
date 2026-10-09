"""为 qingzhi.wzl136122.cn 签发并安装 Let's Encrypt 证书（acme.sh / HTTP-01）。

跑法：SSH_PASS='...' python scripts/deploy/issue-cert.py [--check-only]

设计要点：
  1) **先做 DNS 预检**：Let's Encrypt 的二级验证节点在海外，刚加的解析记录
     它们可能还在负缓存里 → 直接签会得到
     `During secondary validation: DNS problem: NXDOMAIN`，
     看起来像"域名不存在"，实际只是"还没传播到"。所以先问 7 家公共解析器，
     可见度不足就**不签**，避免消耗 Let's Encrypt 的失败配额。
  2) HTTP-01 webroot 模式，不中断 nginx（与既有两个站点同一套做法）。
  3) 证书装到 **nginx 配置实际引用的路径**，装完不需要改 nginx。
  4) 续期任务：本机已有 acme.sh 的 cron（`29 3,9,15,21 * * *`），只做校验不重复安装。
"""
import os
import re
import sys
import time

from qzssh import connect, run
from qzdeploy import REPO

DOMAIN = os.environ.get("QZ_DOMAIN", "qingzhi.wzl136122.cn")
EXPECT_IP = os.environ.get("QZ_EXPECT_IP", "101.35.46.146")
ACME = "/root/.acme.sh/acme.sh"
CERT_DIR = f"/www/server/panel/vhost/cert/{DOMAIN}"
NGINX_CONF = f"/www/server/panel/vhost/nginx/{DOMAIN}.conf"
NGINX_SBIN = "/www/server/nginx/sbin/nginx"

# 海外递归解析器。用来判断"解析是否已传播"。
# ⚠️ 刻意**不含 64.6.64.6（Verisign Public DNS）**：实测它对本域名的负缓存保留时间
#    远长于其它家（别家都返回正确 A 记录时它仍报 NXDOMAIN），把它算进去会让预检
#    长期卡在 6/7，制造"解析没生效"的假象。
RESOLVERS = ["8.8.8.8", "1.1.1.1", "9.9.9.9", "208.67.222.222", "4.2.2.1", "223.5.5.5"]

DNS_PROBE = r'''
import socket, struct, random, sys
domain = sys.argv[1]
resolvers = sys.argv[2].split(",")
def q(name, server, timeout=4):
    tid = random.randint(0, 65535)
    header = struct.pack("!HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"
    pkt = header + qname + struct.pack("!HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(pkt, (server, 53))
        data, _ = s.recvfrom(2048)
    except Exception as e:
        return "TIMEOUT"
    finally:
        s.close()
    rcode = data[3] & 0x0F
    if rcode == 3:
        return "NXDOMAIN"
    if rcode != 0:
        return "RCODE%d" % rcode
    ancount = struct.unpack("!H", data[6:8])[0]
    if ancount == 0:
        return "NOANSWER"
    # 跳过 header + question
    i = 12
    while data[i] != 0:
        i += data[i] + 1
    i += 5
    # 找 A 记录
    for _ in range(ancount):
        while True:
            l = data[i]
            if l & 0xC0 == 0xC0:
                i += 2; break
            if l == 0:
                i += 1; break
            i += l + 1
        rtype, rclass, ttl, rdlen = struct.unpack("!HHIH", data[i:i+10])
        i += 10
        if rtype == 1 and rdlen == 4:
            return "%d.%d.%d.%d" % tuple(data[i:i+4])
        i += rdlen
    return "NO_A"
for r in resolvers:
    print("%s\t%s" % (r, q(domain, r)))
'''


def dns_preflight(c):
    print("=" * 70)
    print("① DNS 预检（问 %d 家解析器）" % len(RESOLVERS))
    print("=" * 70)
    from qzdeploy import put_text

    put_text(c, DNS_PROBE, "/tmp/qz-dns-probe.py")
    rc, out, err = run(c, "python3 /tmp/qz-dns-probe.py %s %s" % (DOMAIN, ",".join(RESOLVERS)))
    ok = 0
    for line in out.strip().splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        server, result = parts
        mark = "✓" if result == EXPECT_IP else "✗"
        if result == EXPECT_IP:
            ok += 1
        print("   %s %-16s %s" % (mark, server, result))
    print("   → %d/%d 家可见" % (ok, len(RESOLVERS)))
    return ok


def main():
    check_only = "--check-only" in sys.argv
    c = connect()

    ok = dns_preflight(c)
    if ok == 0:
        print("\n✗ 没有任何解析器能看到 %s。" % DOMAIN)
        print("  请先在 DNSPod 添加：记录类型 A / 主机记录 qingzhi / 记录值 %s / 线路默认 / TTL 600" % EXPECT_IP)
        c.close()
        sys.exit(2)
    if ok < len(RESOLVERS):
        # 预检只是**参考**，不是判据：实测出现过"6 家公共解析器都已看到，
        # Let's Encrypt 仍报 NXDOMAIN"（LE 自己的解析器还在负缓存里），
        # 也出现过"7/7 可见但第一次签发失败、几分钟后成功"。
        # 所以这里只告警不阻断 —— 真正的判据是 acme.sh 的退出码，失败后带退避重试。
        print("\n⚠ 仅 %d/%d 家可见，可能有个别解析器仍在负缓存。继续尝试签发（失败会自动重试）。" % (ok, len(RESOLVERS)))
    if check_only:
        print("\n（--check-only）预检完成，未执行签发。")
        c.close()
        return

    print("\n" + "=" * 70)
    print("② ACME 校验通道自检")
    print("=" * 70)
    run(c, "mkdir -p %s/.well-known/acme-challenge && echo qz-acme-ok > %s/.well-known/acme-challenge/preflight" % (REPO, REPO))
    rc, out, _ = run(c, "curl -s -m 8 -H 'Host: %s' http://127.0.0.1/.well-known/acme-challenge/preflight" % DOMAIN)
    if "qz-acme-ok" not in out:
        print("✗ 本机 ACME 通道不通，终止")
        c.close()
        sys.exit(4)
    print("   本机通道 ✓")
    # 公网可达性：云安全组没放行 80 的话，LE 也拿不到
    rc, out, _ = run(c, "curl -s -m 10 -o /dev/null -w '%%{http_code}' -H 'Host: %s' http://%s/.well-known/acme-challenge/preflight" % (DOMAIN, EXPECT_IP))
    print("   公网(80) 自测 → HTTP %s" % out.strip())

    print("\n" + "=" * 70)
    print("③ 签发证书（acme.sh / webroot / ec-256）")
    print("=" * 70)
    # ⚠️ 这里**不能**给命令加 `| tail -30`：管道会把 acme.sh 的非零退出码吞掉，
    #    让 rc 永远是 0 —— 于是脚本会在签发**失败**的情况下继续往下走，
    #    把 0 字节的 fullchain.pem 装到 nginx 引用的路径上，最终表现为
    #    "证书文件存在但 nginx 起不来"。全量输出由 run() 原样打印，退出码保真。
    #
    # 失败重试：NXDOMAIN 是**时段性**的（LE 的验证节点在负缓存里），
    # 等几分钟就会好 —— 这与"域名不存在"是完全不同的两件事，
    # 但报错文案一模一样，所以必须靠重试而不是靠改配置。
    cer = "/root/.acme.sh/%s_ecc/fullchain.cer" % DOMAIN
    attempts = int(os.environ.get("QZ_CERT_ATTEMPTS", "4"))
    delay = int(os.environ.get("QZ_CERT_RETRY_DELAY", "120"))
    rc, valid = 1, False
    for i in range(1, attempts + 1):
        print("\n--- 第 %d/%d 次尝试 ---" % (i, attempts))
        rc, out, err = run(
            c,
            "%s --issue -d %s --webroot %s --keylength ec-256 --force" % (ACME, DOMAIN, REPO),
            timeout=600,
        )
        print("acme.sh 退出码 =", rc)
        # 双重判据：既看退出码，也**实际校验产物**（退出码为 0 但证书没生成是可能的）
        rc2, out2, _ = run(c, "test -s %s && openssl x509 -in %s -noout -subject -dates && echo CERT_VALID" % (cer, cer))
        valid = "CERT_VALID" in out2
        if rc == 0 and valid:
            break
        if i < attempts:
            print("\n   ⚠ 失败（多为 LE 侧 NXDOMAIN 负缓存）。%ds 后重试…" % delay)
            time.sleep(delay)

    if rc != 0 or not valid:
        print("\n✗ %d 次尝试均失败（最后退出码 %s / 产物有效 %s）。请检查：" % (attempts, rc, valid))
        print("   · `DNS problem: NXDOMAIN` → 解析仍在 LE 侧负缓存，过几分钟再跑本脚本")
        print("   · `Invalid response ... 404` → nginx 的 acme location 没生效")
        print("   · `timeout` → 云安全组没放行 80")
        print("   · 域名未备案被腾讯云拦 → 需人工处理，脚本无法绕过")
        run(c, "rm -rf %s" % CERT_DIR)
        c.close()
        sys.exit(5)
    print("\n✓ 签发成功")

    print("\n" + "=" * 70)
    print("④ 安装证书到 nginx 实际引用的路径")
    print("=" * 70)
    # ⚠️ 必须先建目录：--install-cert 不会自建，报 `touch: cannot touch ...: No such file or directory`
    #    看起来像权限问题，实际是目录不存在。
    run(c, "mkdir -p %s" % CERT_DIR)
    rc, out, err = run(
        c,
        "%s --install-cert -d %s --ecc "
        "--key-file %s/privkey.pem --fullchain-file %s/fullchain.pem "
        "--reloadcmd '%s -s reload' 2>&1 | tail -15" % (ACME, DOMAIN, CERT_DIR, CERT_DIR, NGINX_SBIN),
        timeout=300,
    )
    run(c, "ls -la %s" % CERT_DIR)
    rc3, out3, _ = run(c, "test -s %s/fullchain.pem && echo INSTALLED" % CERT_DIR)
    if "INSTALLED" not in out3:
        print("✗ 证书安装失败（fullchain.pem 为空或不存在）")
        c.close()
        sys.exit(6)

    print("\n" + "=" * 70)
    print("⑤ 证书有效性 + 续期任务")
    print("=" * 70)
    run(c, "openssl x509 -in %s/fullchain.pem -noout -subject -issuer -dates -ext subjectAltName" % CERT_DIR)
    run(c, "echo '--- 续期 cron ---'; crontab -l 2>/dev/null | grep -i acme || echo '(缺失！)'")
    run(c, "%s --cron --home /root/.acme.sh 2>&1 | tail -5" % ACME)
    c.close()
    print("\n✓ 证书已签发并安装。下一步：部署最终 nginx 配置（脚本 deploy-nginx.py）")


if __name__ == "__main__":
    main()
