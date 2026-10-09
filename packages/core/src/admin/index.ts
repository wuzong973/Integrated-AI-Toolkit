/**
 * 管理后台域入口（任务清单 M0-23）
 *
 * 只放**纯规则与契约**：权限矩阵、角色/权限点枚举、文案标签。
 * 落地实现在 `apps/api/src/modules/admin/`（守卫与接口）与
 * `apps/admin/`（菜单与按钮），两端都 import 这里。
 */
export * from './permissions';
