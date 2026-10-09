"""青智校园部署用 SSH 小工具（密码经环境变量传入，绝不落盘）。

用法：
    SSH_PASS='...' python scripts/deploy/qzssh.py "命令"
"""
import os
import sys
import time

import paramiko

HOST = os.environ.get("SSH_HOST", "101.35.46.146")
PORT = int(os.environ.get("SSH_PORT", "22"))
USER = os.environ.get("SSH_USER", "root")
PWD = os.environ["SSH_PASS"]


def connect(timeout=25):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    last = None
    for _ in range(3):
        try:
            c.connect(HOST, port=PORT, username=USER, password=PWD,
                      timeout=timeout, banner_timeout=40, auth_timeout=40,
                      look_for_keys=False, allow_agent=False)
            return c
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3)
    raise last


def run(c, cmd, timeout=600, quiet=False, use_sudo=False):
    """执行命令，返回 (rc, stdout, stderr)。"""
    real = f"sudo -S -p '' bash -lc {shell_quote(cmd)}" if use_sudo else f"bash -lc {shell_quote(cmd)}"
    stdin, stdout, stderr = c.exec_command(real, timeout=timeout, get_pty=False)
    if use_sudo:
        stdin.write(PWD + "\n")
        stdin.flush()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    if not quiet:
        if out:
            print(out, end="" if out.endswith("\n") else "\n")
        if err:
            print("[stderr] " + err, end="" if err.endswith("\n") else "\n")
    return rc, out, err


def shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def main():
    c = connect()
    cmd = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "echo connected; hostname; uptime"
    rc, _, _ = run(c, cmd)
    c.close()
    sys.exit(rc)


if __name__ == "__main__":
    main()
