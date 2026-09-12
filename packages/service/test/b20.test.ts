/** B20：batch（引擎+agent+会话）/ networkIdle / loc 稳定 selector / 命名会话+keep */
import { describe, expect, test } from "bun:test";
import { createActionEngine } from "@bw/actions";
import { runTask, scriptLLM } from "@bw/agent";
import type { NavigationIntent } from "@bw/core";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { FakeDriver, type FakePageOptions } from "@bw/driver";
import { EXTRACT_EXPRESSION, renderSnapshot, type Snapshot } from "@bw/perception";
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import { createSessionManager } from "../src/sessions.ts";

const WEBKIT_CAPS: DriverCapabilities = {
  cdp: false,
  upload: false,
  download: false,
  dialogEvents: false,
  userAgentOverride: false,
  pierceClick: false,
  httpOnlyCookies: false,
  networkEvents: false,
  webp: false,
  popups: false,
};
const CHROME_CAPS: DriverCapabilities = { ...WEBKIT_CAPS, networkEvents: true };

const extractOf = (nodes: Array<Record<string, unknown>>): unknown => ({
  nodes,
  headings: [],
  warnings: [],
  title: "t",
  url: "https://fake.test/page",
  scrollY: 0,
  scrollX: 0,
  docHeight: 1000,
  viewportH: 720,
});
const mkDriver = (
  caps: DriverCapabilities = WEBKIT_CAPS,
  extra?: Partial<FakePageOptions>,
): Driver =>
  new FakeDriver(caps, {
    selectors: ['[data-bw-id="1"]', '[data-bw-id="2"]'],
    evaluateHandler: (expr: string) => {
      if (expr === EXTRACT_EXPRESSION) return extractOf([]);
      if (expr.includes("__bwSettle")) return 10_000;
      return null;
    },
    ...extra,
  }) as unknown as Driver;

describe("B20 引擎 batch（P3-14：引擎不执行 batch——工具层职责）", () => {
  test("直调引擎的 batch 拒绝（防旁路）", async () => {
    const d = mkDriver();
    const engine = createActionEngine(d, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act({ kind: "batch", steps: [{ kind: "wait", seconds: 0.01 }] }),
    ).rejects.toThrow(/must go through the tool layer/);
  });

  test("networkIdle：webkit 拒绝；chrome 缓冲无新增即返回", async () => {
    const wk = createActionEngine(mkDriver(), { settleQuietMs: 10, settleCapMs: 200 });
    await wk.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(wk.act({ kind: "wait", seconds: 0.01, until: "networkIdle" })).rejects.toThrow(
      /chrome backend/,
    );

    const chrome = createActionEngine(mkDriver(CHROME_CAPS), {
      settleQuietMs: 10,
      settleCapMs: 2000,
    });
    await chrome.act({ kind: "open_tab", url: "https://fake.test/page" });
    // 触发 ensureNetworkMonitor + 无新请求 → 静默等待立刻满足
    const t0 = Date.now();
    const r = await chrome.act({ kind: "wait", seconds: 0.01, until: "networkIdle" });
    expect(r.text).toContain("network idle");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("B20 agent batch 工具（假 LLM 旅程）", () => {
  test("batch 成功：一次往返多步，末快照附回，计步=子步数", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      {
        toolCalls: [
          {
            name: "batch",
            arguments: {
              steps: [
                { kind: "wait", seconds: 0.01 },
                { kind: "wait", seconds: 0.01 },
                { kind: "wait", seconds: 0.01 },
              ],
            },
          },
        ],
      },
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
    for await (const _e of handle.events) {
      void _e;
      if (_e.type === "task_done") break;
    }
    const result = await handle.result();
    expect(result.status).toBe("done");
    expect(result.steps).toBe(3); // 每子步各计一步（预算不绕过）
    // batch 工具结果在上下文中：3 步清单 + 一份快照
    const batchResult = JSON.stringify(llm.calls[1]?.messages);
    expect(batchResult).toContain("batch 3 steps");
    expect(batchResult).toContain("✓ [3/3]");
    expect((batchResult.match(/# Page:/g) ?? []).length).toBe(1); // 仅一份快照
  });

  test("batch 首错即停：进度清单回传 + 断点快照", async () => {
    const { node, locate } = fakeNode("2", {});
    const world = makeFakeWorld({ locateResults: { 2: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      {
        toolCalls: [
          {
            name: "batch",
            arguments: {
              steps: [
                { kind: "wait", seconds: 0.01 },
                { kind: "click", index: "99" }, // 索引不存在 → 首错
                { kind: "wait", seconds: 0.01 },
              ],
            },
          },
        ],
      },
      { toolCalls: [{ name: "done", arguments: { answer: "recovered" } }] },
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
    for await (const _e of handle.events) {
      void _e;
      if (_e.type === "task_done") break;
    }
    expect((await handle.result()).answer).toBe("recovered");
    const batchResult = JSON.stringify(llm.calls[1]?.messages);
    expect(batchResult).toContain("stopped at step 2");
    expect(batchResult).toContain("✓ [1/3]");
    expect(batchResult).toContain("not in snapshot");
  });
});

const mkMgr = (caps: DriverCapabilities = WEBKIT_CAPS) =>
  createSessionManager({ policyMode: "test", driverFactory: () => mkDriver(caps) });

describe("B20 会话 batch + 命名 + keep", () => {
  test("batch 三步成功，只回末快照；每步计预算", async () => {
    const mgr = mkMgr();
    const s = await mgr.create("https://fake.test/page", { name: "测试任务" });
    const r = await mgr.executeTool(s.id, "batch", {
      steps: [
        { kind: "wait", seconds: 0.01 },
        { kind: "wait", seconds: 0.01 },
        { kind: "extract_text" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("batch 3 steps");
      expect(r.text).toContain("✓ [3/3]");
      expect((r.text.match(/# Page:/g) ?? []).length).toBe(0); // 快照在 snapshot 字段
    }
    const after = mgr.get(s.id);
    expect(after?.steps).toBe(3); // P2-9 对齐：仅子步计（open_tab 不增 steps——create 不计）
    expect(after?.name).toBe("测试任务");
    mgr.closeAll();
  });

  test("batch 首错即停：进度带在 error 里", async () => {
    const mgr = mkMgr();
    const s = await mgr.create("https://fake.test/page");
    const r = await mgr.executeTool(s.id, "batch", {
      steps: [
        { kind: "wait", seconds: 0.01 },
        { kind: "click", index: "99" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) {
      expect(r.error).toContain("stopped at step 2");
      expect(r.error).toContain("✓ [1/2]");
    }
    mgr.closeAll();
  });

  test("batch 参数校验：无 steps / 含 done / 超 10 步", async () => {
    const mgr = mkMgr();
    const s = await mgr.create("https://fake.test/page");
    expect((await mgr.executeTool(s.id, "batch", {})).ok).toBe(false);
    expect((await mgr.executeTool(s.id, "batch", { steps: [{ kind: "done" }] })).ok).toBe(false);
    expect(
      (
        await mgr.executeTool(s.id, "batch", {
          steps: Array.from({ length: 11 }, () => ({ kind: "wait", seconds: 0 })),
        })
      ).ok,
    ).toBe(false);
    mgr.closeAll();
  });

  test("keep/rename：置位与改名；未知名 false", async () => {
    const mgr = createSessionManager({
      policyMode: "test",
      sessionTtlMs: 100, // 100ms TTL——kept 会话也应活过
      driverFactory: () => mkDriver(),
    });
    const s = await mgr.create("https://fake.test/page", { name: "原名" });
    expect(mgr.keep(s.id)).toBe(true);
    expect(mgr.keep("sess-nonexistent")).toBe(false);
    expect(mgr.rename(s.id, "新名")).toBe(true);
    expect(mgr.get(s.id)?.name).toBe("新名");
    expect(mgr.get(s.id)?.kept).toBe(true);
    // 等 TTL 过期窗口（cleaner 周期 60s 不可等——直接验证语义：kept 标记在 list 中可见）
    expect(mgr.list().some((x) => x.id === s.id && x.kept === true)).toBe(true);
    mgr.close(s.id);
    mgr.closeAll();
  });
});

describe("B20 loc 稳定 selector", () => {
  test("渲染行带 loc=（id/data-testid）；无稳定锚不带", () => {
    const snap = {
      formatVersion: 1,
      url: "u",
      title: "t",
      nodes: [
        {
          id: "1",
          tag: "input",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          below: false,
          above: false,
          loc: "#email",
        },
        {
          id: "2",
          tag: "button",
          x: 0,
          y: 20,
          w: 10,
          h: 10,
          below: false,
          above: false,
          loc: '[data-testid="submit"]',
        },
        { id: "3", tag: "a", x: 0, y: 40, w: 10, h: 10, below: false, above: false },
      ],
      headings: [],
      scroll: { y: 0, x: 0, docHeight: 100, viewportH: 720 },
      domHash: "h",
      truncated: false,
      warnings: [],
    } as unknown as Snapshot;
    const text = renderSnapshot(snap);
    expect(text).toContain("loc=#email");
    expect(text).toContain('loc=[data-testid="submit"]');
    expect(text).not.toContain("loc=undefined");
    // 无 loc 节点不带 loc= 片段
    const line3 = text.split("\n").find((l) => l.startsWith("[3]"));
    expect(line3).toBeTruthy();
    expect(line3 ?? "").not.toContain("loc=");
  });
});

describe("B20 意图闸不绕过（batch 内导航确认）", () => {
  test("batch 子步导航到未批准域 → 确认挂起 → 拒绝 → batch 终止带进度", async () => {
    const intents: NavigationIntent[] = [];
    const d = mkDriver(WEBKIT_CAPS);
    const engine = createActionEngine(d, {
      settleQuietMs: 10,
      settleCapMs: 200,
      intentSink: (i) => {
        intents.push(i);
      },
    });
    void engine;
    // 会话级验证（gate 挂起语义在 sessions 层）
    const mgr = createSessionManager({
      policyMode: "test",
      confirmationTimeoutMs: 200,
      driverFactory: () => mkDriver(),
    });
    const s = await mgr.create("https://fake.test/page");
    const r = await mgr.executeTool(s.id, "batch", {
      steps: [
        { kind: "wait", seconds: 0.01 },
        { kind: "navigate", url: "https://unapproved.test/x" },
        { kind: "wait", seconds: 0.01 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) {
      expect(r.code).toBe("CONFIRMATION_DENIED"); // 200ms 超时=deny → 首错即停
      expect(r.error).toContain("stopped at step 2");
    }
    mgr.closeAll();
  });
});

describe("B20 审查处置回归", () => {
  test("P0-1：agent batch 子步 navigate 过 S1①（不再绕过）", async () => {
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([
      {
        toolCalls: [
          {
            name: "batch",
            arguments: {
              steps: [
                { kind: "wait", seconds: 0.01 },
                { kind: "navigate", url: "https://evil.test/x" },
              ],
            },
          },
        ],
      },
      { toolCalls: [{ name: "done", arguments: { answer: "stopped" } }] },
    ]);
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        confirmationTimeoutMs: 200,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    const events: Array<{ type: string; cid?: string }> = [];
    for await (const e of handle.events) {
      events.push(e as { type: string; cid?: string });
      if (e.type === "task_done") break;
    }
    // S1① 前检触发确认（超时 deny → batch 首错即停）
    expect(events.some((e) => e.type === "confirmation_required" && e.cid !== undefined)).toBe(
      true,
    );
  });

  test("P1-3：嵌套 batch 三处拒绝", async () => {
    const mgr = mkMgr();
    const s = await mgr.create("https://fake.test/page");
    const r = await mgr.executeTool(s.id, "batch", {
      steps: [{ kind: "batch", steps: [{ kind: "wait", seconds: 0 }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error).toContain("nested batch");
    mgr.closeAll();
  });

  test("P2-9：batch 计步=子步数（与 agent 对齐，无双重计）", async () => {
    const mgr = mkMgr();
    const s = await mgr.create("https://fake.test/page");
    await mgr.executeTool(s.id, "batch", {
      steps: [
        { kind: "wait", seconds: 0.01 },
        { kind: "wait", seconds: 0.01 },
      ],
    });
    const after = mgr.get(s.id);
    expect(after?.steps).toBe(2); // open_tab 0 + 2 子步（外层不计）
    mgr.closeAll();
  });

  test("P2-12：批准后同域后续子步放行（批准确认路径=单动作确认门，b13/b18 已覆盖；batch 特有面=一次批准盖后续同域子步）", async () => {
    // 第一步：单步 navigate 触发确认——SDK 层 gate 挂起，事件流里拿 cid 批准（1s 后 buffer 必有）
    const mgr = createSessionManager({
      policyMode: "test",
      confirmationTimeoutMs: 8_000,
      driverFactory: () => mkDriver(),
    });
    const s = await mgr.create("https://fake.test/page");
    const nav = mgr.executeTool(s.id, "navigate", { url: "https://neworigin.test/x" });
    await new Promise((r2) => setTimeout(r2, 1000)); // 等 gate emit 确认事件进 buffer
    const it = mgr.events(s.id)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    const cid =
      !first.done && first.value.type === "confirmation_required" ? first.value.cid : undefined;
    expect(cid).toBeTruthy();
    expect(mgr.confirm(s.id, cid as string, true)).toBe(true);
    expect((await nav).ok).toBe(true); // 批准后导航执行
    // 第二步：batch 到同域（已批准）——全部子步放行，无二次确认
    const r = await mgr.executeTool(s.id, "batch", {
      steps: [
        { kind: "wait", seconds: 0.01 },
        { kind: "navigate", url: "https://neworigin.test/x" },
        { kind: "wait", seconds: 0.01 },
      ],
    });
    expect(r.ok).toBe(true); // 批准后同域后续子步免二次确认（origin 级会话放行）
    if (r.ok) expect(r.text).toContain("✓ [3/3]");
    mgr.closeAll();
  }, 30_000);
});
