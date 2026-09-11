/**
 * 驱动层契约（docs/03-units.md U2）。
 * B1 为最小面（navigate/evaluate/click/clickAt/screenshot + 导航回调），
 * B2 扩展为完整契约——形状保持一致，B2 只增不改。
 */
import type { ErrorCode } from "@bw/core";

export interface DriverCapabilities {
  /** 可用 view.cdp() 直发 CDP 命令（仅 chrome 后端） */
  readonly cdp: boolean;
  /** 支持文件上传（仅 chrome 后端，CDP DOM.setFileInputFiles；探针 p11） */
  readonly upload: boolean;
  /** 支持下载（仅 chrome 后端；探针 p11 downloadWillBegin 实证） */
  readonly download: boolean;
  /** dialog 事件可观测（webkit 待 B1 探针定） */
  readonly dialogEvents: boolean;
  /** 支持 UA 覆写（仅 chrome 后端，Emulation.setUserAgentOverride；探针 p10） */
  readonly userAgentOverride: boolean;
  /** click(selector) 可穿透 shadow DOM / iframe（B1 探针定，预期 false） */
  readonly pierceClick: boolean;
  /** httpOnly cookie 元数据可读（仅 chrome，Network.getCookies；B14） */
  readonly httpOnlyCookies: boolean;
  /** 网络请求可监听（仅 chrome，Network 域事件；探针 p10） */
  readonly networkEvents: boolean;
  /** webp 截图（仅 chrome） */
  readonly webp: boolean;
  /** window.open 弹窗成新页（webkit 探针 p2：静默丢弃；chrome 未实证——默认 false） */
  readonly popups: boolean;
}

export interface ClickOptions {
  /** actionable 等待上限 ms（selector 轨），默认 30000 */
  timeoutMs?: number;
  button?: "left" | "right" | "middle";
  clickCount?: 1 | 2 | 3;
}

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export type PressModifier = "Shift" | "Control" | "Alt" | "Meta";

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
  /** 向焦点元素插入文本（InsertText；不触发 keydown/keyup——需要时跟 press） */
  type(text: string): Promise<void>;
  /** 命名键/单字符 + 修饰键 */
  press(key: string, modifiers?: PressModifier[]): Promise<void>;
  /** 视口中心滚轮（dx/dy 像素） */
  scroll(dx: number, dy: number): Promise<void>;
  /** 主文档选择器元素 scrollIntoView */
  scrollTo(
    selector: string,
    opts?: { block?: "start" | "center" | "end" | "nearest"; timeoutMs?: number },
  ): Promise<void>;
  screenshot(opts?: ScreenshotOptions): Promise<Uint8Array>;
  /** 视口尺寸（复合步后须重提取——缓存坐标全失效，B14 审查 P2-10） */
  resize(width: number, height: number): Promise<void>;
  /** 重新加载当前页（探针 p11：双后端 runtime 均有 reload；back/forward 未实现——Bun 1.4.2 上游限制） */
  reload(): Promise<void>;
  /** CDP 直发（仅 chrome；webkit 抛 DRIVER_ERROR；探针 p10/p11 实证） */
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** 订阅 CDP 事件（仅 chrome；返回取消订阅函数） */
  onCdpEvent(method: string, listener: (params: unknown) => void): () => void;
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
