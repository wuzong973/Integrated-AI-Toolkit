import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from './auth/AuthContext';
import { ConfirmProvider } from './components/Confirm';
import { ToastProvider } from './components/Toast';
import { AppRoutes } from './router';

/**
 * 应用根组件。
 *
 * ## Provider 顺序是有要求的
 *
 * `BrowserRouter` 必须在 `AuthProvider` 之外：AuthProvider 用 `useNavigate`
 * 处理"token 失效 → 跳登录页"，脱离 Router 会直接抛错。
 *
 * `ToastProvider` / `ConfirmProvider` 在 AuthProvider 之内：
 * 它们不依赖身份，但 AuthProvider 之后的组件（含各页面）都要用到它们。
 *
 * ## 没有引入任何全局状态库
 *
 * 后台的状态只有两类：**身份**（AuthContext）与**每页自己的列表数据**
 * （`useAsync`）。没有跨页共享的客户端状态，因此 Redux / Zustand 这类
 * 方案在这里只会增加一层无人受益的间接。
 */
export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
