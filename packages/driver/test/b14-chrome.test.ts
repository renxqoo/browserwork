/**
 * B14 chrome 真视图契约（skip-if 无 chrome）：cdp/resize/reload/UA/webp/下载 e2e。
 * 探针 p10/p11 的行为进契约（CI Linux 走系统 chrome，macOS 有则跑）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSnapshot, renderSnapshot } from "@bw/perception";
import { createWebViewDriver } from "../src/backends.ts";
import { connectHelper } from "../src/helperClient.ts";
import { spawnHelper } from "../src/helperSpawn.ts";

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
  test("UA 反泄漏：默认不含 Headless 标记且版本对齐真机（Bun 强制 --headless 的反制）", async () => {
    const f = startFixture();
    const driver = createWebViewDriver({ backend: "chrome" });
    try {
      const page = await driver.createPage({ url: `${f.origin}/` });
      const ua = await page.evaluate<string>("navigator.userAgent");
      expect(ua.includes("Headless")).toBe(false);
      const m = /Chrome\/(\d+)/.exec(ua);
      expect(m?.[1]).toMatch(/^\d+$/);
      // 版本对齐真机（动态取——不锁死具体号）
      const bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (existsSync(bin)) {
        const { spawnSync } = await import("node:child_process");
        const ver = /(\d+)/.exec(
          spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout ?? "",
        )?.[1];
        expect(m?.[1]).toBe(ver);
      }
    } finally {
      driver.close();
      f.stop();
    }
  }, 45_000);

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

describe.skipIf(!chromeAvailable)("B20 chrome 真视图（pierce/loc/batch）", () => {
  function startPierceFixture(): { origin: string; stop(): void } {
    const serverB = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/frame") {
          return new Response(
            '<!doctype html><title>XF</title><button id="cross-btn" data-testid="cross-submit">Cross Btn</button>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("nf", { status: 404 });
      },
    });
    const portB = serverB.port;
    const serverA = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/") {
          return new Response(
            `<!doctype html><title>P20</title>
<input id="email" type="text">
<button data-testid="submit-btn">Go</button>
<iframe src="http://127.0.0.1:${portB}/frame"></iframe>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("nf", { status: 404 });
      },
    });
    return {
      origin: `http://127.0.0.1:${serverA.port}`,
      stop: () => {
        serverA.stop(true);
        serverB.stop(true);
      },
    };
  }

  test("cdpPierceNodes 返回跨域 iframe 节点（几何+锚点）", async () => {
    const f = startPierceFixture();
    const driver = createWebViewDriver({ backend: "chrome" });
    try {
      const page = await driver.createPage({ url: `${f.origin}/` });
      await new Promise((r) => setTimeout(r, 1500));
      const nodes = await page.cdpPierceNodes?.();
      expect(nodes).toBeTruthy();
      const cross = (nodes ?? []).find((n) => n.tag === "button");
      expect(cross).toBeTruthy();
      expect(cross?.text).toContain("Cross Btn");
      expect(cross?.w ?? 0).toBeGreaterThan(0);
    } finally {
      driver.close();
      f.stop();
    }
  }, 60_000);

  test("extractSnapshot 并入 ⟂cross-frame 节点；主文档节点带 loc=", async () => {
    const f = startPierceFixture();
    const driver = createWebViewDriver({ backend: "chrome" });
    try {
      const page = await driver.createPage({ url: `${f.origin}/` });
      await new Promise((r) => setTimeout(r, 1500));
      const snap = await extractSnapshot(page);
      const text = renderSnapshot(snap);
      expect(text).toContain("⟂cross-frame");
      expect(text).toContain("Cross Btn");
      expect(text).toContain("loc=#email");
      expect(text).toContain('loc=[data-testid="submit-btn"]');
      expect(snap.warnings.join("\n")).toContain("cross-origin iframe nodes");
    } finally {
      driver.close();
      f.stop();
    }
  }, 60_000);

  test("UA 引导失败真因探测：data-dir 被另一进程的 Chrome 持有 → 报文点名残留进程", async () => {
    // 全程子进程（bun 测试进程自身已持 Chrome 时 Bun 复用它——dataStore 不生效，
    // 冲突不会发生；泄漏场景即跨进程 CLI，两侧都放子进程仿真）
    const dir = join(tmpdir(), `bw-b14-held-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    const { writeFileSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const backendsUrl = new URL("../src/backends.ts", import.meta.url).pathname;
    const holderJs = join(tmpdir(), `bw-b14-holder-${process.pid}.js`);
    const secondJs = join(tmpdir(), `bw-b14-second-${process.pid}.js`);
    writeFileSync(
      holderJs,
      `import { createWebViewDriver } from ${JSON.stringify(backendsUrl)};
         const d = createWebViewDriver({ backend: "chrome", dataStore: ${JSON.stringify(dir)} });
         await d.createPage({ url: "about:blank" });
         console.log("READY");
         setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      secondJs,
      `import { createWebViewDriver } from ${JSON.stringify(backendsUrl)};
         const d = createWebViewDriver({ backend: "chrome", dataStore: ${JSON.stringify(dir)}, userAgent: "BW-Held-UA/1.0" });
         try { await d.createPage(); console.log("NO-THROW"); }
         catch (e) { console.log("THREW:" + (e instanceof Error ? e.message : String(e))); }
         process.exit(0);`,
    );
    const holder = spawn(process.execPath, [holderJs], { stdio: ["ignore", "pipe", "pipe"] });
    let holderErr = "";
    holder.stderr.on("data", (c: Buffer) => {
      holderErr += c.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`holder not ready in 45s; stderr: ${holderErr}`)),
          45_000,
        );
        holder.stdout.on("data", (c: Buffer) => {
          if (c.toString().includes("READY")) {
            clearTimeout(t);
            resolve();
          }
        });
        holder.on("exit", (code) =>
          reject(new Error(`holder exited early (code ${code}); stderr: ${holderErr}`)),
        );
      });
      const second = spawn(process.execPath, [secondJs], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      second.stdout.on("data", (c: Buffer) => {
        out += c.toString();
      });
      await new Promise((r2) => second.on("exit", r2));
      expect(out).toContain("held by a leftover Chrome process");
      expect(out).toContain(dir);
      expect(out).toContain("bw s gc");
    } finally {
      holder.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      rmSync(holderJs, { force: true });
      rmSync(secondJs, { force: true });
    }
  }, 90_000);

  test("requests 跨命令捕获：连接A导航→断连→连接B读环（agent 反馈回归）", async () => {
    const f = startFixture();
    const sessionDir = join(tmpdir(), `bw-b14-net-${process.pid}`);
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true }); // spawnHelper 不建目录（store 契约）——socket bind 失败 helper 秒退
    const h = await spawnHelper({ sessionDir, backend: "chrome" });
    try {
      // 连接 A（=命令1）：建页导航后断连——engine 侧缓冲随进程死，helper 环必须活
      const d1 = await connectHelper(h.socketPath);
      await d1.createPage({ url: `${f.origin}/` });
      await new Promise((r) => setTimeout(r, 800));
      d1.release();
      // 连接 B（=命令2）：netRequests 读到 A 期间的请求
      const d2 = await connectHelper(h.socketPath);
      const p2 = (await d2.pages())[0] as unknown as {
        netRequests: () => Promise<Array<{ url: string }>>;
      };
      const entries = await p2.netRequests();
      expect(entries.some((e) => e.url.includes(f.origin))).toBe(true);
      d2.release();
    } finally {
      h.killGroup();
      f.stop();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 60_000);
});
