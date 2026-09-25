/**
 * B25 Fix A 集成旅程（真 webkit + text-cases.html）——通用网页文本点击能力。
 * 场景矩阵（不绑定 RNW：React tab / 嵌套 div / 常规按钮 / 大容器包含 / 遮挡 /
 * 内部滚动容器 / 图标按钮 / 叠屏副本）。
 * 设计文档：docs/design-B25-rnw-fixes.md 测试口径 A-集成节（泛化版）。
 */
import { describe, expect, test } from "bun:test";
import { createWebViewDriver, type Driver } from "@bw/driver";
import { withDriverPage, withFixtureServer } from "@bw/testing";
import { createActionEngine } from "../src/engine.ts";

describe.skipIf(process.platform !== "darwin")("click_text 通用网页旅程（B25）", () => {
  const withEngine = async (
    fn: (page: Awaited<ReturnType<Driver["createPage"]>>, engine: ReturnType<typeof createActionEngine>) => Promise<void>,
  ): Promise<void> => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/text-cases.html`);
          const engine = createActionEngine(driver);
          engine.adopt(page);
          await fn(page, engine);
        });
      } finally {
        driver.close();
      }
    });
  };

  test("React 式无痕 div-tab（事件委托，无 onclick/role）", async () => {
    await withEngine(async (page, engine) => {
      await engine.act({ kind: "click_text", text: "月K" });
      const clicks = await page.evaluate<string[]>("window.__clicks");
      expect(clicks).toContain("tab:m");
    });
  }, 60_000);

  test("嵌套 div 换行文本（squeeze 归一回归：/s+/g 字母-s bug）", async () => {
    await withEngine(async (page, engine) => {
      const r = await engine.act({ kind: "click_text", text: "查看示例对话" });
      expect(r.text).toContain('clicked <div "查看示例对话">');
      const clicks = await page.evaluate<string[]>("window.__clicks");
      expect(clicks).toContain("nested");
    });
  }, 60_000);

  test("常规按钮（onclick 直挂）与英文链接文本", async () => {
    await withEngine(async (page, engine) => {
      await engine.act({ kind: "click_text", text: "深色" });
      await engine.act({ kind: "click_text", text: "返回" });
      await engine.act({ kind: "click_text", text: "Dark Mode" });
      const clicks = await page.evaluate<string[]>("window.__clicks");
      expect(clicks).toContain("dark");
      expect(clicks).toContain("back");
    });
  }, 60_000);

  test("大容器包含匹配不抢选（最小面积规则：选叶子）", async () => {
    await withEngine(async (page, engine) => {
      // 容器文本含"深色"，但容器面积 90vw×40 远大于叶子——必须点叶子
      await engine.act({ kind: "click_text", text: "深色" });
      const clicks = await page.evaluate<string[]>("window.__clicks");
      expect(clicks).toContain("dark");
      expect(clicks).not.toContain("wide-container");
    });
  }, 60_000);

  test("遮挡：透明遮罩盖住的元素不被点击命中（点容器或报 occluded，不穿透）", async () => {
    await withEngine(async (page, engine) => {
      await engine.act({ kind: "click_text", text: "被盖住" });
      // 命中的绝不是 under-mask 本体（穿透才算失败）——委托记录容器文本
      const clicked = await page.evaluate<string[]>("window.__clicks");
      expect(clicked).not.toContain("被盖住");
    });
  }, 60_000);

  test("内部滚动容器：overflow:auto 里的元素滚入后可点（window.scroll 滚不进来）", async () => {
    await withEngine(async (page, engine) => {
      // 第十二项在 120px 高的 scroller 底部之外
      const r = await engine.act({ kind: "click_text", text: "第十二项" });
      expect(r.text).toContain("clicked");
      const clicks = await page.evaluate<string[]>("window.__clicks");
      expect(clicks).toContain("第十二项");
    });
  }, 60_000);

  test("图标按钮（无可见文本，aria-label 承载）→ click_text 不乱点", async () => {
    await withEngine(async (page, engine) => {
      await expect(engine.act({ kind: "click_text", text: "提交表单" })).rejects.toThrow(
        /no visible element/,
      );
      const clicks = await page.evaluate<string[]>("window.__clicks");
      expect(clicks).not.toContain("icon");
    });
  }, 60_000);

  test("叠屏屏外副本（translateX 出屏）不抢匹配——点中可见者", async () => {
    await withEngine(async (page, engine) => {
      await engine.act({ kind: "click_text", text: "深色" });
      const clicks = await page.evaluate<string[]>("window.__clicks");
      // 可见屏的 dark 命中；屏外副本（screen-b）无监听——若误点无记录但也无 dark
      expect(clicks).toContain("dark");
    });
  }, 60_000);
});
