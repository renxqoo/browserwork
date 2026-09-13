/**
 * 网络请求出域掩码（B14 审查 P2-10）——engine（直连驱动）与 helper（常驻捕获环）
 * 共用：secret 类 query 参数必须在**捕获时**掩掉（不是读出时）——环里的数据本身
 * 就不允许带明文 secret。单一来源防两处漂移。
 */

/** 敏感 query 键（token/key/签名/口令类——oauth 全家族） */
export const SENSITIVE_QUERY_KEYS =
  /(^|&)(token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|sig|signature|secret|password|passwd|authorization|credential|client_secret|session[_-]?id)=([^&]*)/gi;

/** URL 入环截断上限 */
export const NET_URL_MAX = 500;

/** 网络请求环条目（helper 常驻环与 requests 工具的公共形状） */
export interface NetEntry {
  url: string;
  requestId?: string;
  method?: string;
  type?: string;
  status?: number;
  failed?: boolean;
  truncated?: boolean;
  ts: number;
}

/** query 敏感参数掩码：`...?access_token=abc` → `...?access_token=***`（无 query 原样） */
export function maskNetQuery(raw: string): string {
  if (!raw.includes("?")) return raw;
  const i = raw.indexOf("?");
  const masked = raw.slice(i + 1).replace(SENSITIVE_QUERY_KEYS, "$1$2=***");
  return `${raw.slice(0, i)}?${masked}`;
}
