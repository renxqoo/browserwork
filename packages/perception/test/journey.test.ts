/**
 * B1 de-risk 垂直切片旅程（02 §3 B1 验收点）：
 * 打开 → 提取索引树 → selector 轨点击链接 → 断言新页快照。
 * 真 webkit + fixture 站，无 LLM、无外网。
 */
import { describe, expect, test } from "bun:test";
import { createWebViewDriver } from "@bw/driver";
import { waitForNavigation, withDriverPage, withFixtureServer } from "@bw/testing";
import { extractSnapshot, renderSnapshot } from "../src/index.ts";

describe.skipIf(process.platform !== "darwin")("B1 de-risk 旅程", () => {
  test("打开→提取→按索引点击链接→断言新页", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/index.html`);

          const snap = await extractSnapshot(page);
          expect(snap.title).toBe("BW Fixture Home");
          expect(snap.headings[0]?.text).toBe("Home");

          const link = snap.nodes.find((n) => n.tag === "a" && n.text === "Links page");
          expect(link).toBeDefined();
          expect(link?.href).toBe(`${origin}/links.html`);

          const rendered = renderSnapshot(snap);
          expect(rendered.startsWith("# Page: BW Fixture Home")).toBe(true);
          expect(rendered).toContain(`[${link?.id}] link "Links page"`);

          await page.click(`[data-bw-id="${link?.id}"]`);
          const landed = await waitForNavigation(page);
          expect(landed).toBe(`${origin}/links.html`);

          const snap2 = await extractSnapshot(page);
          expect(snap2.headings[0]?.text).toBe("Links");
          expect(snap2.domHash).not.toBe(snap.domHash);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("密码框值恒 ***（S6 在提取层的最低保证）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/form.html`);
          await page.evaluate(
            "document.querySelector('input[type=password]').value = 'supersecret-value'",
          );
          const snap = await extractSnapshot(page);
          const pw = snap.nodes.find((n) => n.type === "password");
          expect(pw).toBeDefined();
          expect(pw?.value).toBe("***");
          expect(renderSnapshot(snap)).not.toContain("supersecret-value");
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("长页：小预算截断标注 + 渲染不超预算", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/long?n=300`);
          const snap = await extractSnapshot(page, { budgetChars: 900 });
          expect(snap.nodes.length).toBe(300);
          expect(snap.truncated).toBe(true);
          const rendered = renderSnapshot(snap, 900);
          expect(rendered.length).toBeLessThanOrEqual(900);
          expect(rendered).toMatch(/下方还有 \d+ 个元素未显示/);
          expect(snap.nodes.filter((n) => n.below).length).toBeGreaterThan(0);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);
});
