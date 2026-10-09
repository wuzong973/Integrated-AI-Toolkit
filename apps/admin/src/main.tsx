import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

// 样式顺序：令牌 → 基础 → 布局 → 组件 → 数据 → 浮层
// 后加载的可以覆盖前面的（如组件里的 `.qz-btn` 微调布局给的尺寸）
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/data.css';
import './styles/overlay.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点：请检查 index.html 是否被改动');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
