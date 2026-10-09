import { useCallback, useEffect, useRef, useState } from 'react';

import { SdkError } from './http';

/**
 * 最小的数据加载 Hook（**不引入 react-query**：多一个依赖要登记合规表，
 * 而后台只需要"加载 / 错误 / 重载"三件事）。
 *
 * ## 必须处理的两个竞态（否则会出现"数据串页"）
 *
 * ① **过期响应覆盖新响应**：用户在筛选框里连点两次，第一次请求慢、
 *    第二次快，先返回的却先到达 → 列表显示的是旧筛选条件的结果，
 *    而输入框里是新条件。这类不一致极难复现，必须用请求序号拦掉。
 *
 * ② **卸载后 setState**：切页面时旧请求返回，React 会警告且白做一次渲染。
 *
 * 两者都用同一个"当前请求序号"解决：只有最新一次请求的结果会被采纳。
 *
 * ## 为什么 `reload` 不重置 `data`
 *
 * 刷新时保留旧数据可以让表格不闪成空白（配合 `loading` 在工具栏上显示进度）。
 * 把 `data` 清空会让每次筛选都整屏跳一下，长时间使用很累。
 */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: SdkError | null;
  /** 手动重载（筛选条件变化会自动重载，这里给"重试"按钮用） */
  reload: () => void;
  /** 本地替换数据（操作成功后就地更新，避免整页重拉） */
  setData: (next: T) => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SdkError | null>(null);
  const [nonce, setNonce] = useState(0);

  // 当前有效的请求序号：只有最后一次发出的请求才允许写入 state
  const seqRef = useRef(0);
  // 把 loader 放进 ref，避免调用方每次渲染传新函数导致无限循环
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    loaderRef
      .current()
      .then((result) => {
        if (seq !== seqRef.current) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (seq !== seqRef.current) return;
        setError(toSdkError(err));
      })
      .finally(() => {
        if (seq !== seqRef.current) return;
        setLoading(false);
      });
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload, setData };
}

/** 把任意异常收窄成 SdkError（网络层已抛出 SdkError，这里只兜底非预期错误） */
export function toSdkError(err: unknown): SdkError {
  if (err instanceof SdkError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SdkError(message || '未知错误', -1);
}
