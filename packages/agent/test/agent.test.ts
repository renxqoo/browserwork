/**
 * U6 假 LLM 旅程矩阵：完成 / 确认四路径 / 预算触顶 / 事件时序 / 压缩 / redact /
 * steer / abort / done。FakeDriver + 假世界（真 view 旅程与 real 门见下）。
 */
import { describe, expect, test } from "bun:test";
import type { TaskEvent } from "@bw/core";
import type { FakePage } from "@bw/driver";
// 复用 actions 测试的假世界（跨包测试文件——测试期 import，不入运行时图）
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import { runTask, type ScriptStep, scriptLLM } from "../src/index.ts";
import { memoryTrajectorySink } from "../src/trajectory.ts";

async function collect(
  handle: { events: AsyncIterable<TaskEvent> },
  until: (e: TaskEvent) => boolean,
): Promise<TaskEvent[]> {
  const out: TaskEvent[] = [];
  for await (const e of handle.events) {
    out.push(e);
    if (until(e)) break;
  }
  return out;
}

describe("U6 假 LLM 旅程", () => {
  test("完成路径：navigate(起始页自动) → click → done，事件时序（task_done 恰好一次最后）", async () => {
    const { node, locate } = fakeNode("5", {
      tag: "a",
      text: "Go",
      locate: { linkHref: "https://fake.test/go" },
    });
    const world = makeFakeWorld({
      locateResults: { 5: locate },
      rawExtract: { nodes: [node], title: "fake page" },
    });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "click", arguments: { index: "5" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "clicked go" } }] },
    ];
    const llm = scriptLLM(script);
    const traj = memoryTrajectorySink();
    const handle = runTask(
      { goal: "click the go link", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        trajectory: traj,
        testMode: true,
      },
    );
    const events = await collect(handle, (e) => e.type === "task_done");
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.answer).toBe("clicked go");
    expect(result.steps).toBe(1);
    // 时序断言
    expect(events.filter((e) => e.type === "task_done")).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe("task_done");
    // click 的意图经 sink 前检（allow——同源）
    expect((world.createdPages[0] as FakePage).clicks[0]).toMatchObject({
      selector: '[data-bw-id="5"]',
    });
    // 轨迹记录（起始 open_tab + click）
    expect(traj.entries.length).toBeGreaterThanOrEqual(2);
  });

  test("确认路径：新域导航 → confirmation_required → approve → 完成", async () => {
    const { node, locate } = fakeNode("7", {
      tag: "a",
      text: "External",
      locate: { linkHref: "https://neworigin.test/x" },
    });
    const world = makeFakeWorld({ locateResults: { 7: locate }, rawExtract: { nodes: [node] } });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "click", arguments: { index: "7" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "went external" } }] },
    ];
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "go external", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    // 等确认事件并批准
    const collectPromise = collect(handle, (e) => e.type === "task_done");
    for await (const e of handle.events) {
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        await handle.confirm(e.cid, true);
      }
      if (e.type === "task_done") break;
    }
    const events = await collectPromise;
    void events;
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect((world.createdPages[0] as FakePage).clicks.length).toBe(1); // 批准后执行了
  });

  test("确认拒绝：CONFIRMATION_DENIED → LLM 收到错误 → 换路完成", async () => {
    const { node, locate } = fakeNode("8", {
      tag: "a",
      text: "Blocked",
      locate: { linkHref: "https://deny.test/" },
    });
    const world = makeFakeWorld({ locateResults: { 8: locate }, rawExtract: { nodes: [node] } });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "click", arguments: { index: "8" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "found another way" } }] },
    ];
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "try blocked link", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    const collectPromise = collect(handle, (e) => e.type === "task_done");
    for await (const e of handle.events) {
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        await handle.confirm(e.cid, false);
      }
      if (e.type === "task_done") break;
    }
    await collectPromise;
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect((world.createdPages[0] as FakePage).clicks.length).toBe(0); // 拒绝 → 未执行
    // 错误喂回 LLM（第二轮上下文里有 denied 文本）
    const lastContext = llm.calls[llm.calls.length - 1];
    const toolResults = JSON.stringify(lastContext?.messages);
    expect(toolResults).toContain("denied");
  });

  test("确认超时 = deny（confirmationTimeoutMs 可配）", async () => {
    const { node, locate } = fakeNode("9", {
      tag: "a",
      text: "Timeout",
      locate: { linkHref: "https://slow.test/" },
    });
    const world = makeFakeWorld({ locateResults: { 9: locate }, rawExtract: { nodes: [node] } });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "click", arguments: { index: "9" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "timed out path" } }] },
    ];
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "timeout test", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        confirmationTimeoutMs: 150,
      },
    );
    const events = await collect(handle, (e) => e.type === "task_done");
    expect(events.some((e) => e.type === "confirmation_required")).toBe(true);
    const result = await handle.result();
    expect(result.status).toBe("done"); // LLM 收到 denied 后按剧本 done
    expect((world.createdPages[0] as FakePage).clicks.length).toBe(0);
  });

  test("预算触顶：maxSteps=1 → 第二个工具动作 → task_done(budget_exceeded)", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "wait", arguments: { seconds: 0.05 } }] },
      { toolCalls: [{ name: "wait", arguments: { seconds: 0.05 } }] },
    ];
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "loop", startUrl: "https://fake.test/page", budget: { maxSteps: 1 } },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    await collect(handle, (e) => e.type === "task_done");
    const result = await handle.result();
    expect(result.status).toBe("budget_exceeded");
    expect(result.error).toContain("steps");
  });

  test("快照压缩：第 3 步起旧快照 toolResult 压成单行（上下文有界）", async () => {
    const { node, locate } = fakeNode("2", {});
    const world = makeFakeWorld({ locateResults: { 2: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const script: ScriptStep[] = [
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [wait] },
      { toolCalls: [{ name: "done", arguments: { answer: "ok" } }] },
    ];
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "three waits", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    await collect(handle, (e) => e.type === "task_done");
    expect((await handle.result()).status).toBe("done");
    // 第 4 次调用（done 前的 LLM turn）上下文中：快照 toolResult 只保留最近 2 个完整
    const ctx = llm.calls[Math.min(3, llm.calls.length - 1)];
    const msgs = JSON.stringify(ctx?.messages);
    const fullSnapshots = (msgs.match(/\\[SNAPSHOT\\]/g) ?? []).length;
    expect(fullSnapshots).toBeLessThanOrEqual(2);
    expect(msgs).toContain("[snapshot removed:");
  });

  test("事件出域 redact：secret 不出现在任何事件文本中", async () => {
    const { node, locate } = fakeNode("3", { type: "password", tag: "input" });
    const world = makeFakeWorld({ locateResults: { 3: locate }, rawExtract: { nodes: [node] } });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "type_text_secret", arguments: { index: "3", secretName: "pw" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "typed the hunter2-secret password" } }] },
    ];
    const llm = scriptLLM(script);
    const events: TaskEvent[] = [];
    const handle = runTask(
      {
        goal: "type secret",
        startUrl: "https://fake.test/page",
        secrets: { pw: { source: "literal", ref: "hunter2-secret" } },
      },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "task_done") break;
    }
    const all = JSON.stringify(events);
    expect(all).not.toContain("hunter2-secret");
    // 秘密确实敲进了页面
    expect((world.createdPages[0] as FakePage).typed).toEqual(["hunter2-secret"]);
  });

  test("abort：运行中终止 → task_done(aborted)", async () => {
    const { node, locate } = fakeNode("4", {});
    const world = makeFakeWorld({ locateResults: { 4: locate }, rawExtract: { nodes: [node] } });
    const script: ScriptStep[] = [
      { toolCalls: [{ name: "wait", arguments: { seconds: 1 } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "never" } }] },
    ];
    const llm = scriptLLM(script);
    const handle = runTask(
      { goal: "abort me", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    const collectPromise = (async () => {
      for await (const _e of handle.events) {
        void _e;
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    await handle.abort("user said stop");
    await collectPromise;
    const result = await handle.result();
    expect(result.status).toBe("aborted");
    expect(result.error).toContain("user said stop");
  });

  test("LLM 未调 done 直接文本收尾：取最后 assistant 文本作答案", async () => {
    const { node, locate } = fakeNode("6", {});
    const world = makeFakeWorld({ locateResults: { 6: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      { toolCalls: [{ name: "wait", arguments: { seconds: 0.01 } }] },
      { text: "the answer is 42" },
    ]);
    const handle = runTask(
      { goal: "answer", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    await collect(handle, (e) => e.type === "task_done");
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.answer).toBe("the answer is 42");
  });
});

describe("B6 审查回归", () => {
  test("P0-1：done 后同批工具被拦截（beforeToolCall block）", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      {
        toolCalls: [
          { name: "done", arguments: { answer: "first" } },
          { name: "wait", arguments: { seconds: 0.01 } },
        ],
      },
      { text: "(never needed)" },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 300,
      },
    );
    for await (const e of handle.events) {
      if (e.type === "task_done") break;
    }
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.answer).toBe("first");
    // wait 被拦截：steps 只计 done 之前的动作（此处 0 步——done 是首个工具）
    expect(result.steps).toBe(0);
  });

  test("P0-2：press Enter 提交意图走确认门（挂起等决议，非 fire-and-forget）", async () => {
    const { node, locate } = fakeNode("2", {});
    const world = makeFakeWorld({
      locateResults: { 2: locate },
      rawExtract: { nodes: [node] },
      enterSubmit: { submit: true, action: "https://evil.test/steal", method: "get" },
    });
    const llm = scriptLLM([
      { toolCalls: [{ name: "press", arguments: { key: "Enter" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "after enter" } }] },
    ]);
    const handle = runTask(
      { goal: "press enter", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        confirmationTimeoutMs: 200,
      },
    );
    const events: import("@bw/core").TaskEvent[] = [];
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "task_done") break;
    }
    // Enter 的提交意图指向未批准域 → 确认事件出现（超时 deny 后 Enter 才落地/或被拒）
    expect(events.some((e) => e.type === "confirmation_required")).toBe(true);
    const result = await handle.result();
    expect(result.status).toBe("done");
  });

  test("P0-4：预算触顶强制终局（不合作的 LLM 也无法继续）", async () => {
    const { node, locate } = fakeNode("3", {});
    const world = makeFakeWorld({ locateResults: { 3: locate }, rawExtract: { nodes: [node] } });
    const wait = { name: "wait", arguments: { seconds: 0.01 } };
    const llm = scriptLLM([
      { toolCalls: [wait] }, // 步骤 1（maxSteps=1）→ 触顶
      { toolCalls: [wait] }, // 不合作——继续发
      { toolCalls: [wait] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page", budget: { maxSteps: 1 } },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    for await (const _e of handle.events) {
      void _e;
      if (_e.type === "task_done") break;
    }
    const result = await handle.result();
    expect(result.status).toBe("budget_exceeded");
    // LLM 调用数被强制截断（≤2——第二个 wait 在批内被 terminate 拦下不再追发）
    expect(llm.calls.length).toBeLessThan(3);
  });

  test("P1-4：确认批准令牌一次性——同签名敏感动作第二次仍确认", async () => {
    const { node, locate } = fakeNode("4", { tag: "button", text: "purchase now" });
    const world = makeFakeWorld({ locateResults: { 4: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      { toolCalls: [{ name: "click", arguments: { index: "4" } }] },
      { toolCalls: [{ name: "click", arguments: { index: "4" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "twice attempted" } }] },
    ]);
    const handle = runTask(
      { goal: "click purchase twice", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        confirmationTimeoutMs: 150,
      },
    );
    let confirms = 0;
    const events: import("@bw/core").TaskEvent[] = [];
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "confirmation_required") {
        confirms += 1;
        if (e.cid !== undefined) await handle.confirm(e.cid, true);
      }
      if (e.type === "task_done") break;
    }
    expect(confirms).toBe(2); // 第二次同签名也进了确认门
    expect((await handle.result()).status).toBe("done");
  });

  test("P1-5：confirmation_required.reason 过 redact（secret 不泄漏）", async () => {
    const { node: pwNode, locate: pwLocate } = fakeNode("5", { type: "password", tag: "input" });
    const { node: btnNode, locate: btnLocate } = fakeNode("6", {
      tag: "button",
      text: "purchase hunter2-secret",
    });
    const world = makeFakeWorld({
      locateResults: { 5: pwLocate, 6: btnLocate },
      rawExtract: { nodes: [pwNode, btnNode] },
    });
    const llm = scriptLLM([
      { toolCalls: [{ name: "type_text_secret", arguments: { index: "5", secretName: "pw" } }] },
      { toolCalls: [{ name: "click", arguments: { index: "6" } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "clicked" } }] },
    ]);
    const handle = runTask(
      {
        goal: "type and click",
        startUrl: "https://fake.test/page",
        secrets: { pw: { source: "literal", ref: "hunter2-secret" } },
      },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        confirmationTimeoutMs: 150,
      },
    );
    const all: import("@bw/core").TaskEvent[] = [];
    for await (const e of handle.events) {
      all.push(e);
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        await handle.confirm(e.cid, true);
      }
      if (e.type === "task_done") break;
    }
    expect(JSON.stringify(all)).not.toContain("hunter2-secret");
    expect(JSON.stringify(all)).not.toContain("hunter2secret");
  });

  test("P1-6：localhost 起始 URL 不再自动进测试档（S4 保持封锁）", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "x" } }] }]);
    const handle = runTask(
      { goal: "x", startUrl: "http://127.0.0.1:9999/local-app" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
      }, // 不传 testMode
    );
    for await (const _e of handle.events) {
      void _e;
      if (_e.type === "task_done") break;
    }
    // localhost startUrl：S4 封锁 → failed（不是静默放行）
    const result = await handle.result();
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("private");
  });

  test("P1-7：畸形 startUrl → failed(含 invalid)，不同步抛", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([]);
    const handle = runTask(
      { goal: "x", startUrl: "::::not-a-url" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    );
    for await (const _e of handle.events) {
      void _e;
      if (_e.type === "task_done") break;
    }
    const result = await handle.result();
    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("invalid");
  });
});
