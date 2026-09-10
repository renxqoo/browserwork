/**
 * 外部 agent 会话管理（docs/01-baseline.md §4.2 扩展）：
 * 每会话独立 Driver + PolicyEngine + ActionEngine；每次工具调用过策略闸。
 * 外部 LLM（Claude/GPT/任意框架）通过 REST 驱动浏览器工具——与内部 agent
 * 共用同一套安全基线（S1-S6）与感知层。
 */

import { type ActionEngine, createActionEngine, type InspectKind } from "@bw/actions";
import { type BrowserAction, BWError, type TaskEvent, type TrajectorySink } from "@bw/core";
import { createWebViewDriver, type Driver, type Page } from "@bw/driver";
import { renderSnapshot, type Snapshot } from "@bw/perception";
import {
  createPolicyEngine,
  type GateDecision,
  type PolicyConfig,
  type PolicyEngine,
  testPolicyConfig,
} from "@bw/policies";

export interface SessionToolResponse {
  ok: true;
  /** 动作结果文本（LLM 可读） */
  text: string;
  /** 新快照（索引化 DOM 树——LLM 下一步决策的依据） */
  snapshot: string;
  /** 截图（仅 look 工具） */
  image?: { base64: string; mimeType: string };
  /** 动作解析出的导航意图 */
  intent?: { kind: string; href?: string };
}

export interface SessionToolError {
  ok: false;
  error: string;
  code: string;
}

export interface SessionConfirmationNeeded {
  ok: false;
  code: "CONFIRMATION_REQUIRED";
  cid: string;
  reason: string;
  action: BrowserAction;
}

export type SessionToolResult = SessionToolResponse | SessionToolError | SessionConfirmationNeeded;

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastUsed: number;
  url: string;
  title: string;
  steps: number;
}

interface PendingConfirmation {
  cid: string;
  reason: string;
  action: BrowserAction;
  resolve: (approve: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagedSession {
  id: string;
  driver: Driver;
  engine: ActionEngine;
  policy: PolicyEngine;
  snapshot: Snapshot | null;
  confirmations: Map<string, PendingConfirmation>;
  createdAt: number;
  lastUsed: number;
  steps: number;
  /** eval 工具开关（默认关——显式 opt-in，B11） */
  allowEval: boolean;
  /** S1③：最近一次通过 onNavigationSettled 的 URL（违规回滚目标） */
  lastAllowedUrl: string;
  /** 事件流（外部 agent 可选订阅） */
  events: TaskEvent[];
  eventWaiters: Array<() => void>;
  closed: boolean;
}

export interface SessionManagerOptions {
  /** 会话超时（默认 30 分钟无活动自动清理） */
  sessionTtlMs?: number;
  /** 确认超时（默认 120s = deny） */
  confirmationTimeoutMs?: number;
  /** 最大并发会话数 */
  maxSessions?: number;
  /** 策略配置（缺省测试档） */
  policyConfig?: PolicyConfig;
  /** 轨迹 sink */
  trajectory?: TrajectorySink;
}

const DEFAULT_TTL = 30 * 60_000;
const DEFAULT_CONFIRM_TIMEOUT = 120_000;
const DEFAULT_MAX_SESSIONS = 16;

export interface SessionManager {
  create(startUrl?: string, opts?: { allowEval?: boolean }): Promise<SessionInfo>;
  get(id: string): SessionInfo | undefined;
  list(): SessionInfo[];
  close(id: string): void;
  closeAll(): void;
  snapshot(id: string): string;
  events(id: string): AsyncIterable<TaskEvent>;
  confirm(id: string, cid: string, approve: boolean): boolean;
  executeTool(
    id: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SessionToolResult>;
}

/** inspect 类工具名 → 引擎类目（B11） */
const INSPECT_TOOLS: Record<string, InspectKind> = {
  console: "console",
  errors: "errors",
  cookies: "cookies",
  cookies_set: "cookies_set",
  cookies_clear: "cookies_clear",
  storage: "storage",
  storage_set: "storage_set",
  storage_clear: "storage_clear",
};

export function createSessionManager(opts?: SessionManagerOptions): SessionManager {
  const ttl = opts?.sessionTtlMs ?? DEFAULT_TTL;
  const confirmTimeout = opts?.confirmationTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT;
  const maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, ManagedSession>();

  // TTL 清理定时器
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed > ttl) {
        destroySession(s);
        sessions.delete(id);
      }
    }
  }, 60_000);
  // 不阻止进程退出
  if (typeof cleaner.unref === "function") cleaner.unref();

  const destroySession = (s: ManagedSession): void => {
    if (s.closed) return;
    s.closed = true;
    // 拒绝所有挂起确认
    for (const [, pc] of s.confirmations) {
      clearTimeout(pc.timer);
      pc.resolve(false);
    }
    s.confirmations.clear();
    // 唤醒所有事件等待者
    for (const w of s.eventWaiters) w();
    s.eventWaiters.length = 0;
    try {
      s.driver.close();
    } catch {
      /* 幂等 */
    }
  };

  const emit = (s: ManagedSession, e: TaskEvent): void => {
    s.events.push(e);
    if (s.events.length > 500) s.events.splice(0, s.events.length - 500);
    for (const w of s.eventWaiters) w();
    s.eventWaiters.length = 0;
  };

  /**
   * S1③ 事后复检（B11 安全补齐——此前仅 agent 模式有）：
   * 每次 URL 落定即查 onNavigationSettled；违规（同源链接 302/meta-refresh/JS
   * 跳到未批准域）→ 回滚到最近放行 URL + 发事件。每 page 只接一次线。
   */
  const wiredPages = new WeakSet<object>();
  const wireSettledCheck = (s: ManagedSession, page: Page): void => {
    if (wiredPages.has(page)) return;
    wiredPages.add(page);
    page.onNavigated(async (url) => {
      if (s.closed) return;
      try {
        const verdict = await s.policy.onNavigationSettled(url);
        if (verdict.ok) {
          s.lastAllowedUrl = url;
          return;
        }
        emit(s, {
          type: "confirmation_required",
          cid: `violation-${Date.now()}`,
          reason: `NAVIGATION VIOLATION (rolling back): ${verdict.violation ?? "unapproved origin"}`,
          action: { kind: "navigate", url },
        });
        try {
          await page.navigate(s.lastAllowedUrl);
        } catch {
          /* 回滚失败留给会话关闭 */
        }
      } catch {
        /* 复检自身异常不阻断 */
      }
    });
  };

  const info = (s: ManagedSession): SessionInfo => ({
    id: s.id,
    createdAt: s.createdAt,
    lastUsed: s.lastUsed,
    url: s.snapshot?.url ?? "",
    title: s.snapshot?.title ?? "",
    steps: s.steps,
  });

  /** 策略闸：返回 null = 放行；返回 SessionToolResult = 拦截/确认 */
  const gate = async (
    s: ManagedSession,
    decision: GateDecision,
    action: BrowserAction,
  ): Promise<SessionToolResult | null> => {
    if (decision.kind === "allow") return null;
    if (decision.kind === "block") {
      return { ok: false, code: "POLICY_BLOCKED", error: decision.reason };
    }
    // confirm → 挂起等待
    return new Promise<SessionToolResult>((resolve) => {
      const cid = decision.cid;
      const timer = setTimeout(() => {
        s.confirmations.delete(cid);
        emit(s, { type: "confirmation_required", cid, reason: decision.reason, action });
        resolve({ ok: false, code: "CONFIRMATION_DENIED", error: `timeout: ${decision.reason}` });
      }, confirmTimeout);
      s.confirmations.set(cid, {
        cid,
        reason: decision.reason,
        action,
        timer,
        resolve: (approve) => {
          clearTimeout(timer);
          s.confirmations.delete(cid);
          if (!approve) {
            resolve({
              ok: false,
              code: "CONFIRMATION_DENIED",
              error: `denied: ${decision.reason}`,
            });
          } else {
            resolve(null as unknown as SessionToolResult); // approved → 继续执行
          }
        },
      });
      emit(s, { type: "confirmation_required", cid, reason: decision.reason, action });
    });
  };

  /** 构造 BrowserAction（参数校验） */
  const buildAction = (toolName: string, params: Record<string, unknown>): BrowserAction => {
    switch (toolName) {
      case "navigate":
        if (typeof params.url !== "string")
          throw new BWError("INVALID_TOOL_ARGS", "navigate requires url");
        return { kind: "navigate", url: params.url };
      case "click":
        if (typeof params.index !== "string")
          throw new BWError("INVALID_TOOL_ARGS", "click requires index");
        return { kind: "click", index: params.index };
      case "type":
        if (typeof params.index !== "string" || typeof params.text !== "string") {
          throw new BWError("INVALID_TOOL_ARGS", "type requires index and text");
        }
        return { kind: "type", index: params.index, text: params.text };
      case "type_text_secret":
        if (typeof params.index !== "string" || typeof params.secretName !== "string") {
          throw new BWError("INVALID_TOOL_ARGS", "type_text_secret requires index and secretName");
        }
        return { kind: "type_text_secret", index: params.index, secretName: params.secretName };
      case "press":
        if (typeof params.key !== "string")
          throw new BWError("INVALID_TOOL_ARGS", "press requires key");
        return { kind: "press", key: params.key };
      case "scroll":
        if (typeof params.direction !== "string")
          throw new BWError("INVALID_TOOL_ARGS", "scroll requires direction");
        return {
          kind: "scroll",
          direction: params.direction as "up" | "down" | "left" | "right",
          ...(params.amount !== undefined ? { amount: params.amount as number } : {}),
        };
      case "scroll_to":
        if (typeof params.index !== "string")
          throw new BWError("INVALID_TOOL_ARGS", "scroll_to requires index");
        return { kind: "scroll_to", index: params.index };
      case "select":
        if (typeof params.index !== "string" || typeof params.value !== "string") {
          throw new BWError("INVALID_TOOL_ARGS", "select requires index and value");
        }
        return { kind: "select", index: params.index, value: params.value };
      case "extract_text":
        return { kind: "extract_text" };
      case "look":
        return { kind: "look" };
      case "open_tab":
        if (typeof params.url !== "string")
          throw new BWError("INVALID_TOOL_ARGS", "open_tab requires url");
        return { kind: "open_tab", url: params.url };
      case "switch_tab":
        if (typeof params.tab !== "number")
          throw new BWError("INVALID_TOOL_ARGS", "switch_tab requires tab (number)");
        return { kind: "switch_tab", tab: params.tab };
      case "close_tab":
        return { kind: "close_tab" };
      case "wait":
        if (typeof params.seconds !== "number")
          throw new BWError("INVALID_TOOL_ARGS", "wait requires seconds");
        return { kind: "wait", seconds: params.seconds };
      default:
        throw new BWError("INVALID_TOOL_ARGS", `unknown tool: ${toolName}`);
    }
  };

  return {
    async create(startUrl, createOpts) {
      if (sessions.size >= maxSessions) {
        throw new BWError("DRIVER_ERROR", `max sessions reached (${maxSessions})`);
      }
      // P1-8：随机 ID——时间戳+序号可预测
      const id = `sess-${crypto.randomUUID().slice(0, 13)}`;

      const policyConfig =
        opts?.policyConfig ??
        testPolicyConfig(startUrl !== undefined ? [startUrl] : [], {
          budget: {
            maxSteps: 10_000,
            maxTokensInput: 100_000_000,
            maxTokensOutput: 10_000_000,
            wallClockMs: 3_600_000,
          },
        });

      const policy = createPolicyEngine(policyConfig, {
        dns: {
          async resolve(hostname) {
            const { lookup } = await import("node:dns/promises");
            return (await lookup(hostname, { all: true })).map((a) => a.address);
          },
        },
        secrets: {
          async resolve() {
            throw new Error("secrets not configured for session mode");
          },
        },
        newCid: () => `sc-${Math.random().toString(36).slice(2, 10)}`,
      });

      const driver = createWebViewDriver();
      const engine = createActionEngine(driver, {
        resolveSecret: (name, origin) => policy.resolveSecret(name, origin),
        intentSink: async (intent, action) => {
          // 意图前检：S1②/S5 + S2（submit）
          const nav = await policy.onNavigationIntent(intent, action);
          const g = await gate(sessions.get(id) as ManagedSession, nav, action);
          if (g !== null && g.ok === false && "error" in g) {
            throw new BWError(g.code as "POLICY_BLOCKED", g.error);
          }
        },
        settleQuietMs: 400,
        settleCapMs: 8000,
      });

      const session: ManagedSession = {
        id,
        driver,
        engine,
        policy,
        snapshot: null,
        confirmations: new Map(),
        createdAt: Date.now(),
        lastUsed: Date.now(),
        steps: 0,
        allowEval: createOpts?.allowEval === true,
        lastAllowedUrl: startUrl ?? "about:blank",
        events: [],
        eventWaiters: [],
        closed: false,
      };
      sessions.set(id, session);

      // 打开起始页（或 about:blank）
      const targetUrl = startUrl ?? "about:blank";
      const navCheck = await policy.onNavigate(targetUrl);
      const navGate = await gate(session, navCheck, { kind: "navigate", url: targetUrl });
      if (navGate !== null) {
        destroySession(session);
        sessions.delete(id);
        if (navGate.ok === false && "error" in navGate) {
          return Promise.reject(new BWError(navGate.code as "POLICY_BLOCKED", navGate.error));
        }
        return Promise.reject(new BWError("DRIVER_ERROR", "unexpected session gate result"));
      }
      const r = await engine.act({ kind: "open_tab", url: targetUrl });
      session.snapshot = r.snapshot;
      // S1③ 接线：起始页（后续 open_tab/switch_tab 的新页在 executeTool 里接线）
      try {
        wireSettledCheck(session, engine.activePage());
      } catch {
        /* 无活动页 */
      }

      return info(session);
    },

    get(id) {
      const s = sessions.get(id);
      return s !== undefined ? info(s) : undefined;
    },

    list() {
      return [...sessions.values()].map(info);
    },

    close(id) {
      const s = sessions.get(id);
      if (s === undefined) return;
      destroySession(s);
      sessions.delete(id);
    },

    closeAll() {
      for (const [id, s] of sessions) {
        destroySession(s);
        sessions.delete(id);
      }
      clearInterval(cleaner);
    },

    snapshot(id) {
      const s = sessions.get(id);
      if (s === undefined || s.snapshot === null) return "";
      return renderSnapshot(s.snapshot);
    },

    events(id) {
      const s = sessions.get(id);
      if (s === undefined) {
        return (async function* () {})();
      }
      const self = s;
      return (async function* () {
        let index = 0;
        for (;;) {
          while (index < self.events.length) {
            yield self.events[index] as TaskEvent;
            index += 1;
          }
          if (self.closed) return;
          await new Promise<void>((r) => {
            self.eventWaiters.push(r);
          });
        }
      })();
    },

    confirm(id, cid, approve) {
      const s = sessions.get(id);
      if (s === undefined) return false;
      const pc = s.confirmations.get(cid);
      if (pc === undefined) return false;
      s.policy.resolveConfirmation(cid, approve);
      pc.resolve(approve);
      return true;
    },

    async executeTool(id, toolName, params) {
      const s = sessions.get(id);
      if (s === undefined) {
        return { ok: false, code: "DRIVER_ERROR", error: `session ${id} not found` };
      }
      if (s.closed) {
        return { ok: false, code: "DRIVER_ERROR", error: "session is closed" };
      }
      s.lastUsed = Date.now();
      s.steps += 1;

      try {
        // S1③ 接线：open_tab/switch_tab 产生的新页在此补接（幂等）
        try {
          wireSettledCheck(s, s.engine.activePage());
        } catch {
          /* 无活动页（close_tab 后） */
        }

        // ---- inspect 类工具（B11：console/errors/cookies/storage——无导航语义，锁内直读）
        const inspectKind = INSPECT_TOOLS[toolName];
        if (inspectKind !== undefined) {
          const text = await s.engine.inspect(
            inspectKind,
            params as { key?: string; value?: string },
          );
          s.policy.budget.consume("steps", 1);
          try {
            s.policy.budget.assert();
          } catch {
            destroySession(s);
            sessions.delete(id);
            return { ok: false, code: "BUDGET_EXCEEDED", error: "budget exceeded" };
          }
          return { ok: true, text, snapshot: "" };
        }

        // ---- eval（B11：默认禁用——create 时显式 allowEval 才可用）
        if (toolName === "eval") {
          if (!s.allowEval) {
            return {
              ok: false,
              code: "EVAL_DISABLED",
              error: "eval is disabled for this session (create with allowEval)",
            };
          }
          if (typeof params.expression !== "string") {
            return { ok: false, code: "INVALID_TOOL_ARGS", error: "eval requires expression" };
          }
          const text = await s.engine.runExpression(params.expression);
          return { ok: true, text, snapshot: "" };
        }

        const action = buildAction(toolName, params);

        // 导航类工具 → S1① 前检
        if (action.kind === "navigate" || action.kind === "open_tab") {
          const url = action.kind === "navigate" ? action.url : action.url;
          const nav = await s.policy.onNavigate(url);
          const g = await gate(s, nav, action);
          if (g !== null) return g;
        }

        // 非导航类 → S2 词面闸
        if (action.kind !== "navigate" && action.kind !== "open_tab") {
          const index = "index" in action ? (action as { index?: string }).index : undefined;
          const target =
            index !== undefined && s.snapshot !== null
              ? (() => {
                  const node = s.snapshot.nodes.find((n) => n.id === index);
                  if (node === undefined) return undefined;
                  const t: { tag: string; text?: string; href?: string } = { tag: node.tag };
                  if (node.text !== undefined) t.text = node.text;
                  if (node.href !== undefined) t.href = node.href;
                  return t;
                })()
              : undefined;
          const d = s.policy.onAction(action, target);
          const g = await gate(s, d, action);
          if (g !== null) return g;
        }

        // 执行
        const r = await s.engine.act(action, s.snapshot);
        s.snapshot = r.snapshot;

        // 构造响应
        const response: SessionToolResponse = {
          ok: true,
          text: r.text,
          snapshot: r.snapshot !== null ? renderSnapshot(r.snapshot) : "",
          ...(r.image !== undefined ? { image: r.image } : {}),
          ...(r.intent !== undefined
            ? {
                intent: {
                  kind: r.intent.kind,
                  ...(r.intent.href !== undefined ? { href: r.intent.href } : {}),
                },
              }
            : {}),
        };

        // 轨迹
        if (opts?.trajectory !== undefined) {
          void opts.trajectory
            .append({
              ts: Date.now(),
              step: s.steps,
              action,
              resultText: r.text.slice(0, 2000),
              url: s.snapshot?.url ?? "",
              domHash: s.snapshot?.domHash ?? "",
            })
            .catch(() => {});
        }

        // 预算检查
        s.policy.budget.consume("steps", 1);
        try {
          s.policy.budget.assert();
        } catch (e) {
          destroySession(s);
          sessions.delete(id);
          return {
            ok: false,
            code: "BUDGET_EXCEEDED",
            error: BWError.is(e) ? e.message : String(e),
          };
        }

        return response;
      } catch (e) {
        if (BWError.is(e)) {
          return { ok: false, code: e.code, error: e.message };
        }
        return {
          ok: false,
          code: "DRIVER_ERROR",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
