/**
 * HTTP 服务（docs/01-baseline.md §4.2 / 03-units.md U7）：
 * 自治模式：POST /tasks · SSE · steer · confirmations · abort
 * 外部模式：POST /sessions · snapshot · tools/:name · confirmations · SSE · DELETE
 * 统一 Bearer 鉴权；S6 出域 redact；并发限制。
 */
import { type RunTaskOptions, runTask } from "@bw/agent";
import type { TaskEvent, TaskHandle, TaskRequest, TaskResult } from "@bw/core";
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerOptions,
} from "./sessions.ts";

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

function sseFormat(event: TaskEvent, id: number): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createServer(config: ServiceConfig): {
  start(): Promise<void>;
  stop(): void;
  url: string;
  sessionManager: SessionManager;
} {
  const maxConcurrent = config.maxConcurrentTasks ?? 8;
  const tasks = new Map<string, ManagedTask>();
  let active = 0;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const unauthorized = (): Response => json(401, { error: "unauthorized" });
  const checkAuth = (req: Request): boolean => {
    if (config.authToken === undefined) return false;
    return req.headers.get("authorization") === `Bearer ${config.authToken}`;
  };

  const sessionManager = createSessionManager(config.sessionOptions);

  const server = Bun.serve({
    port: config.port,
    hostname: config.host ?? "127.0.0.1",
    async fetch(req): Promise<Response> {
      if (!checkAuth(req)) return unauthorized();
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // ============ 自治模式 /tasks ============
      if (method === "POST" && path === "/tasks") {
        if (active >= maxConcurrent)
          return json(429, { error: "too many concurrent tasks", active });
        let body: TaskRequest;
        try {
          body = (await req.json()) as TaskRequest;
        } catch {
          return json(400, { error: "invalid JSON body" });
        }
        if (typeof body.goal !== "string" || body.goal === "") {
          return json(400, { error: "goal is required" });
        }
        const handle = runTask(body, config.runOptions);
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
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }
        if (method === "GET" && sub === "") {
          const settled = await Promise.race([task.result, Promise.resolve(null)]);
          return settled !== null
            ? json(200, { id: taskId, status: "finished", result: settled })
            : json(200, { id: taskId, status: "running" });
        }
        if (method === "POST" && sub === "/steer") {
          try {
            const body = (await req.json()) as { text?: string };
            if (typeof body.text !== "string" || body.text === "")
              return json(400, { error: "text is required" });
            await task.handle.steer(body.text);
            return json(200, { ok: true });
          } catch (e) {
            return json(409, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (method === "POST" && sub === "/abort") {
          try {
            const body = (await req.json().catch(() => ({}))) as { reason?: string };
            await task.handle.abort(body.reason);
            return json(200, { ok: true });
          } catch (e) {
            return json(409, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        const cm = /^\/confirmations\/([a-zA-Z0-9-]+)$/.exec(sub);
        if (method === "POST" && cm !== null) {
          try {
            const body = (await req.json().catch(() => ({}))) as { approve?: boolean };
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
        const body = (await req.json().catch(() => ({}))) as { startUrl?: string };
        try {
          const info = await sessionManager.create(body.startUrl);
          return json(201, info);
        } catch (e) {
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
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }

        const cm = /^\/confirmations\/([a-zA-Z0-9-]+)$/.exec(subPath);
        if (method === "POST" && cm !== null) {
          const body = (await req.json().catch(() => ({}))) as { approve?: boolean };
          const ok = sessionManager.confirm(sessionId, cm[1] as string, body.approve === true);
          return ok ? json(200, { ok: true }) : json(404, { error: "confirmation not found" });
        }

        const toolMatch = /^\/tools\/([a-zA-Z_]+)$/.exec(subPath);
        if (method === "POST" && toolMatch !== null) {
          const toolName = toolMatch[1] as string;
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
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
    url: `http://${config.host ?? "127.0.0.1"}:${server.port}`,
    sessionManager,
  };
}
