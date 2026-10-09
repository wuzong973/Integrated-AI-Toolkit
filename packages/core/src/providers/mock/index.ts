/**
 * Mock Providers（红线 10）
 * 纪律：任何使用 Mock 的响应必须在响应头带 X-Provider: mock，
 *       并在界面上显示"演示模式"角标。
 */
export * from './mock-llm.provider';
export * from './mock-media.providers';
export * from './mock-infra.providers';
export * from './mock-pdf.provider';
export * from './mock-map.provider';
export * from './mock-repo.provider';
