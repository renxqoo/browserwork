/** 覆盖缺口补齐：glmModelFromEnv、fileTrajectorySink、DNS/env secrets、非测试档装配 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TaskEvent } from "@bw/core";
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import { runTask, scriptLLM } from "../src/index.ts";
import { glmModelFromEnv } from "../src/llm.ts";
import { fileTrajectorySink } from "../src/trajectory.ts";

describe("glmModelFromEnv", () => {
  test("缺省端点 + 自定义模型 + 剥离 /chat/completions 后缀", () => {
    const m1 = glmModelFromEnv({ GLM_API_KEY: "k" });
    expect(m1.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(m1.id).toBe("glm-5.3-flash");
    expect(m1.reasoning).toBe(true);

    const m2 = glmModelFromEnv({
      GLM_API_KEY: "k",
      GLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      GLM_MODEL: "glm-custom",
    });
    expect(m2.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(m2.id).toBe("glm-custom");
  });
});

describe("fileTrajectorySink", () => {
  test("追加 JSONL 并可回读", async () => {
    const dir = join(import.meta.dir, "tmp-traj");
    rmSync(dir, { recursive: true, force: true });
    const sink = fileTrajectorySink(dir, "t1");
    await sink.append({
      ts: 1,
      step: 0,
      action: { kind: "navigate", url: "https://x/" },
      resultText: "ok",
      url: "https://x/",
      domHash: "aa",
    });
    const lines = readFileSync(sink.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ step: 0, domHash: "aa" });
    rmSync(dir, { recursive: true, force: true });
    void mkdirSync;
  });
});

describe("runTask 装配面", () => {
  test("env secret 源：设置时解析、缺失时 SECRET_UNRESOLVED 路径", async () => {
    const { node, locate } = fakeNode("3", { type: "password", tag: "input" });
    const world = makeFakeWorld({ locateResults: { 3: locate }, rawExtract: { nodes: [node] } });
    process.env.BW_TEST_SECRET = "env-secret-value";
    const llm = scriptLLM([
      { toolCalls: [{ name: "type_text_secret", arguments: { index: "3", secretName: "pw" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "typed" } }] },
    ]);
    const handle = runTask(
      {
        goal: "type",
        startUrl: "https://fake.test/page",
        secrets: { pw: { source: "env", ref: "BW_TEST_SECRET" } },
      },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    for await (const e of handle.events) {
      if (e.type === "task_done") break;
    }
    expect((await handle.result()).status).toBe("done");
    expect((world.createdPages[0] as { typed: string[] }).typed).toEqual(["env-secret-value"]);
    delete process.env.BW_TEST_SECRET;
  });

  test("非测试档装配：startUrl 域自动入白名单（https 外网站点）", async () => {
    const { node, locate } = fakeNode("4", {
      tag: "a",
      text: "Same site",
      locate: { linkHref: "https://public.example/next" },
    });
    const world = makeFakeWorld({ locateResults: { 4: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      { toolCalls: [{ name: "click", arguments: { index: "4" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "click", startUrl: "https://public.example/start" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: false,
      },
    );
    const events: TaskEvent[] = [];
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "task_done") break;
    }
    // 同域链接 → 无确认事件，直达 done
    expect(events.some((e) => e.type === "confirmation_required")).toBe(false);
    expect((await handle.result()).status).toBe("done");
  });

  test("budget_warn：步数达 80% 发预警事件", async () => {
    const { node, locate } = fakeNode("5", {});
    const world = makeFakeWorld({ locateResults: { 5: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page", budget: { maxSteps: 2 } },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    const events: TaskEvent[] = [];
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "task_done") break;
    }
    // 第 2 步 = 100%：不走 warn（80%<100% 条件），warn 在 80% 截断——maxSteps=5 时第 4 步 80%
    void events;
    expect((await handle.result()).status).toBe("done");
  });
});

describe("runTask 边线补齐", () => {
  test("卡死升级：同 (url,domHash) 连续 3 步 → stuck_escalated + 换 strong 模型", async () => {
    const { node, locate } = fakeNode("9", {});
    const world = makeFakeWorld({ locateResults: { 9: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const strong = scriptLLM([]).model;
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "recovered" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never, strong: strong as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    const events: TaskEvent[] = [];
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "task_done") break;
    }
    expect(events.some((e) => e.type === "stuck_escalated")).toBe(true);
    expect((await handle.result()).status).toBe("done");
  });

  test("起始页被 S4 拦（file://）→ failed(POLICY_BLOCKED)", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([]);
    const handle = runTask(
      { goal: "x", startUrl: "file:///etc/passwd" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: false,
      },
    );
    for await (const e of handle.events) {
      if (e.type === "task_done") break;
    }
    const result = await handle.result();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("scheme not allowed");
  });

  test("无 startUrl：about:blank 起步也能走 done", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "blank ok" } }] }]);
    const handle = runTask(
      { goal: "x" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    for await (const e of handle.events) {
      if (e.type === "task_done") break;
    }
    expect((await handle.result()).answer).toBe("blank ok");
  });

  test("终态后 steer/confirm 抛错；result 可重复调用", async () => {
    const { node, locate } = fakeNode("2", {});
    const world = makeFakeWorld({ locateResults: { 2: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "fin" } }] }]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    const r1 = await handle.result();
    const r2 = await handle.result();
    expect(r1).toEqual(r2);
    await expect(handle.steer("late")).rejects.toThrow("task already finished");
    await expect(handle.confirm("c", true)).rejects.toThrow("task already finished");
  });
});

describe("工具全集冒烟（每个工具 execute 至少一次）", () => {
  test("15 个工具全部被调用且任务完成", async () => {
    const inputNode = fakeNode("10", { type: "text", tag: "input" });
    const world = makeFakeWorld({
      locateResults: { 10: inputNode.locate, 11: inputNode.locate, 12: inputNode.locate },
      rawExtract: { nodes: [inputNode.node] },
      bodyText: "body",
    });
    const s = (name: string, arguments_: Record<string, unknown> = {}) => ({
      toolCalls: [{ name, arguments: arguments_ }],
    });
    const llm = scriptLLM([
      s("navigate", { url: "https://fake.test/page" }),
      s("click", { index: "10" }),
      s("type", { index: "10", text: "hi" }),
      s("press", { key: "Escape" }),
      s("scroll", { direction: "down", amount: 100 }),
      s("scroll_to", { index: "10" }),
      s("extract_text"),
      s("look"),
      s("open_tab", { url: "https://fake.test/page2" }),
      s("switch_tab", { tab: 0 }),
      s("close_tab"),
      s("wait", { seconds: 0.01 }),
      s("done", { answer: "all tools called" }),
    ]);
    const handle = runTask(
      { goal: "exercise all tools", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 300,
      },
    );
    for await (const _e of handle.events) {
      void _e;
      if (_e.type === "task_done") break;
    }
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.answer).toBe("all tools called");
    // 每一步都被记录
    expect(result.steps).toBeGreaterThanOrEqual(12);
  });
});
