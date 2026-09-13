/**
 * CdpAttachDriver 契约：bw 主动 attach 外部 CDP 端点（Electron/调试口 Chrome）。
 * 用真 Chrome 带 --remote-debugging-port=0 当「外部浏览器」——close 只断连不杀对方
 * 是本驱动的存在性语义，必须锚死。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebViewDriver } from "../src/backends.ts";
import { createCdpAttachDriver } from "../src/cdpAttach.ts";

const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => p !== undefined);
const chromeAvailable = CHROME_CANDIDATES.some((p) => existsSync(p));

describe.skipIf(!chromeAvailable)("CdpAttachDriver（真 Chrome 外部端点）", () => {
  test("收养外部窗口 + 交互语义 + close 不杀对方", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          "<!doctype html><title>ExtWin</title><input id=q><button id=b onclick=\"document.getElementById('out').textContent='ok:'+document.getElementById('q').value\">go</button><div id=out></div><div style=\"height:2000px\"></div>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    const dir = join(tmpdir(), `bw-att-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    // 「外部浏览器」：spawn 侧 driver 带调试口（与 bw 会话自身无关——测试持有）
    const ext = createWebViewDriver({
      backend: "chrome",
      dataStore: dir,
      argv: ["--remote-debugging-port=0"],
    });
    try {
      await ext.createPage({ url: `http://127.0.0.1:${server.port}/` });
      await new Promise((r) => setTimeout(r, 600));
      const [port] = readFileSync(join(dir, "DevToolsActivePort"), "utf8").trim().split("\n");

      const d = await createCdpAttachDriver({
        endpoint: `http://127.0.0.1:${port}`,
        attachExisting: true,
      });
      // ① 首个 createPage 收养外部窗口（非 about:blank 优先）
      const page = await d.createPage();
      expect(page.url).toContain("127.0.0.1");
      expect(page.title).toBe("ExtWin");

      // ② 交互语义：selector click（含 actionable 等待）+ type + 坐标/键/滚动
      await page.click("#q", { timeoutMs: 5000 });
      await page.type("hi");
      await page.click("#b", { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 200));
      expect(await page.evaluate<string>("document.getElementById('out').textContent")).toBe(
        "ok:hi",
      );
      await page.press("Enter");
      await page.scroll(0, 500);
      await new Promise((r) => setTimeout(r, 300));
      expect(await page.evaluate<number>("window.scrollY")).toBeGreaterThan(0);
      expect((await page.screenshot()).length).toBeGreaterThan(500);

      // ③ navigate + 状态缓存推进
      await page.navigate(`http://127.0.0.1:${server.port}/`, { timeoutMs: 10_000 });
      expect(page.url).toContain("127.0.0.1");

      // ④ 后续 createPage = 新 target（opentab 语义）
      const p2 = await d.createPage({ url: `http://127.0.0.1:${server.port}/` });
      expect(d.pages().length).toBe(2);
      p2.close();

      // ⑤ 存在性语义：close 只断连——外部浏览器必须存活
      d.close();
      await new Promise((r) => setTimeout(r, 400));
      const alive = await fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => r.ok)
        .catch(() => false);
      expect(alive).toBe(true);
      d.close(); // 幂等
    } finally {
      ext.close();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("端点不可达 → 可读错误", async () => {
    await expect(
      createCdpAttachDriver({ endpoint: "http://127.0.0.1:1/json/version" }),
    ).rejects.toThrow("not reachable");
  }, 15_000);
});
