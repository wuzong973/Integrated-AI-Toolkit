"""青智校园部署操作库：SSH 执行 + SFTP 上传 + MySQL 执行。

密码一律走环境变量 SSH_PASS；本文件不含任何口令。
"""
import os
import posixpath
import stat as statmod

from qzssh import connect, run  # noqa: F401  (re-export)

MYSQL = "/www/server/mysql/bin/mysql"
REPO = "/www/wwwroot/qingzhi.wzl136122.cn"
MYSQL_ROOT_PWD = os.environ.get("MYSQL_ROOT_PWD", "")


def sftp(c):
    return c.open_sftp()


def put_text(c, text, remote, mode=0o600):
    """把字符串写到远端文件（先写临时文件再原子改名）。"""
    s = sftp(c)
    d = posixpath.dirname(remote)
    _mkdirs(s, d)
    tmp = remote + ".qztmp"
    with s.open(tmp, "w") as f:
        f.write(text)
    s.chmod(tmp, mode)
    # 原子替换
    s.posix_rename(tmp, remote)
    s.close()


def put_file(c, local, remote, mode=0o644):
    s = sftp(c)
    _mkdirs(s, posixpath.dirname(remote))
    tmp = remote + ".qztmp"
    s.put(local, tmp)
    s.chmod(tmp, mode)
    s.posix_rename(tmp, remote)
    s.close()


def _mkdirs(s, path):
    if not path or path == "/":
        return
    parts = path.strip("/").split("/")
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            s.stat(cur)
        except IOError:
            s.mkdir(cur)


def mysql_exec(c, sql, db=None, root=True, user=None, pwd=None, timeout=600, quiet=False):
    """执行一段 SQL（写到远端临时文件后喂给 mysql，避免 shell 转义问题）。"""
    remote = "/tmp/qz-sql-%d.sql" % os.getpid()
    put_text(c, sql, remote)
    if root:
        cred = "-uroot -p'%s'" % MYSQL_ROOT_PWD
    else:
        cred = "-u%s -p'%s'" % (user, pwd)
    dbpart = (" " + db) if db else ""
    cmd = (
        "%s %s%s --default-character-set=utf8mb4 --batch < %s; rc=$?; rm -f %s; exit $rc"
        % (MYSQL, cred, dbpart, remote, remote)
    )
    return run(c, cmd, timeout=timeout, quiet=quiet)


def read_remote(c, remote):
    s = sftp(c)
    with s.open(remote, "r") as f:
        data = f.read().decode("utf-8", "replace")
    s.close()
    return data


def exists(c, remote):
    s = sftp(c)
    try:
        s.stat(remote)
        return True
    except IOError:
        return False
    finally:
        s.close()


def size(c, remote):
    s = sftp(c)
    try:
        return s.stat(remote).st_size
    except IOError:
        return -1
    finally:
        s.close()
