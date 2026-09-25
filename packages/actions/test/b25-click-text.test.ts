/**
 * B25 Fix A 引擎级测试口径（docs/design-B25-rnw-fixes.md）：
 * click_text 的出界/遮挡/空文本语义 + 单源表达式消费。
 * FakeDriver 引擎级——不碰真浏览器。
 */
import { describe, expect, test } from "bun:test";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { FakeDriver, type FakePageOptions } from "@bw/driver";
import { CLICK_TEXT_LOCATE_EXPRESSION, EXTRACT_EXPRESSION } from "@bw/perception";
import { createActionEngine } from "../src/engine.ts";

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

const snapHandler = (expr: string): unknown => {
  if (expr === EXTRACT_EXPRESSION) {
    return {
      nodes: [],
      headings: [],
      warnings: [],
      title: "t",
      url: "https://t/",
      scrollY: 0,
      scrollX: 0,
      docHeight: 800,
      viewportH: 720,
    };
  }
  if (expr.includes("__bwSettle")) return 10_000;
  return null;
};

const isLocate = (expr: string): boolean =>
  expr === CLICK_TEXT_LOCATE_EXPRESSION("__probe__", 1280, 720) ||
  /^\/\* bw-locate \*\//.test(expr) ||
  expr.includes("__bwLocateText");

const mkEngine = (locateReply: unknown, seen?: string[]): Driver => {
  const handler = (expr: string): unknown => {
    seen?.push(expr);
    if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
    if (expr.includes("__bwSettle")) return 10_000;
    if (isLocate(expr)) return locateReply;
    return null;
  };
  return new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver;
};

describe("click_text 引擎语义（B25 Fix A）", () => {
  test("空文本 → INVALID_TOOL_ARGS（页面外拒绝，不空转）", async () => {
    const engine = createActionEngine(mkEngine({ found: true }), {
      settleQuietMs: 10,
      settleCapMs: 200,
    });
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await expect(engine.act({ kind: "click_text", text: "" })).rejects.toThrow(
      /non-blank/i,
    );
  });

  test("纯空白文本 → INVALID_TOOL_ARGS（归一后为空同样拒绝）", async () => {
    const engine = createActionEngine(mkEngine({ found: true }), {
      settleQuietMs: 10,
      settleCapMs: 200,
    });
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await expect(engine.act({ kind: "click_text", text: "  \n\t " })).rejects.toThrow(
      /non-blank/i,
    );
  });

  test("全候选被遮挡 → ELEMENT_NOT_FOUND + occluded 理由", async () => {
    const engine = createActionEngine(
      mkEngine({ found: false, reason: "occluded", matches: 2 }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await expect(engine.act({ kind: "click_text", text: "深色" })).rejects.toThrow(
      /occluded|遮挡/,
    );
  });

  test("全候选出界且滚入后仍无 → ELEMENT_NOT_FOUND + offscreen 理由", async () => {
    const engine = createActionEngine(
      mkEngine({ found: false, reason: "offscreen", matches: 1 }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await expect(engine.act({ kind: "click_text", text: "返回" })).rejects.toThrow(
      /outside viewport/i,
    );
  });

  test("消费单源表达式（页面收到的就是 CLICK_TEXT_LOCATE_EXPRESSION 的产物）", async () => {
    const seen: string[] = [];
    const engine = createActionEngine(
      mkEngine({ found: true, x: 10, y: 20, w: 30, h: 8, matches: 1, tag: "div" }, seen),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await engine.act({ kind: "click_text", text: "日K" });
    const locateCalls = seen.filter((e) => e.includes("__bwLocateText"));
    expect(locateCalls.length).toBeGreaterThanOrEqual(1);
    // 与单源生成器逐字节一致（含注入文本与视口）
    expect(locateCalls[0]).toBe(CLICK_TEXT_LOCATE_EXPRESSION("日K", 1280, 720));
  });

  test("多匹配 → 输出仍报 (N matches, clicked smallest/best)", async () => {
    const engine = createActionEngine(
      mkEngine({ found: true, x: 0, y: 0, w: 10, h: 10, matches: 3, tag: "span" }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.act({ kind: "click_text", text: "日K" });
    expect(r.text).toContain("3 matches");
    expect(r.text).toContain("smallest/best");
  });

  test("视口外元素由页内 scrollIntoView 滚入（不再依赖 window.scroll——内部滚动容器也可达）", async () => {
    const seen: string[] = [];
    const handler = (expr: string): unknown => {
      seen.push(expr);
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("__bwLocateText")) {
        return { found: true, x: 5, y: 300, w: 40, h: 20, matches: 1, tag: "div" };
      }
      return null;
    };
    const driver = new FakeDriver(CAPS, {
      evaluateHandler: handler as never,
    }) as unknown as Driver;
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.act({ kind: "click_text", text: "深色" });
    expect(r.text).toContain('clicked <div "深色">');
    // 页内滚入：不再发 page.scroll（window 滚动）——滚入在定位表达式内完成
    const page = driver.pages()[0] as unknown as { scrolls: unknown[]; clicks: Array<{ x: number; y: number }> };
    expect(page.scrolls).toHaveLength(0);
    expect(page.clicks).toHaveLength(1);
    expect([page.clicks[0]?.x, page.clicks[0]?.y]).toEqual([25, 310]);
    // 只有一次定位往返（滚动内联，无第二次 re-locate）
    expect(seen.filter((e) => e.includes("__bwLocateText")).length).toBe(1);
  });
});
