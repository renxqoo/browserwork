/**
 * B12（05 §3.1–3.4）：渲染 diff 复用 / keep-2 只数全量 / image keep-1 /
 * 窗口分阶段裁剪 / strong abort+continue / costUsd / contextWindow 预警。
 */
import { describe, expect, test } from "bun:test";
import type { TaskEvent } from "@bw/core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import { compactSnapshots, runTask, type ScriptStep, scriptLLM } from "../src/index.ts";

async function drain(
  handle: { events: AsyncIterable<TaskEvent> },
  onConfirm?: (cid: string) => Promise<void>,
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const e of handle.events) {
    events.push(e);
    if (e.type === "confirmation_required" && e.cid !== undefined && onConfirm !== undefined) {
      await onConfirm(e.cid);
    }
    if (e.type === "task_done") break;
  }
  return events;
}

const msgText = (m: AgentMessage): string => JSON.stringify(m);

describe("B12 §3.1 渲染 diff 快照复用", () => {
  test("静态页：首个动作全量快照，其后 unchanged 标记", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    // 第 2 次调用的上下文里：第 1 个 wait 全量、无 unchanged；第 3 次调用里第 2 个 wait 是 unchanged
    const ctx2 = llm.calls[1];
    const ctx3 = llm.calls[2];
    expect(ctx2).toBeTruthy();
    expect(ctx3).toBeTruthy();
    expect(JSON.stringify(ctx2?.messages)).toContain("# Page:");
    expect(JSON.stringify(ctx2?.messages)).not.toContain("page unchanged");
    expect(JSON.stringify(ctx3?.messages)).toContain("page unchanged since last step");
  });

  test("值变更（审查 P0-2）：渲染含 [value: x] 变化 → 仍全量快照", async () => {
    const { node, locate } = fakeNode("2", {});
    const world = makeFakeWorld({
      locateResults: { 2: locate },
      rawExtract: { nodes: [node] },
      extractSequence: [
        { nodes: [{ ...node, value: "" }] },
        { nodes: [{ ...node, value: "hello" }] },
      ],
    });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    // open_tab 消耗序列首项(value:"")，wait 消耗第二项(value:"hello") → 第 2 次调用即含新值
    const ctx2 = JSON.stringify(llm.calls[1]?.messages);
    expect(ctx2).toContain("[value: hello]");
    expect(ctx2).not.toContain("page unchanged since last step");
  });

  test("keep-2 只数全量（审查 P0-1）：连续 unchanged 不把全量挤出保留窗", async () => {
    const { node, locate } = fakeNode("3", {});
    const world = makeFakeWorld({ locateResults: { 3: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    // 第 5 次调用（done 前）：结果序列 = 全量,unchanged×3——全量必须仍在上下文
    const msgs = JSON.stringify(llm.calls[4]?.messages);
    expect(msgs).toContain("# Page:");
    expect((msgs.match(/# Page:/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test("动态页：三个不同快照 → 更早的压单行（keep-2 语义不回归）", async () => {
    const { node, locate } = fakeNode("4", {});
    const mk = (text: string): Array<Record<string, unknown>> => [{ ...node, text }];
    const world = makeFakeWorld({
      locateResults: { 4: locate },
      rawExtract: { nodes: mk("a") },
      extractSequence: [
        { nodes: mk("a") },
        { nodes: mk("b") },
        { nodes: mk("c") },
        { nodes: mk("d") },
      ],
    });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    const msgs = JSON.stringify(llm.calls[3]?.messages);
    expect((msgs.match(/# Page:/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(msgs).toContain("[snapshot removed:");
  });
});

describe("B12 §3.2 截图与窗口治理", () => {
  test("look 截图只保最近 1 张，更早替换 [screenshot removed]", async () => {
    const { node, locate } = fakeNode("5", {});
    const world = makeFakeWorld({ locateResults: { 5: locate }, rawExtract: { nodes: [node] } });
    const look = { name: "look", arguments: {} };
    const llm = scriptLLM([
      { toolCalls: [look] },
      { toolCalls: [look] },
      { toolCalls: [look] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    const raw = llm.calls[3]?.messages ?? [];
    const images = raw
      .filter((m) => m.role === "toolResult")
      .map((m) => msgText(m).match(/"type":"image"/g)?.length ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(images).toBeLessThanOrEqual(1);
    expect(JSON.stringify(raw)).toContain("[screenshot removed]");
  });

  const toolResult = (text: string, extra: unknown[] = []): AgentMessage =>
    ({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "t",
      content: [{ type: "text", text }, ...extra],
      isError: false,
      timestamp: 1,
    }) as unknown as AgentMessage;
  const assistant = (parts: unknown[]): AgentMessage =>
    ({
      role: "assistant",
      content: parts,
      usage: { input: 0, output: 0 },
      stopReason: "toolUse",
      timestamp: 1,
    }) as unknown as AgentMessage;
  const user = (text: string): AgentMessage =>
    ({ role: "user", content: text, timestamp: 1 }) as unknown as AgentMessage;
  const snapshotTool = (body: string): AgentMessage =>
    toolResult(`waited\n[SNAPSHOT]\n# Page: t\n${body}`);

  test("compactSnapshots 直接单测：无窗口 → 仅阶段 0", () => {
    const ms = [
      user("goal"),
      assistant([{ type: "toolCall", id: "c1", name: "t", arguments: {} }]),
      snapshotTool("a".repeat(3000)),
      assistant([{ type: "toolCall", id: "c2", name: "t", arguments: {} }]),
      snapshotTool("b".repeat(3000)),
      assistant([{ type: "toolCall", id: "c3", name: "t", arguments: {} }]),
      snapshotTool("c".repeat(3000)),
    ];
    const out = compactSnapshots(ms);
    const texts = out.map((m) => msgText(m)).join("");
    expect((texts.match(/# Page:/g) ?? []).length).toBe(2);
    expect(texts).toContain("[snapshot removed:");
  });

  test("compactSnapshots 窗口裁剪：阶段渐进 + toolCall part 结构不变", () => {
    const big = (t: string): string => t.repeat(500);
    const ms: AgentMessage[] = [
      user("goal"),
      assistant([
        { type: "text", text: big("assistant-narration") },
        { type: "toolCall", id: "c1", name: "t", arguments: {} },
      ]),
      toolResult(big("plain-result-xyz")),
      assistant([{ type: "toolCall", id: "c2", name: "t", arguments: {} }]),
      snapshotTool(big("snapA")),
      assistant([{ type: "toolCall", id: "c3", name: "t", arguments: {} }]),
      snapshotTool(big("snapB")),
      assistant([{ type: "toolCall", id: "c4", name: "t", arguments: {} }]),
      snapshotTool(big("snapC")),
    ];
    // 估算远超 0.5×窗口 → 三阶段全触发
    const out = compactSnapshots(ms, { contextWindowTokens: 1500 });
    const texts = out.map((m) => msgText(m)).join("");
    // 阶段 1：普通 toolResult 已单行化
    expect(texts).toContain("[result:");
    // 阶段 2：快照 2→1
    expect((texts.match(/# Page:/g) ?? []).length).toBe(1);
    // 阶段 3：assistant 长文本被截断、toolCall part 原样（结构不变）
    const first = out[1];
    expect(first).toBeTruthy();
    if (first !== undefined && first.role === "assistant") {
      const parts = first.content as Array<{ type: string; text?: string }>;
      const textPart = parts.find((c) => c.type === "text");
      expect(textPart?.text).toContain("…[truncated]");
      expect(parts.filter((c) => c.type === "toolCall")).toHaveLength(1);
    }
  });

  test("contextWindow 预警：50%/80% 两档各一次", async () => {
    const { node, locate } = fakeNode("6", {});
    const world = makeFakeWorld({ locateResults: { 6: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait], usage: { input: 55_000, output: 5 } },
      { toolCalls: [wait], usage: { input: 85_000, output: 5 } },
      {
        toolCalls: [{ name: "done", arguments: { answer: "ok" } }],
        usage: { input: 90_000, output: 5 },
      },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    const events = await drain(handle);
    const warns = events.filter(
      (e) => e.type === "budget_warn" && e.dimension === "contextWindow",
    ) as Array<{ usedPct?: number }>;
    const pcts = warns.map((w) => w.usedPct).sort();
    expect(pcts).toContain(50);
    expect(pcts).toContain(80);
    // 各档恰好一次
    expect(warns.filter((w) => w.usedPct === 50)).toHaveLength(1);
    expect(warns.filter((w) => w.usedPct === 80)).toHaveLength(1);
  });
});

describe("B12 §3.3 strong 模型路由（abort + prompt continue）", () => {
  test("卡死升级：strong 续跑完成 + 模型 id 切换 + 状态迁移", async () => {
    const { node, locate } = fakeNode("7", {});
    const world = makeFakeWorld({ locateResults: { 7: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const script: ScriptStep[] = [
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [wait] }, // 第 3 步触发升级 → abort → continue
      { toolCalls: [{ name: "done", arguments: { answer: "strong finished" } }] },
    ];
    const llm = scriptLLM(script);
    const fast = { ...llm.model, id: "fast-m" };
    const strong = { ...llm.model, id: "strong-m" };
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: fast as never, strong: strong as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    const events = await drain(handle);
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.answer).toBe("strong finished");
    expect(events.some((e) => e.type === "stuck_escalated")).toBe(true);
    // 模型切换实证：前 3 次调用 fast-m，续跑那次 strong-m
    expect(llm.callModels[0]).toBe("fast-m");
    expect(llm.callModels[1]).toBe("fast-m");
    expect(llm.callModels[2]).toBe("fast-m");
    expect(llm.callModels[3]).toBe("strong-m");
    // 预算连续：3 个 wait 全部计数
    expect(result.steps).toBe(3);
  });

  test("升级后仍卡：failed(stuck after model escalation)", async () => {
    const { node, locate } = fakeNode("8", {});
    const world = makeFakeWorld({ locateResults: { 8: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const script: ScriptStep[] = [];
    for (let i = 0; i < 8; i++) script.push({ toolCalls: [wait] });
    script.push({ toolCalls: [{ name: "done", arguments: { answer: "never" } }] });
    const llm = scriptLLM(script);
    const fast = { ...llm.model, id: "fast-m" };
    const strong = { ...llm.model, id: "strong-m" };
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: fast as never, strong: strong as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    const result = await handle.result();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("stuck after model escalation");
  });
});

describe("B12 §3.4 costUsd", () => {
  test("价目注入：consume + TaskResult.cost", async () => {
    const { node, locate } = fakeNode("9", {});
    const world = makeFakeWorld({ locateResults: { 9: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      { toolCalls: [{ name: "wait", arguments: { seconds: 0.01 } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
        prices: { scripted: { input: 1, output: 2 } }, // (100*1 + 10*2)/1e6 = 0.00012/次
      },
    );
    await drain(handle);
    const result = await handle.result();
    expect(result.cost?.usd).toBeCloseTo(0.00024, 6);
  });

  test("价目缺失且显式 costUsd 预算 → 一次性停用警告", async () => {
    const { node, locate } = fakeNode("10", {});
    const world = makeFakeWorld({ locateResults: { 10: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page", budget: { costUsd: 1 } },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    const events = await drain(handle);
    const warns = events.filter((e) => e.type === "budget_warn" && e.dimension === "costUsd");
    expect(warns).toHaveLength(1);
    const w = warns[0] as { reason?: string };
    expect(w.reason ?? "").toContain("no price configured");
    // 未配价 → 无 cost 字段
    expect((await handle.result()).cost).toBeUndefined();
  });
});

describe("B12 装配面（env 路径覆盖）", () => {
  test("模型三级装配：无 opts.models 时按 req.model/env 解析（GLM_STRONG_MODEL 生效）", async () => {
    const { node, locate } = fakeNode("11", {});
    const world = makeFakeWorld({ locateResults: { 11: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      { toolCalls: [{ name: "wait", arguments: { seconds: 0.01 } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const prevModel = process.env.GLM_MODEL;
    const prevStrong = process.env.GLM_STRONG_MODEL;
    process.env.GLM_MODEL = "env-fast-id";
    process.env.GLM_STRONG_MODEL = "env-strong-id";
    try {
      const handle = runTask(
        { goal: "x", startUrl: "https://fake.test/page" },
        {
          driver: world.driver as never,
          // 不传 models——走 req.model/env 装配
          streamFn: llm.streamFn as never,
          apiKey: "test-key",
          testMode: true,
          settleQuietMs: 10,
          settleCapMs: 200,
        },
      );
      await drain(handle);
      expect(llm.callModels[0]).toBe("env-fast-id");
      expect((await handle.result()).status).toBe("done");
    } finally {
      if (prevModel === undefined) delete process.env.GLM_MODEL;
      else process.env.GLM_MODEL = prevModel;
      if (prevStrong === undefined) delete process.env.GLM_STRONG_MODEL;
      else process.env.GLM_STRONG_MODEL = prevStrong;
    }
  });

  test("BW_PRICES_JSON：合法 JSON 注入价目 / 畸形 JSON 静默停用", async () => {
    const { node, locate } = fakeNode("12", {});
    const mk = (): ReturnType<typeof makeFakeWorld> =>
      makeFakeWorld({ locateResults: { 12: locate }, rawExtract: { nodes: [node] } });
    const prev = process.env.BW_PRICES_JSON;

    // 合法：cost 计入
    process.env.BW_PRICES_JSON = '{"scripted":{"input":1,"output":2}}';
    try {
      const llm1 = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "ok" } }] }]);
      const h1 = runTask(
        { goal: "x", startUrl: "https://fake.test/page" },
        {
          driver: mk().driver as never,
          models: { fast: llm1.model as never },
          streamFn: llm1.streamFn as never,
          testMode: true,
        },
      );
      await drain(h1);
      expect((await h1.result()).cost?.usd).toBeCloseTo(0.00012, 6);
    } finally {
      if (prev === undefined) delete process.env.BW_PRICES_JSON;
      else process.env.BW_PRICES_JSON = prev;
    }

    // 畸形：静默停用（无 cost、无崩溃）
    process.env.BW_PRICES_JSON = "not-json{{{";
    try {
      const llm2 = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "ok" } }] }]);
      const h2 = runTask(
        { goal: "x", startUrl: "https://fake.test/page" },
        {
          driver: mk().driver as never,
          models: { fast: llm2.model as never },
          streamFn: llm2.streamFn as never,
          testMode: true,
        },
      );
      await drain(h2);
      expect((await h2.result()).cost).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BW_PRICES_JSON;
      else process.env.BW_PRICES_JSON = prev;
    }
  });
});

describe("B12 审查处置回归", () => {
  test("P1-1：checkbox 勾选态变化 → 渲染含 [checked] 差异 → 全量快照", async () => {
    const { node, locate } = fakeNode("13", { tag: "input", type: "checkbox" });
    const world = makeFakeWorld({
      locateResults: { 13: locate },
      rawExtract: { nodes: [node] },
      extractSequence: [
        { nodes: [{ ...node, checked: false }] },
        { nodes: [{ ...node, checked: true }] },
      ],
    });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    const ctx2 = JSON.stringify(llm.calls[1]?.messages);
    expect(ctx2).toContain("[checked]");
    expect(ctx2).not.toContain("page unchanged since last step");
  });

  test("P1-4a：stuckRing 清零——升级后仍卡的终局恰在第 6 步（steps=6）", async () => {
    const { node, locate } = fakeNode("14", {});
    const world = makeFakeWorld({ locateResults: { 14: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const script: ScriptStep[] = [];
    for (let i = 0; i < 8; i++) script.push({ toolCalls: [wait] });
    script.push({ toolCalls: [{ name: "done", arguments: { answer: "never" } }] });
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: {
          fast: { ...llm.model, id: "f" } as never,
          strong: { ...llm.model, id: "s" } as never,
        },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    const result = await handle.result();
    expect(result.status).toBe("failed");
    // 3 步 fast 升级 + 3 步 strong 仍卡 = 6（ring 未清零则第 4 步即终局）
    expect(result.steps).toBe(6);
  });

  test("P1-4b：keep-2 精确断言——1 全量 + 5 unchanged，全量恰 1 张在窗", async () => {
    const { node, locate } = fakeNode("15", {});
    const world = makeFakeWorld({ locateResults: { 15: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const script: ScriptStep[] = [];
    for (let i = 0; i < 6; i++) script.push({ toolCalls: [wait] });
    script.push({ toolCalls: [{ name: "done", arguments: { answer: "ok" } }] });
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    await drain(handle);
    // 第 7 次调用（done 前）：结果 = 全量×1 + unchanged×5（若 unchanged 误计入窗则全量被挤成 0）
    const msgs = JSON.stringify(llm.calls[6]?.messages);
    expect((msgs.match(/# Page:/g) ?? []).length).toBe(1);
    expect((msgs.match(/page unchanged since last step/g) ?? []).length).toBe(5);
  });

  test("P1-4c：升级与 done 同批——done 优先，不续跑，steps=3", async () => {
    const { node, locate } = fakeNode("16", {});
    const world = makeFakeWorld({ locateResults: { 16: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      // 一个批次里 3 个 wait + done：第 3 个 wait 触发升级（terminateAfterBatch），
      // done 同批已调 → done.called 优先，main 不续跑
      {
        toolCalls: [wait, wait, wait, { name: "done", arguments: { answer: "batch done" } }],
      },
      { toolCalls: [{ name: "done", arguments: { answer: "second run" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: {
          fast: { ...llm.model, id: "f" } as never,
          strong: { ...llm.model, id: "s" } as never,
        },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    const events = await drain(handle);
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.answer).toBe("batch done"); // 首个 done 定案（重复调用不覆写）
    expect(result.steps).toBe(3);
    // 不发起 strong 续跑（done 优先）；pi every() 批语义允许旧模型多跑一轮——全 fast
    expect(llm.callModels.every((m) => m === "f")).toBe(true);
    expect(events.some((e) => e.type === "stuck_escalated")).toBe(true);
  });

  test("P2-13：首调直跳 ≥80% → 50/80 两档同发（顺序不倒挂）", async () => {
    const { node, locate } = fakeNode("17", {});
    const world = makeFakeWorld({ locateResults: { 17: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      {
        toolCalls: [{ name: "done", arguments: { answer: "ok" } }],
        usage: { input: 90_000, output: 5 },
      },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    const events = await drain(handle);
    const warns = events
      .filter((e) => e.type === "budget_warn" && e.dimension === "contextWindow")
      .map((e) => (e as { usedPct?: number }).usedPct);
    expect(warns).toEqual([50, 80]);
  });
});
