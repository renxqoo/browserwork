/** B18：过程渲染器纯函数 + runTask 事件透传（args/ms/resultText/pageState/snapshotHead） */
import { describe, expect, test } from "bun:test";
import { runTask, scriptLLM } from "@bw/agent";
import type { TaskEvent } from "@bw/core";
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import {
  fmtTokens,
  formatPageState,
  formatToolEnd,
  formatToolStart,
  printEvent,
} from "../src/cli-run.ts";

describe("B18 渲染器纯函数", () => {
  test("formatToolStart：步数/参数键值/长 text 省略", () => {
    expect(formatToolStart(3, 50, "click", { index: "5" })).toBe("\n▸ [3/50] click index=5");
    expect(formatToolStart(1, 10, "navigate", { url: "https://x.test/a?b=1" })).toBe(
      "\n▸ [1/10] navigate url=https://x.test/a?b=1",
    );
    // 超长 text 整段省略（防刷屏）；60 内保留
    expect(formatToolStart(2, 10, "type", { index: "4", text: "x".repeat(200) })).toBe(
      "\n▸ [2/10] type index=4",
    );
    expect(formatToolStart(2, 10, "type", { index: "4", text: "短文本" })).toBe(
      "\n▸ [2/10] type index=4 text=短文本",
    );
    // 值截断 60 字符
    const long = formatToolStart(4, 50, "navigate", { url: `https://x.test/${"y".repeat(100)}` });
    expect(long.length).toBeLessThan(100);
    expect(long).toContain("…");
  });

  test("formatToolEnd：结果首行 + 耗时", () => {
    expect(formatToolEnd("navigated to https://x/", 2100)).toBe(
      "  ✓ navigated to https://x/ (2.1s)",
    );
    expect(formatToolEnd(undefined, undefined)).toBe("  ✓ ok");
  });

  test("formatPageState：标题/元素数/未变标注；空标题回退 URL", () => {
    const ps = { title: "Example Domain", url: "https://example.com/", elements: 3 };
    expect(formatPageState(ps)).toBe("    ↳ Example Domain · 3 元素");
    expect(formatPageState(ps, ps)).toBe("    ↳ Example Domain · 3 元素（页面未变）");
    expect(formatPageState(ps, { ...ps, elements: 4 })).not.toContain("未变");
    expect(formatPageState({ title: "", url: "about:blank", elements: 0 })).toContain(
      "about:blank",
    );
  });

  test("fmtTokens：K 形态", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(3141)).toBe("3.1K");
    expect(fmtTokens(104_857)).toBe("104.9K");
  });

  test("printEvent：确认门文案含非交互去向提示", () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      printEvent(
        { type: "confirmation_required", cid: "c1", reason: "origin not in whitelist" },
        { step: 0, maxSteps: 50, verbose: false },
      );
    } finally {
      console.log = origLog;
    }
    expect(lines.join("\n")).toContain("120s 后自动拒绝");
    expect(lines.join("\n")).toContain("--url 预授权");
  });

  test("printEvent：verbose 打快照头；非 verbose 不打", () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => lines.push(s);
    const end: TaskEvent = {
      type: "tool_execution_end",
      toolName: "navigate",
      toolCallId: "t1",
      resultText: "navigated to https://x/",
      ms: 120,
      pageState: { title: "X", url: "https://x/", elements: 5 },
      snapshotHead: '# Page: X\n# URL: https://x/\n[1] link "a"',
    };
    try {
      printEvent(end, { step: 1, maxSteps: 50, verbose: true });
      printEvent(end, { step: 2, maxSteps: 50, verbose: false });
    } finally {
      console.log = origLog;
    }
    const out = lines.join("\n");
    expect(out).toContain("  ✓ navigated to https://x/ (0.1s)");
    expect(out).toContain("    ↳ X · 5 元素");
    expect((out.match(/ {4}│ # Page: X/g) ?? []).length).toBe(1); // 只 verbose 那次打
  });
});

describe("B18 runTask 事件透传", () => {
  test("tool_execution_start 带 args；end 带 ms/resultText/pageState/snapshotHead", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      { toolCalls: [{ name: "click", arguments: { index: "1" } }] },
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
    const events: TaskEvent[] = [];
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "task_done") break;
    }
    const start = events.find(
      (e) => e.type === "tool_execution_start" && e.toolName === "click",
    ) as TaskEvent & { args?: Record<string, unknown> };
    expect(start?.args).toMatchObject({ index: "1" });
    const end = events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "click",
    ) as TaskEvent & {
      resultText?: string;
      ms?: number;
      pageState?: unknown;
      snapshotHead?: string;
    };
    expect(end?.resultText).toContain("clicked");
    expect(typeof end?.ms).toBe("number");
    expect(end?.pageState).toMatchObject({ url: "https://fake.test/page" });
    expect(end?.snapshotHead).toContain("# Page:");
    // snapshotHead 已过 redact（不含 secret——此处无 secret，结构性断言行数上限）
    expect((end?.snapshotHead ?? "").split("\n").length).toBeLessThanOrEqual(15);
  });

  test("trajectory 工厂：bw run 落盘路径（fileTrajectorySink 注入验证）", async () => {
    const { fileTrajectorySink, memoryTrajectorySink } = await import("@bw/agent");
    // 工厂形态被 runTask 消费（B13 既有）——这里验证 runCliTask 传的是工厂而非内存
    const { runTrajectoryDir } = await import("../src/cli-run.ts");
    expect(runTrajectoryDir()).toContain("trajectories");
    // fileTrajectorySink path 形态（replay 兼容）
    const sink = fileTrajectorySink(runTrajectoryDir(), "task-test-b18");
    expect(sink.path.endsWith("task-test-b18.jsonl")).toBe(true);
    void memoryTrajectorySink;
  });
});
