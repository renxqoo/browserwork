/**
 * 浏览器工具集（U6）：BrowserAction → pi AgentTool（全 sequential——U4 每 page
 * 互斥 + 平台单操作槽双保险）。策略闸在工具 execute 内：navigate/open_tab 走
 * onNavigate 前检；click/press 的意图经引擎 intentSink（执行前触发）接
 * onNavigationIntent + onAction；确认门挂起在工具内（pi 语义即长工具）。
 */

import type { ActionResult } from "@bw/actions";
import { type BrowserAction, BWError, type NavigationIntent } from "@bw/core";
import { renderSnapshot, type Snapshot } from "@bw/perception";
import type { ActionTarget, GateDecision, PolicyEngine } from "@bw/policies";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

export const SNAPSHOT_MARKER = "[SNAPSHOT]";

export interface ToolHooks {
  onEvent: (event: {
    type: "confirmation_required";
    cid: string;
    reason: string;
    action: BrowserAction;
  }) => void;
  awaitConfirmation: (cid: string) => Promise<boolean>;
  onActionResult: (action: BrowserAction, result: ActionResult) => void;
  beforeStep: (action: BrowserAction) => void;
}

export interface ToolContext {
  engine: { act: (action: BrowserAction, snapshot?: Snapshot | null) => Promise<ActionResult> };
  policy: PolicyEngine;
  hooks: ToolHooks;
  /** 当前最新快照（工具间共享；每个 DOM 动作复合步产出新快照） */
  current: { snapshot: Snapshot | null };
  redact: (text: string) => string;
}

function targetOf(ctx: ToolContext, index: string | undefined): ActionTarget | undefined {
  if (index === undefined || ctx.current.snapshot === null) return undefined;
  const node = ctx.current.snapshot.nodes.find((n) => n.id === index);
  if (node === undefined) return undefined;
  const t: ActionTarget = { tag: node.tag };
  if (node.text !== undefined) t.text = node.text;
  if (node.href !== undefined) t.href = node.href;
  return t;
}

async function gate(
  ctx: ToolContext,
  decision: GateDecision,
  action: BrowserAction,
): Promise<void> {
  if (decision.kind === "allow") return;
  if (decision.kind === "block") {
    throw new BWError("POLICY_BLOCKED", ctx.redact(decision.reason));
  }
  ctx.hooks.onEvent({
    type: "confirmation_required",
    cid: decision.cid,
    // P1-5 处置：confirm 路径的 reason 同样过 redact
    reason: ctx.redact(decision.reason),
    action,
  });
  const approved = await ctx.hooks.awaitConfirmation(decision.cid);
  if (!approved) {
    throw new BWError("CONFIRMATION_DENIED", ctx.redact(`confirmation denied: ${decision.reason}`));
  }
}

/** 意图前检（B4 引擎在执行 click/press 前调用） */
export function makeIntentSink(ctx: ToolContext) {
  return async (intent: NavigationIntent, action: BrowserAction): Promise<void> => {
    const nav = await ctx.policy.onNavigationIntent(intent, action);
    await gate(ctx, nav, action);
    const index = "index" in action ? (action as { index?: string }).index : undefined;
    const act = ctx.policy.onAction(action, targetOf(ctx, index), intent);
    await gate(ctx, act, action);
  };
}

interface ActionOutput {
  text: string;
  image?: { base64: string; mimeType: "image/png" };
}

async function runAction(ctx: ToolContext, action: BrowserAction): Promise<ActionOutput> {
  ctx.hooks.beforeStep(action);
  // S2 词面闸（无意图面：submit 意图在 sink 二次拦）
  if (action.kind !== "navigate" && action.kind !== "open_tab") {
    const index = "index" in action ? (action as { index?: string }).index : undefined;
    const d = ctx.policy.onAction(action, targetOf(ctx, index));
    await gate(ctx, d, action);
  }
  const r = await ctx.engine.act(action, ctx.current.snapshot);
  let text = r.text;
  if (r.snapshot !== null) {
    text = `${text}\n${SNAPSHOT_MARKER}\n${renderSnapshot(r.snapshot)}`;
    ctx.current.snapshot = r.snapshot;
  }
  ctx.hooks.onActionResult(action, r);
  return {
    text: ctx.redact(text),
    ...(r.image !== undefined ? { image: { base64: r.image.base64, mimeType: "image/png" } } : {}),
  };
}

const idxSchema = (d: string) => Type.String({ description: d });

/** 组装浏览器工具（navigate..wait，全 sequential） */
export function buildBrowserTools(ctx: ToolContext): AgentTool<never>[] {
  const t = <P>(
    name: string,
    description: string,
    parameters: P,
    toAction: (p: Record<string, unknown>) => Promise<BrowserAction> | BrowserAction,
    preGate?: (p: Record<string, unknown>) => Promise<void>,
  ): AgentTool<never> =>
    ({
      name,
      label: name,
      description,
      parameters,
      executionMode: "sequential",
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (preGate !== undefined) await preGate(params);
        const action = await toAction(params);
        const out = await runAction(ctx, action);
        return {
          content: [
            { type: "text", text: out.text },
            ...(out.image !== undefined
              ? [{ type: "image", data: out.image.base64, mimeType: out.image.mimeType }]
              : []),
          ],
        };
      },
    }) as unknown as AgentTool<never>;

  const navGate =
    (urlFrom: (p: Record<string, unknown>) => string) => async (p: Record<string, unknown>) => {
      const url = urlFrom(p);
      const d = await ctx.policy.onNavigate(url);
      await gate(ctx, d, { kind: "navigate", url });
    };

  return [
    t(
      "navigate",
      "导航当前 tab 到 URL",
      Type.Object({ url: Type.String({ description: "绝对 URL（http/https）" }) }),
      (p) => ({ kind: "navigate", url: p.url as string }),
      navGate((p) => p.url as string),
    ),
    t(
      "click",
      "点击快照中指定索引的元素",
      Type.Object({ index: idxSchema("要点击的元素") }),
      (p) => ({
        kind: "click",
        index: p.index as string,
      }),
    ),
    t(
      "type",
      "向输入框输入文本（不按键——需要时跟 press Enter）",
      Type.Object({ index: idxSchema("输入框"), text: Type.String() }),
      (p) => ({ kind: "type", index: p.index as string, text: p.text as string }),
    ),
    t(
      "type_text_secret",
      "按名称输入凭据（值不进入上下文；仅限已授权域名）",
      Type.Object({
        index: idxSchema("密码框"),
        secretName: Type.String({ description: "secrets 里的名称" }),
      }),
      (p) => ({
        kind: "type_text_secret",
        index: p.index as string,
        secretName: p.secretName as string,
      }),
    ),
    t("press", "按键（Enter/Tab/Escape/ArrowDown…）", Type.Object({ key: Type.String() }), (p) => ({
      kind: "press",
      key: p.key as string,
    })),
    t(
      "scroll",
      "滚动页面",
      Type.Object({
        direction: Type.Union([
          Type.Literal("up"),
          Type.Literal("down"),
          Type.Literal("left"),
          Type.Literal("right"),
        ]),
        amount: Type.Optional(Type.Number({ description: "像素，默认 600" })),
      }),
      (p): BrowserAction => {
        const direction = p.direction as "up" | "down" | "left" | "right";
        return p.amount !== undefined
          ? { kind: "scroll", direction, amount: p.amount as number }
          : { kind: "scroll", direction };
      },
    ),
    t("scroll_to", "滚动到指定元素", Type.Object({ index: idxSchema("目标元素") }), (p) => ({
      kind: "scroll_to",
      index: p.index as string,
    })),
    t(
      "select",
      "选择下拉框选项",
      Type.Object({ index: idxSchema("select 元素"), value: Type.String() }),
      (p) => ({ kind: "select", index: p.index as string, value: p.value as string }),
    ),
    t("extract_text", "提取页面正文文本", Type.Object({}), () => ({ kind: "extract_text" })),
    t("look", "截图查看当前页面（视觉兜底）", Type.Object({}), () => ({ kind: "look" })),
    t(
      "open_tab",
      "打开新 tab 并导航",
      Type.Object({ url: Type.String() }),
      (p) => ({ kind: "open_tab", url: p.url as string }),
      navGate((p) => p.url as string),
    ),
    t("switch_tab", "切换活动 tab（从 0 开始）", Type.Object({ tab: Type.Integer() }), (p) => ({
      kind: "switch_tab",
      tab: p.tab as number,
    })),
    t("close_tab", "关闭当前 tab", Type.Object({}), () => ({ kind: "close_tab" })),
    t("wait", "等待秒数（0-30）", Type.Object({ seconds: Type.Number() }), (p) => ({
      kind: "wait",
      seconds: p.seconds as number,
    })),
  ];
}

/** done 工具（终止信号 + answer 透传） */
export function buildDoneTool(onDone: (answer: string | undefined) => void): AgentTool<never> {
  return {
    name: "done",
    label: "done",
    description: "任务完成：给出最终答案并结束",
    parameters: Type.Object({ answer: Type.Optional(Type.String({ description: "最终答案" })) }),
    executionMode: "sequential",
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      onDone(params.answer as string | undefined);
      return { content: [{ type: "text", text: "task complete" }] };
    },
  } as unknown as AgentTool<never>;
}
