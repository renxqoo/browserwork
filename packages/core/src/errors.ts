/**
 * @bw/core 错误分类法 —— 全仓单一真相（docs/01-baseline.md §4.3）。
 * message 为英文中性语言；面向用户的文案由消费方按 code 本地化。
 */
export const ERROR_CODES = [
  // B22 文件会话新增（IMPLEMENTATION §3 错误码目录）
  "SESSION_BUSY",
  "EVAL_ERROR",
  "AUTH_IMPORT_FAILED",
  "CONFIRMATION_REQUIRED",
  "NOT_FOUND",
  "SESSION_LIMIT",
  "BROWSER_DEAD",
  "ELEMENT_NOT_FOUND",
  "ELEMENT_NOT_ACTIONABLE",
  "NAVIGATION_FAILED",
  "POLICY_BLOCKED",
  "CONFIRMATION_DENIED",
  "BUDGET_EXCEEDED",
  "DRIVER_ERROR",
  "TIMEOUT",
  "SECRET_UNRESOLVED",
  "INVALID_TOOL_ARGS",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface BWErrorOptions {
  cause?: unknown;
  detail?: unknown;
}

export class BWError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, options?: BWErrorOptions) {
    super(message, options && options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BWError";
    this.code = code;
    if (options && options.detail !== undefined) {
      this.detail = options.detail;
    }
  }

  static is(value: unknown): value is BWError {
    return value instanceof BWError;
  }
}

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
