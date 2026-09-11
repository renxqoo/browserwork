/**
 * 浏览器动作词表（docs/01-baseline.md §2 默认裁决 / 03-units.md U4）。
 * 判别联合，词表封闭（U1 测试双向断言）。
 * `index` 一律指快照元素的 bw-id；tab 用 `tab`（从 0 起）。
 */
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; index: string }
  | { kind: "type"; index: string; text: string }
  | { kind: "type_text_secret"; index: string; secretName: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { kind: "scroll_to"; index: string }
  | { kind: "select"; index: string; value: string }
  | { kind: "extract_text" }
  | { kind: "look" }
  | { kind: "open_tab"; url: string }
  | { kind: "switch_tab"; tab: number }
  | { kind: "close_tab" }
  | { kind: "wait"; seconds: number }
  | { kind: "resize"; width: number; height: number }
  | { kind: "reload" }
  | { kind: "download"; index: string }
  | { kind: "upload"; index: string; files: string[] }
  | { kind: "done"; answer?: string };

export const BROWSER_ACTION_KINDS = [
  "navigate",
  "click",
  "type",
  "type_text_secret",
  "press",
  "scroll",
  "scroll_to",
  "select",
  "extract_text",
  "look",
  "open_tab",
  "switch_tab",
  "close_tab",
  "wait",
  "resize",
  "reload",
  "download",
  "upload",
  "done",
] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

export function isBrowserActionKind(value: string): value is BrowserActionKind {
  return (BROWSER_ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * 导航/提交意图（S1②/S2 前检的数据源，U4 解析、U5 消费）。
 * - link：click 目标（或祖先）是 a[href]
 * - submit：click submit 类控件 / 带 formaction —— action 为表单绝对地址
 * - enter_submit：press Enter 且焦点在表单内
 */
export interface NavigationIntent {
  kind: "link" | "submit" | "enter_submit";
  /** link 的绝对 href / 表单 action（绝对化） */
  href?: string;
  method?: string;
}
