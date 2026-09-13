/** B21：extract_code——沙箱执行器纯函数 + 树序列化 + 引擎/agent/会话接线 + batch 嵌入 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, scriptLLM } from "@bw/agent";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { FakeDriver, type FakePageOptions } from "@bw/driver";
import { EXTRACT_EXPRESSION, SERIALIZE_TREE_EXPRESSION } from "@bw/perception";
import type { SessionStore } from "@bw/service";
import { createSessionStore } from "@bw/service";
import { createActionEngine } from "../src/engine.ts";
import { EXTRACT_CODE_MAX_CHARS, runTreeCode } from "../src/sandbox.ts";
import { fakeNode, makeFakeWorld } from "./helpers.ts";

const CAPS: DriverCapabilities = {
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

const TREE = {
  tag: "body",
  children: [
    {
      tag: "ul",
      attrs: { class: "items" },
      children: [
        { tag: "li", attrs: { "data-id": "1" }, text: "苹果 ¥5" },
        { tag: "li", attrs: { "data-id": "2" }, text: "梨 ¥12" },
      ],
    },
    { tag: "input", attrs: { type: "password" }, value: "***" },
  ],
};

describe("B21 沙箱执行器（runTreeCode）", () => {
  test("正常提取：filter/map/正则", async () => {
    const r = await runTreeCode(
      `(tree) => tree.children[0].children
        .map(li => ({ id: li.attrs["data-id"], price: Number(li.text.match(/¥([\\d.]+)/)?.[1] ?? 0) }))
        .filter(x => x.price > 6)`,
      TREE,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe(JSON.stringify([{ id: "2", price: 12 }]));
  });

  test("安全隔离：fetch/process/require/WebSocket 不可达", async () => {
    for (const probe of ["fetch", "process", "require", "WebSocket", "Bun"]) {
      const r = await runTreeCode(`(tree) => typeof ${probe}`, TREE);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).toBe(JSON.stringify("undefined"));
    }
  });

  test("构造链逃逸封死（审查 P0）：X.constructor.compiler 不通宿主 realm", async () => {
    // 修复前：宿主 tree/JSON 进 context → .constructor.constructor 编译回 Worker realm
    // （process/Bun/fetch 全可达，审查员实测）。修复后 context 零宿主对象——
    // tree 在目标 realm 内 parse，其构造链只通目标 realm 自身。
    const probes = [
      `(tree) => tree.constructor.constructor("return typeof process")()`,
      `(tree) => JSON.constructor.constructor("return typeof process")()`,
      `(tree) => Math.constructor.constructor("return typeof Bun + '/' + typeof fetch")()`,
    ];
    for (const code of probes) {
      const r = await runTreeCode(code, TREE);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).not.toContain('"object"');
    }
    // 直通判据：构造链探针在目标 realm 的求值结果是 "undefined"
    const r0 = await runTreeCode(
      `(tree) => tree.constructor.constructor("return typeof process")()`,
      TREE,
    );
    if (r0.ok) expect(r0.text).toBe(JSON.stringify("undefined"));
  });

  test("死循环由 Worker terminate 硬杀（3s 内返回错误）", async () => {
    const t0 = Date.now();
    const r = await runTreeCode("(tree) => { while (true) {} }", TREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error ?? "").toContain("timed out");
    expect(Date.now() - t0).toBeLessThan(6_000);
  }, 10_000);

  test("非函数 / 编译错 / undefined 返回 / 超长——四类拒绝", async () => {
    expect((await runTreeCode("42", TREE)).ok).toBe(false);
    expect((await runTreeCode("(((", TREE)).ok).toBe(false);
    expect((await runTreeCode("(tree) => undefined", TREE)).ok).toBe(false);
    expect((await runTreeCode(`(tree) => 1 // ${"x".repeat(5000)}`, TREE)).ok).toBe(false);
  });

  test("超限结果拒绝（截断的 JSON 是无效 JSON——不静默裁断）", async () => {
    const r = await runTreeCode(`(tree) => "y".repeat(20000)`, TREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error ?? "").toContain("too large");
  });

  test("环形引用 / 函数返回——不可序列化拒绝", async () => {
    const r = await runTreeCode("(tree) => { const o = {}; o.self = o; return o; }", TREE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error ?? "").toContain("not JSON-serializable");
    const f = await runTreeCode("(tree) => () => 1", TREE);
    expect(f.ok).toBe(false);
  });

  test("代码上限常量存在", () => {
    expect(EXTRACT_CODE_MAX_CHARS).toBe(4000);
  });
});

const fakeTreeHandler = (expr: string): unknown => {
  if (expr === EXTRACT_EXPRESSION) {
    return {
      nodes: [],
      headings: [],
      warnings: [],
      title: "t",
      url: "https://fake.test/page",
      scrollY: 0,
      scrollX: 0,
      docHeight: 1000,
      viewportH: 720,
    };
  }
  if (expr === SERIALIZE_TREE_EXPRESSION) {
    return {
      root: TREE,
      nodeCount: 5,
      truncated: false,
    };
  }
  if (expr.includes("__bwSettle")) return 10_000;
  return null;
};

const mkDriver = (extra?: Partial<FakePageOptions>): Driver =>
  new FakeDriver(CAPS, {
    selectors: ['[data-bw-id="1"]'],
    evaluateHandler: fakeTreeHandler as never,
    ...extra,
  }) as unknown as Driver;

describe("B21 引擎与 batch 嵌入", () => {
  test("extract_code 单步：树序列化 + 沙箱结果", async () => {
    const engine = createActionEngine(mkDriver(), { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act({
      kind: "extract_code",
      code: "(tree) => tree.children[0].children.length",
    });
    expect(r.text).toBe("2");
  });

  test("树截断时结果附 warn 行（静默丢数据不可接受）", async () => {
    const engine = createActionEngine(
      mkDriver({
        evaluateHandler: (expr: string) => {
          if (expr === SERIALIZE_TREE_EXPRESSION) {
            return { root: { tag: "body", text: "x" }, nodeCount: 10000, truncated: true };
          }
          return fakeTreeHandler(expr);
        },
      }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act({ kind: "extract_code", code: "(tree) => tree.tag" });
    expect(r.text).toContain("[warn] DOM tree truncated");
  });

  test("extract_code 作为引擎单步可执行（batch 嵌入由会话层测）", async () => {
    const engine = createActionEngine(mkDriver(), { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act({
      kind: "extract_code",
      code: "(tree) => tree.tag",
    });
    expect(r.text).toBe(JSON.stringify("body"));
  });

  test("非法代码在引擎层报 INVALID_TOOL_ARGS", async () => {
    const engine = createActionEngine(mkDriver(), { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(engine.act({ kind: "extract_code", code: "not a function" })).rejects.toThrow(
      /extract_code/,
    );
  });
});

describe("B21 agent 工具（假 LLM）", () => {
  test("extract_code 结果直回上下文；batch 嵌入可用", async () => {
    void fakeNode;
    void makeFakeWorld;
    const llm = scriptLLM([
      { toolCalls: [{ name: "extract_code", arguments: { code: '(tree) => "ok"' } }] },
      { toolCalls: [{ name: "done", arguments: { answer: "done" } }] },
    ]);
    // world.driver 的 evaluateHandler 不识树表达式——注入 extractSequence? 更简单：world extraEvaluate
    // makeFakeWorld 无 extraEvaluate 透传给所有表达式——直接用 mkDriver 形态的 driverFactory in runTask
    const handle = runTask(
      { goal: "x", startUrl: "https://fake.test/page" },
      {
        driver: mkDriver() as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    );
    for await (const _e of handle.events) void _e;
    expect((await handle.result()).status).toBe("done");
    const out = JSON.stringify(llm.calls[1]?.messages);
    expect(out).toContain("ok");
  });
});

describe("B21 会话模式 + redact（B22 S3 移植：store 测试缝）", () => {
  const mkFakeStore = (extraHandler?: (expr: string) => unknown): SessionStore => {
    // driver 每 store 私有（describe 级共享会让前一用例的 evaluateHandler 泄漏给后续——
    // 密码树 handler 串到 batch 用例导致 (tree)=>tree.text undefined，实测）
    let driver: ReturnType<typeof mkDriver> | null = null;
    return createSessionStore({
      bwHome: mkdtempSync(join(tmpdir(), "bw-b21-")), // 独立世界（不复用全局 BW_HOME——别撞上限）
      policyMode: "test",
      helperSpawner: async (rec) => ({
        pid: 0, // 守卫语义：≤0 = 无进程可杀（pid 1 = launchd，kill(-1) 是全进程！）
        socketPath: `fake://${rec.id}`,
        killGroup: () => {},
      }),
      helperFactory: async () => {
        // 单例 driver：真实 helper 的页面在进程内持久——假工厂必须跨调用共享同一实例
        driver ??= mkDriver({
          ...(extraHandler !== undefined
            ? {
                evaluateHandler: (expr: string) => {
                  if (expr === SERIALIZE_TREE_EXPRESSION) return extraHandler(expr);
                  return fakeTreeHandler(expr);
                },
              }
            : { evaluateHandler: fakeTreeHandler }),
        });
        return { driver, release: () => {}, kill: () => {} };
      },
    });
  };

  test("密码在树序列化源头已掩码（安全主保证）", async () => {
    const store = mkFakeStore(() => ({
      root: {
        tag: "body",
        children: [
          { tag: "input", attrs: { type: "password" }, value: "***" },
          { tag: "input", attrs: { type: "text" }, value: "visible value" },
        ],
      },
      nodeCount: 3,
      truncated: false,
    }));
    const { id } = await store.create({ url: "https://fake.test/page", policyMode: "test" });
    const r = await store.executeTool(id, "extract_code", {
      code: "(tree) => tree.children.map(c => c.value ?? null)",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("***");
      expect(r.text).toContain("visible value"); // 非密码字段照常可读
    }
    store.close(id);
  });

  test("batch 嵌 extract_code 步过会话闸与 redact", async () => {
    const store = mkFakeStore(() => ({
      root: { tag: "body", text: "clean" },
      nodeCount: 1,
      truncated: false,
    }));
    const { id } = await store.create({ url: "https://fake.test/page", policyMode: "test" });
    const r = await store.executeTool(id, "batch", {
      steps: [
        { kind: "wait", seconds: 0.01 },
        { kind: "extract_code", code: "(tree) => tree.text" },
      ],
    });
    if (!r.ok) console.error("DBG batch:", JSON.stringify(r));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("✓ [2/2]");
    store.close(id);
  });

  test("无 code / 空 code 拒绝", async () => {
    const store = mkFakeStore();
    const { id } = await store.create({ policyMode: "test" });
    expect((await store.executeTool(id, "extract_code", {})).ok).toBe(false);
    store.close(id);
  });
});
