/**
 * S1③ 事件甄别回归（四案：deepseek/eastmoney/douyin/zhipin）：
 * iframe 加载与浏览器内部过渡（chrome://、about:）绝不能进 navRing——否则 S1③
 * 记违规 + 回滚死锁。主帧真实导航必须照常记录（S1 的存在意义）。
 * 共享外部浏览器（Bun 同进程 Chrome 单例）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHelper } from "../src/helperClient.ts";
import { spawnHelper } from "../src/helperSpawn.ts";

const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
].filter((p): p is string => p !== undefined);
const chromeAvailable = CHROME_CANDIDATES.some((p) => existsSync(p));

/** 跨源 iframe fixture：主文档在 origin1，iframe 指向 origin2（不同端口=跨源） */
function fixturePair(): { main: string; frame: string; stop(): void } {
  const frame = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<!doctype html><title>Tracker</title>track", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  const main = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `<!doctype html><title>Main</title><p>main-content</p><iframe src="http://127.0.0.1:${frame.port}/"></iframe>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  });
  return {
    main: `http://127.0.0.1:${main.port}`,
    frame: `http://127.0.0.1:${frame.port}`,
    stop: () => {
      main.stop(true);
      frame.stop(true);
    },
  };
}

async function waitForActivePort(dir: string): Promise<string> {
  for (let i = 0; i < 130; i += 1) {
    const f = join(dir, "DevToolsActivePort");
    if (existsSync(f)) return readFileSync(f, "utf8").trim().split("\n")[0] ?? "";
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("DevToolsActivePort not ready in 20s");
}

/** 断言环内只有主帧 URL */
const onlyMainUrls = (urls: string[], mainOrigin: string): boolean =>
  urls.every((u) => u.startsWith(mainOrigin) || u === "about:blank");

describe.skipIf(!chromeAvailable)("S1③ 事件甄别（iframe/内部过渡不入环）", () => {
  const fx = fixturePair();
  afterAll(() => {
    fx.stop();
  });

  test("attach 路径：收养页 iframe 不入环；主帧导航照常记录", async () => {
    // 外部浏览器 = 独立进程 helper（进程内 createWebViewDriver 会撞 Bun 同进程
    // Chrome 单例——全量测试时 dataStore 被先跑的文件占用，ActivePort 永不就绪）
    const extH = await spawnHelper({
      sessionDir: mkdtempSync(join(tmpdir(), "bw-s1-ext-")),
      backend: "chrome",
      dataStore: join(tmpdir(), `bw-s1-extd-${process.pid}`),
      debugPort: 0,
    });
    const extConn = await connectHelper(extH.socketPath);
    await extConn.createPage({ url: `${fx.main}/` });
    extConn.release();
    const extPort = await waitForActivePort(join(tmpdir(), `bw-s1-extd-${process.pid}`));
    const h = await spawnHelper({
      sessionDir: mkdtempSync(join(tmpdir(), "bw-s1-att-")),
      backend: "chrome",
      cdpUrl: `http://127.0.0.1:${extPort}`,
    });
    try {
      const conn = await connectHelper(h.socketPath);
      const page = await conn.createPage(); // 收养 fixture 页（iframe 已在加载）
      await new Promise((r) => setTimeout(r, 1200)); // 等 iframe 加载完
      // 主帧真实导航（S1 必须能看到的）
      await page.navigate(`${fx.main}/second`, { timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 1200));
      const ring = await conn.conn.call<{ events: Array<{ url: string }> }>("navEvents", {
        since: 0,
      });
      const urls = (ring.events ?? []).map((e) => e.url);
      expect(urls.some((u) => u.includes("/second"))).toBe(true); // 主帧导航在环
      expect(onlyMainUrls(urls, fx.main)).toBe(true); // iframe host/内部页不在环
      conn.release();
    } finally {
      h.killGroup();
      extH.killGroup();
      rmSync(join(tmpdir(), `bw-s1-extd-${process.pid}`), { recursive: true, force: true });
    }
  }, 90_000);

  test("spawn 路径：主帧导航必入环（iframe 泄漏由 S1③ 消费端同站放宽兜住）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-s1-sp-"));
    const h = await spawnHelper({ sessionDir: dir, backend: "chrome", dataStore: join(dir, "d") });
    try {
      const conn = await connectHelper(h.socketPath);
      const page = await conn.createPage({ url: `${fx.main}/` });
      await new Promise((r) => setTimeout(r, 1500)); // 等 iframe 加载完
      await page.navigate(`${fx.main}/third`, { timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 1200));
      const ring = await conn.conn.call<{ events: Array<{ url: string }> }>("navEvents", {
        since: 0,
      });
      const urls = (ring.events ?? []).map((e) => e.url);
      // 现状（架构裁决）：Bun onNavigated 的 iframe 泄漏留在环里，由 store 的
      // S1③ 同站放宽容忍（见 service 端到端回归）。此处锚定：主帧导航必在环
      expect(urls.some((u) => u.includes("/third"))).toBe(true);
      expect(urls.some((u) => u === `${fx.main}/`)).toBe(true);
      conn.release();
    } finally {
      h.killGroup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
