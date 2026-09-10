/**
 * 驱动层契约（docs/03-units.md U2）。
 * B1 为最小面（navigate/evaluate/click/clickAt/screenshot + 导航回调），
 * B2 扩展为完整契约——形状保持一致，B2 只增不改。
 */
import type { ErrorCode } from "@bw/core";

export interface DriverCapabilities {
  /** 可用 view.cdp() 直发 CDP 命令（仅 chrome 后端） */
  readonly cdp: boolean;
  /** 支持文件上传（仅 chrome 后端，CDP DOM.setFileInputFiles） */
  readonly upload: boolean;
  /** 支持下载（仅 chrome 后端） */
  readonly download: boolean;
  /** dialog 事件可观测（webkit 待 B1 探针定） */
  readonly dialogEvents: boolean;
  /** 支持 UA 覆写（仅 chrome 后端） */
  readonly userAgentOverride: boolean;
  /** click(selector) 可穿透 shadow DOM / iframe（B1 探针定，预期 false） */
  readonly pierceClick: boolean;
}

export interface ClickOptions {
  /** actionable 等待上限 ms（selector 轨），默认 30000 */
  timeoutMs?: number;
  button?: "left" | "right" | "middle";
  clickCount?: 1 | 2 | 3;
}

export type ScreenshotFormat = "png" | "jpeg";

export interface ScreenshotOptions {
  format?: ScreenshotFormat;
  /** jpeg 质量 0-100，默认 80 */
  quality?: number;
}

export type NavigationListener = (url: string, title: string) => void;
export type NavigationFailedListener = (error: Error) => void;

export interface Page {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  navigate(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** 表达式形式（Bun 约定）；结果 undefined 归一为 null；单飞护栏内建 */
  evaluate<T>(expression: string): Promise<T>;
  /** selector 轨：主文档 light DOM，透传 actionable 等待 */
  click(selector: string, opts?: ClickOptions): Promise<void>;
  /** 坐标轨：视口坐标原生点击（shadow DOM / iframe 目标） */
  clickAt(x: number, y: number, opts?: Omit<ClickOptions, "timeoutMs">): Promise<void>;
  screenshot(opts?: ScreenshotOptions): Promise<Uint8Array>;
  /** 返回取消订阅函数 */
  onNavigated(listener: NavigationListener): () => void;
  onNavigationFailed(listener: NavigationFailedListener): () => void;
  close(): void;
}

export interface PageOptions {
  width?: number;
  height?: number;
  url?: string;
}

export interface Driver {
  createPage(opts?: PageOptions): Promise<Page>;
  capabilities(): DriverCapabilities;
  /** 当前打开的 page 列表（view=tab 注册表；「活动 tab」是 agent 层状态，不归驱动） */
  pages(): Page[];
  /** 幂等；关闭后一切方法（含 createPage）抛 DRIVER_ERROR */
  close(): void;
}

/** 异常归一（01 §4.3）：message 含 actionable → ELEMENT_NOT_ACTIONABLE；等待类超时 → TIMEOUT */
export function classifyClickError(error: unknown): ErrorCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("actionable")) return "ELEMENT_NOT_ACTIONABLE";
  if (message.includes("timeout") || message.includes("timed out")) return "TIMEOUT";
  return "DRIVER_ERROR";
}
