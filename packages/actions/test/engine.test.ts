/** U4 动作引擎 fake 表驱动（词表 × 行为矩阵；真 view 旅程见 journey.test.ts） */
import { describe, expect, test } from "bun:test";
import { BWError, type ErrorCode, type NavigationIntent } from "@bw/core";
import type { LocateResult } from "@bw/perception";
import { type ActionResult, createActionEngine } from "../src/index.ts";
import { fakeNode, makeFakeWorld } from "./helpers.ts";

function snapOf(nodes: Array<Record<string, unknown>>) {
  return {
    formatVersion: 1 as const,
    url: "https://fake.test/page",
    title: "fake",
    nodes: nodes as never,
    headings: [],
    scroll: { y: 0, x: 0, docHeight: 1000, viewportH: 720 },
    domHash: "aa",
    truncated: false,
    warnings: [],
  };
}

async function expectCode(p: Promise<unknown>, code: ErrorCode): Promise<BWError> {
  try {
    await p;
    expect.unreachable();
  } catch (e) {
    expect(BWError.is(e)).toBe(true);
    expect((e as BWError).code).toBe(code);
    return e as BWError;
  }
}

describe("click 双轨", () => {
  test("主文档 → selector 轨 + link 意图上报", async () => {
    const { node, locate } = fakeNode("7", {
      tag: "a",
      text: "Go",
      locate: { linkHref: "https://fake.test/go" },
    });
    const world = makeFakeWorld({ locateResults: { 7: locate }, rawExtract: { nodes: [node] } });
    const intents: NavigationIntent[] = [];
    const engine = createActionEngine(world.driver, {
      intentSink: (i) => {
        intents.push(i);
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const result = await engine.act({ kind: "click", index: "7" }, snapOf([node]));
    expect(world.pageOf(0).clicks[0]).toMatchObject({ selector: '[data-bw-id="7"]' });
    expect(intents).toEqual([{ kind: "link", href: "https://fake.test/go" }]);
    expect(result.intent).toEqual({ kind: "link", href: "https://fake.test/go" });
    expect(result.snapshot).not.toBeNull();
  });

  test("shadow/iframe → 坐标轨（clickAt）", async () => {
    const { node, locate } = fakeNode("8", { locate: { inShadow: true } as Partial<LocateResult> });
    const world = makeFakeWorld({ locateResults: { 8: locate }, rawExtract: { nodes: [node] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "click", index: "8" }, snapOf([node]));
    const click = world.pageOf(0).clicks[0];
    expect(click).toMatchObject({ x: 100 + 100, y: 200 + 15 }); // rect 中心
    expect(click?.selector).toBeUndefined();
  });

  test("below-viewport → 先 scrollTo 再点击", async () => {
    const { node, locate } = fakeNode("9", { below: true });
    const world = makeFakeWorld({
      locateResults: { 9: locate },
      rawExtract: { nodes: [node] },
    });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "click", index: "9" }, snapOf([node]));
    expect(world.pageOf(0).scrollToCalls).toEqual(['[data-bw-id="9"]']);
    expect(world.pageOf(0).clicks[0]).toMatchObject({ selector: '[data-bw-id="9"]' });
  });

  test("DOM 漂移（rect 移动超容差）→ ELEMENT_NOT_FOUND 自纠通道", async () => {
    const { node, locate } = fakeNode("10");
    const world = makeFakeWorld({
      locateResults: { 10: { ...locate, y: 500 } },
      rawExtract: { nodes: [node] },
    });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expectCode(
      engine.act({ kind: "click", index: "10" }, snapOf([node])),
      "ELEMENT_NOT_FOUND",
    );
    expect(world.pageOf(0).clicks.length).toBe(0); // 未误点
  });

  test("元素已消失（locate found:false）→ ELEMENT_NOT_FOUND", async () => {
    const { node } = fakeNode("11");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [node] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expectCode(
      engine.act({ kind: "click", index: "11" }, snapOf([node])),
      "ELEMENT_NOT_FOUND",
    );
  });

  test("submit 类按钮 → submit 意图（formAction）", async () => {
    const { node, locate } = fakeNode("12", {
      tag: "button",
      text: "Submit",
      locate: {
        formAction: "https://fake.test/submitted",
        formMethod: "get",
      } as Partial<LocateResult>,
    });
    const world = makeFakeWorld({ locateResults: { 12: locate }, rawExtract: { nodes: [node] } });
    const intents: NavigationIntent[] = [];
    const engine = createActionEngine(world.driver, {
      intentSink: (i) => {
        intents.push(i);
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "click", index: "12" }, snapOf([node]));
    expect(intents).toEqual([
      { kind: "submit", href: "https://fake.test/submitted", method: "get" },
    ]);
  });
});

describe("type / secret", () => {
  test("type：聚焦后 InsertText", async () => {
    const { node, locate } = fakeNode("20");
    const world = makeFakeWorld({ locateResults: { 20: locate }, rawExtract: { nodes: [node] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "type", index: "20", text: "hello" }, snapOf([node]));
    expect(world.pageOf(0).typed).toEqual(["hello"]);
    expect(world.pageOf(0).clicks[0]).toMatchObject({ selector: '[data-bw-id="20"]' });
  });

  test("type 到非输入元素 → ELEMENT_NOT_ACTIONABLE", async () => {
    const { node, locate } = fakeNode("21", { tag: "button" });
    const world = makeFakeWorld({ locateResults: { 21: locate }, rawExtract: { nodes: [node] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expectCode(
      engine.act({ kind: "type", index: "21", text: "x" }, snapOf([node])),
      "ELEMENT_NOT_ACTIONABLE",
    );
  });

  test("type_text_secret：无解析器 → SECRET_UNRESOLVED；有解析器 → 输入且本页 look 被拒", async () => {
    const { node, locate } = fakeNode("22", { type: "password" });
    const world = makeFakeWorld({ locateResults: { 22: locate }, rawExtract: { nodes: [node] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expectCode(
      engine.act({ kind: "type_text_secret", index: "22", secretName: "pw" }, snapOf([node])),
      "SECRET_UNRESOLVED",
    );

    const engine2 = createActionEngine(world.driver, {
      resolveSecret: async (name, origin) => {
        expect(name).toBe("pw");
        expect(origin).toBe("https://fake.test");
        return "hunter2";
      },
    });
    const r = await engine2.act({ kind: "open_tab", url: "https://fake.test/page" });
    expect(r.text).toContain("opened tab");
    await engine2.act({ kind: "type_text_secret", index: "22", secretName: "pw" }, snapOf([node]));
    expect(world.pageOf(1).typed).toEqual(["hunter2"]);
    await expectCode(engine2.act({ kind: "look" }), "POLICY_BLOCKED");
  });
});

describe("press / scroll / select / 文本与视觉", () => {
  test("press Enter 在表单内 → enter_submit 意图 + 按键记录", async () => {
    const world = makeFakeWorld({
      locateResults: {},
      rawExtract: { nodes: [] },
      enterSubmit: { submit: true, action: "https://fake.test/submitted", method: "get" },
    });
    const intents: NavigationIntent[] = [];
    const engine = createActionEngine(world.driver, {
      intentSink: (i) => {
        intents.push(i);
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "press", key: "Enter" });
    expect(intents).toEqual([
      { kind: "enter_submit", href: "https://fake.test/submitted", method: "get" },
    ]);
    expect(world.pageOf(0).presses).toEqual([{ key: "Enter", modifiers: undefined }]);
  });

  test("press 非 Enter 不解析意图", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const intents: NavigationIntent[] = [];
    const engine = createActionEngine(world.driver, {
      intentSink: (i) => {
        intents.push(i);
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "press", key: "Escape" });
    expect(intents).toEqual([]);
  });

  test("scroll 方向与步长（含自定义 amount）", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "scroll", direction: "down" });
    await engine.act({ kind: "scroll", direction: "left", amount: 250 });
    expect(world.pageOf(0).scrolls).toEqual([
      { dx: 0, dy: 600 },
      { dx: -250, dy: 0 },
    ]);
  });

  test("scroll_to：可达滚动；不可达 → ELEMENT_NOT_FOUND", async () => {
    const { node, locate } = fakeNode("30", { tag: "a", below: true });
    const world = makeFakeWorld({ locateResults: { 30: locate }, rawExtract: { nodes: [node] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act({ kind: "scroll_to", index: "30" }, snapOf([node]));
    expect(r.text).toContain("scrolled to");
    world.setLocate("31", { found: false });
    await expectCode(
      engine.act({ kind: "scroll_to", index: "31" }, snapOf([{ ...node, id: "31" }])),
      "ELEMENT_NOT_FOUND",
    );
  });

  test("select：合法设置；非 select 节点 → ELEMENT_NOT_ACTIONABLE", async () => {
    const sel = fakeNode("40", { tag: "select" });
    const world = makeFakeWorld({
      locateResults: { 40: sel.locate },
      rawExtract: { nodes: [sel.node] },
    });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act({ kind: "select", index: "40", value: "slow" }, snapOf([sel.node]));
    expect(r.text).toContain("slow");
    const btn = fakeNode("41", { tag: "button" });
    world.setLocate("41", btn.locate);
    await expectCode(
      engine.act({ kind: "select", index: "41", value: "x" }, snapOf([btn.node])),
      "ELEMENT_NOT_ACTIONABLE",
    );
  });

  test("extract_text / look / wait / done", async () => {
    const world = makeFakeWorld({
      locateResults: {},
      rawExtract: { nodes: [] },
      bodyText: "page body content",
    });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });

    const text = await engine.act({ kind: "extract_text" });
    expect(text.text).toBe("page body content");
    expect(text.snapshot).toBeNull();

    const look = await engine.act({ kind: "look" });
    expect(look.image?.base64).toBeDefined();
    expect(look.image?.mimeType).toBe("png");

    const waited = await engine.act({ kind: "wait", seconds: 0.1 });
    expect(waited.text).toContain("waited");

    const done = await engine.act({ kind: "done", answer: "all good" });
    expect(done.done).toBe(true);
    expect(done.text).toBe("all good");
  });
});

describe("tab 管理", () => {
  test("open/switch/close 与越界", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const engine = createActionEngine(world.driver);
    await engine.act({ kind: "open_tab", url: "https://fake.test/a" });
    await engine.act({ kind: "open_tab", url: "https://fake.test/b" });
    expect(world.driver.pages().length).toBe(2);
    const r = await engine.act({ kind: "switch_tab", tab: 0 });
    expect(r.text).toContain("https://fake.test/a");
    await expectCode(engine.act({ kind: "switch_tab", tab: 5 }), "INVALID_TOOL_ARGS");
    await engine.act({ kind: "close_tab" });
    expect(world.driver.pages().length).toBe(1);
    expect(engine.activePage().url).toBe("https://fake.test/b");
  });
});

describe("settle 语义", () => {
  test("永动页到上限照常继续（不报错）", async () => {
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] }, quietMs: 0 });
    const engine = createActionEngine(world.driver, { settleCapMs: 250, settleQuietMs: 500 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" }).catch(() => {});
    const t0 = Date.now();
    const r: ActionResult = await engine.act({ kind: "navigate", url: "https://fake.test/x" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200); // 烧完上限
    expect(r.snapshot).not.toBeNull(); // 照常提取
  }, 10_000);
});
