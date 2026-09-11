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
import { glmModelsFromEnv } from "./llm.ts";
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
  /** 轨迹 sink 或按任务 id 的工厂（B13：serve 落盘 `<dir>/<taskId>.jsonl`） */
  trajectory?: TrajectorySink | ((taskId: string) => TrajectorySink);
  confirmationTimeoutMs?: number;
  /** 测试档：fixture origin 白名单 + 内网放宽（默认自动判定 127.0.0.1 起始 URL） */
  testMode?: boolean;
  /** 提供商 API key（真实路径必传；缺省回落 env GLM_API_KEY） */
  apiKey?: string;
  /** settle 静默窗（默认 400ms；测试可调小加速） */
  settleQuietMs?: number;
  settleCapMs?: number;
  env?: GlmEnv;
  /** 价目表（每 1M token USD；05 §3.4；缺省读 env BW_PRICES_JSON） */
  prices?: Record<string, { input: number; output: number }>;
}

/** 最后一条 assistant 纯文本（终局兜底答案；无则 undefined） */
function lastAssistantText(agent: Agent, redact: (t: string) => string): string | undefined {
  const lastText = [...agent.state.messages]
    .reverse()
    .map((m) => m as { role: string; content: unknown })
    .find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((c) => c.type === "text"),
    );
  if (lastText === undefined) return undefined;
  const joined = (lastText.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return joined !== "" ? redact(joined) : undefined;
}

export function runTask(req: TaskRequest, opts?: RunTaskOptions): TaskHandle {
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // ---- 模型三级装配（05 §3.3）：opts.models > req.model(+env) > env > no-model
  const resolvedModels: { fast: Model<never>; strong?: Model<never> } | undefined = (() => {
    if (opts?.models !== undefined) return opts.models;
    const key = opts?.apiKey ?? process.env.GLM_API_KEY;
    if (key === undefined || key === "") return undefined;
    const modelId = req.model?.fast ?? process.env.GLM_MODEL;
    const strongId = req.model?.strong ?? process.env.GLM_STRONG_MODEL;
    return glmModelsFromEnv({
      GLM_API_KEY: key,
      ...(process.env.GLM_BASE_URL !== undefined ? { GLM_BASE_URL: process.env.GLM_BASE_URL } : {}),
      ...(modelId !== undefined && modelId !== "" ? { GLM_MODEL: modelId } : {}),
      ...(strongId !== undefined && strongId !== "" ? { GLM_STRONG_MODEL: strongId } : {}),
    }) as { fast: Model<never>; strong?: Model<never> };
  })();
  // ---- 价目表（05 §3.4）：opts > env BW_PRICES_JSON（畸形 JSON = 静默停用，warn 事件兜底）
  const prices: Record<string, { input: number; output: number }> | undefined = (() => {
    if (opts?.prices !== undefined) return opts.prices;
    const raw = process.env.BW_PRICES_JSON;
    if (raw === undefined || raw === "") return undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, { input?: unknown; output?: unknown }>;
      const out: Record<string, { input: number; output: number }> = {};
      for (const [id, p] of Object.entries(parsed)) {
        if (typeof p?.input === "number" && typeof p?.output === "number") {
          out[id] = { input: p.input, output: p.output };
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  })();
  const budgetLimits = {
    maxSteps: req.budget?.maxSteps ?? DEFAULT_BUDGET.maxSteps,
    maxTokensInput: req.budget?.maxTokensInput ?? DEFAULT_BUDGET.maxTokensInput,
    maxTokensOutput: req.budget?.maxTokensOutput ?? DEFAULT_BUDGET.maxTokensOutput,
    wallClockMs: req.budget?.wallClockMs ?? DEFAULT_BUDGET.wallClockMs,
    costUsd: req.budget?.costUsd ?? DEFAULT_BUDGET.costUsd,
    ...(req.budget?.contextWindow !== undefined
      ? { contextWindow: req.budget.contextWindow }
      : (() => {
          const modelWindow = (resolvedModels?.fast as { contextWindow?: number } | undefined)
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
  const trajectory: TrajectorySink =
    typeof opts?.trajectory === "function"
      ? opts.trajectory(id)
      : (opts?.trajectory ?? memoryTrajectorySink());
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
  let costUsd = 0;
  const costWarnedModels = new Set<string>();
  let contextWarned50 = false;
  let contextWarned80 = false;
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
  let stuckAfterEscalation = false;
  /** 当前批次后强制收束（升级/终卡——比 abort 干净：批次内语义完整后停） */
  let terminateAfterBatch = false;
  const stuckRing: Array<{ url: string; domHash: string }> = [];
  const current: { snapshot: Snapshot | null; rendered: string | null } = {
    snapshot: null,
    rendered: null,
  };
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
        if (stuckNow && !escalated && resolvedModels?.strong !== undefined) {
          // 05 §3.3：pi loop config 在 run 启动时捕获 state.model（实证 createLoopConfig），
          // 运行中赋值对当轮无效 → 本批后 terminate 收束当前 run；main 里以 strong
          // 续跑 prompt("continue")（每次 prompt 重建 config，读到新 state.model）。
          // 实证：abort() 在工具执行中不能保证在下一轮 LLM 调用前停下——不可用。
          escalated = true;
          stuckRing.length = 0; // 升级后重新累计（状态迁移清单 §3.3）
          agent.state.model = resolvedModels.strong as never;
          emit({
            type: "stuck_escalated",
            from: resolvedModels.fast.id,
            to: resolvedModels.strong.id,
            reason: "same page state for 3 consecutive steps",
          });
          terminateAfterBatch = true;
        } else if (stuckNow && escalated) {
          // P1-2 处置延续：升级后仍卡 → 终局，不无限烧预算
          stuckAfterEscalation = true;
          terminateAfterBatch = true;
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
      // 首个 done 定案：pi 批终止是 every() 语义——升级发生在批中段时整批不收束，
      // 可能多跑一轮旧模型并重复调 done；重复调用不覆写（B12 审查 P2-9 处置）
      if (done.called) return;
      done.called = true;
      done.answer = answer;
    }),
  ];

  // P2-1 处置延续：无显式模型时自动装配 GLM（key 缺失则保持 no-model，首个请求会以
  // 明确的 provider 错误失败而非 undefined api）
  const fastModel = (resolvedModels?.fast ?? { id: "no-model" }) as never;
  const needsThinking =
    (resolvedModels?.fast as { reasoning?: boolean } | undefined)?.reasoning === true;
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
    transformContext: async (messages: AgentMessage[]) =>
      compactSnapshots(messages, {
        ...(budgetLimits.contextWindow !== undefined
          ? { contextWindowTokens: budgetLimits.contextWindow }
          : {}),
      }),
    // P0-1 处置：done 一旦出现在批次，同批后续工具全部拦截（不依赖 pi「整批全 terminate」）
    beforeToolCall: async (context) => {
      if (done.called && context.toolCall.name !== "done") {
        return { block: true, reason: "task already concluded" };
      }
      return undefined;
    },
    // P0-4 处置：done / 预算触顶 / 升级收束 → 强制终局（不把命运交给 LLM 是否配合调 done）。
    // 判据用全局旗标（done.called）而非本 call 名——pi 批终止要求批内每个结果都 terminate，
    // [done, X] 批的 X（被 block）也要 terminate 才不在续跑前多烧一轮（B12 审查 P2-9）
    afterToolCall: async () => {
      if (done.called || budgetExceeded !== null || terminateAfterBatch) {
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
          // costUsd 计量（05 §3.4）：价目缺失且用户显式设了 costUsd → 按 model id 一次性停用警告
          //（B12 审查 P2-10：升级后 message.model 变 strong id——逐 id 告警，不是全程一次）
          const modelId = (event.message as { model?: string }).model ?? "";
          const price = prices?.[modelId];
          if (price !== undefined) {
            const delta =
              (event.message.usage.input * price.input +
                event.message.usage.output * price.output) /
              1_000_000;
            costUsd += delta;
            policy.budget.consume("costUsd", delta);
          } else if (req.budget?.costUsd !== undefined && !costWarnedModels.has(modelId)) {
            costWarnedModels.add(modelId);
            emit({
              type: "budget_warn",
              dimension: "costUsd",
              usedPct: 0,
              reason: `cost dimension disabled: no price configured for model '${modelId}' (set prices or BW_PRICES_JSON)`,
            });
          }
          // contextWindow 独立计量（P1-1 处置：B5 账本把 contextWindow 计入 tokensInput
          // 会双扣——改为独立累计并独立断言，语义=当前上下文尺寸的近似上界）
          contextTokens = event.message.usage.input;
          // 05 §3.2：50%/80% 两档一次性预警——两档独立 if（跳变直上 80% 时两档都发，
          // 不留「回落才补发 50」的倒挂；B12 审查 P2-13）
          if (budgetLimits.contextWindow !== undefined) {
            const pct = (contextTokens / budgetLimits.contextWindow) * 100;
            if (pct >= 50 && !contextWarned50) {
              contextWarned50 = true;
              emit({ type: "budget_warn", dimension: "contextWindow", usedPct: 50 });
            }
            if (pct >= 80 && !contextWarned80) {
              contextWarned80 = true;
              emit({ type: "budget_warn", dimension: "contextWindow", usedPct: 80 });
            }
            if (contextTokens > budgetLimits.contextWindow) {
              budgetExceeded = "contextWindow";
              policy.budget.consume("steps", budgetLimits.maxSteps + 1); // 触发账本锁存
            }
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
      ...(costUsd > 0 ? { cost: { usd: Math.round(costUsd * 1e6) / 1e6 } } : {}),
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

      // 05 §3.3：卡死升级后以 strong 续跑（prompt 重建 loop config → 读到新 state.model）。
      // 状态迁移：done 守卫/预算/wallClock/确认门不经 Agent 边界（同一闭包），stuckRing 已清。
      if (
        escalated &&
        !stuckAfterEscalation &&
        !aborted &&
        !finished &&
        budgetExceeded === null &&
        settledViolation === null &&
        agent.state.errorMessage === undefined &&
        !done.called
      ) {
        terminateAfterBatch = false; // 续跑批次正常推进（升级终结名额只作用一次）
        await agent.prompt("continue with the same goal");
      }

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
      if (stuckAfterEscalation) {
        return finalize("failed", undefined, "stuck after model escalation");
      }
      if (settledViolation !== null) {
        return finalize("failed", undefined, `navigation violation: ${settledViolation}`);
      }
      if (aborted) {
        return finalize("aborted", undefined, abortReason);
      }
      if (agent.state.errorMessage !== undefined) {
        // B12 审查 P2-11：provider 抖动（含升级续跑失败）不丢升级前产出——
        // 最后一条 assistant 文本仍作答案带回（status 保持 failed 如实）
        const fallback = lastAssistantText(agent, policy.redact);
        return finalize("failed", fallback, policy.redact(agent.state.errorMessage));
      }
      if (done.called) {
        return finalize("done", policy.redact(done.answer ?? ""));
      }
      if (budgetExceeded !== null) {
        return finalize("budget_exceeded", undefined, `budget exceeded: ${budgetExceeded}`);
      }
      // agent 结束但没调 done：取最后一条 assistant 文本作答案
      return finalize("done", lastAssistantText(agent, policy.redact));
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

/**
 * transformContext（01 §6.8 + 05 §3.1/§3.2）：
 * - 全量快照（[SNAPSHOT]）保最近 2 个，更早压单行；**unchanged 标记不计数不压缩**（单行本小）
 * - image content 只保最近 1 张，更早替换 `[screenshot removed]`
 * - 估算超 0.5×contextWindow 时分阶段裁剪：非快照 toolResult → 单行；全量快照 2→1；
 *   旧 assistant 仅 text part 截断（toolCall part 原样——结构不变）
 */
export interface CompactOptions {
  contextWindowTokens?: number;
}

/** 按 role 展开为宽松 content 项视图（user 的 string content 归一为 text 项） */
const itemsOf = (m: AgentMessage): Array<{ type: string; text?: string; argsJson?: string }> => {
  if (m.role === "user") {
    return typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : m.content.map((c) => ({ ...c }) as { type: string; text?: string });
  }
  return m.content.map((c) => {
    const item = { ...c } as { type: string; text?: string; argsJson?: string };
    if (c.type === "toolCall") {
      // B12 审查 P2-5：toolCall arguments 每轮重发上 wire——计入估算
      item.argsJson = JSON.stringify((c as { arguments?: unknown }).arguments ?? {});
    }
    return item;
  });
};

/** 估算：CJK>30% 用 1.5 chars/token，否则 4；image 按 2000 token/张（05 §3.2 审查 P13 处置） */
function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  let cjk = 0;
  let images = 0;
  for (const m of messages) {
    for (const c of itemsOf(m)) {
      const lens = [c.text?.length ?? 0, c.argsJson?.length ?? 0];
      if (c.type === "image") images += 1;
      if (lens[0] === 0 && lens[1] === 0) continue;
      for (const len of lens) {
        chars += len;
      }
      const text = c.text ?? "";
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
      }
    }
  }
  const perToken = chars > 0 && cjk / chars > 0.3 ? 1.5 : 4;
  return Math.ceil(chars / perToken) + images * 2000;
}

const textOf = (m: AgentMessage): string =>
  itemsOf(m)
    .filter((c) => c.type === "text" && c.text !== undefined)
    .map((c) => c.text ?? "")
    .join("\n");

/** toolResult 替换为单行文本（保持 toolCallId 等结构字段） */
const toSingleLine = (m: AgentMessage, line: string): AgentMessage =>
  m.role === "toolResult" ? { ...m, content: [{ type: "text" as const, text: line }] } : m;

export function compactSnapshots(messages: AgentMessage[], opts?: CompactOptions): AgentMessage[] {
  const isFullSnapshot = (m: AgentMessage): boolean =>
    m.role === "toolResult" && textOf(m).includes(SNAPSHOT_MARKER) && textOf(m).includes("# Page:");
  const hasImage = (m: AgentMessage): boolean =>
    m.role === "toolResult" && m.content.some((c) => c.type === "image");

  const fullIdxOf = (ms: AgentMessage[]): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m !== undefined && isFullSnapshot(m)) idx.push(i);
    }
    return idx;
  };

  // 阶段 0（恒定，不依赖估算）：全量快照 keep-2、image keep-1
  // （imageIdx 独立收集——全量快照与 image 可共存于同一 toolResult，B12 审查 P2-6）
  let work: AgentMessage[] = (() => {
    const fullIdx: number[] = [];
    const imageIdx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m === undefined) continue;
      if (isFullSnapshot(m)) fullIdx.push(i);
      if (hasImage(m)) imageIdx.push(i);
    }
    const keepFull = new Set(fullIdx.slice(-2));
    const keepImage = new Set(imageIdx.slice(-1));
    return messages.map((m, i) => {
      if (m.role === "toolResult" && fullIdx.includes(i) && !keepFull.has(i)) {
        const firstLine = textOf(m).split("\n")[0] ?? "[snapshot]";
        return toSingleLine(m, `[snapshot removed: ${firstLine.slice(0, 80)}]`);
      }
      if (m.role === "toolResult" && hasImage(m) && !keepImage.has(i)) {
        return {
          ...m,
          content: m.content
            .filter((c) => c.type !== "image")
            .concat([{ type: "text" as const, text: "[screenshot removed]" }]),
        };
      }
      return m;
    });
  })();

  const window = opts?.contextWindowTokens;
  if (window === undefined) return work;
  const over = (): boolean => estimateTokens(work) > 0.5 * window;
  if (!over()) return work;

  // 阶段 1：非快照 toolResult 压单行——最近 2 条消息不动。
  // 已单行化结果（≤120 chars 设计上限）天然不达 200 阈值——无前缀启发式免疫洞（B12 审查 P1-2）
  const fullIdx1 = new Set(fullIdxOf(work));
  work = work.map((m, i) => {
    if (
      m.role === "toolResult" &&
      !fullIdx1.has(i) &&
      i < work.length - 2 &&
      textOf(m).length > 200
    ) {
      const firstLine = textOf(m).split("\n")[0] ?? "[result]";
      return toSingleLine(m, `[result: ${firstLine.slice(0, 100)}]`);
    }
    return m;
  });
  if (!over()) return work;

  // 阶段 2：全量快照 2→1（保最新；unchanged 标记链的锚点可能随之丢失——极端窗口压力下的
  // 已知取舍，05 §3.2 注记）
  const fullIdx2 = fullIdxOf(work);
  if (fullIdx2.length > 1) {
    const keep = new Set(fullIdx2.slice(-1));
    work = work.map((m, i) => {
      if (m.role === "toolResult" && fullIdx2.includes(i) && !keep.has(i)) {
        const firstLine = textOf(m).split("\n")[0] ?? "[snapshot]";
        return toSingleLine(m, `[snapshot removed: ${firstLine.slice(0, 80)}]`);
      }
      return m;
    });
  }
  if (!over()) return work;

  // 阶段 3：旧 assistant/user 仅截 text part（最近 2 条不动；toolCall part 原样——结构不变）。
  // user 纳入：goal/steer 可超长——第二有界性破口（B12 审查 P1-3）
  return work.map((m, i) => {
    if (i >= work.length - 2) return m;
    if (m.role === "assistant") {
      const content = m.content.map((c) =>
        c.type === "text" && c.text.length > 200
          ? { ...c, text: `${c.text.slice(0, 200)}…[truncated]` }
          : c,
      );
      return { ...m, content };
    }
    if (m.role === "user" && typeof m.content === "string" && m.content.length > 200) {
      return { ...m, content: `${m.content.slice(0, 200)}…[truncated]` };
    }
    return m;
  });
}

export { isSameView };
