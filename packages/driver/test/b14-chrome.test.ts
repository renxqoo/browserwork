/**
 * B14 chrome 真视图契约（skip-if 无 chrome）：cdp/resize/reload/UA/webp/下载 e2e。
 * 探针 p10/p11 的行为进契约（CI Linux 走系统 chrome，macOS 有则跑）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebViewDriver } from "../src/backends.ts";

const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter((p): p is string => p !== undefined);

const chromeAvailable = CHROME_CANDIDATES.some((p) => existsSync(p));

/** 每用例独立 fixture（server 生命周期与用例对齐） */
function startFixture(): { origin: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/")
        return new Response('<!doctype html><title>B14</title><a id="a" href="/next">next</a>', {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (p === "/next")
        return new Response("<!doctype html><title>B14 Next</title><p>n</p>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (p === "/file")
        return new Response("hello-b14-download", {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="b14.txt"',
          },
        });
      return new Response("nf", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe.skipIf(!chromeAvailable)("B14 chrome 真视图", () => {
  test("resize/cdp/webp/reload", async () => {
    const f = startFixture();
    const driver = createWebViewDriver({ backend: "chrome" });
    try {
      const page = await driver.createPage({ url: `${f.origin}/` });
      await page.resize(1024, 768);
      const wh = await page.evaluate<{ w: number; h: number }>(
        "({ w: window.innerWidth, h: window.innerHeight })",
      );
      expect(wh?.w).toBeGreaterThanOrEqual(1000);

      const doc = await page.cdp<{ root?: { nodeId?: number } }>("DOM.getDocument", {});
      expect(doc?.root?.nodeId).toBeGreaterThan(0);

      const webp = await page.screenshot({ format: "webp", quality: 60 });
      expect(webp.length).toBeGreaterThan(0);

      await page.reload();
      const url = await page.evaluate<string>("location.href");
      expect(url).toContain(f.origin);
    } finally {
      driver.close();
      f.stop();
    }
  }, 45_000);

  test("UA 覆写（about:blank 引导 → 首请求即带覆写 UA）", async () => {
    const f = startFixture();
    const driver = createWebViewDriver({
      backend: "chrome",
      userAgent: "BW-Contract-UA/1.0",
    });
    try {
      const page = await driver.createPage({ url: `${f.origin}/` });
      const ua = await page.evaluate<string>("navigator.userAgent");
      expect(ua).toContain("BW-Contract-UA/1.0");
    } finally {
      driver.close();
      f.stop();
    }
  }, 45_000);

  test("下载 e2e（Content-Disposition 附件 → 落盘）", async () => {
    const f = startFixture();
    const dlDir = join(tmpdir(), "bw-b14-contract-dl");
    rmSync(dlDir, { recursive: true, force: true });
    const driver = createWebViewDriver({ backend: "chrome" });
    try {
      const page = await driver.createPage({ url: `${f.origin}/` });
      await page.cdp("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dlDir,
        eventsEnabled: true,
      });
      let filename = "";
      page.onCdpEvent("Page.downloadWillBegin", (params) => {
        filename = String((params as { suggestedFilename?: string }).suggestedFilename ?? "");
      });
      // JS 触发下载（a[download] click——不走导航语义，事件路径更干净）
      await page.evaluate(
        `(() => { const a = document.createElement('a'); a.href = '/file'; a.download = 'b14.txt'; document.body.appendChild(a); a.click(); return 1; })()`,
      );
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 20_000);
        page.onCdpEvent("Page.downloadProgress", (params) => {
          if ((params as { state?: string }).state === "completed") {
            clearTimeout(t);
            resolve(true);
          }
        });
      });
      expect(ok).toBe(true);
      expect(filename).toBe("b14.txt");
      await new Promise((r) => setTimeout(r, 800));
      let content = "";
      try {
        content = readFileSync(join(dlDir, "b14.txt"), "utf8");
      } catch {
        content = "";
      }
      expect(content).toContain("hello-b14-download");
      rmSync(dlDir, { recursive: true, force: true });
    } finally {
      driver.close();
      f.stop();
    }
  }, 60_000);
});
