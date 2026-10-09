"""勘察脚本（只读，不做任何改动）。

跑法：SSH_PASS='...' python scripts/deploy/probe.py
"""
import sys

from qzssh import connect, run

CMDS = [
    ("系统", "cat /etc/os-release | head -3; uname -m; uptime"),
    ("资源", "free -h; df -h / | tail -2"),
    ("运行时", "node -v; npm -v; python3 -V; nginx -v 2>&1; git --version; pm2 -v 2>/dev/null"),
    ("PM2 清单", "pm2 list 2>/dev/null || echo 'no pm2'"),
    ("PM2 详情", "pm2 jlist 2>/dev/null | head -c 4000 || true"),
    ("监听端口", "ss -lntp 2>/dev/null | sort -k4 || netstat -lntp"),
    ("宝塔", "ps aux | grep -E 'BT-Panel|nginx: master' | grep -v grep"),
    ("nginx 生效配置清单", "nginx -T 2>/dev/null | grep -c 'configuration file'; nginx -T 2>/dev/null | grep 'configuration file' | head -40"),
    ("vhost 目录", "ls -la /www/server/panel/vhost/nginx/ 2>/dev/null"),
    ("证书目录", "ls -la /www/server/panel/vhost/cert/ 2>/dev/null"),
    ("wwwroot", "ls -la /www/wwwroot/ 2>/dev/null"),
    ("MySQL 版本", "mysql --version 2>/dev/null; /www/server/mysql/bin/mysql --version 2>/dev/null; ps aux|grep mysqld|grep -v grep|head -3"),
    ("MySQL 端口", "ss -lntp 2>/dev/null | grep -E '3306|3307|3308'"),
    ("Redis", "ss -lntp 2>/dev/null | grep 6379; redis-cli -v 2>/dev/null; ls /www/server/redis 2>/dev/null | head"),
    ("Docker", "docker ps -a --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}' 2>/dev/null | head -20; docker --version 2>/dev/null"),
    ("firewalld", "firewall-cmd --state 2>/dev/null; firewall-cmd --list-ports 2>/dev/null"),
    ("磁盘大目录", "du -sh /www/wwwroot/* 2>/dev/null | sort -h"),
    ("内存占用TOP", "ps aux --sort=-%mem | head -12"),
]


def main():
    c = connect()
    print("=== 连接成功 ===")
    for title, cmd in CMDS:
        print(f"\n########## {title} ##########")
        try:
            run(c, cmd, timeout=120)
        except Exception as e:  # noqa: BLE001
            print(f"[失败] {e}")
    c.close()


if __name__ == "__main__":
    sys.exit(main())
