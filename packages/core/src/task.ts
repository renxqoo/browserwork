/**
 * 顶层任务契约（docs/01-baseline.md §4.1）。TaskEvent 词表封闭（U1 双向断言）。
 */
import type { BrowserAction } from "./actions.ts";

export interface BudgetInput {
  maxSteps?: number;
  maxTokensInput?: number;
  maxTokensOutput?: number;
  wallClockMs?: number;
  costUsd?: number;
  contextWindow?: number;
}

/** 预算缺省（01 §6.4；contextWindow 默认随模型注入） */
export const DEFAULT_BUDGET = {
  maxSteps: 50,
  maxTokensInput: 2_000_000,
  maxTokensOutput: 100_000,
  wallClockMs: 15 * 60_000,
  costUsd: 5,
} as const;

export interface SecretRef {
  source: "env" | "literal";
  ref: string;
}

export interface TaskRequest {
  goal: string;
  startUrl?: string;
  /** 初始白名单之外的附加 host */
  allowedHosts?: string[];
  allowSecretsHosts?: string[];
  budget?: BudgetInput;
  secrets?: Record<string, SecretRef>;
  /** fast/strong 双模型（卡死升级用；缺省同一个） */
  model?: { fast?: string; strong?: string };
  /** 驱动构造（B14：backend/视口/持久化目录/Chrome 路径/UA——未注入 opts.driver 时生效） */
  driver?: {
    backend?: "webkit" | "chrome";
    width?: number;
    height?: number;
    dataDir?: string;
    chromePath?: string;
    userAgent?: string;
  };
}

export type TaskStatus = "done" | "failed" | "aborted" | "budget_exceeded";

export interface TaskResult {
  status: TaskStatus;
  answer?: string;
  steps: number;
  tokens: { input: number; output: number };
  trajectory: string;
  error?: string;
  /** 价目表已注入时的累计成本（05 §3.4；未注入则缺省） */
  cost?: { usd: number };
}

/** pi 事件名透传集合（message 前缀、tool_execution 前缀、turn 前缀、agent 前缀）与本域事件 */
export const TASK_EVENT_KINDS = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "confirmation_required",
  "budget_warn",
  "stuck_escalated",
  "task_done",
] as const;

export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

export interface TaskEvent {
  type: TaskEventKind;
  /** text_delta / tool 结果文本（已过 redact） */
  text?: string;
  /** 工具名与调用 id */
  toolName?: string;
  toolCallId?: string;
  /** confirmation_required */
  cid?: string;
  reason?: string;
  action?: BrowserAction;
  /** budget_warn / stuck_escalated */
  dimension?: string;
  usedPct?: number;
  from?: string;
  to?: string;
  /** task_done */
  result?: TaskResult;
}

export interface TaskHandle {
  id: string;
  events: AsyncIterable<TaskEvent>;
  steer(text: string): Promise<void>;
  confirm(cid: string, approve: boolean): Promise<void>;
  result(): Promise<TaskResult>;
  abort(reason?: string): Promise<void>;
}

/** 轨迹汇聚点（定义在 core；默认文件实现住 @bw/agent，U6 写 / U7 读） */
export interface TrajectoryEntry {
  ts: number;
  step: number;
  action:
    | BrowserAction
    | { kind: "llm"; text: string }
    /** B13：崩溃恢复审计事件（动作静默消失 + 页面跳变的事后可解释性） */
    | { kind: "__recovery"; reason: string };
  resultText: string;
  url: string;
  domHash: string;
}

export interface TrajectorySink {
  readonly path: string;
  append(entry: TrajectoryEntry): Promise<void>;
}
