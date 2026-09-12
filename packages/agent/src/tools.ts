/**
 * 浏览器工具集（U6）：BrowserAction → pi AgentTool（全 sequential——U4 每 page
 * 互斥 + 平台单操作槽双保险）。策略闸在工具 execute 内：navigate/open_tab 走
 * onNavigate 前检；click/press 的意图经引擎 intentSink（执行前触发）接
 * onNavigationIntent + onAction；确认门挂起在工具内（pi 语义即长工具）。
 */

import type { ActionResult } from "@bw/actions";
import { type BrowserAction, BWError, buildAction, type NavigationIntent } from "@bw/core";
import type { DriverCapabilities } from "@bw/driver";
import { renderSnapshot, type Snapshot } from "@bw/perception";
import type { ActionTarget, GateDecision, PolicyEngine } from "@bw/policies";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

export const SNAPSHOT_MARKER = "[SNAPSHOT]";
/** unchanged 标记（05 §3.1）——渲染逐字符相等；不参与 keep-2 计数（区别于全量标记） */
export const SNAPSHOT_MARKER_UNCHANGED = "[SNAPSHOT-UNCHANGED]";

export interface ToolHooks {
  /** B20：batch 完成回调（轨迹/评测消费——子步各自 onActionResult 之外的整体条目） */
  onBatchComplete?: (count: number, ok: boolean) => void;
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
  /** 当前最新快照 + 最近返回给 LLM 的全量渲染文本（工具间共享） */
  current: { snapshot: Snapshot | null; rendered: string | null };
  redact: (text: string) => string;
  /** B14：inspect 通道（requests/cookies_all——chrome-only 工具的数据源） */
  inspect?: (kind: "requests" | "cookies_all") => Promise<string>;
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
  // S1① 导航前检（P0-1 处置：原只在单动作工具 preGate——batch 子步绕过，实证复现；
  // 移入 runAction 后 batch/单动作共用同一闸面）
  if (action.kind === "navigate" || action.kind === "open_tab") {
    const url = action.url;
    const d = await ctx.policy.onNavigate(url);
    await gate(ctx, d, action);
  }
  // S2 词面闸（无意图面：submit 意图在 sink 二次拦）
  if (action.kind !== "navigate" && action.kind !== "open_tab") {
    const index = "index" in action ? (action as { index?: string }).index : undefined;
    const d = ctx.policy.onAction(action, targetOf(ctx, index));
    await gate(ctx, d, action);
  }
  const r = await ctx.engine.act(action, ctx.current.snapshot);
  let text = r.text;
  if (r.snapshot !== null) {
    // 05 §3.1：渲染文本逐字符 diff（白名单法废除——value/checked/滚动变化天然改变渲染）
    const rendered = renderSnapshot(r.snapshot);
    if (ctx.current.rendered !== null && rendered === ctx.current.rendered) {
      text = `${text}\n${SNAPSHOT_MARKER_UNCHANGED}\n(page unchanged since last step — render identical)`;
    } else {
      text = `${text}\n${SNAPSHOT_MARKER}\n${rendered}`;
      ctx.current.rendered = rendered;
    }
    // 快照本体始终更新（坐标新鲜，供下一步 locate 校验）
    ctx.current.snapshot = r.snapshot;
  }
  ctx.hooks.onActionResult(action, r);
  return {
    text: ctx.redact(text),
    ...(r.image !== undefined ? { image: { base64: r.image.base64, mimeType: "image/png" } } : {}),
  };
}

/** B20 §9.1：batch 执行——逐步过同一闸面（runAction），首错即停；仅末步附快照。
 * 失败不 throw 空：带已完成步清单 + 失败步原因（BWError 语义保留——code 透传），
 * 并附失败时刻的当前快照（runAction 已更新 ctx.current）——LLM 从断点自纠。 */
async function runBatch(
  ctx: ToolContext,
  steps: BrowserAction[],
): Promise<{ ok: boolean; text: string; errorCode?: string; failedAt?: number }> {
  const lines: string[] = [];
  let i = 0;
  for (const step of steps) {
    i += 1;
    try {
      const out = await runAction(ctx, step);
      lines.push(`  ✓ [${i}/${steps.length}] ${out.text.split("\n")[0]}`);
    } catch (e) {
      const code = e instanceof BWError ? e.code : "DRIVER_ERROR";
      lines.push(
        `  ✗ [${i}/${steps.length}] ${step.kind}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      );
      return { ok: false, text: lines.join("\n"), errorCode: code, failedAt: i };
    }
  }
  return { ok: true, text: lines.join("\n") };
}

const idxSchema = (d: string) => Type.String({ description: d });

/**
 * 组装浏览器工具（全 sequential）。B14 起按 driver capabilities 动态注册：
 * resize/reload 双后端；download/upload/requests/cookies_all 仅 chrome。
 */
export function buildBrowserTools(ctx: ToolContext, caps?: DriverCapabilities): AgentTool<never>[] {
  const has = (k: keyof DriverCapabilities): boolean => caps?.[k] === true;
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
        if (name === "batch") {
          // B20：batch 走 runBatch——每子步过 runAction 全闸（S2/导航前检/upload 路径），
          // beforeStep 计步由子步各自触发。失败=首错即停但带进度与断点快照（LLM 自纠面）。
          const steps = (params.steps ?? []) as unknown as BrowserAction[];
          const r = await runBatch(ctx, steps);
          ctx.hooks.onBatchComplete?.(steps.length, r.ok);
          let text = r.text;
          if (r.ok) {
            // 成功：附末步后快照（ctx.current.rendered 为最新全量渲染）
            text =
              `batch ${steps.length} steps OK\n${text}` +
              (ctx.current.rendered !== null
                ? `\n${SNAPSHOT_MARKER}\n${ctx.current.rendered}`
                : "");
          } else {
            text =
              `batch stopped at step ${r.failedAt ?? "?"} (${r.errorCode})\n${text}` +
              (ctx.current.rendered !== null
                ? `\n${SNAPSHOT_MARKER}\n${ctx.current.rendered}`
                : "");
          }
          return { content: [{ type: "text", text: ctx.redact(text) }] };
        }
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

  /** inspect 类工具（引擎锁内直读；结果过 redact——不走 runAction/beforeStep） */
  const inspectTool = (
    name: string,
    description: string,
    kind: "requests" | "cookies_all",
  ): AgentTool<never> =>
    ({
      name,
      label: name,
      description,
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        const text = await ctx.inspect?.(kind);
        return { content: [{ type: "text", text: ctx.redact(text ?? "[]") }] };
      },
    }) as unknown as AgentTool<never>;

  return [
    t(
      "navigate",
      "导航当前 tab 到 URL",
      Type.Object({ url: Type.String({ description: "绝对 URL（http/https）" }) }),
      (p) => buildAction("navigate", p),
      navGate((p) => p.url as string),
    ),
    t("click", "点击快照中指定索引的元素", Type.Object({ index: idxSchema("要点击的元素") }), (p) =>
      buildAction("click", p),
    ),
    t(
      "type",
      "向输入框输入文本（不按键——需要时跟 press Enter）",
      Type.Object({ index: idxSchema("输入框"), text: Type.String() }),
      (p) => buildAction("type", p),
    ),
    t(
      "type_text_secret",
      "按名称输入凭据（值不进入上下文；仅限已授权域名）",
      Type.Object({
        index: idxSchema("密码框"),
        secretName: Type.String({ description: "secrets 里的名称" }),
      }),
      (p) => buildAction("type_text_secret", p),
    ),
    t("press", "按键（Enter/Tab/Escape/ArrowDown…）", Type.Object({ key: Type.String() }), (p) =>
      buildAction("press", p),
    ),
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
      (p) => buildAction("scroll", p),
    ),
    t("scroll_to", "滚动到指定元素", Type.Object({ index: idxSchema("目标元素") }), (p) =>
      buildAction("scroll_to", p),
    ),
    t(
      "select",
      "选择下拉框选项",
      Type.Object({ index: idxSchema("select 元素"), value: Type.String() }),
      (p) => buildAction("select", p),
    ),
    t("extract_text", "提取页面正文文本", Type.Object({}), () => ({ kind: "extract_text" })),
    t("look", "截图查看当前页面（视觉兜底）", Type.Object({}), () => ({ kind: "look" })),
    t(
      "open_tab",
      "打开新 tab 并导航",
      Type.Object({ url: Type.String() }),
      (p) => buildAction("open_tab", p),
      navGate((p) => p.url as string),
    ),
    t("switch_tab", "切换活动 tab（从 0 开始）", Type.Object({ tab: Type.Integer() }), (p) =>
      buildAction("switch_tab", p),
    ),
    t("close_tab", "关闭当前 tab", Type.Object({}), () => ({ kind: "close_tab" })),
    t(
      "wait",
      "等待秒数（0-30；可加 until=networkIdle 等网络静默）",
      Type.Object({ seconds: Type.Number(), until: Type.Optional(Type.Literal("networkIdle")) }),
      (p) => buildAction("wait", p),
    ),
    t(
      "batch",
      "一次调用执行 3-10 个已确定的动作（如填多字段表单）。每个 step 是一个动作对象 {kind, index/text/...}。只在当前快照就能确定全部步骤时用；每步依赖上一步结果的探索任务不要用。首错即停并报告完成到第几步",
      Type.Object({
        steps: Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 10 }),
      }),
      (p) => buildAction("batch", p),
      // 参数校验前置：done 不可入、kind 合法性（engine 二次校验兜底）
      async (p) => {
        const steps = (p.steps ?? []) as Array<{ kind?: string }>;
        if (steps.length === 0) {
          throw new BWError("INVALID_TOOL_ARGS", "batch requires at least one step");
        }
        if (steps.some((s) => s.kind === "done")) {
          throw new BWError("INVALID_TOOL_ARGS", "batch steps must not contain done");
        }
        if (steps.some((s) => s.kind === "batch")) {
          throw new BWError("INVALID_TOOL_ARGS", "batch steps must not contain nested batch");
        }
        for (const s of steps) {
          if (s.kind === undefined || typeof s.kind !== "string") {
            throw new BWError("INVALID_TOOL_ARGS", "batch step missing kind");
          }
        }
      },
    ),
    // ---- B14：视口/重载（双后端）----
    t(
      "resize",
      "调整视口尺寸（1-16384；快照坐标随之刷新）",
      Type.Object({ width: Type.Integer(), height: Type.Integer() }),
      (p) => buildAction("resize", p),
    ),
    t("reload", "重新加载当前页（POST 落点会走确认门）", Type.Object({}), () => ({
      kind: "reload",
    })),
    t(
      "extract_code",
      "结构化数据提取：写一个纯函数 (tree) => ...，tree 是整页 DOM 的冻结 JSON 树（{tag, attrs, text, value, children}；密码已掩码）。任意 filter/map/正则。返回值 JSON 化后回传。适用于列表/表格/商品数据等结构化抓取——比逐元素读快照省 token。无网络/computed style/canvas（那些用 extract_text 或 eval）",
      Type.Object({ code: Type.String({ description: "函数表达式 (tree) => {...}" }) }),
      (p) => buildAction("extract_code", p),
    ),
    // ---- B14：chrome-only（按能力注册）----
    ...(has("download")
      ? [
          t(
            "download",
            "点击下载链接并把文件存到本地（60s 超时；单文件≤100MB）",
            Type.Object({ index: idxSchema("下载链接元素") }),
            (p) => buildAction("download", p),
          ),
        ]
      : []),
    ...(has("upload")
      ? [
          t(
            "upload",
            "向文件输入框上传本地文件（仅允许 tmp/配置目录，目录外需确认）",
            Type.Object({ index: idxSchema("文件输入框"), files: Type.Array(Type.String()) }),
            (p) => buildAction("upload", p),
            // 路径闸：目录外 → S2 确认门（realpath 在策略内解析——审查 P9）
            async (p) => {
              const files = ((p.files ?? []) as string[]).map((f) => f);
              if (files.length === 0) {
                throw new BWError("INVALID_TOOL_ARGS", "upload requires at least one file");
              }
              await gate(ctx, ctx.policy.checkUploadFiles(files), {
                kind: "upload",
                index: p.index as string,
                files,
              });
            },
          ),
        ]
      : []),
    // ---- B14：inspect 类（chrome-only，直读不经 runAction）----
    ...(has("networkEvents") && ctx.inspect !== undefined
      ? [
          inspectTool(
            "requests",
            "查看最近网络请求（url/方法/状态——找 API 端点；最近 50 条）",
            "requests",
          ),
        ]
      : []),
    ...(has("httpOnlyCookies") && ctx.inspect !== undefined
      ? [inspectTool("cookies_all", "全量 cookie 元数据（含 httpOnly；值不显示）", "cookies_all")]
      : []),
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
