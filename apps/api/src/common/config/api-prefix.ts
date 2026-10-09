/**
 * API 前缀解析（文档 9.1：BaseURL = /api/v1）
 *
 * NestJS 的 URI 版本控制把「全局前缀」与「版本号」拆成两个概念，
 * 而 .env 只暴露一个 API_PREFIX，因此这里做一次拆分：
 *   '/api/v1'  ->  { prefix: 'api', version: '1' }  最终路由 /api/v1/xxx
 *   '/api'     ->  { prefix: 'api', version: '1' }  最终路由 /api/v1/xxx
 *   ''         ->  { prefix: '',    version: '1' }  最终路由 /v1/xxx
 */
export interface ApiPrefixParts {
  /** 传给 app.setGlobalPrefix() 的路径前缀（不含首尾斜杠） */
  prefix: string;
  /** 传给 enableVersioning({ defaultVersion }) 的纯数字版本号 */
  version: string;
}

const VERSION_SUFFIX = /^(.*?)\/v(\d+)$/;

export function splitApiPrefix(apiPrefix: string): ApiPrefixParts {
  const cleaned = apiPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const matched = VERSION_SUFFIX.exec(cleaned);
  if (matched) return { prefix: matched[1], version: matched[2] };
  return { prefix: cleaned, version: '1' };
}
