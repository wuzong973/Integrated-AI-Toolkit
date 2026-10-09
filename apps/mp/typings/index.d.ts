/// <reference types="miniprogram-api-typings" />

/** 全局 App 类型声明 */
interface IAppOption {
  globalData: {
    user: Record<string, unknown> | null;
    isLoggedIn: boolean;
    systemInfo: unknown;
    demoMode: boolean;
  };
  /** 采集系统信息（顶部胶囊对齐与底部安全区适配） */
  initSystemInfo(): void;
  /** 静默登录 / 恢复登录态 */
  silentLogin(): Promise<void>;
  /** 主动刷新用户态 */
  refreshUser(): Promise<void>;
  /** 同步"演示模式"标记（请求层收到 X-Provider 响应头时调用） */
  setDemoMode(demo: boolean): void;
  /** 环境配置自检（启动时打印环境名/基址，占位域名会报错） */
  reportEnvConfig(): void;
}
