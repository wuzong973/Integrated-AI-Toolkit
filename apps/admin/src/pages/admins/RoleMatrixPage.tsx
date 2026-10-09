import {
  ADMIN_PERMISSION_GROUPS,
  ADMIN_PERMISSION_LABELS,
  ADMIN_ROLES,
  ADMIN_ROLE_DESCRIPTIONS,
  ADMIN_ROLE_LABELS,
  permissionsOf,
} from '@qz/core';

import { Card, PageHeader } from '../../components/PageHeader';

/**
 * 角色权限矩阵（只读）。
 *
 * ## 为什么是只读的
 *
 * 矩阵定义在 `packages/core/src/admin/permissions.ts` —— 它是**代码常量**，
 * 后端守卫与前端菜单都 import 同一份。做成可在后台点选编辑，就必须把矩阵
 * 搬到数据库，然后面对"改了矩阵但后端进程还持着旧常量"这种不一致
 * （要么热更新机制，要么重启即变数）。当前阶段（首个版本、角色固定四种）
 * 这个复杂度换不来收益。
 *
 * 因此这一页的定位是**答疑**：新人问"审核员能不能放款"，打开就能看到答案，
 * 而不是去读代码。要改权限，改常量 + 重新部署，这是有意的取舍。
 */
export function RoleMatrixPage() {
  return (
    <>
      <PageHeader
        title="角色权限矩阵"
        desc="后端与前端读取的是同一份定义（packages/core/src/admin/permissions.ts），因此矩阵不会与接口的实际放行不一致。"
      />

      <div className="qz-col" style={{ gap: 'var(--sp-5)' }}>
        <div className="qz-stat-grid">
          {ADMIN_ROLES.map((role) => (
            <div className="qz-stat" key={role}>
              <div className="qz-stat__label">{ADMIN_ROLE_LABELS[role]}</div>
              <div className="qz-stat__value">{permissionsOf(role).length}</div>
              <div className="qz-stat__foot">{ADMIN_ROLE_DESCRIPTIONS[role]}</div>
            </div>
          ))}
        </div>

        <Card title="权限明细" subtitle="✓ 表示该角色拥有此权限" flush>
          <div className="qz-table-wrap">
            <table className="qz-table qz-matrix">
              <thead>
                <tr>
                  <th>权限点</th>
                  {ADMIN_ROLES.map((role) => (
                    <th key={role}>
                      {ADMIN_ROLE_LABELS[role]}
                      <div className="qz-dim" style={{ fontWeight: 400, fontSize: 11 }}>
                        {permissionsOf(role).length} 项
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ADMIN_PERMISSION_GROUPS.map((group) => (
                  <GroupRows key={group.key} group={group} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="qz-alert qz-alert--info">
          提示：界面按权限隐藏菜单只是<strong>体验优化</strong>，真正的安全边界是后端的
          <span className="qz-mono"> @RequirePermission() </span>
          守卫。因此每一个写接口都独立声明了权限点，"藏起来的按钮"挡不住直接调接口。
        </div>
      </div>
    </>
  );
}

/** 一个权限分组（分组标题 + 组内每个权限一行） */
function GroupRows({ group }: { group: (typeof ADMIN_PERMISSION_GROUPS)[number] }) {
  return (
    <>
      <tr>
        <td colSpan={ADMIN_ROLES.length + 1} style={{ background: 'var(--bg-sunken)' }}>
          <strong>{group.label}</strong>
        </td>
      </tr>
      {group.permissions.map((perm) => (
        <tr key={perm}>
          <td>
            {ADMIN_PERMISSION_LABELS[perm]}
            <div className="qz-dim qz-mono">{perm}</div>
          </td>
          {ADMIN_ROLES.map((role) => {
            const on = permissionsOf(role).includes(perm);
            return (
              <td key={role}>
                {on ? (
                  <span className="qz-matrix__yes">✓</span>
                ) : (
                  <span className="qz-matrix__no">—</span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
