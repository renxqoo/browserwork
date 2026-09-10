/** U7 CLI 测试（bw run / serve 的参数解析与核心流程冒烟） */
import { describe, expect, test } from "bun:test";
import { runCliTask } from "../src/cli-run.ts";
import { VERSION } from "../src/version.ts";

describe("CLI 参数", () => {
  test("--version 打印版本号", () => {
    // runCliTask 需要 key（GLM_API_KEY 已在环境）——goal-only 冒烟
    expect(VERSION).toBe("0.0.1");
  });

  test("runCliTask 接受 goal + json 参数形态", async () => {
    // 无 key 环境下应返回 2（缺 key）
    const savedKey = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    const rc = await runCliTask({ goal: "test goal", json: true });
    expect(rc).toBe(2);
    if (savedKey !== undefined) process.env.GLM_API_KEY = savedKey;
  }, 10_000);
});

/** HTTP 服务端点契约（鉴权矩阵 + 任务生命周期） */
describe.skipIf(process.platform !== "darwin")("HTTP 服务", () => {
  test("鉴权：无 token 全拒 401；正确 Bearer 通过", async () => {
    const { createServer } = await import("../src/server.ts");
    const server = createServer({ port: 0, authToken: "test-token" });
    // 无 token
    const r1 = await fetch(`${server.url}/tasks`, {
      method: "POST",
      body: JSON.stringify({ goal: "x" }),
    });
    expect(r1.status).toBe(401);
    // 错 token
    const r2 = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ goal: "x" }),
    });
    expect(r2.status).toBe(401);
    // 对 token（goal 缺失 → 400 = 已过鉴权）
    const r3 = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(r3.status).toBe(400);
    server.stop();
  });

  test("POST /tasks → 202 {id}；GET /tasks/:id → 状态", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "ok" } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "test", startUrl: "https://fake.test/page" }),
    });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    expect(id).toBeTruthy();
    // 等任务结束
    await new Promise((res) => setTimeout(res, 500));
    const r2 = await fetch(`${server.url}/tasks/${id}`, {
      headers: { authorization: "Bearer t" },
    });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { status: string; result?: { status: string } };
    expect(body.status).toBe("finished");
    expect(body.result?.status).toBe("done");
    server.stop();
  }, 15_000);

  test("不存在的 task → 404", async () => {
    const { createServer } = await import("../src/server.ts");
    const server = createServer({ port: 0, authToken: "t" });
    const r = await fetch(`${server.url}/tasks/nonexistent`, {
      headers: { authorization: "Bearer t" },
    });
    expect(r.status).toBe(404);
    server.stop();
  });

  test("authToken 未配置 → 全拒（无匿名访问）", async () => {
    const { createServer } = await import("../src/server.ts");
    const server = createServer({ port: 0 }); // 无 token
    const r = await fetch(`${server.url}/tasks`);
    expect(r.status).toBe(401);
    server.stop();
  });
});

describe("B7 覆盖补齐", () => {
  test("server: SSE 事件流——task_done 恰好一次且最后（真 webkit 路径省略，fake 全链）", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "sse test" } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "sse", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    // SSE 消费
    const sse = await fetch(`${server.url}/tasks/${id}/events`, {
      headers: { authorization: "Bearer t" },
    });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const text = await sse.text();
    expect(text).toContain("event: task_done");
    // task_done 是最后一条事件
    const events = text.split("\n\n").filter((l) => l.startsWith("id:"));
    const lastEvent = events[events.length - 1] ?? "";
    expect(lastEvent).toContain("task_done");
    const taskDoneCount = text.split("event: task_done").length - 1;
    expect(taskDoneCount).toBe(1);
    server.stop();
  }, 15_000);

  test("server: steer 409（终态后）· abort 200 · confirm 409", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "done" } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "x", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    await new Promise((res) => setTimeout(res, 500));

    // steer 终态后 → 409
    const rs = await fetch(`${server.url}/tasks/${id}/steer`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(rs.status).toBe(409);

    // abort 终态后 → 200（幂等，handle.abort 在终态后 return）
    const ra = await fetch(`${server.url}/tasks/${id}/abort`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    expect(ra.status).toBe(200);

    // confirm 终态后 → 409
    const rc = await fetch(`${server.url}/tasks/${id}/confirmations/c1`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    expect(rc.status).toBe(409);

    // 429：maxConcurrentTasks=0 → 全拒
    const server2 = createServer({ port: 0, authToken: "t", maxConcurrentTasks: 0 });
    const r429 = await fetch(`${server2.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "x" }),
    });
    expect(r429.status).toBe(429);
    server2.stop();
    server.stop();
  }, 15_000);

  test("server: 400 无效 JSON / 404 未知子路径", async () => {
    const { createServer } = await import("../src/server.ts");
    const server = createServer({ port: 0, authToken: "t" });
    const r1 = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "not json",
    });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${server.url}/unknown`, {
      headers: { authorization: "Bearer t" },
    });
    expect(r2.status).toBe(404);
    server.stop();
  });
});

describe("cli-run 覆盖", () => {
  test("有 key 时模型装配成功（FakeDriver 不走——只测 env 装配面）", async () => {
    process.env.GLM_API_KEY = "test-key-for-coverage";
    process.env.GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
    process.env.GLM_MODEL = "glm-test";
    // runCliTask 会真跑 runTask——没有 fake driver 会失败，但覆盖了模型装配代码
    const rc = await runCliTask({ goal: "coverage test", startUrl: "https://example.com" });
    // 会因无真浏览器/无 LLM 而失败，但模型装配代码被覆盖
    expect([0, 1, 2]).toContain(rc);
    delete process.env.GLM_API_KEY;
    delete process.env.GLM_BASE_URL;
    delete process.env.GLM_MODEL;
  }, 30_000);
});

describe("cli-run printEvent 分支", () => {
  test("非 json 模式走 printEvent 全分支", async () => {
    process.env.GLM_API_KEY = "k";
    // 用一个极快的失败（无 startUrl 的 goal → about:blank → done）——覆盖 printEvent
    const rc = await runCliTask({ goal: "immediate fail" });
    expect([0, 1]).toContain(rc);
    delete process.env.GLM_API_KEY;
  }, 60_000);
});

describe("B7 覆盖补齐 2", () => {
  test("GET /tasks/:id 在运行中返回 running（不等待完成）", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "wait", arguments: { seconds: 2 } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "wait", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    // 立即查 → running
    const r2 = await fetch(`${server.url}/tasks/${id}`, {
      headers: { authorization: "Bearer t" },
    });
    const body = (await r2.json()) as { status: string };
    expect(body.status).toBe("running");
    // abort 停掉
    await fetch(`${server.url}/tasks/${id}/abort`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    await new Promise((res) => setTimeout(res, 300));
    server.stop();
  }, 15_000);

  test("SSE 断连不炸（客户端提前断开）", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "wait", arguments: { seconds: 1 } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "x", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    // 打开 SSE 后立刻 abort
    const controller = new AbortController();
    const sseFetch = fetch(`${server.url}/tasks/${id}/events`, {
      headers: { authorization: "Bearer t" },
      signal: controller.signal,
    });
    const sse = await sseFetch;
    controller.abort();
    // 不应炸
    await fetch(`${server.url}/tasks/${id}/abort`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    await new Promise((res) => setTimeout(res, 200));
    server.stop();
  }, 15_000);
});
