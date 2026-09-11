/** B16 装置自测（默认门）：MCP client 协议正确性（假 server）+ 循环边界（假 fetch） */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  fakeServerScript,
  grade,
  McpStdioClient,
  runMcpAgentLoop,
  SMALL_TASKS,
} from "../src/index.ts";

describe("McpStdioClient（假 server 协议）", () => {
  test("initialize → tools/list → tools/call 往返", async () => {
    const script = fakeServerScript([
      { name: "browser_navigate", description: "nav" },
      { name: "browser_snapshot", description: "snap" },
    ]);
    const dir = join(import.meta.dir, "tmp-mcp");
    await Bun.write(join(dir, "fake-server.mjs"), script).catch(async () => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      await Bun.write(join(dir, "fake-server.mjs"), script);
    });
    const client = new McpStdioClient({
      command: "bun",
      args: [join(dir, "fake-server.mjs")],
      startupTimeoutMs: 15_000,
    });
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["browser_navigate", "browser_snapshot"]);
      const r = await client.callTool("browser_navigate", { url: "https://x/" });
      expect(r.content[0]?.text).toBe("called:browser_navigate");
      expect(r.isError).toBeFalsy();
    } finally {
      client.stop();
    }
  }, 30_000);
});

describe("runMcpAgentLoop（假 fetch 剧本）", () => {
  const makeFetch = (
    turns: Array<{ toolCalls?: Array<{ name: string; arguments: string }>; text?: string }>,
  ) => {
    let call = 0;
    const seenBodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seenBodies.push(body);
      const turn = turns[Math.min(call++, turns.length - 1)] ?? {};
      const toolCalls =
        turn.toolCalls !== undefined
          ? turn.toolCalls.map((tc, i) => ({
              id: `c${call}-${i}`,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
          : undefined;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: turn.text ?? null,
                ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    return { fetchFn, seenBodies };
  };

  test("工具循环 → done 收束，usage/steps 采集", async () => {
    const { fetchFn, seenBodies } = makeFetch([
      { toolCalls: [{ name: "browser_navigate", arguments: '{"url":"https://x/"}' }] },
      { toolCalls: [{ name: "done", arguments: '{"answer":"the answer is fast bun"}' }] },
    ]);
    let called = 0;
    const r = await runMcpAgentLoop({
      goal: "test",
      baseUrl: "http://fake.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "sys",
      finishTool: "done",
      tools: [{ name: "browser_navigate" }, { name: "done" }],
      callTool: async () => {
        called += 1;
        return { ok: true, text: "ok" };
      },
      fetchFn,
    });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("the answer is fast bun");
    expect(called).toBe(1);
    expect(r.usage).toEqual({ input: 200, output: 20 });
    expect(r.steps).toHaveLength(2);
    // 工具结果以 tool 消息回传（done 前那轮请求里可见）
    const second = seenBodies[1] as { messages?: Array<{ role: string; content?: string }> };
    expect(JSON.stringify(second?.messages)).toContain("ok");
  });

  test("maxSteps 上限截断", async () => {
    const { fetchFn } = makeFetch([{ toolCalls: [{ name: "browser_snapshot", arguments: "{}" }] }]);
    const r = await runMcpAgentLoop({
      goal: "loop",
      baseUrl: "http://fake.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      finishTool: "done",
      tools: [{ name: "browser_snapshot" }],
      callTool: async () => ({ ok: true, text: "x" }),
      maxSteps: 3,
      fetchFn,
    });
    expect(r.ok).toBe(false);
    expect(r.steps.length).toBe(3);
  });

  test("provider 错误如实返回", async () => {
    const fetchFail = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const r = await runMcpAgentLoop({
      goal: "x",
      baseUrl: "http://fake.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      finishTool: "done",
      tools: [],
      callTool: async () => ({ ok: true, text: "" }),
      fetchFn: fetchFail,
    });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toContain("401");
  });
});

describe("任务集口径", () => {
  test("5 任务、锚点小写命中", () => {
    expect(SMALL_TASKS.length).toBeGreaterThanOrEqual(3);
    const t = SMALL_TASKS[0];
    expect(t).toBeTruthy();
    if (t !== undefined) {
      expect(grade(t, "Bun is FAST")).toBe(true);
      expect(grade(t, "nothing relevant")).toBe(false);
    }
  });
});

describe("McpStdioClient 边角", () => {
  test("stop 后 pending 全拒 + 幂等", async () => {
    const script = fakeServerScript([]);
    const dir = join(import.meta.dir, "tmp-mcp2");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "fake-server.mjs"), script);
    const client = new McpStdioClient({
      command: "bun",
      args: [join(dir, "fake-server.mjs")],
      startupTimeoutMs: 15_000,
    });
    await client.start();
    client.stop();
    client.stop(); // 幂等
    await expect(client.listTools()).rejects.toThrow(/stopped/);
  }, 30_000);
});

describe("runMcpAgentLoop 边角", () => {
  test("工具失败以 ERROR 回传（下轮可见）+ 坏 JSON 参数按空对象", async () => {
    let call = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      call += 1;
      const calls =
        call === 1
          ? [
              {
                id: "a1",
                type: "function" as const,
                function: { name: "t1", arguments: "NOT-JSON" },
              },
            ]
          : call === 2
            ? [{ id: "a2", type: "function" as const, function: { name: "t1", arguments: "{}" } }]
            : undefined;
      return new Response(
        JSON.stringify({
          choices: [
            calls !== undefined
              ? { message: { content: null, tool_calls: calls } }
              : { message: { content: "final answer fast" } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const seenArgs: Array<Record<string, unknown>> = [];
    const r = await runMcpAgentLoop({
      goal: "g",
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      finishTool: "done",
      tools: [{ name: "t1" }],
      callTool: async (_n, args) => {
        seenArgs.push(args);
        return { ok: false, text: "tool exploded" };
      },
      fetchFn,
    });
    expect(r.answer).toBe("final answer fast");
    expect(seenArgs[0]).toEqual({}); // 坏 JSON → 空对象
    expect(r.steps.every((s) => !s.ok)).toBe(true);
    const second = bodies[1] as { messages?: Array<{ content?: string }> };
    expect(JSON.stringify(second?.messages)).toContain("ERROR: tool exploded");
  });

  test("空 choice 如实失败", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
    const r = await runMcpAgentLoop({
      goal: "g",
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      finishTool: "done",
      tools: [],
      callTool: async () => ({ ok: true, text: "" }),
      fetchFn,
    });
    expect(r.error).toBe("empty choice");
  });

  test("finish 工具收束（带 answer 解析）", async () => {
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      const calls =
        call === 1
          ? [
              {
                id: "f1",
                type: "function" as const,
                function: { name: "done", arguments: '{"answer":"fast bun"}' },
              },
            ]
          : undefined;
      return new Response(
        JSON.stringify({
          choices: [
            calls !== undefined
              ? { message: { content: null, tool_calls: calls } }
              : { message: { content: "x" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await runMcpAgentLoop({
      goal: "g",
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      finishTool: "done",
      tools: [{ name: "done" }],
      callTool: async () => ({ ok: true, text: "" }),
      fetchFn,
    });
    expect(r.answer).toBe("fast bun");
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.toolName).toBe("done");
  });
});

describe("McpStdioClient error 响应", () => {
  test("RPC error → reject（error.message 透传）", async () => {
    const script = `
let buf = "";
const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1); nl = buf.indexOf("\\n");
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    } else {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
    }
  }
});
`;
    const dir = join(import.meta.dir, "tmp-mcp3");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "err-server.mjs"), script);
    const client = new McpStdioClient({
      command: "bun",
      args: [join(dir, "err-server.mjs")],
      startupTimeoutMs: 15_000,
      callTimeoutMs: 5_000,
    });
    await client.start();
    await expect(client.listTools()).rejects.toThrow(/method not found/);
    client.stop();
  }, 30_000);
});

describe("McpStdioClient 超时", () => {
  test("无响应 → 超时 reject", async () => {
    const script = `
let buf = "";
const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1); nl = buf.indexOf("\\n");
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    }
    // 其它 method 永不回——触发客户端超时
  }
});
`;
    const dir = join(import.meta.dir, "tmp-mcp4");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "silent-server.mjs"), script);
    const client = new McpStdioClient({
      command: "bun",
      args: [join(dir, "silent-server.mjs")],
      startupTimeoutMs: 15_000,
      callTimeoutMs: 300,
    });
    await client.start();
    await expect(client.listTools()).rejects.toThrow(/timed out/);
    client.stop();
  }, 30_000);
});
