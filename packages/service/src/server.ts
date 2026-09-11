/**
 * HTTP 服务（docs/01-baseline.md §4.2 / 03-units.md U7）：
 * 自治模式：POST /tasks · SSE · steer · confirmations · abort
 * 外部模式：POST /sessions · snapshot · tools/:name · confirmations · SSE · DELETE
 * 安全基线：Bearer 鉴权（缺省自动生成——永不裸奔）· Host 白名单（防 DNS
 * rebinding）· content-type 强制 JSON（防 text/plain 表单 CSRF）· body 上限 ·
 * 常数时间 token 比对 · nosniff/no-store。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { fileTrajectorySink, type RunTaskOptions, runTask } from "@bw/agent";
import type { TaskEvent, TaskHandle, TaskRequest, TaskResult, TrajectorySink } from "@bw/core";
import {
  createSessionManager,
  SessionLimitError,
  type SessionManager,
  type SessionManagerOptions,
} from "./sessions.ts";
import { VERSION } from "./version.ts";

export interface ServiceConfig {
  port: number;
  host?: string;
  authToken?: string;
  maxConcurrentTasks?: number;
  trajectoryDir?: string;
  runOptions?: RunTaskOptions;
  sessionOptions?: SessionManagerOptions;
}

interface ManagedTask {
  handle: TaskHandle;
  result: Promise<TaskResult>;
}

const MAX_QUEUE = 1000;
/** 请求体上限（B11 安全：本地内存 DoS 防护） */
const MAX_BODY_BYTES = 1024 * 1024;
/** Host 白名单：绑 loopback 时仅放行本机回环名（防 DNS rebinding） */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function sseFormat(event: TaskEvent, id: number): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Host 校验（导出以供单测）：loopback 绑定只认回环名；显式 --host 时放行任意 Host */
export function isAllowedHost(hostHeader: string | null, boundHost: string): boolean {
  if (!LOOPBACK_HOSTS.has(boundHost)) return true;
  if (hostHeader === null) return false;
  const bare = hostHeader.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(bare) || LOOPBACK_HOSTS.has(hostHeader);
}

/** 常数时间 Bearer 比对（P1-9）：sha256 等长后 timingSafeEqual */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createServer(config: ServiceConfig): {
  start(): Promise<void>;
  stop(): void;
  url: string;
  /** 实际生效的 token（config 未给时自动生成——调用方需取走告知用户） */
  token: string;
  sessionManager: SessionManager;
  /** 运行状态（healthz/空闲退出消费，B13） */
  stats(): { activeTasks: number; sessions: number; uptimeMs: number; lastRequestAt: number };
} {
  const maxConcurrent = config.maxConcurrentTasks ?? 8;
  const tasks = new Map<string, ManagedTask>();
  let active = 0;
  const boundHost = config.host ?? "127.0.0.1";
  // P0-1：缺省自动生成——服务永不无鉴权运行
  const authToken = config.authToken ?? crypto.randomUUID();
  const startedAt = Date.now();
  let lastRequestAt = Date.now();

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  const unauthorized = (): Response => json(401, { error: "unauthorized" });
  const checkAuth = (req: Request): boolean => {
    const h = req.headers.get("authorization");
    if (h === null || !h.startsWith("Bearer ")) return false;
    return tokenMatches(h.slice(7), authToken);
  };
  /**
   * 统一 JSON body 读取（P1-6/P1-7）：
   * 空 body → {}；content-type 非 application/json → 415；超 1MB → 413；解析失败 → 400。
   */
  const readJsonBody = async (req: Request): Promise<{ ok: true; body: unknown } | Response> => {
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return json(413, { error: "body too large" });
    const raw = await req.text();
    if (raw === "") return { ok: true, body: {} };
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return json(415, { error: "content-type must be application/json" });
    }
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "body too large" });
    try {
      return { ok: true, body: JSON.parse(raw) };
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
  };

  // B13：轨迹工厂（config.trajectoryDir → `<dir>/<id>.jsonl`；任务与会话共用）
  const trajectoryFactory: ((id: string) => TrajectorySink) | undefined =
    config.trajectoryDir !== undefined
      ? (id: string) => fileTrajectorySink(config.trajectoryDir as string, id)
      : undefined;

  const sessionManager = createSessionManager({
    ...config.sessionOptions,
    ...(trajectoryFactory !== undefined ? { trajectory: trajectoryFactory } : {}),
  });

  const server = Bun.serve({
    port: config.port,
    hostname: boundHost,
    async fetch(req): Promise<Response> {
      // B13 /healthz（审查 P2-4 处置）：不计入 lastRequestAt（匿名探活不喂活空闲时钟）、
      // 不早于 Host 校验返回（rebinding 面一致）；仅 loopback 绑定暴露。
      const isHealthz = req.method === "GET" && new URL(req.url).pathname === "/healthz";
      if (isHealthz) {
        if (!isAllowedHost(req.headers.get("host"), boundHost)) {
          return json(403, { error: "host not allowed" });
        }
        if (LOOPBACK_HOSTS.has(boundHost)) {
          return json(200, {
            ok: true,
            version: VERSION,
            uptimeMs: Date.now() - startedAt,
            sessions: sessionManager.list().length,
            activeTasks: active,
          });
        }
        return json(404, { error: "not found" });
      }
      lastRequestAt = Date.now();
      if (!checkAuth(req)) return unauthorized();
      // P0-5：loopback 绑定时校验 Host（DNS rebinding 纵深防御）
      if (!isAllowedHost(req.headers.get("host"), boundHost)) {
        return json(403, { error: "host not allowed" });
      }
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // ============ 自治模式 /tasks ============
      if (method === "POST" && path === "/tasks") {
        if (active >= maxConcurrent)
          return json(429, { error: "too many concurrent tasks", active });
        const parsed = await readJsonBody(req);
        if (parsed instanceof Response) return parsed;
        const body = parsed.body as TaskRequest;
        if (typeof body.goal !== "string" || body.goal === "") {
          return json(400, { error: "goal is required" });
        }
        const handle = runTask(body, {
          ...config.runOptions,
          ...(trajectoryFactory !== undefined ? { trajectory: trajectoryFactory } : {}),
        });
        active += 1;
        tasks.set(handle.id, {
          handle,
          result: handle.result().finally(() => {
            active -= 1;
          }),
        });
        return json(202, { id: handle.id });
      }

      const tm = /^\/tasks\/([a-zA-Z0-9-]+)(\/.*)?$/.exec(path);
      if (tm !== null) {
        const taskId = tm[1] as string;
        const sub = tm[2] ?? "";
        const task = tasks.get(taskId);
        if (task === undefined) return json(404, { error: `task ${taskId} not found` });

        if (method === "GET" && sub === "/events") {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();
          let eventId = 0;
          let queue: TaskEvent[] = [];
          let closed = false;
          void (async () => {
            try {
              for await (const e of task.handle.events) {
                if (closed) return;
                queue.push(e);
                if (queue.length > MAX_QUEUE)
                  queue = queue.filter((x) => x.type !== "message_update");
                while (queue.length > 0 && !closed) {
                  const ev = queue.shift();
                  if (ev === undefined) break;
                  eventId += 1;
                  await writer.write(encoder.encode(sseFormat(ev, eventId)));
                  if (ev.type === "task_done") {
                    await writer.close();
                    closed = true;
                    return;
                  }
                }
              }
            } catch {
              if (!closed) {
                await writer.close().catch(() => {});
                closed = true;
              }
            }
          })();
          return new Response(readable, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }
        if (method === "GET" && sub === "") {
          const settled = await Promise.race([task.result, Promise.resolve(null)]);
          return settled !== null
            ? json(200, { id: taskId, status: "finished", result: settled })
            : json(200, { id: taskId, status: "running" });
        }
        if (method === "POST" && sub === "/steer") {
          const parsed = await readJsonBody(req);
          if (parsed instanceof Response) return parsed;
          const body = parsed.body as { text?: string };
          if (typeof body.text !== "string" || body.text === "")
            return json(400, { error: "text is required" });
          try {
            await task.handle.steer(body.text);
            return json(200, { ok: true });
          } catch (e) {
            return json(409, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (method === "POST" && sub === "/abort") {
          const parsed = await readJsonBody(req);
          if (parsed instanceof Response) return parsed;
          const body = parsed.body as { reason?: string };
          try {
            await task.handle.abort(body.reason);
            return json(200, { ok: true });
          } catch (e) {
            return json(409, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        const cm = /^\/confirmations\/([a-zA-Z0-9-]+)$/.exec(sub);
        if (method === "POST" && cm !== null) {
          const parsed = await readJsonBody(req);
          if (parsed instanceof Response) return parsed;
          const body = parsed.body as { approve?: boolean };
          try {
            await task.handle.confirm(cm[1] as string, body.approve === true);
            return json(200, { ok: true });
          } catch (e) {
            return json(409, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        return json(404, { error: "not found" });
      }

      // ============ 外部模式 /sessions ============
      if (method === "POST" && path === "/sessions") {
        const parsed = await readJsonBody(req);
        if (parsed instanceof Response) return parsed;
        const body = parsed.body as {
          startUrl?: string;
          allowEval?: boolean;
          allowPrivateNetwork?: boolean;
          backend?: "webkit" | "chrome";
          dataDir?: string;
          chromePath?: string;
          width?: number;
          height?: number;
          userAgent?: string;
          allowUploadDirs?: string[];
          budget?: { maxSteps?: number; wallClockMs?: number };
        };
        // B13 审查 P1-3：S4 网络边界不给请求方——allowPrivateNetwork 需 serve 级
        // env BW_ALLOW_PRIVATE_NETWORK=1 显式开门（用户裁决，非持 token 方可自取）
        if (body.allowPrivateNetwork === true && process.env.BW_ALLOW_PRIVATE_NETWORK !== "1") {
          return json(400, {
            error: "allowPrivateNetwork requires the server to run with BW_ALLOW_PRIVATE_NETWORK=1",
          });
        }
        // B14 审查 P1-4：本地路径面（chromePath/dataDir/allowUploadDirs）同 env 门——
        // 不给持 token 方 spawn 任意可执行文件/读任意目录的原语
        const driverPathsRequested = body.chromePath !== undefined || body.dataDir !== undefined;
        const uploadDirsRequested =
          Array.isArray(body.allowUploadDirs) && (body.allowUploadDirs as string[]).length > 0;
        if (
          (driverPathsRequested || uploadDirsRequested) &&
          process.env.BW_ALLOW_DRIVER_PATHS !== "1"
        ) {
          return json(400, {
            error:
              "chromePath/dataDir/allowUploadDirs require the server to run with BW_ALLOW_DRIVER_PATHS=1",
          });
        }
        try {
          const info = await sessionManager.create(body.startUrl, {
            ...(body.allowEval === true ? { allowEval: true } : {}),
            ...(body.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
            ...(Array.isArray(body.allowUploadDirs)
              ? { allowUploadDirs: body.allowUploadDirs as string[] }
              : {}),
            ...(body.budget !== undefined && typeof body.budget === "object"
              ? { budget: body.budget as { maxSteps?: number; wallClockMs?: number } }
              : {}),
            driver: {
              ...(body.backend !== undefined ? { backend: body.backend } : {}),
              ...(body.dataDir !== undefined ? { dataStore: body.dataDir } : {}),
              ...(body.chromePath !== undefined ? { chromePath: body.chromePath } : {}),
              ...(body.width !== undefined ? { width: body.width } : {}),
              ...(body.height !== undefined ? { height: body.height } : {}),
              ...(body.userAgent !== undefined ? { userAgent: body.userAgent } : {}),
            },
          });
          return json(201, info);
        } catch (e) {
          if (e instanceof SessionLimitError) {
            return json(429, { error: e.message });
          }
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (method === "GET" && path === "/sessions") {
        return json(200, sessionManager.list());
      }

      const sm = /^\/sessions\/([a-zA-Z0-9-]+)(\/.*)?$/.exec(path);
      if (sm !== null) {
        const sessionId = sm[1] as string;
        const subPath = sm[2] ?? "";

        if (method === "GET" && subPath === "") {
          const info = sessionManager.get(sessionId);
          return info !== undefined ? json(200, info) : json(404, { error: "session not found" });
        }
        if (method === "DELETE" && subPath === "") {
          sessionManager.close(sessionId);
          return json(200, { ok: true });
        }
        if (method === "GET" && subPath === "/snapshot") {
          const snap = sessionManager.snapshot(sessionId);
          return json(200, { snapshot: snap });
        }
        if (method === "GET" && subPath === "/events") {
          if (sessionManager.get(sessionId) === undefined) {
            return json(404, { error: "session not found" });
          }
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();
          let eventId = 0;
          void (async () => {
            try {
              for await (const e of sessionManager.events(sessionId)) {
                eventId += 1;
                await writer.write(encoder.encode(sseFormat(e, eventId)));
              }
            } catch {
              /* closed */
            }
            await writer.close().catch(() => {});
          })();
          return new Response(readable, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }

        const cm = /^\/confirmations\/([a-zA-Z0-9-]+)$/.exec(subPath);
        if (method === "POST" && cm !== null) {
          const parsed = await readJsonBody(req);
          if (parsed instanceof Response) return parsed;
          const body = parsed.body as { approve?: boolean };
          const ok = sessionManager.confirm(sessionId, cm[1] as string, body.approve === true);
          return ok ? json(200, { ok: true }) : json(404, { error: "confirmation not found" });
        }

        const toolMatch = /^\/tools\/([a-zA-Z_]+)$/.exec(subPath);
        if (method === "POST" && toolMatch !== null) {
          const toolName = toolMatch[1] as string;
          const parsed = await readJsonBody(req);
          if (parsed instanceof Response) return parsed;
          const body = parsed.body as Record<string, unknown>;
          const result = await sessionManager.executeTool(sessionId, toolName, body);
          if (result.ok) return json(200, result);
          if (result.code === "CONFIRMATION_REQUIRED") return json(202, result);
          return json(400, result);
        }
        return json(404, { error: "not found" });
      }

      return json(404, { error: "not found" });
    },
  });

  return {
    start: async () => {
      await Promise.resolve();
    },
    stop: () => {
      for (const [, t] of tasks) void t.handle.abort("server shutting down");
      sessionManager.closeAll();
      server.stop(true);
    },
    url: `http://${boundHost}:${server.port}`,
    token: authToken,
    sessionManager,
    stats: () => ({
      activeTasks: active,
      sessions: sessionManager.list().length,
      uptimeMs: Date.now() - startedAt,
      lastRequestAt,
    }),
  };
}
