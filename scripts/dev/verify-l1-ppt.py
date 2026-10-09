"""验收线验证：一句话生成 PPT → 真实 .pptx 落盘 → 可下载。

覆盖 M1-01 目录 / M1-02 调用 / M1-03 作业 / M0-12 文件 / M1-06 计费 的完整链路，
是文档 3.5 里 P0 主链路 **L1** 的回归脚本。

用法：先起 API（见 docs/dev/ENV.md），再
    node scripts/dev/run-python.mjs scripts/dev/verify-l1-ppt.py [baseUrl]

⚠️ 自 M1-06 起工具调用会**消耗积分**（generate_ppt 单价 5）。本脚本每次用
**新的登录 code**（末尾带时间戳）拿到一个新用户（注册赠 20 分），
因此可以反复运行而不会因为上一轮把积分花光而失败。
若改成固定 code，跑几次就会遇到 403 / 40321「积分不足」。
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3100/api/v1'
TOKEN = None

# 测试夹具 code 前缀，须与后端 `DEV_LOGIN_CODE_PREFIX` 一致（漂移守卫见
# apps/api/src/modules/auth/__tests__/wechat.service.spec.ts）。
# 真实微信 code 不含冒号，所以带这个前缀的 code 只可能是脚本造的，
# 后端仅在非生产环境放行（详见 scripts/dev/dev-login.mjs）。
DEV_LOGIN_PREFIX = 'qz-dev:'

ok = lambda c: '✅' if c else '❌'


def call(method, path, body=None, auth=True, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if auth and TOKEN:
        req.add_header('Authorization', 'Bearer ' + TOKEN)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def fetch_absolute(url):
    with urllib.request.urlopen(urllib.request.Request(url), timeout=60) as r:
        return r.status, r.read()


st, res = call('POST', '/auth/login', {'code': f'{DEV_LOGIN_PREFIX}l1-probe-{int(time.time() * 1000)}'}, auth=False)
TOKEN = res['data']['accessToken']
print(f'登录 HTTP {st}\n')

print('=' * 78)
print('① 提交「一句话生成 PPT」')
print('=' * 78)
st, res = call(
    'POST',
    '/tools/generate_ppt/invoke',
    {
        'params': {
            'topic': '校园二手交易平台商业计划书',
            'purpose': 'contest',
            'pages': 12,
            'style': 'business',
            'extra': '突出可持续盈利模式',
        },
        'async': True,
    },
)
job_id = res.get('data', {}).get('jobId')
print(f"   HTTP {st}  jobId={job_id}  status={res.get('data', {}).get('status')} {ok(st == 201 and job_id)}")

print()
print('=' * 78)
print('② 轮询作业直到终态')
print('=' * 78)
job = None
for i in range(40):
    st, res = call('GET', f'/jobs/{job_id}')
    job = res['data']
    print(f"   [{(i + 1) * 0.5:4.1f}s] status={job['status']:<10} progress={job['progress']:>3}%  {job.get('stage') or ''}")
    if job['status'] in ('succeeded', 'failed', 'canceled', 'rejected'):
        break
    time.sleep(0.5)

print(f"\n   最终状态: {job['status']} {ok(job['status'] == 'succeeded')}")
if job.get('error'):
    print(f"   error: {job['error']}")

print()
print('=' * 78)
print('③ 产出物落库')
print('=' * 78)
outs = job.get('outputFiles') or []
print(f"   outputFiles={outs} {ok(len(outs) == 1)}")
if outs:
    st, res = call('GET', f'/files/{outs[0]}')
    f = res['data']
    print(f"   文件: {f['name']}  type={f['type']}  size={f['size']} 字节  scene={f['scene']}")

print()
print('=' * 78)
print('④ 下载并校验是真实可打开的 .pptx')
print('=' * 78)
is_zip = has_ct = has_ppt = False
if outs:
    st, res = call('GET', f'/files/{outs[0]}/download')
    url = res['data']['url']
    print(f"   签名下载地址: {url[:76]}…")
    st2, blob = fetch_absolute(url)
    is_zip = blob[:2] == b'PK'
    has_ct = b'[Content_Types].xml' in blob
    has_ppt = b'ppt/' in blob
    print(f"   HTTP {st2}  下载 {len(blob)} 字节")
    print(f"   魔数 = {blob[:2]!r}            {ok(is_zip)}")
    print(f"   含 [Content_Types].xml  {ok(has_ct)}")
    print(f"   含 ppt/ 目录条目        {ok(has_ppt)}")
    print(f"   → {'是真实的 Office Open XML 演示文稿' if (is_zip and has_ct and has_ppt) else '❌ 不是有效 pptx'}")

print()
print('=' * 78)
print('⑤ 文件列表与用量')
print('=' * 78)
st, res = call('GET', '/files')
print(f"   GET /files -> {len(res['data'])} 个文件 {ok(len(res['data']) >= 1)}")
st, res = call('GET', '/files/storage')
u = res['data']
print(f"   用量: {u['usedBytes']} 字节 / {u['fileCount']} 个文件 {ok(u['fileCount'] >= 1)}")

print()
print('=' * 78)
print('⑥ 幂等（同一 Idempotency-Key 不重复生成）')
print('=' * 78)
# key 每次运行都不同：断言才能落在"同一用户内幂等"这件事上，
# 而不是因为命中了上一轮遗留的记录而"因为错误的原因"通过
KEY = f'e2e-idem-ppt-{int(time.time() * 1000)}'
a = call('POST', '/tools/generate_ppt/invoke', {'params': {'topic': '幂等验证'}, 'async': True},
         headers={'Idempotency-Key': KEY})[1]
b = call('POST', '/tools/generate_ppt/invoke', {'params': {'topic': '幂等验证'}, 'async': True},
         headers={'Idempotency-Key': KEY})[1]
same = a['data']['jobId'] == b['data']['jobId']
print(f"   两次 jobId: {a['data']['jobId'][:8]}… / {b['data']['jobId'][:8]}…")
print(f"   相同 {ok(same)}   第二次 reused={b['data'].get('reused')} {ok(b['data'].get('reused') is True)}")

print()
print('=' * 78)
print('⑦ 幂等键的作用范围是「单个用户」（回归：跨用户串号）')
print('=' * 78)
# 修前的缺陷：幂等键全局唯一且回读不带 userId → 用户 B 用同一个 key 会拿到 A 的作业，
# 自己的提交被静默丢弃（不执行、不扣费），随后访问该 jobId 还会 403。
# 修后：库层面是 @@unique([userId, idempotencyKey])，两个用户各自成作业。
st2, res2 = call('POST', '/auth/login', {'code': f'{DEV_LOGIN_PREFIX}l1-probe-b-{int(time.time() * 1000)}'}, auth=False)
TOKEN_B = res2['data']['accessToken']
SHARED = f'shared-key-{int(time.time() * 1000)}'

ua = call('POST', '/tools/generate_ppt/invoke', {'params': {'topic': '跨用户键'}, 'async': True},
          headers={'Idempotency-Key': SHARED})[1]
ub = call('POST', '/tools/generate_ppt/invoke', {'params': {'topic': '跨用户键'}, 'async': True},
          auth=False, headers={'Idempotency-Key': SHARED,
                               'Authorization': 'Bearer ' + TOKEN_B})[1]
job_a = ua['data']['jobId']
job_b = ub['data']['jobId']
distinct = job_a != job_b
print(f"   用户A jobId {job_a[:8]}…  用户B jobId {job_b[:8]}…")
print(f"   两者不同 {ok(distinct)}")
print(f"   用户B 未被误判为重复 reused={ub['data'].get('reused')} {ok(ub['data'].get('reused') is not True)}")

print()
print('=' * 78)
allok = (
    job['status'] == 'succeeded' and is_zip and has_ct and has_ppt and same and distinct
)
print('🎉 验收线通过：一句话 → 真实 .pptx → 可下载（含跨用户幂等）' if allok else '❌ 验收线未通过')
print('=' * 78)
