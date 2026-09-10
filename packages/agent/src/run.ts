/**
 * runTask（U6 契约 01 §4.1）：组装 driver/engine/policy/tools/agent；
 * 事件出域统一 redact；task_done 恰好一次且最后；PendingConfirmation 唯一
 * 计时器（默认 120s，超时=deny）；卡死升级 fast→strong 一次；预算双点断言。
 */

import { type ActionEngine, createActionEngine } from "@bw/actions";
import {
  type BrowserAction,
  BWError,
  DEFAULT_BUDGET,
  type TaskEvent,
  type TaskHandle,
  type TaskRequest,
  type TaskResult,
  type TrajectorySink,
} from "@bw/core";
import { createWebViewDriver, type Driver } from "@bw/driver";
import { isSameView, type Snapshot } from "@bw/perception";
import {
  createPolicyEngine,
  type PolicyConfig,
  type PolicyEngine,
  testPolicyConfig,
} from "@bw/policies";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { GlmEnv } from "./llm.ts";
import { glmModelFromEnv } from "./llm.ts";
import { systemPrompt } from "./prompt.ts";
import { buildBrowserTools, buildDoneTool, SNAPSHOT_MARKER } from "./tools.ts";
import { memoryTrajectorySink } from "./trajectory.ts";

export interface RunTaskOptions {
  driver?: Driver;
  policyConfig?: PolicyConfig;
  models?: { fast: Model<never>; strong?: Model<never> };
  /** 替代真实 streamFn（测试注 ScriptedLLM） */
  streamFn?: (
    model: Model<never>,
    context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
  ) => unknown;
  trajectory?: TrajectorySink;
  confirmationTimeoutMs?: number;
  /** 测试档：fixture origin 白名单 + 内网放宽（默认自动判定 127.0.0.1 起始 URL） */
  testMode?: boolean;
  /** 提供商 API key（真实路径必传；缺省回落 env GLM_API_KEY） */
  apiKey?: string;
  /** settle 静默窗（默认 400ms；测试可调小加速） */
  settleQuietMs?: number;
  settleCapMs?: number;
  env?: GlmEnv;
}

export function runTask(req: TaskRequest, opts?: RunTaskOptions): TaskHandle {
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const budgetLimits = {
    maxSteps: req.budget?.maxSteps ?? DEFAULT_BUDGET.maxSteps,
    maxTokensInput: req.budget?.maxTokensInput ?? DEFAULT_BUDGET.maxTokensInput,
    maxTokensOutput: req.budget?.maxTokensOutput ?? DEFAULT_BUDGET.maxTokensOutput,
    wallClockMs: req.budget?.wallClockMs ?? DEFAULT_BUDGET.wallClockMs,
    costUsd: req.budget?.costUsd ?? DEFAULT_BUDGET.costUsd,
    ...(req.budget?.contextWindow !== undefined
      ? { contextWindow: req.budget.contextWindow }
      : (() => {
          const modelWindow = (opts?.models?.fast as { contextWindow?: number } | undefined)
            ?.contextWindow;
          return modelWindow !== undefined ? { contextWindow: modelWindow } : {};
        })()),
  };
  // P1-6 处置：testMode 只能显式传入（localhost 起始 URL 不再自动进测试档——
  // 生产任务访问本地 web 应用时 S4/S3 静默放开是安全洞）
  const startHost = (() => {
    try {
      return req.startUrl !== undefined ? new URL(req.startUrl).hostname : undefined;
    } catch {
      return "__invalid__";
    }
  })();
  const testMode = opts?.testMode === true;
  const basePolicy: PolicyConfig =
    opts?.policyConfig ??
    (testMode
      ? testPolicyConfig(req.startUrl !== undefined ? [req.startUrl] : [], {
          ...(req.allowedHosts !== undefined ? { allowedHosts: req.allowedHosts } : {}),
          budget: budgetLimits,
        })
      : {
          allowedHosts: [
            ...(startHost !== undefined && !testMode ? [startHost] : []),
            ...(req.allowedHosts ?? []),
          ],
          ...(req.allowSecretsHosts !== undefined
            ? { allowSecretsHosts: req.allowSecretsHosts }
            : {}),
          budget: budgetLimits,
        });

  const secrets = req.secrets ?? {};
  const policy: PolicyEngine = createPolicyEngine(basePolicy, {
    dns: {
      async resolve(hostname) {
        const { lookup } = await import("node:dns/promises");
        return (await lookup(hostname, { all: true })).map((a) => a.address);
      },
    },
    secrets: {
      async resolve(name) {
        const ref = secrets[name];
        if (ref === undefined) throw new Error(`secret not configured: ${name}`);
        if (ref.source === "literal") return ref.ref;
        const v = process.env[ref.ref];
        if (v === undefined || v === "") throw new Error(`env var not set: ${ref.ref}`);
        return v;
      },
    },
    newCid: () => `c-${Math.random().toString(36).slice(2, 10)}`,
  });

  const driver = opts?.driver ?? createWebViewDriver();
  const toolCtxLate: { engine?: ActionEngine } = {};
  const engine: ActionEngine = createActionEngine(driver, {
    resolveSecret: (name, origin) => policy.resolveSecret(name, origin),
    intentSink: async (intent, action) => {
      const e = toolCtxLate.engine;
      if (e === undefined) return;
      const { makeIntentSink } = await import("./tools.ts");
      await makeIntentSink({
        engine: e,
        policy,
        hooks,
        current,
        redact: (t: string) => policy.redact(t),
      })(intent, action);
    },
    settleQuietMs: opts?.settleQuietMs ?? 400,
    settleCapMs: opts?.settleCapMs ?? 8000,
  });
  toolCtxLate.engine = engine;
  const trajectory = opts?.trajectory ?? memoryTrajectorySink();
  const confirmationTimeoutMs = opts?.confirmationTimeoutMs ?? 120_000;

  // ---- 事件总线（出域 redact）
  const eventQueue: TaskEvent[] = [];
  let eventResolve: (() => void) | null = null;
  let finished = false;
  const emit = (e: TaskEvent): void => {
    if (finished && e.type !== "task_done") return;
    eventQueue.push(e);
    eventResolve?.();
    eventResolve = null;
  };

  // ---- 确认门状态机（唯一计时器）
  const pendingConfirmations = new Map<string, (approve: boolean) => void>();
  const awaitConfirmation = (cid: string): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirmations.delete(cid);
        resolve(false); // 超时 = deny
      }, confirmationTimeoutMs);
      pendingConfirmations.set(cid, (approve) => {
        clearTimeout(timer);
        pendingConfirmations.delete(cid);
        resolve(approve);
      });
    });

  // ---- 预算 / 步数 / 卡死（声明在 engine 之前——intentSink 闭包引用）
  // wallClock 计量：记录上一次计量点，每步消费其间距（P1-3）
  let contextTokens = 0;
  let lastWallTick = Date.now();
  const stepWallBase = (): number => {
    const now = Date.now();
    const delta = now - lastWallTick;
    lastWallTick = now;
    return delta;
  };
  let steps = 0;
  const tokens = { input: 0, output: 0 };
  let budgetExceeded: string | null = null;
  let escalated = false;
  const stuckRing: Array<{ url: string; domHash: string }> = [];
  const current: { snapshot: Snapshot | null } = { snapshot: null };
  const hooks = {
    onEvent: emit,
    awaitConfirmation,
    onActionResult: (action: BrowserAction, r: { text: string }) => {
      const snap = current.snapshot;
      void trajectory
        .append({
          ts: Date.now(),
          step: steps,
          action,
          resultText: policy.redact(r.text).slice(0, 2000),
          url: snap?.url ?? "",
          domHash: snap?.domHash ?? "",
        })
        .catch(() => {});
      // 卡死检测：同 (url, domHash) 连续 3 次且无进展
      if (snap !== null) {
        stuckRing.push({ url: snap.url, domHash: snap.domHash });
        if (stuckRing.length > 3) stuckRing.shift();
        const last = stuckRing[stuckRing.length - 1];
        const stuckNow =
          stuckRing.length === 3 &&
          stuckRing.every((s) => s.url === last?.url && s.domHash === last?.domHash);
        if (stuckNow && !escalated && opts?.models?.strong !== undefined) {
          escalated = true;
          agent.state.model = opts.models.strong as never;
          emit({
            type: "stuck_escalated",
            from: opts.models.fast.id,
            to: opts.models.strong.id,
            reason: "same page state for 3 consecutive steps",
          });
        } else if (stuckNow && escalated) {
          // P1-2 处置：升级后仍卡（pi 运行中换模型对当前 run 不生效——平台限制已文档化）
          // → 终局 abort，不无限烧预算
          agent.abort();
        }
      }
    },
    beforeStep: (action: BrowserAction) => {
      if (action.kind === "done") return;
      steps += 1;
      // P1-3 处置：wallClock 每步累计（挂起时段由预算 consume 的 No-op 语义吸收——
      // 确认等待期间无工具调用即无 beforeStep；精确豁免确认期在 U7 服务层实现）
      policy.budget.consume("wallClockMs", stepWallBase());
      policy.budget.consume("steps", 1);
      const pct = (steps / budgetLimits.maxSteps) * 100;
      if (pct >= 80 && pct < 100) {
        emit({ type: "budget_warn", dimension: "steps", usedPct: Math.round(pct) });
      }
      try {
        policy.budget.assert();
      } catch (e) {
        budgetExceeded = BWError.is(e)
          ? String(
              ((e as BWError).detail as { dimension?: string } | undefined)?.dimension ?? "steps",
            )
          : "steps";
        // P0-4：预算超限 = 终局。工具抛错只是喂 LLM——同时强制收束循环
        agent.abort();
        throw e;
      }
    },
  };

  const done = { answer: undefined as string | undefined, called: false };
  const tools = [
    ...buildBrowserTools({
      engine,
      policy,
      hooks,
      current,
      redact: (t: string) => policy.redact(t),
    }),
    buildDoneTool((answer) => {
      done.called = true;
      done.answer = answer;
    }),
  ];

  // P2-1 处置：无显式模型时自动装配 GLM（key 缺失则保持 no-model，首个请求会以
  // 明确的 provider 错误失败而非 undefined api）
  const fallbackModel =
    process.env.GLM_API_KEY !== undefined
      ? glmModelFromEnv({ GLM_API_KEY: process.env.GLM_API_KEY }).id === ""
        ? undefined
        : glmModelFromEnv({ GLM_API_KEY: process.env.GLM_API_KEY })
      : undefined;
  const fastModel = (opts?.models?.fast ?? fallbackModel ?? { id: "no-model" }) as never;
  const needsThinking =
    (opts?.models?.fast as { reasoning?: boolean } | undefined)?.reasoning === true;
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(budgetLimits.maxSteps),
      model: fastModel,
      tools: tools as never,
      // GLM 5.3 flash 等常思考模型不支持关闭（探针 p11）：reasoning 模型默认 low
      ...(needsThinking ? { thinkingLevel: "low" as const } : {}),
    },
    toolExecution: "sequential",
    ...(opts?.streamFn !== undefined ? { streamFn: opts.streamFn as never } : {}),
    getApiKey: () => opts?.apiKey ?? process.env.GLM_API_KEY ?? undefined,
    transformContext: async (messages: AgentMessage[]) => compactSnapshots(messages),
    // P0-1 处置：done 一旦出现在批次，同批后续工具全部拦截（不依赖 pi「整批全 terminate」）
    beforeToolCall: async (context) => {
      if (done.called && context.toolCall.name !== "done") {
        return { block: true, reason: "task already concluded" };
      }
      return undefined;
    },
    // P0-4 处置：done / 预算触顶 → 强制终局（不把命运交给 LLM 是否配合调 done）
    afterToolCall: async (context) => {
      if (context.toolCall.name === "done" || budgetExceeded !== null) {
        return { terminate: true };
      }
      return undefined;
    },
  });

  // ---- S1③ 事后复检（P0-3 处置）：最终 URL 落定即查，违规 → 回滚 + 终止
  let settledViolation: string | null = null;
  let _lastSettledUrl = req.startUrl ?? "about:blank";
  const wireSettledCheck = (page: import("@bw/driver").Page): void => {
    page.onNavigated(async (url) => {
      if (settledViolation !== null || finished) return;
      _lastSettledUrl = url;
      try {
        const verdict = await policy.onNavigationSettled(url);
        if (!verdict.ok) {
          settledViolation = verdict.violation ?? "unapproved origin";
          emit({
            type: "confirmation_required",
            cid: `violation-${Date.now()}`,
            reason: `NAVIGATION VIOLATION (rolling back): ${settledViolation}`,
            action: { kind: "navigate", url },
          });
          try {
            await page.navigate("about:blank");
          } catch {
            /* 回滚失败则留给 driver.close */
          }
          agent.abort();
        }
      } catch {
        /* 复检自身异常不阻断任务（记入 settledViolation 语义会误杀） */
      }
    });
  };
  // 对引擎新建的每个 page 接线（open_tab/switch_tab 后 activePage 变化——轮询接线）
  const settleWireTimer = setInterval(() => {
    if (finished) {
      clearInterval(settleWireTimer);
      return;
    }
    try {
      const page = engine.activePage() as unknown as { onNavigated?: unknown } | undefined;
      if (page !== undefined && !(page as { __bwSettledWired?: boolean }).__bwSettledWired) {
        (page as { __bwSettledWired?: boolean }).__bwSettledWired = true;
        wireSettledCheck(page as import("@bw/driver").Page);
      }
    } catch {
      /* 无活动页 */
    }
  }, 200);

  // ---- pi 事件 → TaskEvent（redact）
  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          emit({
            type: "message_update",
            text: policy.redact(event.assistantMessageEvent.delta),
          });
        }
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          tokens.input += event.message.usage.input;
          tokens.output += event.message.usage.output;
          policy.budget.consume("tokensInput", event.message.usage.input);
          policy.budget.consume("tokensOutput", event.message.usage.output);
          // contextWindow 独立计量（P1-1 处置：B5 账本把 contextWindow 计入 tokensInput
          // 会双扣——改为独立累计并独立断言，语义=当前上下文尺寸的近似上界）
          contextTokens = event.message.usage.input;
          if (
            budgetLimits.contextWindow !== undefined &&
            contextTokens > budgetLimits.contextWindow
          ) {
            budgetExceeded = "contextWindow";
            policy.budget.consume("steps", budgetLimits.maxSteps + 1); // 触发账本锁存
          }
        }
        break;
      case "tool_execution_start":
        emit({
          type: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;
      case "tool_execution_end":
        emit({
          type: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;
      default:
        emit({ type: event.type as TaskEvent["type"] });
    }
  });

  // ---- 终态
  const finalize = (status: TaskResult["status"], answer?: string, error?: string): TaskResult => {
    const result: TaskResult = {
      status,
      ...(answer !== undefined && answer !== "" ? { answer } : {}),
      steps,
      tokens: { ...tokens },
      trajectory: trajectory.path,
      ...(error !== undefined ? { error } : {}),
    };
    emit({ type: "task_done", result });
    finished = true;
    clearInterval(settleWireTimer);
    eventResolve?.();
    eventResolve = null;
    try {
      driver.close();
    } catch {
      /* U2 close 幂等 */
    }
    return result;
  };

  // ---- 主流程（aborted 声明在前——main 闭包引用）
  let aborted = false;
  let abortReason: string | undefined;
  const main = (async () => {
    const startedWall = Date.now();
    try {
      // 打开起始页（或空白）
      if (req.startUrl !== undefined) {
        const d = await policy.onNavigate(req.startUrl);
        if (d.kind === "block") throw new BWError("POLICY_BLOCKED", d.reason);
        if (d.kind === "confirm") {
          emit({
            type: "confirmation_required",
            cid: d.cid,
            reason: d.reason,
            action: { kind: "navigate", url: req.startUrl },
          });
          const ok = await awaitConfirmation(d.cid);
          if (!ok) throw new BWError("CONFIRMATION_DENIED", d.reason);
          policy.resolveConfirmation(d.cid, true);
        }
        const r = await engine.act({ kind: "open_tab", url: req.startUrl });
        current.snapshot = r.snapshot;
      } else {
        const r = await engine.act({ kind: "open_tab", url: "about:blank" });
        current.snapshot = r.snapshot;
      }
      {
        // 起始页入轨迹（步骤 0）
        const snap = current.snapshot;
        void trajectory
          .append({
            ts: Date.now(),
            step: 0,
            action: { kind: "open_tab", url: req.startUrl ?? "about:blank" },
            resultText: `opened ${req.startUrl ?? "about:blank"}`,
            url: snap?.url ?? "",
            domHash: snap?.domHash ?? "",
          })
          .catch(() => {});
      }
      policy.budget.consume("wallClockMs", Date.now() - startedWall);

      await agent.prompt(req.goal);

      policy.budget.consume("wallClockMs", stepWallBase());
      try {
        policy.budget.assert();
      } catch (e) {
        if (BWError.is(e)) {
          budgetExceeded = String(
            ((e as BWError).detail as { dimension?: string } | undefined)?.dimension ?? "",
          );
          return finalize("budget_exceeded", undefined, `budget exceeded: ${budgetExceeded}`);
        }
        throw e;
      }
      if (settledViolation !== null) {
        return finalize("failed", undefined, `navigation violation: ${settledViolation}`);
      }
      if (aborted) {
        return finalize("aborted", undefined, abortReason);
      }
      if (agent.state.errorMessage !== undefined) {
        return finalize("failed", undefined, policy.redact(agent.state.errorMessage));
      }
      if (done.called) {
        return finalize("done", policy.redact(done.answer ?? ""));
      }
      if (budgetExceeded !== null) {
        return finalize("budget_exceeded", undefined, `budget exceeded: ${budgetExceeded}`);
      }
      // agent 结束但没调 done：取最后一条 assistant 文本作答案
      const lastText = [...agent.state.messages]
        .reverse()
        .map((m) => m as { role: string; content: unknown })
        .find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            (m.content as Array<{ type: string }>).some((c) => c.type === "text"),
        );
      const answer =
        lastText !== undefined
          ? policy.redact(
              (lastText.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join(""),
            )
          : undefined;
      return finalize("done", answer);
    } catch (e) {
      if (BWError.is(e) && e.code === "BUDGET_EXCEEDED") {
        const dim = String(
          ((e as BWError).detail as { dimension?: string } | undefined)?.dimension ?? "",
        );
        budgetExceeded = dim;
        return finalize("budget_exceeded", undefined, `budget exceeded: ${dim}`);
      }
      if (aborted) {
        return finalize("aborted", undefined, abortReason);
      }
      if (BWError.is(e) && e.code === "CONFIRMATION_DENIED") {
        return finalize("failed", undefined, policy.redact(e.message));
      }
      return finalize(
        "failed",
        undefined,
        e instanceof Error ? policy.redact(e.message) : String(e),
      );
    }
  })();

  const handle: TaskHandle = {
    id,
    events: (async function* () {
      for (;;) {
        while (eventQueue.length > 0) {
          const e = eventQueue.shift();
          if (e !== undefined) yield e;
        }
        if (finished) return;
        await new Promise<void>((r) => {
          eventResolve = r;
        });
      }
    })(),
    async steer(text) {
      if (finished) throw new Error("task already finished");
      agent.steer({ role: "user", content: policy.redact(text), timestamp: Date.now() });
    },
    async confirm(cid, approve) {
      if (finished) throw new Error("task already finished");
      const waiter = pendingConfirmations.get(cid);
      policy.resolveConfirmation(cid, approve);
      if (waiter !== undefined) waiter(approve);
    },
    result: () => main,
    async abort(reason) {
      if (finished) return;
      aborted = true;
      abortReason = reason ?? "aborted by user";
      agent.abort();
      for (const [, waiter] of pendingConfirmations) waiter(false);
    },
  };
  return handle;
}

/** transformContext：保留最近 2 个快照 toolResult，更早的压成单行（01 §6.8） */
export function compactSnapshots(messages: AgentMessage[]): AgentMessage[] {
  const snapshotIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === "toolResult") {
      const hasSnapshot = m.content.some(
        (c) => c.type === "text" && c.text.includes(SNAPSHOT_MARKER),
      );
      if (hasSnapshot) snapshotIdx.push(i);
    }
  }
  const keep = new Set(snapshotIdx.slice(-2));
  return messages.map((m, i) => {
    if (m.role === "toolResult" && snapshotIdx.includes(i) && !keep.has(i)) {
      const firstLine =
        m.content
          .find((c): c is { type: "text"; text: string } => c.type === "text" && c.text !== "")
          ?.text.split("\n")[0] ?? "[snapshot]";
      return {
        ...m,
        content: [{ type: "text" as const, text: `[snapshot removed: ${firstLine.slice(0, 80)}]` }],
      };
    }
    return m;
  });
}

export { isSameView };
