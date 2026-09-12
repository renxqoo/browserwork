/**
 * B22 S0（D1 单源）：工具词汇表——「工具名+原始参数 → BrowserAction」的唯一校验/构造点。
 * 消费方：SessionStore/executor（会话与 CLI 面）+ agent tools 注册（LLM 工具面的
 * mapper 一律委托此处——TypeBox schema 只做 LLM 呈现，校验以此为准）。
 * 漂移实证（审计 B8）：agent 面要求 batch ≥1 步、会话面空 steps 放行——本文件即裁决：
 * 空 steps 拒绝。
 */

import type { BrowserAction } from "./actions.ts";
import { BROWSER_ACTION_KINDS } from "./actions.ts";
import { BWError } from "./errors.ts";

export type RawParams = Record<string, unknown>;

type Builder = (params: RawParams) => BrowserAction;

const requireString = (params: RawParams, key: string, tool: string): string => {
  const v = params[key];
  if (typeof v !== "string") {
    throw new BWError("INVALID_TOOL_ARGS", `${tool} requires ${key}`);
  }
  return v;
};

const requireNumber = (params: RawParams, key: string, tool: string): number => {
  const v = params[key];
  if (typeof v !== "number") {
    throw new BWError("INVALID_TOOL_ARGS", `${tool} requires ${key} (number)`);
  }
  return v;
};

const TOOL_BUILDERS: Record<string, Builder> = {
  navigate: (p) => ({ kind: "navigate", url: requireString(p, "url", "navigate") }),
  click: (p) => ({ kind: "click", index: requireString(p, "index", "click") }),
  type: (p) => ({
    kind: "type",
    index: requireString(p, "index", "type"),
    text: requireString(p, "text", "type"),
  }),
  type_text_secret: (p) => ({
    kind: "type_text_secret",
    index: requireString(p, "index", "type_text_secret"),
    secretName: requireString(p, "secretName", "type_text_secret"),
  }),
  press: (p) => ({ kind: "press", key: requireString(p, "key", "press") }),
  scroll: (p) => {
    const direction = requireString(p, "direction", "scroll") as "up" | "down" | "left" | "right";
    const amount = p.amount;
    if (amount !== undefined && typeof amount !== "number") {
      throw new BWError("INVALID_TOOL_ARGS", "scroll requires amount (number)");
    }
    return amount !== undefined
      ? { kind: "scroll", direction, amount }
      : { kind: "scroll", direction };
  },
  scroll_to: (p) => ({ kind: "scroll_to", index: requireString(p, "index", "scroll_to") }),
  select: (p) => ({
    kind: "select",
    index: requireString(p, "index", "select"),
    value: requireString(p, "value", "select"),
  }),
  extract_text: () => ({ kind: "extract_text" }),
  look: () => ({ kind: "look" }),
  open_tab: (p) => ({ kind: "open_tab", url: requireString(p, "url", "open_tab") }),
  switch_tab: (p) => ({ kind: "switch_tab", tab: requireNumber(p, "tab", "switch_tab") }),
  close_tab: () => ({ kind: "close_tab" }),
  wait: (p) => {
    const seconds = requireNumber(p, "seconds", "wait");
    if (p.until !== undefined && p.until !== "networkIdle") {
      throw new BWError("INVALID_TOOL_ARGS", "wait until must be networkIdle");
    }
    return p.until !== undefined
      ? { kind: "wait", seconds, until: "networkIdle" }
      : { kind: "wait", seconds };
  },
  extract_code: (p) => {
    const code = requireString(p, "code", "extract_code");
    if (code === "") {
      throw new BWError("INVALID_TOOL_ARGS", "extract_code requires code");
    }
    return { kind: "extract_code", code };
  },
  batch: (p) => buildBatch(p),
  resize: (p) => ({
    kind: "resize",
    width: requireNumber(p, "width", "resize"),
    height: requireNumber(p, "height", "resize"),
  }),
  reload: () => ({ kind: "reload" }),
  download: (p) => ({ kind: "download", index: requireString(p, "index", "download") }),
  upload: (p) => {
    const index = requireString(p, "index", "upload");
    const files = p.files;
    if (!Array.isArray(files)) {
      throw new BWError("INVALID_TOOL_ARGS", "upload requires index and files[]");
    }
    return { kind: "upload", index, files: files.map((f) => String(f)) };
  },
};

/** batch 单点：≤10 步、非空、禁 done/嵌套、子步递归走同一构造器（B8 裁决） */
function buildBatch(p: RawParams): BrowserAction {
  const steps = p.steps;
  if (!Array.isArray(steps)) {
    throw new BWError("INVALID_TOOL_ARGS", "batch requires steps[]");
  }
  if (steps.length === 0) {
    throw new BWError("INVALID_TOOL_ARGS", "batch requires at least one step");
  }
  if (steps.length > 10) {
    throw new BWError("INVALID_TOOL_ARGS", "batch steps exceed limit (10)");
  }
  const built = (steps as RawParams[]).map((sp, i) => {
    const kind = sp.kind;
    if (typeof kind !== "string") {
      throw new BWError("INVALID_TOOL_ARGS", `batch step ${i} missing kind`);
    }
    if (kind === "done") {
      throw new BWError("INVALID_TOOL_ARGS", "batch steps must not contain done");
    }
    if (kind === "batch") {
      throw new BWError("INVALID_TOOL_ARGS", "batch steps must not contain nested batch");
    }
    return buildAction(kind, sp);
  });
  return { kind: "batch", steps: built };
}

/** 工具名 → BrowserAction（会话/CLI/agent 三面唯一构造点） */
export function buildAction(toolName: string, params: RawParams): BrowserAction {
  const builder = TOOL_BUILDERS[toolName];
  if (builder === undefined) {
    throw new BWError("INVALID_TOOL_ARGS", `unknown tool: ${toolName}`);
  }
  return builder(params);
}

/** 词表封闭性：注册的构造器 = 动作词表减去非工具动作（done 由终止协议持有，不入 batch/工具面） */
export const TOOL_NAMES: readonly string[] = Object.keys(TOOL_BUILDERS);
export { BROWSER_ACTION_KINDS };
