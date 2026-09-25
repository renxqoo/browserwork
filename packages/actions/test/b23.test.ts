/** B22+ 实战反馈修复：eval 语义（自动 IIFE/EVAL_ERROR）+ click_text + look fullPage + extract 截断标记 */
import { describe, expect, test } from "bun:test";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { FakeDriver, type FakePageOptions } from "@bw/driver";
import { EXTRACT_EXPRESSION } from "@bw/perception";
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

const CLICK_TEXT_EXPR_PREFIX = "/* __bwLocateText */";
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

describe("eval 语义（用户实战问题 2）", () => {
  const mk = (opts?: Partial<FakePageOptions>): Driver =>
    new FakeDriver(CAPS, { evaluateHandler: snapHandler as never, ...opts }) as unknown as Driver;

  test("自动 IIFE：多语句表达式包 (() => { ... })() 求值", async () => {
    const seen: string[] = [];
    const engine = createActionEngine(
      mk({
        evaluateHandler: (expr: string) => {
          seen.push(expr);
          if (expr === EXTRACT_EXPRESSION) return snapHandler(expr) as never;
          if (expr.includes("__bwSettle")) return 10_000 as never;
          return 42 as never;
        },
      }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const out = await engine.runExpression("let x = 40; x + 2");
    expect(out).toBe("42");
    expect(seen.some((e) => e.startsWith("(() => {") && e.includes("let x = 40"))).toBe(true);
  });

  test("表达式形态不包（1+1 直传）", async () => {
    const seen: string[] = [];
    const engine = createActionEngine(
      mk({
        evaluateHandler: (expr: string) => {
          seen.push(expr);
          if (expr === EXTRACT_EXPRESSION) return snapHandler(expr) as never;
          if (expr.includes("__bwSettle")) return 10_000 as never;
          return "2" as never;
        },
      }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await engine.runExpression("1+1");
    expect(seen).toContain("1+1");
  });

  test("语法错 → EVAL_ERROR + SyntaxError 消息（非 DRIVER_ERROR/表达式回显）", async () => {
    const engine = createActionEngine(mk({ evaluateHandler: snapHandler as never }), {
      settleQuietMs: 10,
      settleCapMs: 200,
    });
    await engine.act({ kind: "open_tab", url: "https://t/" });
    try {
      await engine.runExpression("this is ((( not valid");
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("EVAL_ERROR");
      expect((e as Error).message).toContain("SyntaxError");
      expect((e as Error).message).not.toContain("this is ((( not valid"); // 不回显整段表达式
    }
  });

  test("页面运行时异常 → EVAL_ERROR + 真实异常消息", async () => {
    const engine = createActionEngine(
      mk({
        evaluateHandler: (expr: string) => {
          if (expr === EXTRACT_EXPRESSION) return snapHandler(expr) as never;
          if (expr.includes("__bwSettle")) return 10_000 as never;
          throw new Error("ReferenceError: boomVar is not defined");
        },
      }),
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    try {
      await engine.runExpression("boomVar");
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("EVAL_ERROR");
      expect((e as Error).message).toContain("boomVar is not defined");
    }
  });
});

describe("click_text（用户实战问题 3：SPA div-tab）", () => {
  test("找到文本元素 → clickAt 中心坐标 + 汇报匹配数", async () => {
    const clicks: Array<[number, number]> = [];
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.startsWith(CLICK_TEXT_EXPR_PREFIX)) {
        return { found: true, x: 100, y: 200, w: 60, h: 30, matches: 3, tag: "div" };
      }
      return null;
    };
    const driver = new FakeDriver(CAPS, {
      evaluateHandler: handler as never,
    } as Partial<FakePageOptions>) as unknown as Driver;
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.act({ kind: "click_text", text: "日K" });
    expect(r.text).toContain('clicked <div "日K">');
    expect(r.text).toContain("3 matches");
    const page = driver.pages()[0] as unknown as { clicks: Array<{ x: number; y: number }> };
    expect(page.clicks).toHaveLength(1);
    expect([page.clicks[0]?.x, page.clicks[0]?.y]).toEqual([130, 215]); // 中心
    void clicks;
  });

  test("找不到 → ELEMENT_NOT_FOUND", async () => {
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.startsWith(CLICK_TEXT_EXPR_PREFIX)) return { found: false };
      return null;
    };
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await expect(engine.act({ kind: "click_text", text: "不存在" })).rejects.toThrow(
      'no visible element with text "不存在"',
    );
  });
});

describe("look fullPage + extract 截断标记（小摩擦）", () => {
  test("webkit（无 cdp）fullPage → INVALID_TOOL_ARGS 明说仅 chrome", async () => {
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: snapHandler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await expect(engine.act({ kind: "look", fullPage: true })).rejects.toThrow(
      /full-page screenshot requires the chrome backend/,
    );
  });

  test("extract_text 达上限 → 附截断标记 + 总长", async () => {
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("innerText")) {
        return JSON.stringify({ n: 9000, t: "x".repeat(4000) });
      }
      return null;
    };
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.act({ kind: "extract_text" });
    expect(r.text).toContain("[truncated at 4000/9000 chars");
  });

  test("extract_text 未达上限 → 无标记", async () => {
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("innerText")) return JSON.stringify({ n: 100, t: "短文本" });
      return null;
    };
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.act({ kind: "extract_text" });
    expect(r.text).toBe("短文本");
  });
});
