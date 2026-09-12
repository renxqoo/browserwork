/**
 * 外部 agent 会话管理（docs/01-baseline.md §4.2 扩展）：
 * 每会话独立 Driver + PolicyEngine + ActionEngine；每次工具调用过策略闸。
 * 外部 LLM（Claude/GPT/任意框架）通过 REST 驱动浏览器工具——与内部 agent
 * 共用同一套安全基线（S1-S6）与感知层。
 */

import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ActionEngine, createActionEngine, type InspectKind } from "@bw/actions";
import {
  type BrowserAction,
  BWError,
  buildAction as buildActionFromRegistry,
  resolveBwHome,
  type TaskEvent,
  type TrajectorySink,
} from "@bw/core";
import { type CreateDriverOptions, createWebViewDriver, type Driver, type Page } from "@bw/driver";
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
  /** 渲染文本与上一步逐字符相等（05 §3.1）——外部 agent 可据此跳过重读 */
  unchanged: boolean;
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
  /** B20 §9.5：任务名（create --name；list 显示，agent 记账用） */
  name?: string;
  /** B20 §9.5：保留标记（keep 置位——TTL 不回收，显式 close 才销毁） */
  kept?: boolean;
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
  /** 本会话 driver 构造（create 与崩溃恢复共用；B14 透传选项） */
  makeDriver: () => Driver;
  policy: PolicyEngine;
  snapshot: Snapshot | null;
  confirmations: Map<string, PendingConfirmation>;
  createdAt: number;
  lastUsed: number;
  steps: number;
  /** eval 工具开关（默认关——显式 opt-in，B11） */
  allowEval: boolean;
  /** S1③：最近一次通过 onNavigationSettled 的 URL（违规回滚目标/崩溃恢复目标） */
  lastAllowedUrl: string;
  /** 最近一次返回的快照渲染文本（unchanged 判定 + 渲染缓存，05 §3.1） */
  lastRendered: string | null;
  /** 上次成功恢复时刻（限次窗口） */
  lastRecoveryAt: number;
  /** 本会话轨迹 sink（create 时经工厂解析） */
  trajectorySink: TrajectorySink | undefined;
  /** B20 §9.5 */
  name: string | undefined;
  kept: boolean;
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
  /**
   * 策略档（B13 §3.5）：production（缺省——S4 生效/确认门全开，本地地址需
   * create 显式 allowPrivateNetwork）或 test（fixture 白名单 + 内网放宽）。
   * 不可经 HTTP 注入。
   */
  policyMode?: "production" | "test";
  /** 显式策略配置（优先于 policyMode；测试用） */
  policyConfig?: PolicyConfig;
  /** 轨迹 sink 或按会话 id 的工厂（B13：serve 落盘） */
  trajectory?: TrajectorySink | ((sessionId: string) => TrajectorySink);
  /** driver 工厂（测试注入 FakeDriver；崩溃恢复时再次调用——B13 §3.6） */
  driverFactory?: () => Driver;
  /** 驱动构造默认项（B14：SDK 层 backend/视口/持久化/UA；可被 create 覆写） */
  driverOptions?: CreateDriverOptions;
}

const DEFAULT_TTL = 30 * 60_000;
const DEFAULT_CONFIRM_TIMEOUT = 120_000;
const DEFAULT_MAX_SESSIONS = 16;
/** 崩溃恢复限次窗口（05 §4-3：会话级 ≤1 / 进程级 ≤2） */
const RECOVERY_WINDOW_MS = 5 * 60_000;
const RECOVERY_PROBE_TIMEOUT_MS = 2_000;
const MAX_PROCESS_RECOVERIES = 2;
/** 进程级恢复记账（模块级——跨 manager 实例共享；B13 审查 P2-7） */
const processRecoveries: number[] = [];
/** chrome 后端 dataStore 进程级目录（首 view 生效——Bun 限制，B14 告警用） */
let firstChromeDataStore: string | undefined;

/** 测试专用：清进程级恢复记账（同进程多场景矩阵互不挤占额度） */
export function __resetRecoveryLedgerForTest(): void {
  processRecoveries.length = 0;
}

/** 下载根统一解析（B14 P2-12 三处同源 + B22 B17：BW_HOME 对齐——run/replay/serve 同根） */
export function downloadsRoot(): string {
  return process.env.BW_DOWNLOADS_DIR ?? join(resolveBwHome(), "downloads");
}
const sessionDownloadsDir = (sessionId: string): string => join(downloadsRoot(), sessionId);

/** 会话触顶（传输层语义——不进 core 错误分类法；server 映射 429，B12 审查 P16） */
export class SessionLimitError extends Error {
  constructor(readonly max: number) {
    super(`max sessions reached (${max})`);
    this.name = "SessionLimitError";
  }
}

export interface SessionCreateOptions {
  allowEval?: boolean;
  allowPrivateNetwork?: boolean;
  /** B20 §9.5：任务名（3-6 词自然语言——Space 记账语义） */
  name?: string;
  /** B14 驱动构造覆写（backend/视口/持久化/Chrome 路径/UA） */
  driver?: CreateDriverOptions;
  /** B14：上传目录白名单（serve 级 env 门后经 HTTP 传入；SDK 直用） */
  allowUploadDirs?: string[];
  /** B14：会话级预算覆写（steps/wallClock） */
  budget?: { maxSteps?: number; wallClockMs?: number };
}

export interface SessionManager {
  create(startUrl?: string, opts?: SessionCreateOptions): Promise<SessionInfo>;
  /** B20 §9.5：标记保留（TTL 不回收）；再调幂等；未知名 false */
  keep(id: string): boolean;
  rename(id: string, name: string): boolean;
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
  requests: "requests",
  cookies_all: "cookies_all",
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
      if (s.kept) continue; // B20 §9.5：保留会话免 TTL——显式 close 才销毁
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
    // B14 审查 P1-6：会话结束清空本会话下载目录（敏感文件不留盘）
    try {
      rmSync(sessionDownloadsDir(s.id), { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
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
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.kept ? { kept: true } : {}),
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
  // B22 S0（D1 单源）：构造/校验唯一实现迁 @bw/core toolRegistry——本层不再持有词汇表
  const buildAction = (toolName: string, params: Record<string, unknown>): BrowserAction =>
    buildActionFromRegistry(toolName, params);

  // B13 §3.5：生产档缺省——S4 生效（本地地址需 serve 级 env 放行，见 server.ts）；test 档仅显式
  const policyMode = opts?.policyMode ?? "production";

  /** 会话策略配置（create 与崩溃恢复共用；opts.policyConfig 显式优先——审查 P2-5） */
  const buildPolicyConfig = (
    startUrl: string | undefined,
    allowPrivateNetwork: boolean,
    createOpts?: SessionCreateOptions,
  ): PolicyConfig => {
    const budget = {
      maxSteps: createOpts?.budget?.maxSteps ?? 10_000,
      maxTokensInput: 100_000_000,
      maxTokensOutput: 10_000_000,
      wallClockMs: createOpts?.budget?.wallClockMs ?? 3_600_000,
    };
    if (policyMode === "test") {
      return testPolicyConfig(startUrl !== undefined ? [startUrl] : [], {
        budget,
        ...(createOpts?.allowUploadDirs !== undefined
          ? { allowUploadDirs: createOpts.allowUploadDirs }
          : {}),
      });
    }
    const host = (() => {
      try {
        return startUrl !== undefined ? new URL(startUrl).hostname : undefined;
      } catch {
        return "__invalid__";
      }
    })();
    return {
      allowedHosts: [...(host !== undefined ? [host] : [])],
      ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      ...(createOpts?.allowUploadDirs !== undefined
        ? { allowUploadDirs: createOpts.allowUploadDirs }
        : {}),
      budget,
    };
  };

  /** 会话动作引擎（create 与崩溃恢复共用——intentSink 闸接线一致） */
  const buildEngine = (s: ManagedSession, driver: Driver): ActionEngine =>
    createActionEngine(driver, {
      downloadsDir: () => sessionDownloadsDir(s.id),
      resolveSecret: (name, origin) => s.policy.resolveSecret(name, origin),
      intentSink: async (intent, action) => {
        // 意图前检：S1②/S5 + S2（submit）
        const nav = await s.policy.onNavigationIntent(intent, action);
        const g = await gate(s, nav, action);
        if (g !== null && g.ok === false && "error" in g) {
          throw new BWError(g.code as "POLICY_BLOCKED", g.error);
        }
      },
      settleQuietMs: 400,
      settleCapMs: 8000,
    });

  /**
   * 崩溃恢复（B13 §3.6，审查 P1-1/P2-7 处置后）：driver 死亡（host 崩溃/OOM）→
   * 重建 driver+engine、回 lastAllowedUrl 单页化。语义边界：tab 拓扑重置；挂起确认
   * 一律 deny；**尝试即记账**（claim-at-entry——并发第二路径在窗口检查处被拦，
   * driverFactory 持续抛错也不会循环重试）；会话级 5min ≤1 + 进程级（模块级）5min ≤2；
   * 恢复成败均入轨迹（审计链，core TrajectoryEntry __recovery）。
   */
  const recoverSession = async (s: ManagedSession, toolName: string): Promise<boolean> => {
    const now = Date.now();
    if (now - s.lastRecoveryAt < RECOVERY_WINDOW_MS) return false;
    while (processRecoveries.length > 0 && now - (processRecoveries[0] ?? 0) > RECOVERY_WINDOW_MS) {
      processRecoveries.shift();
    }
    if (processRecoveries.length >= MAX_PROCESS_RECOVERIES) return false;
    // claim-at-entry：并发恢复互斥 + 失败尝试同样占额度（退避语义）
    s.lastRecoveryAt = now;
    processRecoveries.push(now);
    const record = (reason: string): void => {
      if (s.trajectorySink !== undefined) {
        void s.trajectorySink
          .append({
            ts: Date.now(),
            step: s.steps,
            action: { kind: "__recovery", reason },
            resultText: reason.slice(0, 2000),
            url: s.lastAllowedUrl,
            domHash: s.snapshot?.domHash ?? "",
          })
          .catch(() => {});
      }
    };
    // 挂起确认一律 deny
    for (const [, pc] of s.confirmations) {
      clearTimeout(pc.timer);
      pc.resolve(false);
    }
    s.confirmations.clear();
    try {
      s.driver.close();
    } catch {
      /* 幂等 */
    }
    let driver: Driver;
    try {
      driver = s.makeDriver();
    } catch (e) {
      record(`recovery failed (driver factory): '${toolName}' crashed; ${String(e).slice(0, 80)}`);
      return false;
    }
    const engine = buildEngine(s, driver);
    s.driver = driver;
    s.engine = engine;
    try {
      const r = await engine.act({ kind: "open_tab", url: s.lastAllowedUrl });
      s.snapshot = r.snapshot;
      s.lastRendered = null; // 渲染缓存失效（单页化重载）
      wireSettledCheck(s, engine.activePage());
    } catch (e) {
      // 只销毁「自己装上的 engine 仍是在役 engine」的会话——并发路径互不误杀（审查 P1-1）
      if (s.engine === engine && !s.closed) {
        record(
          `recovery failed (reload): '${toolName}' crashed; ${String(e instanceof Error ? e.message : e).slice(0, 80)}`,
        );
        destroySession(s);
        sessions.delete(s.id);
      }
      return false;
    }
    record(`recovered: '${toolName}' crashed; reloaded ${s.lastAllowedUrl}`);
    return true;
  };

  /** driver 死亡探测：活动页最小求值 2s 超时（无活动页 ≠ 死——close_tab 场景） */
  const isDriverDead = async (s: ManagedSession): Promise<boolean> => {
    let page: Page;
    try {
      page = s.engine.activePage();
    } catch {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        page.evaluate("1"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("probe timeout")), RECOVERY_PROBE_TIMEOUT_MS);
        }),
      ]);
      return false;
    } catch {
      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    async create(startUrl, createOpts) {
      if (sessions.size >= maxSessions) {
        throw new SessionLimitError(maxSessions);
      }
      // P1-8：随机 ID——时间戳+序号可预测
      const id = `sess-${crypto.randomUUID().slice(0, 13)}`;

      const policy = createPolicyEngine(
        opts?.policyConfig ??
          buildPolicyConfig(startUrl, createOpts?.allowPrivateNetwork === true, createOpts),
        {
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
        },
      );

      // B14 驱动选项合并（create 覆写管理器默认；driverFactory 测试注入优先）
      const driverOpts: CreateDriverOptions = { ...opts?.driverOptions, ...createOpts?.driver };
      // chrome dataStore 是进程级首 view 生效——后续实例目录不符时告警（Bun 限制）
      if (
        (driverOpts.backend ?? opts?.driverOptions?.backend) === "chrome" &&
        driverOpts.dataStore !== undefined
      ) {
        if (firstChromeDataStore === undefined) {
          firstChromeDataStore = driverOpts.dataStore;
        } else if (firstChromeDataStore !== driverOpts.dataStore) {
          driverOpts.dataStore = firstChromeDataStore; // 对齐实际生效目录，避免静默误解
        }
      }
      const makeDriver = (): Driver =>
        opts?.driverFactory !== undefined ? opts.driverFactory() : createWebViewDriver(driverOpts);

      const session: ManagedSession = {
        id,
        driver: null as unknown as Driver,
        engine: null as unknown as ActionEngine,
        makeDriver,
        policy,
        snapshot: null,
        confirmations: new Map(),
        createdAt: Date.now(),
        lastUsed: Date.now(),
        steps: 0,
        allowEval: createOpts?.allowEval === true,
        lastAllowedUrl: startUrl ?? "about:blank",
        lastRendered: null,
        lastRecoveryAt: 0,
        trajectorySink: undefined,
        name: createOpts?.name,
        kept: false,
        events: [],
        eventWaiters: [],
        closed: false,
      };
      const driver = makeDriver();
      const engine = buildEngine(session, driver);
      session.driver = driver;
      session.engine = engine;
      session.trajectorySink =
        typeof opts?.trajectory === "function"
          ? opts.trajectory(id)
          : (opts?.trajectory ?? undefined);
      sessions.set(id, session);

      // 打开起始页（或 about:blank——无 startUrl 不过策略闸：about: 不是导航语义，
      // S1① 只对显式 URL 生效；B13 审查 P2-12a 处置）
      const targetUrl = startUrl ?? "about:blank";
      if (startUrl !== undefined) {
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
      }
      try {
        const r = await engine.act({ kind: "open_tab", url: targetUrl });
        session.snapshot = r.snapshot;
        // S1③ 接线：起始页（后续 open_tab/switch_tab 的新页在 executeTool 里接线）
        try {
          wireSettledCheck(session, engine.activePage());
        } catch {
          /* 无活动页 */
        }
      } catch (e) {
        // 起始导航失败：清场防 maxSessions 泄漏（B13 审查 P2-12b 处置）
        destroySession(session);
        sessions.delete(id);
        throw e;
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

    keep(id) {
      const s = sessions.get(id);
      if (s === undefined) return false;
      s.kept = true;
      // P2-10：keep 即清下载目录——保留语义不应携带敏感文件无限期留盘（B14 P1-6 理据）
      try {
        rmSync(sessionDownloadsDir(s.id), { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
      return true;
    },

    rename(id, name) {
      const s = sessions.get(id);
      if (s === undefined) return false;
      s.name = name;
      return true;
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
          // B14：chrome-only inspect 闸（能力不符 → INVALID_TOOL_ARGS）
          const caps = s.driver.capabilities();
          if (inspectKind === "requests" && !caps.networkEvents) {
            return {
              ok: false,
              code: "INVALID_TOOL_ARGS",
              error: "requests requires the chrome backend",
            };
          }
          if (inspectKind === "cookies_all" && !caps.httpOnlyCookies) {
            return {
              ok: false,
              code: "INVALID_TOOL_ARGS",
              error: "cookies_all requires the chrome backend",
            };
          }
          const rawText = await s.engine.inspect(
            inspectKind,
            params as { key?: string; value?: string },
          );
          // requests/cookies_all 出域文本过 redact（B14 审查 P2-10 会话侧）
          const text =
            inspectKind === "requests" || inspectKind === "cookies_all"
              ? s.policy.redact(rawText)
              : rawText;
          s.policy.budget.consume("steps", 1);
          try {
            s.policy.budget.assert();
          } catch {
            destroySession(s);
            sessions.delete(id);
            return { ok: false, code: "BUDGET_EXCEEDED", error: "budget exceeded" };
          }
          return { ok: true, text, snapshot: "", unchanged: false };
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
          return { ok: true, text, snapshot: "", unchanged: false };
        }

        // ---- tabs：标签页清单（driver.pages() 只读快照）
        if (toolName === "tabs") {
          const tabs = s.driver.pages().map((p, i) => ({ tab: i, url: p.url, title: p.title }));
          return { ok: true, text: JSON.stringify(tabs), snapshot: "", unchanged: false };
        }

        const action = buildAction(toolName, params);

        // B14：chrome-only 动作闸
        const caps = s.driver.capabilities();
        if (
          (action.kind === "download" && !caps.download) ||
          (action.kind === "upload" && !caps.upload)
        ) {
          return {
            ok: false,
            code: "INVALID_TOOL_ARGS",
            error: `${action.kind} requires the chrome backend`,
          };
        }

        // B14：upload 路径闸（目录外 → 确认门）；批准后 realpath 复核（分钟级审批窗内
        // 的 symlink 偷换——B14 审查 P1-5 TOCTOU；不重跑 checkUploadFiles——那会
        // 生成全新 cid 变成二次确认）
        if (action.kind === "upload") {
          const resolveAll = (): string[] =>
            action.files.map((f) => {
              try {
                return realpathSync(f);
              } catch {
                return f;
              }
            });
          const before = resolveAll();
          const d = s.policy.checkUploadFiles(action.files);
          const g = await gate(s, d, action);
          if (g !== null) return g;
          const after = resolveAll();
          if (before.some((p, i) => p !== (after[i] ?? ""))) {
            return {
              ok: false,
              code: "CONFIRMATION_DENIED",
              error: "upload path changed during confirmation window",
            };
          }
        }

        // ---- B20 §9.1：batch——递归走 executeTool（每子步全闸面+计步）；首错即停。
        // 响应层只留末子步快照（token 语义）；子步各自的快照在循环中丢弃。
        if (action.kind === "batch") {
          s.steps -= 1; // P2-9：与 agent 模式对齐——只按子步计（外层包装不计）
          const lines: string[] = [];
          let last: {
            ok: true;
            text: string;
            snapshot: string;
            unchanged: boolean;
            image?: { base64: string; mimeType: string };
            intent?: { kind: string; href?: string };
          } | null = null;
          let i = 0;
          for (const step of action.steps) {
            i += 1;
            const sub = await this.executeTool(
              id,
              step.kind,
              step as unknown as Record<string, unknown>,
            );
            if (!sub.ok) {
              const done = lines.join("\n");
              const subError = "error" in sub ? sub.error : sub.code;
              return {
                ok: false,
                code: sub.code,
                error: `batch stopped at step ${i}/${action.steps.length}: ${subError}${done !== "" ? `\ncompleted:\n${done}` : ""}`,
              };
            }
            lines.push(`  ✓ [${i}/${action.steps.length}] ${sub.text.split("\n")[0]}`);
            last = sub;
          }
          return {
            ok: true,
            text: `batch ${action.steps.length} steps\n${lines.join("\n")}`,
            snapshot: last !== null ? last.snapshot : "",
            unchanged: last !== null ? last.unchanged : false,
            ...(last?.image !== undefined ? { image: last.image } : {}),
            ...(last?.intent !== undefined ? { intent: last.intent } : {}),
          };
        }

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

        // 执行（extract_text/look/wait 返回 null 快照——保留缓存供后续索引动作用）
        const r = await s.engine.act(action, s.snapshot);
        if (r.snapshot !== null) s.snapshot = r.snapshot;

        // B21：extract_code 结果过 redact（读数据面与 requests/cookies_all 同规则）
        let resultText = r.text;
        if (action.kind === "extract_code" && resultText !== "") {
          resultText = s.policy.redact(resultText);
        }
        // 05 §3.1：渲染缓存 + unchanged 判定（外部 agent 可跳过重读）
        const rendered = r.snapshot !== null ? renderSnapshot(r.snapshot) : "";
        const unchanged =
          r.snapshot !== null && s.lastRendered !== null && rendered === s.lastRendered;
        if (r.snapshot !== null) s.lastRendered = rendered;

        // 构造响应
        const response: SessionToolResponse = {
          ok: true,
          text: resultText,
          snapshot: rendered,
          unchanged,
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

        // 轨迹（per-session sink，B13 工厂解析）
        if (s.trajectorySink !== undefined) {
          void s.trajectorySink
            .append({
              ts: Date.now(),
              step: s.steps,
              action,
              resultText: resultText.slice(0, 2000), // 脱敏后文本（审查 P1-3：HTTP 面与盘面同规则）
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
        const code = BWError.is(e) ? e.code : "DRIVER_ERROR";
        const message = e instanceof Error ? e.message : String(e);
        // B13 §3.6：DRIVER_ERROR → 探测 driver 死亡 → 单页化恢复
        if (code === "DRIVER_ERROR" && !s.closed) {
          if (await isDriverDead(s)) {
            const recovered = await recoverSession(s, toolName);
            if (recovered) {
              const rendered = s.snapshot !== null ? renderSnapshot(s.snapshot) : "";
              if (rendered !== "") s.lastRendered = rendered; // 与常规路径一致回写缓存
              return {
                ok: true,
                text: `driver crashed during '${toolName}'; recovered and reloaded ${s.lastAllowedUrl} (tabs reset to single page)`,
                snapshot: rendered,
                unchanged: false,
              };
            }
            if (s.closed) {
              return {
                ok: false,
                code: "DRIVER_ERROR",
                error: `${message} (recovery failed; session closed)`,
              };
            }
          }
        }
        return { ok: false, code, error: message };
      }
    },
  };
}
