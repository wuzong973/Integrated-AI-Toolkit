/**
 * 「我的」页二级菜单：数据 + 可见性规则。
 *
 * ## 为什么从页面里搬出来
 *
 * 原先 `MENU_GROUPS` 直接写在 `pages/mine/index.ts`，页面同时承担
 * "菜单数据 + 可见性规则 + 交互分派"。搬出来是为了让**可见性规则能被单测**
 * （`tests/mp/mine-menu.spec.ts`）—— 它是权限相关逻辑，而"多显示了一个入口"
 * 在真机上**不会报任何错**：用户点进去看到的是 403 或空白，只能靠人发现。
 *
 * ## 入口的形态
 *
 * 每一项都带 `url` —— 菜单里**不再有**"按 key 分派"的特殊项。
 * 原先「管理后台」是唯一没有 `url` 的入口（后台是网页，`navigateTo` 跳不过去），
 * 现在它从列表里挪到了页面底部的固定栏（见 `showsAdminEntry` 与
 * `pages/mine/index.wxml` 的 `.qz-footer-bar`），所以这条特殊分支连同
 * "点了没反应就弹『该入口暂不可用』"的兜底一起删掉了：
 * `url` 改成必填，漏填在编译期就报错，比运行时给用户一句废话强。
 */

export interface MineMenuItem {
  key: string;
  /** 糖果图标类名（见 `styles/icons`） */
  icon: string;
  label: string;
  /** 给用户的一句说明，避免"光看标题不知道点进去干嘛" */
  desc: string;
  /** 小程序内页面路径（必填：漏填会让入口变成"点了没反应"，编译期就该拦住） */
  url: string;
}

export type MineMenuGroup = MineMenuItem[];

/** 二级入口（icon 为糖果图标类名，desc 是给用户的一句说明） */
export const MENU_GROUPS: MineMenuGroup[] = [
  [
    {
      key: 'files',
      icon: 'qz-i-files',
      label: '我的文件',
      desc: 'AI 生成的文件都在这里',
      url: '/pkg-toolbox/files/index',
    },
    {
      key: 'orders',
      icon: 'qz-i-orders',
      label: '我的订单',
      desc: '担保交易与履约进度',
      url: '/pkg-station/order-list/index',
    },
    {
      key: 'notifications',
      icon: 'qz-i-bell',
      label: '消息通知',
      desc: '报名、接单与订单动态',
      url: '/pkg-mine/notifications/index',
    },
    {
      key: 'wallet',
      icon: 'qz-i-wallet',
      label: '钱包与结算',
      desc: '余额、冻结与提现',
      url: '/pkg-mine/wallet/index',
    },
    {
      key: 'credit',
      icon: 'qz-i-credit',
      label: '信用与评价',
      desc: '信用分与评价记录',
      url: '/pkg-mine/credit/index',
    },
  ],
  [
    {
      key: 'verify',
      icon: 'qz-i-verify',
      label: '学生认证',
      desc: '解锁交易与提现',
      url: '/pkg-mine/verify/index',
    },
    {
      key: 'workbench',
      icon: 'qz-i-workbench',
      label: '服务者工作台',
      desc: '上架服务、接单、结算',
      url: '/pkg-station/workbench/index',
    },
    {
      key: 'myService',
      icon: 'qz-i-station',
      label: '我上架的服务',
      // 下架是软删除、市场里看不到，这一页是**唯一**能把它们找回来的入口
      desc: '含已下架，可重新上架',
      url: '/pkg-station/my-service/index',
    },
    {
      key: 'skill',
      icon: 'qz-i-skill',
      label: '技能画像',
      desc: '让 AI 更懂你能做什么',
      url: '/pkg-station/skill/index',
    },
  ],
  [
    {
      key: 'settings',
      icon: 'qz-i-settings',
      label: '设置',
      desc: '隐私、通知与缓存',
      url: '/pkg-mine/settings/index',
    },
  ],
];

/**
 * 要不要给这个用户亮出「管理后台」入口（页面底部的固定栏）。
 *
 * ## 为什么从菜单里挪出来
 *
 * 后台是管理员的**另一重身份**，和学生功能混在一张滚动列表里，
 * 滑到底才找得到、又容易被当成"又一个功能"。放到固定底栏后它一眼可见，
 * 普通用户则完全看不到（他们看到的是没有底栏的同一个页面）。
 *
 * ## ⚠️ 隐藏入口不是权限控制
 *
 * 真正的拦截在后端：`AdminPermissionGuard` 每次请求都回库查 `admin_account`，
 * 没有那一行就是 403/40313。这里只做一件事 —— 不让普通学生看到一个点进去必然失败的位置。
 * 判据用后端返回的 `isAdmin`（由"状态为 active 的 admin 角色"推出），不在客户端另算一套。
 *
 * 用 `=== true` 而不是真值判断：资料还没到（`me` 为 null）时按**非管理员**处理，
 * 宁可管理员晚一帧看到入口，也不要在身份未定时先把入口亮出来。
 */
export function showsAdminEntry(me: { isAdmin?: boolean } | null | undefined): boolean {
  return me?.isAdmin === true;
}
