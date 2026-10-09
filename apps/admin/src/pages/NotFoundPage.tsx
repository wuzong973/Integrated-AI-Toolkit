import { Link } from 'react-router-dom';

/** 404：给出回到看板的出口，而不是让人卡在一个死页面上 */
export function NotFoundPage() {
  return (
    <div className="qz-card">
      <div className="qz-card__body">
        <div className="qz-empty">
          <div className="qz-empty__icon">🧭</div>
          <div className="qz-empty__title">页面不存在</div>
          <div className="qz-empty__desc">地址可能已变更，或你输入的路径有误。</div>
          <Link className="qz-btn qz-btn--primary" to="/dashboard">
            回到数据看板
          </Link>
        </div>
      </div>
    </div>
  );
}
