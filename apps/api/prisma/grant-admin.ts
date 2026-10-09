/**
 * 把「一个已存在的微信用户」提升为管理员（运维命令，不是业务接口）
 *
 * ## 用法
 *
 * ```bash
 * npm run db:grant-admin                                   # 不带参数 = 最近登录的那个用户，试运行
 * npm run db:grant-admin -- --openid=oXXXXXXXXXXXX          # 按微信 openid 指定
 * npm run db:grant-admin -- --user-id=xxxxxxxx-xxxx-...     # 按 user.id 指定
 * npm run db:grant-admin -- oXXXXXXXXXXXX                    # 裸参数（先按 openid 找，再按 id 找）
 * npm run db:grant-admin -- --openid=oXXXX --yes            # 确认无误后真正写库
 * npm run db:grant-admin -- --openid=oXXXX --role=operator --yes
 * npm run db:grant-admin -- --openid=oXXXX --reset-password --yes   # 需先设 ADMIN_INITIAL_PASSWORD
 * ```
 *
 * 默认**试运行**：只打印将要改动什么、改在谁身上，不写一行数据。
 * 必须显式加 `--yes` 才落库 —— 这个命令给人的是管理员权限，
 * "手滑提错了人"比"多敲一次命令"的代价高得多，所以默认值必须偏保守。
 *
 * ## 为什么要一个脚本，而不是调现成接口
 *
 * 系统里**故意**没有「把微信用户绑到后台账号」的接口：
 *   · `admin-account.service.ts` 建管理员时是**另建一个 User**（openid 为
 *     `admin:<username>`），它服务的是"网页后台用账号密码登录"这条路，
 *     跟某个真实微信身份无关；
 *   · `admin-user.service.ts` 只动 `user_role`，明确拒绝桥接两张表。
 * 于是"让某个真实微信用户能进后台"没有任何入口，只能由运维直接落库。
 *
 * ## 为什么必须写两张表（本脚本存在的核心理由）
 *
 * 1. `user_role`：小程序的管理员入口来自 `auth.service.ts` 的 `buildMe()`，
 *    它只认 `user_role` 里 `role='admin'` 且 `status='active'` 的行。
 * 2. `admin_account`：`/admin/*` 由 `admin-permission.guard.ts` 把守，它
 *    **每次请求**都按 `userId` 回查 `admin_account`，查不到就抛 40313。
 *    JWT 里的 `isAdmin` 并不够 —— 只写第 1 张表的话，界面进得去、接口全 403。
 *
 * 少写一张表**不会有任何报错**，属于典型的"看着做完了、实际不能用"，
 * 所以这里两处一起写，并且都做成幂等。
 *
 * ## username 推导规则（与既有两个命名空间刻意隔离）
 *
 * ```
 * wx_<openid 净化后>     净化 = 只保留 [A-Za-z0-9_-]，其余字符换成 '_'，大小写不变
 * 长度 > 40 时         → wx_<sha256(openid) 的前 37 位十六进制>
 * ```
 *
 * 为什么不用昵称、也不用 openid 原文：username 是后台登录名，要能一眼看出
 * "这是脚本绑定的微信用户"，而不是运营在后台手建的账号；昵称会被人改
 * （改了以后登录名跟着变 = 不可重复执行），openid 原文最长 64 字符放不下。
 * `wx_` 前缀与 seed 的 `admin`、后台新建账号的 `admin:<username>` 都不撞车；
 * 写之前仍然会查 `admin_account.username` 与 `User.openid` 两处唯一约束，
 * 撞了就停下来问人 —— 静默加后缀会让同一个用户下次跑出另一个 username。
 *
 * ## 为什么不放在 `scripts/db/`（AGENTS.md 的常规落点）
 *
 * 它要 `import` 本模块的 `password.service`（复用 scrypt 实现，见 hashPassword）
 * 和 `@prisma/client`（类型来自 `apps/api/prisma/schema.prisma` 的生成结果），
 * 放在 `prisma/` 下，`tsx prisma/grant-admin.ts` 的相对路径才与 `db:seed` 一致。
 */
import { createHash, randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { ADMIN_ROLES, AdminRole, isAdminRole, Role } from '@qz/core';

/** 只用于"建新行"；改已存在的行时**不**套用这个默认值（原因见 planAccount） */
const DEFAULT_ADMIN_ROLE: AdminRole = AdminRole.SuperAdmin;
const USERNAME_PREFIX = 'wx_';
const USERNAME_MAX = 40;
/** 后台新建管理员时占用的 openid 前缀，那是假微信身份，不该再被提升 */
const CONSOLE_OPENID_PREFIX = 'admin:';

const USER_SELECT = { id: true, openid: true, nickname: true, status: true, lastLogin: true };

/** 读已绑定的后台账号时只要这三列：passwordHash 绝不该被本脚本读出来 */
const BOUND_SELECT = { username: true, adminRole: true, displayName: true };

/** 目标微信用户（字段与 `USER_SELECT` 一一对应） */
interface TargetUser {
  id: string;
  openid: string;
  nickname: string | null;
  status: string;
  lastLogin: Date | null;
}

/** 目标用户当前已绑定的后台账号（查不到 = 还没绑过） */
type BoundAccount = { username: string; adminRole: string; displayName: string };

/** `admin_account` 更新分支的字段（刻意不含 username，见 planAccount） */
type AdminAccountUpdate = { status: string; adminRole?: AdminRole; passwordHash?: string };

type TargetKind = 'openid' | 'id' | 'either';

interface Options {
  target?: { kind: TargetKind; value: string };
  username?: string;
  role?: string;
  yes: boolean;
  resetPassword: boolean;
}

/** 执行计划：username / displayName 在"已绑定"时取库里现值，未绑定时取推导值 */
interface AccountPlan {
  userId: string;
  username: string;
  displayName: string;
  /** undefined = 不动现有角色 */
  adminRole?: AdminRole;
  bound?: BoundAccount;
  /** 库里登录名与推导值不一致时必须说出来，不能"打印 wx_a、实际是 admin" */
  usernameNote?: string;
  /** create = 新绑；update = 只保证 active；password = 连 passwordHash 一起重写 */
  mode: 'create' | 'update' | 'password';
}

/** 用法错误：只报"该怎么办"，不甩堆栈 */
class UsageError extends Error {}

/**
 * 输出统一走一个封装（而不是散落 console.log）。
 *
 * 为什么：① 运维脚本的"界面"就是标准输出，提示信息与告警必须同一通道、同一顺序，
 * 混用 console.log 与 console.warn 会在管道里错位；② 全仓的 `no-console` 是警告级
 * 门禁（`npm run lint` 带 `--max-warnings 0`），本文件按 `seed.ts` 的同款 override
 * 放行，但仍然沿用同一约定写，不给后来者留"这里可以随便 console"的口子。
 */
const say = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { yes: false, resetPassword: false };
  let positional: string | undefined;

  for (const arg of argv) {
    if (arg === '--yes') opts.yes = true;
    else if (arg === '--reset-password') opts.resetPassword = true;
    else if (arg.startsWith('--')) assignFlag(opts, arg);
    else if (!positional) positional = arg;
    else throw new UsageError(`只能有一个裸参数（openid 或 user.id），多出来的是：${arg}`);
  }

  if (positional) opts.target = { kind: 'either', value: positional };
  return opts;
}

/** 解析 `--key=value` 形态的开关 */
function assignFlag(opts: Options, arg: string): void {
  const eq = arg.indexOf('=');
  if (eq < 0) throw new UsageError(`开关 ${arg} 缺少值（写法是 ${arg}=...）`);

  const key = arg.slice(2, eq);
  const value = arg.slice(eq + 1);
  if (key === 'openid') opts.target = { kind: 'openid', value };
  else if (key === 'user-id') opts.target = { kind: 'id', value };
  else if (key === 'username') opts.username = value;
  else if (key === 'role') opts.role = value;
  else {
    throw new UsageError(
      `不认识的参数 --${key}。可用：--openid / --user-id / --username / --role / --yes / --reset-password`,
    );
  }
}

/**
 * 解析 `--role`：合法就返回，非法立刻失败，没给则返回 undefined（= 不改现有角色）。
 *
 * 为什么必须拦住非法值：`admin_role` 列是无约束 VarChar，写进代码不认识的值时
 * 守卫走 `isAdminRole()` 判定并**直接拒绝**（不退回默认角色），
 * 后果是这个人看着是管理员、调 `/admin/*` 一律 40313，而写入期没有任何报错。
 */
function requestedRole(role?: string): AdminRole | undefined {
  if (role === undefined) return undefined;
  if (isAdminRole(role)) return role;
  throw new UsageError(`--role=${role} 非法。可选：${ADMIN_ROLES.join(' / ')}`);
}

const sanitizeOpenid = (openid: string): string => openid.replace(/[^A-Za-z0-9_-]/g, '_');

/** 见文件头「username 推导规则」：openid 原文最长 64 字符放不下，超出就退成摘要（仍然确定） */
function deriveAdminUsername(openid: string): string {
  const candidate = USERNAME_PREFIX + sanitizeOpenid(openid);
  if (candidate.length <= USERNAME_MAX) return candidate;
  return USERNAME_PREFIX + createHash('sha256').update(openid).digest('hex').slice(0, 37);
}

const displayNameFor = (user: TargetUser): string =>
  (user.nickname?.trim() || `微信用户${user.openid.slice(-4)}`).slice(0, USERNAME_MAX);

const locate = (prisma: PrismaClient, by: 'openid' | 'id', value: string) =>
  prisma.user.findUnique({
    where: by === 'openid' ? { openid: value } : { id: value },
    select: USER_SELECT,
  });

async function findTarget(prisma: PrismaClient, opts: Options): Promise<TargetUser | null> {
  const { target } = opts;
  if (!target) {
    // 不带参数 = "多半是想给自己开权限"：取最近一次登录的、真实存在的微信用户。
    // 排除 admin:* 是因为那是后台账号的占位 openid，不是微信用户。
    return prisma.user.findFirst({
      where: { NOT: { openid: { startsWith: CONSOLE_OPENID_PREFIX } } },
      orderBy: [{ lastLogin: 'desc' }, { createdAt: 'desc' }],
      select: USER_SELECT,
    });
  }
  if (target.kind !== 'either') return locate(prisma, target.kind, target.value);
  // 裸参数：openid 与 id 都是唯一键，先按 openid 找再按 id 找，找不到就是真没有。
  const { value } = target;
  return (await locate(prisma, 'openid', value)) ?? (await locate(prisma, 'id', value));
}

const envPassword = () => process.env.ADMIN_INITIAL_PASSWORD?.trim() || undefined;

/**
 * 密码来源。
 *
 * 沿用 seed.ts 的环境变量约定（`ADMIN_INITIAL_PASSWORD`），但**不**沿用它的
 * `DEV_ADMIN_PASSWORD` 硬编码默认值：本脚本授予的是管理员权限，把一个公开在
 * 源码里的密码写进新后台账号，等于给全网发万能钥匙。
 * 没配环境变量时改为"随机生成后立刻丢弃"—— 微信端的管理员入口完全不受影响
 * （它只依赖 Bearer token + admin_account 存在性），需要网页后台登录时再设
 * `ADMIN_INITIAL_PASSWORD` 重跑 `--reset-password`，或由现有超管「重置密码」。
 *
 * 为什么连 seed.ts 的 `DEV_ADMIN_PASSWORD` 常量都不 import：seed.ts 在模块顶层
 * 就建客户端并开始灌数据，`import` 它等于"顺手跑了一次 db:seed"。
 */
function resolvePassword(): { value: string; source: 'env' | 'random' } {
  const fromEnv = envPassword();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  return { value: randomBytes(32).toString('base64url'), source: 'random' };
}

/** 哈希只在"需要写 passwordHash"时才 import，与 seed.ts 同一做法（绝不自抄 scrypt 参数） */
async function hashPassword(plain: string): Promise<string> {
  const { PasswordService } = await import('../src/modules/admin/password.service');
  return new PasswordService().hash(plain);
}

function assertUsernameShape(username: string): void {
  if (!username.trim()) throw new UsageError('--username 不能是空值');
  if (username.length <= USERNAME_MAX) return;
  throw new UsageError(`--username 超过 ${USERNAME_MAX} 字符列宽（当前 ${username.length}）`);
}

/**
 * 决定要往 `admin_account` 写什么。
 *
 * 已存在时为什么默认**不动** `username` / `admin_role` / `displayName` / `passwordHash`：
 * 不加 `--role` 就套用 super_admin 等于"重跑一次就把 operator 升成超管"（提权），
 * 覆盖 displayName 会冲掉运维在后台改过的名字，重置密码则与 seed.ts 的约定相反
 * （"已存在时不重置密码"），而 username 是登录名 —— 改了要通知本人，归后台管。
 * 要改哪一项都得显式点名：`--role=` / `--reset-password`。
 */
function planAccount(
  user: TargetUser,
  opts: Options,
  bound: BoundAccount | null,
  role?: AdminRole,
): AccountPlan {
  const derived = deriveAdminUsername(user.openid);

  if (!bound) {
    const username = opts.username ?? derived;
    assertUsernameShape(username);
    return {
      userId: user.id,
      username,
      displayName: displayNameFor(user),
      adminRole: role ?? DEFAULT_ADMIN_ROLE,
      mode: 'create',
    };
  }

  // 已绑定：本脚本从不改 username（改名要通知本人，归后台管），显示名也沿用库里现值。
  if (opts.username && opts.username !== bound.username) {
    throw new UsageError(
      `${user.openid} 已绑定「${bound.username}」，本脚本不给已绑定的账号改名。` +
        `改名请去后台「管理员账号」；要换对象请传另一个 --openid。`,
    );
  }
  return {
    userId: user.id,
    username: bound.username,
    displayName: bound.displayName,
    adminRole: role,
    bound,
    mode: opts.resetPassword ? 'password' : 'update',
    usernameNote: bound.username === derived ? undefined : renameNote(bound.username, derived),
  };
}

/** 库里登录名与推导值不一致时要提醒：否则"打印 wx_a、实际是 admin"会误导 */
const renameNote = (bound: string, derived: string): string =>
  `  · 登录名沿用库里的「${bound}」（按 openid 会推导成 ${derived}，本脚本不改名）`;

/**
 * username 撞车预检：本表唯一键 + 后台建号时占用的 `User.openid` 唯一键。
 *
 * 只在"建新行"这条路上调用（此时已确认该 userId 还没有 admin_account），
 * 所以只要 username 被占用就一定是别人的，不必再比较 userId。
 * 真正的兜底是这两处的唯一索引 —— 预检只是把 P2002 换成一句人话。
 * 第二项尤其要查：后台建同名账号时会去撞 `admin:<username>` 这个 openid，
 * 现在不拦，报错要等到几周后别人建号那天才暴露。
 */
async function assertUsernameFree(prisma: PrismaClient, username: string): Promise<void> {
  const clash = await prisma.adminAccount.findUnique({
    where: { username },
    select: { userId: true },
  });
  if (clash)
    throw new UsageError(`username「${username}」已被占用（${clash.userId}），请换 --username=`);
  const wxid = `${CONSOLE_OPENID_PREFIX}${username}`;
  const legacy = await prisma.user.findUnique({ where: { openid: wxid }, select: { id: true } });
  if (legacy)
    throw new UsageError(`User.openid「${wxid}」已存在，会撞后台建号唯一键，请换 --username=`);
}

/** 第 1 张表：小程序管理员入口的数据来源（`buildMe()` 只看这张表） */
async function applyRole(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.userRole.upsert({
    where: { userId_role: { userId, role: Role.Admin } },
    // update 分支只把状态拉回 active（这正是"被停用后重新授权"的语义）。
    // scope 不动：它不参与 isAdmin 判定，别覆盖运维调过的值。
    update: { status: 'active' },
    create: { userId, role: Role.Admin, scope: 'global', status: 'active' },
  });
}

/** 第 2 张表：`/admin/*` 守卫每次请求都要回查的那一行 */
async function applyAccount(prisma: PrismaClient, plan: AccountPlan): Promise<void> {
  if (plan.mode === 'create') {
    const pw = resolvePassword();
    const passwordHash = await hashPassword(pw.value);
    await prisma.adminAccount.upsert({
      where: { userId: plan.userId },
      // 重复执行走到这里：只保证 active，不动密码也不动登录名
      update: { status: 'active' },
      create: {
        userId: plan.userId,
        username: plan.username,
        displayName: plan.displayName,
        adminRole: plan.adminRole ?? DEFAULT_ADMIN_ROLE,
        status: 'active',
        passwordHash,
      },
    });
    passwordNotice(pw.source, 'written');
    return;
  }

  // 已存在（main 里 findUnique 读到了这行）时用 update 而不是 upsert：
  // upsert 必须连 create 分支一起给，而 create 要求 passwordHash，
  // 于是"只想确认一下绑定"的重跑也会白算一次 scrypt。
  const data: AdminAccountUpdate = { status: 'active' };
  if (plan.adminRole) data.adminRole = plan.adminRole;
  if (plan.mode === 'password') {
    const pw = resolvePassword();
    data.passwordHash = await hashPassword(pw.value);
    passwordNotice(pw.source, 'written');
  }
  await prisma.adminAccount.update({ where: { userId: plan.userId }, data });
}

/**
 * 密码来源要**在试运行就说清**：等加了 --yes 才提示，运维往往已经写完了，
 * 事后发现"后台登不上"只会当成脚本的 bug。
 */
const RANDOM_PASSWORD_WARNING = [
  '  ⚠⚠⚠ 未设 ADMIN_INITIAL_PASSWORD：本次写入的密码是随机生成后**立刻丢弃**的，无人知道它。',
  '        微信端管理员入口不受影响（走 Bearer token）。要登网页后台：设好环境变量再跑',
  '        --reset-password --yes，或由现有超管在后台「重置密码」。',
];

function passwordNotice(source: 'env' | 'random', stage: 'plan' | 'written'): void {
  if (source === 'env') {
    say('  · passwordHash 取自 ADMIN_INITIAL_PASSWORD（不会打印明文）');
    return;
  }
  if (stage === 'plan') {
    say('  · 未设 ADMIN_INITIAL_PASSWORD → 密码将随机生成并立即丢弃（没人知道它，包括本脚本）');
    return;
  }
  RANDOM_PASSWORD_WARNING.forEach(say);
}

const roleLabel = (p: AccountPlan): string => p.adminRole ?? `保持现有（${p.bound?.adminRole}）`;

function modeLabel(plan: AccountPlan): string {
  if (plan.mode === 'create') return `新建 admin_account 行（登录名 ${plan.username}）`;
  const rolePart = plan.adminRole ? `，并把角色改为 ${plan.adminRole}` : '（不动角色）';
  if (plan.mode === 'password') return `已绑定 ${plan.bound?.username}：本次重写密码${rolePart}`;
  return `已绑定 ${plan.bound?.username}：保证 status=active${rolePart}`;
}

function printIdentity(user: TargetUser, plan: AccountPlan): void {
  say('将要把下列用户提升为管理员：');
  say(`  · 昵称   ${user.nickname ?? '(无昵称)'}`);
  say(`  · openid ${user.openid}`);
  say(`  · id     ${user.id}`);
  say(`  · 最近登录 ${user.lastLogin ? user.lastLogin.toISOString() : '(从未记录)'}`);
  say(`  · 账号状态 ${user.status}`);
  say('');
  say(`  → user_role     role=${Role.Admin} status=active（小程序的管理员入口看这张表）`);
  say(
    `  → admin_account username=${plan.username} adminRole=${roleLabel(plan)} ` +
      `displayName=${plan.displayName}（守卫每次请求回查这张表）`,
  );
  say(`  · 执行方式 ${modeLabel(plan)}`);
  if (plan.usernameNote) say(plan.usernameNote);
  if (plan.mode === 'create') passwordNotice(envPassword() ? 'env' : 'random', 'plan');
  if (user.status !== 'active') {
    say('  ⚠ 该用户 status 不是 active：登录与 /auth/refresh 都会被 buildMe 拦成账号冻结，');
    say('    管理员入口不会出现。先解封（后台用户管理）再跑本命令。');
  }
}

function printDryRun(user: TargetUser): void {
  say('');
  say(`【试运行】没有写入任何数据。目标用户：${user.nickname ?? user.openid}（${user.openid}）`);
  say(`  确认无误后加 --yes 真正执行：npm run db:grant-admin -- --openid=${user.openid} --yes`);
}

/**
 * 最后一步为什么必须打印出来：
 * `roles` / `isAdmin` 是**签发时**塞进 JWT 的，改库不会让手上的 token 立刻生效。
 * 不提醒的话，运维写完就认定"没生效"，回头去查守卫 —— 而真相只是没重新签发。
 */
function printNextStep(user: TargetUser): void {
  say('');
  say('还差最后一步（**不是失败**，是设计如此）：');
  say('  JWT 里的 roles / isAdmin 是签发时写死的，改库不会让当前 token 立刻生效。');
  say(`  让 ${user.nickname ?? user.openid} 在小程序里重新登录，或调用 POST /auth/refresh，`);
  say('  之后 /auth/me 返回 isAdmin=true —— 管理员入口才出现，/admin/* 也才放行。');
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  // 角色先于连库校验：写错角色时不必等一次数据库往返就能看见提示
  const role = requestedRole(opts.role);

  const prisma = new PrismaClient();
  try {
    const user = await findTarget(prisma, opts);
    if (!user) {
      const asked = opts.target
        ? `${opts.target.kind}=${opts.target.value}`
        : '库里没有任何真实微信用户';
      say(`✗ 找不到目标用户（${asked}）`);
      return 1;
    }
    if (user.openid.startsWith(CONSOLE_OPENID_PREFIX)) {
      say(`✗ ${user.openid} 是后台账号的占位 openid，不是微信用户，拒绝提升。`);
      say('  这种身份本来就能登后台；要给真人开管理员请传 --openid=<真实微信 openid>。');
      return 1;
    }

    const bound = await prisma.adminAccount.findUnique({
      where: { userId: user.id },
      select: BOUND_SELECT,
    });
    const plan = planAccount(user, opts, bound, role);
    // 撞车预检放在打印之前：试运行就得能看见"这个名字被人占了"，而不是等 --yes 才失败。
    if (plan.mode === 'create') await assertUsernameFree(prisma, plan.username);
    printIdentity(user, plan);
    if (!opts.yes) {
      printDryRun(user);
      return 0;
    }

    await applyRole(prisma, plan.userId);
    await applyAccount(prisma, plan);
    say('');
    say(`✓ 已写入：user_role(${Role.Admin}) + admin_account(${plan.username})`);
    printNextStep(user);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    say(err instanceof UsageError ? `✗ ${message}` : `✗ 执行失败：${message}`);
    process.exitCode = 1;
  });
