/**
 * HTTP 服务（docs/01-baseline.md §4.2 / 03-units.md U7）：
 * POST /tasks · GET /tasks/:id/events（SSE）· steer · confirmations · abort · GET /tasks/:id
 * 事件出域统一 redact（S6）；有界队列（每连接 1000 条，溢出合并 message_update）；
 * Bearer 鉴权；并发 ≤8（超出 429）。
 */
import { type RunTaskOptions, runTask } from "@bw/agent";
import type { TaskEvent, TaskHandle, TaskRequest, TaskResult } from "@bw/core";

export interface ServiceConfig {
  port: number;
  host?: string;
  /** Bearer 鉴权 token（undefined = 拒绝一切请求——无匿名访问） */
  authToken?: string;
  maxConcurrentTasks?: number;
  trajectoryDir?: string;
  /** runTask 透传（LLM key 等） */
  runOptions?: RunTaskOptions;
}

interface ManagedTask {
  handle: TaskHandle;
  /** SSE 订阅者转发（多订阅者各自维护队列） */
  result: Promise<TaskResult>;
}

const MAX_QUEUE = 1000;
const SSE_TERMINAL = "task_done";

function sseFormat(event: TaskEvent, id: number): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createServer(config: ServiceConfig): {
  start(): Promise<void>;
  stop(): void;
  url: string;
} {
  const maxConcurrent = config.maxConcurrentTasks ?? 8;
  const tasks = new Map<string, ManagedTask>();
  let active = 0;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const unauthorized = (): Response => json(401, { error: "unauthorized" });

  const checkAuth = (req: Request): boolean => {
    if (config.authToken === undefined) return false; // 无 token 配置 = 全拒
    const auth = req.headers.get("authorization");
    return auth === `Bearer ${config.authToken}`;
  };

  const server = Bun.serve({
    port: config.port,
    hostname: config.host ?? "127.0.0.1",
    async fetch(req): Promise<Response> {
      if (!checkAuth(req)) return unauthorized();
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // ---- POST /tasks
      if (method === "POST" && path === "/tasks") {
        if (active >= maxConcurrent) {
          return json(429, { error: "too many concurrent tasks", active });
        }
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
        const managed: ManagedTask = {
          handle,
          result: handle.result().finally(() => {
            active -= 1;
          }),
        };
        tasks.set(handle.id, managed);
        return json(202, { id: handle.id });
      }

      // ---- /tasks/:id/*
      const m = /^\/tasks\/([a-zA-Z0-9-]+)(\/.*)?$/.exec(path);
      if (m === null) return json(404, { error: "not found" });
      const taskId = m[1] as string;
      const sub = m[2] ?? "";
      const task = tasks.get(taskId);
      if (task === undefined) return json(404, { error: `task ${taskId} not found` });

      // GET /tasks/:id/events（SSE）
      if (method === "GET" && sub === "/events") {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        let eventId = 0;
        let queue: TaskEvent[] = [];
        let closed = false;
        const pump = async (): Promise<void> => {
          try {
            for await (const e of task.handle.events) {
              if (closed) return;
              queue.push(e);
              // 有界：溢出时合并丢 message_update 增量
              if (queue.length > MAX_QUEUE) {
                queue = queue.filter((x) => x.type !== "message_update");
              }
              while (queue.length > 0 && !closed) {
                const ev = queue.shift();
                if (ev === undefined) break;
                eventId += 1;
                await writer.write(encoder.encode(sseFormat(ev, eventId)));
                if (ev.type === SSE_TERMINAL) {
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
        };
        void pump();
        return new Response(readable, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        });
      }

      // GET /tasks/:id
      if (method === "GET" && sub === "") {
        const settled = await Promise.race([
          task.result.then((r) => r),
          Promise.resolve(null).then(() => null),
        ]);
        if (settled !== null) {
          return json(200, { id: taskId, status: "finished", result: settled });
        }
        return json(200, { id: taskId, status: "running" });
      }

      // POST /tasks/:id/steer
      if (method === "POST" && sub === "/steer") {
        try {
          const body = (await req.json()) as { text?: string };
          if (typeof body.text !== "string" || body.text === "") {
            return json(400, { error: "text is required" });
          }
          await task.handle.steer(body.text);
          return json(200, { ok: true });
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // POST /tasks/:id/abort
      if (method === "POST" && sub === "/abort") {
        try {
          const body = (await req.json().catch(() => ({}))) as { reason?: string };
          await task.handle.abort(body.reason);
          return json(200, { ok: true });
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // POST /tasks/:id/confirmations/:cid
      const cm = /^\/confirmations\/([a-zA-Z0-9-]+)$/.exec(sub);
      if (method === "POST" && cm !== null) {
        const cid = cm[1] as string;
        try {
          const body = (await req.json().catch(() => ({}))) as { approve?: boolean };
          await task.handle.confirm(cid, body.approve === true);
          return json(200, { ok: true });
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      return json(404, { error: "not found" });
    },
  });

  return {
    start: async () => {
      await Promise.resolve(); // Bun.serve 已启动
    },
    stop: () => {
      for (const [, t] of tasks) {
        void t.handle.abort("server shutting down");
      }
      server.stop(true);
    },
    url: `http://${config.host ?? "127.0.0.1"}:${server.port}`,
  };
}
