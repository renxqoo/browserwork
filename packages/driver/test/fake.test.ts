/** FakePage/FakeDriver 替身自身行为（U2：替身必须语义保真，否则下游测试失真） */
import { describe, expect, test } from "bun:test";
import { BWError } from "@bw/core";
import { FakeDriver, FakePage } from "../src/index.ts";

describe("FakePage", () => {
  test("url/title/loading 只读态", () => {
    const page = new FakePage({ url: "https://a.test/", title: "A" });
    expect(page.url).toBe("https://a.test/");
    expect(page.title).toBe("A");
    expect(page.loading).toBe(false);
  });

  test("navigate 成功：url 变化 + onNavigated 通知 + navHistory", async () => {
    const page = new FakePage();
    const seen: string[] = [];
    page.onNavigated((url) => seen.push(url));
    await page.navigate("https://a.test/x");
    expect(page.url).toBe("https://a.test/x");
    expect(seen).toEqual(["https://a.test/x"]);
    expect(page.navHistory).toEqual(["https://a.test/x"]);
  });

  test("navigate 失败：onNavigationFailed 通知 + NAVIGATION_FAILED", async () => {
    const page = new FakePage({ failUrls: ["fake://nope/"] });
    const failures: string[] = [];
    page.onNavigationFailed((e) => failures.push(e.message));
    await expect(page.navigate("fake://nope/")).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
    expect(failures).toHaveLength(1);
  });

  test("notActionable：命中表内但不可点 → ELEMENT_NOT_ACTIONABLE", async () => {
    const page = new FakePage({ selectors: ["#a", "#b"], notActionable: ["#b"] });
    await page.click("#a");
    expect(page.clicks).toEqual([{ selector: "#a", opts: undefined }]);
    await expect(page.click("#b")).rejects.toMatchObject({ code: "ELEMENT_NOT_ACTIONABLE" });
    await expect(page.click("#missing")).rejects.toMatchObject({
      code: "ELEMENT_NOT_ACTIONABLE",
    });
  });

  test("evaluate：handler 异常包装 DRIVER_ERROR；handler 空返回 null", async () => {
    const page = new FakePage({
      evaluateHandler: (expr) => {
        if (expr === "boom") throw new Error("handler boom");
        return undefined;
      },
    });
    expect(await page.evaluate("anything")).toBeNull();
    try {
      await page.evaluate("boom");
      expect.unreachable();
    } catch (e) {
      expect(BWError.is(e)).toBe(true);
      expect((e as BWError).code).toBe("DRIVER_ERROR");
    }
  });

  test("clickAt 记录坐标", async () => {
    const page = new FakePage();
    await page.clickAt(10, 20, { button: "right" });
    expect(page.clicks).toEqual([{ x: 10, y: 20, opts: { button: "right" } }]);
  });

  test("screenshot 返回合法 PNG 字节", async () => {
    const png = await new FakePage().screenshot();
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  test("close 后 url 抛 DRIVER_ERROR；onClosed 恰好一次且可退订", async () => {
    const page = new FakePage({ url: "https://a/" });
    let closed = 0;
    const off = page.onClosed(() => closed++);
    page.close();
    page.close();
    expect(closed).toBe(1);
    expect(() => page.url).toThrow();
    off();
    // 退订后再 close（已关，无副作用）
    expect(() => page.title).toThrow();
  });
});

describe("FakeDriver", () => {
  test("默认 capabilities 为 webkit 形态", () => {
    expect(new FakeDriver().capabilities()).toEqual({
      cdp: false,
      upload: false,
      download: false,
      dialogEvents: false,
      userAgentOverride: false,
      pierceClick: false,
    });
  });

  test("close 后 createPage 抛；pages 注册表收缩", async () => {
    const driver = new FakeDriver();
    const p1 = await driver.createPage();
    await driver.createPage();
    p1.close();
    expect(driver.pages()).toHaveLength(1);
    driver.close();
    await expect(driver.createPage()).rejects.toMatchObject({ code: "DRIVER_ERROR" });
  });
});
