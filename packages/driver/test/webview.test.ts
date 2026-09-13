import { describe, expect, test } from "bun:test";
import { BWError } from "@bw/core";
import { withFixtureServer } from "@bw/testing";
import { classifyClickError, createWebViewDriver } from "../src/index.ts";

const DATA_PAGE = "data:text/html,<title>bw</title><p>hello</p>";

describe("classifyClickError（异常归一表，01 §4.3）", () => {
  test("actionable 语义 → ELEMENT_NOT_ACTIONABLE", () => {
    expect(classifyClickError(new Error("timeout waiting for '#x' to be actionable"))).toBe(
      "ELEMENT_NOT_ACTIONABLE",
    );
  });
  test("普通超时 → TIMEOUT", () => {
    expect(classifyClickError(new Error("operation timed out"))).toBe("TIMEOUT");
  });
  test("其它 → DRIVER_ERROR", () => {
    expect(classifyClickError(new Error("host process died"))).toBe("DRIVER_ERROR");
    expect(classifyClickError("not an error")).toBe("DRIVER_ERROR");
  });
});

/** webkit 仅 macOS（02 §1 平台矩阵：Linux CI 项显式 skip 并计数） */
describe.skipIf(process.platform !== "darwin")("WebViewPage（真 webkit）", () => {
  test("capabilities：webkit 声明（01 §5）", () => {
    expect(createWebViewDriver().capabilities()).toEqual({
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
    });
  });

  test("evaluate：表达式形式 + JSON 往返", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      expect(await page.evaluate<number>("1 + 1")).toBe(2);
      expect(await page.evaluate<{ a: number[] }>("({ a: [1, 2] })")).toEqual({ a: [1, 2] });
      expect(await page.evaluate<string>("document.title")).toBe("bw");
    } finally {
      driver.close();
    }
  });

  test("evaluate：undefined 归一为 null（01 §4.3）", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      expect(await page.evaluate("undefined")).toBeNull();
    } finally {
      driver.close();
    }
  });

  test("evaluate：并发被单飞护栏串行化，不抛 ERR_INVALID_STATE", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      const results = await Promise.all([
        page.evaluate("1+1"),
        page.evaluate("2+2"),
        page.evaluate("3+3"),
      ]);
      expect(results).toEqual([2, 4, 6]);
    } finally {
      driver.close();
    }
  });

  test("click：不存在元素短超时 → ELEMENT_NOT_ACTIONABLE（异常归一 01 §4.3）", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      try {
        await page.click('[data-bw-id="999"]', { timeoutMs: 800 });
        expect.unreachable();
      } catch (e) {
        expect(BWError.is(e)).toBe(true);
        expect((e as BWError).code).toBe("ELEMENT_NOT_ACTIONABLE");
      }
    } finally {
      driver.close();
    }
  });

  test("navigate：不可解析主机 → NAVIGATION_FAILED", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      try {
        await page.navigate("https://bw-nonexistent.invalid/");
        expect.unreachable();
      } catch (e) {
        expect(BWError.is(e)).toBe(true);
        expect((e as BWError).code).toBe("NAVIGATION_FAILED");
      }
    } finally {
      driver.close();
    }
  }, 30_000);

  test("close 后调用 → DRIVER_ERROR（close 幂等）", async () => {
    const driver = createWebViewDriver();
    const page = await driver.createPage();
    page.close();
    page.close();
    expect(() => page.url).toThrow();
    try {
      expect(
        BWError.is(
          (() => {
            try {
              return page.url;
            } catch (e) {
              return e;
            }
          })(),
        ),
      ).toBe(true);
    } finally {
      driver.close();
    }
  });

  test("onNavigated：导航回调可订阅、退订后不再收到（精确断言）", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      const seen: string[] = [];
      const off = page.onNavigated((url) => seen.push(url));
      await page.navigate(DATA_PAGE);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      off();
      const countAtOff = seen.length;
      await page.navigate("data:text/html,<title>b2</title>");
      expect(seen.length).toBe(countAtOff); // 退订后零新事件
    } finally {
      driver.close();
    }
  });

  test("onNavigated：重定向链只报最终 URL（U2 契约，S1③ 数据源）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const page = await driver.createPage();
        const events: string[] = [];
        page.onNavigated((url) => events.push(url));
        const inner = encodeURIComponent(`${origin}/links.html`);
        await page.navigate(`${origin}/redirect?to=${inner}`);
        expect(events).toEqual([`${origin}/links.html`]);
        expect(page.url).toBe(`${origin}/links.html`);
      } finally {
        driver.close();
      }
    });
  }, 30_000);

  test("driver.close 后 createPage 抛 DRIVER_ERROR（幂等 close）", async () => {
    const driver = createWebViewDriver();
    await driver.createPage();
    driver.close();
    driver.close();
    try {
      await driver.createPage();
      expect.unreachable();
    } catch (e) {
      expect(BWError.is(e)).toBe(true);
      expect((e as BWError).code).toBe("DRIVER_ERROR");
    }
  });

  test("screenshot：返回非空 PNG 字节", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      const png = await page.screenshot();
      expect(png.length).toBeGreaterThan(100);
      expect(png[0]).toBe(0x89); // PNG magic
    } finally {
      driver.close();
    }
  });

  test("evaluate：页面运行时异常 → DRIVER_ERROR + 真实消息透传（B22+：不再回显表达式）", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      try {
        await page.evaluate("(() => { throw new Error('page-side boom') })()");
        expect.unreachable();
      } catch (e) {
        expect(BWError.is(e)).toBe(true);
        expect((e as BWError).code).toBe("DRIVER_ERROR");
        expect((e as BWError).message).toContain("page-side boom"); // 真实异常消息
      }
      // 非表达式（语句）输入：SyntaxError 原因透传（旧实现回显表达式——误导排查方向）
      try {
        await page.evaluate("throw new Error('x')");
        expect.unreachable();
      } catch (e) {
        expect(BWError.is(e)).toBe(true);
        expect((e as BWError).message).toContain("SyntaxError");
      }
    } finally {
      driver.close();
    }
  });

  test("click 选项分支：clickCount/button 不经 timeout 路径", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      await page.navigate(DATA_PAGE);
      await page.click("p", { clickCount: 2 });
      await page.click("p", { button: "right" });
    } finally {
      driver.close();
    }
  });

  test("onNavigationFailed：失败导航触发监听", async () => {
    const driver = createWebViewDriver();
    try {
      const page = await driver.createPage();
      const failures: string[] = [];
      page.onNavigationFailed((e) => failures.push(e.message));
      await page.navigate("https://bw-nonexistent.invalid/").catch(() => {});
      expect(failures.length).toBeGreaterThanOrEqual(1);
    } finally {
      driver.close();
    }
  }, 30_000);

  test("clickAt 坐标轨：真实原生点击生效（P0-2 兜底路径证明）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const page = await driver.createPage();
        await page.navigate(`${origin}/index.html`);
        const rect = await page.evaluate<{ x: number; y: number; w: number; h: number }>(
          "(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()",
        );
        await page.evaluate("document.getElementById('q').value = 'hello'");
        await page.clickAt(Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2));
        const out = await page.evaluate<string>("document.getElementById('out').textContent");
        expect(out).toBe("searched: hello");
      } finally {
        driver.close();
      }
    });
  }, 30_000);
});
