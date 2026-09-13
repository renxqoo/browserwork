/**
 * CdpAttachDriver 契约：bw 主动 attach 外部 CDP 端点（Electron/调试口 Chrome）。
 * 用真 Chrome 带 --remote-debugging-port=0 当「外部浏览器」——close 只断连不杀对方
 * 是本驱动的存在性语义，必须锚死。
 * 共享一个外部浏览器：Bun 同进程 Chrome 单例（dataStore 首个生效）——各测试自行
 * spawn 会拿不到自己的 DevToolsActivePort（实测踩坑）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebViewDriver } from "../src/backends.ts";
import { createCdpAttachDriver } from "../src/cdpAttach.ts";
import { connectHelper } from "../src/helperClient.ts";
import { spawnHelper } from "../src/helperSpawn.ts";

const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => p !== undefined);
const chromeAvailable = CHROME_CANDIDATES.some((p) => existsSync(p));

/** DevToolsActivePort 就绪轮询（冷启动竞态——固定 sleep 会 ENOENT） */
async function waitForActivePort(dir: string): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    const f = join(dir, "DevToolsActivePort");
    if (existsSync(f)) return readFileSync(f, "utf8").trim().split("\n")[0] ?? "";
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("DevToolsActivePort not ready in 6s");
}

describe.skipIf(!chromeAvailable)("CdpAttachDriver（真 Chrome 外部端点）", () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        "<!doctype html><title>ExtWin</title><input id=q><button id=b onclick=\"document.getElementById('out').textContent='ok:'+document.getElementById('q').value\">go</button><div id=out></div><div style=\"height:2000px\"></div>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  });
  const extDir = join(tmpdir(), `bw-att-shared-${process.pid}`);
  const ext = createWebViewDriver({
    backend: "chrome",
    dataStore: extDir,
    argv: ["--remote-debugging-port=0"],
  });
  let extPort = "";
  beforeAll(async () => {
    rmSync(extDir, { recursive: true, force: true });
    await ext.createPage({ url: `http://127.0.0.1:${server.port}/` });
    extPort = await waitForActivePort(extDir);
  }, 60_000);
  afterAll(() => {
    ext.close();
    server.stop(true);
    rmSync(extDir, { recursive: true, force: true });
  });

  test("收养外部窗口 + 交互语义 + close 不杀对方", async () => {
    const d = await createCdpAttachDriver({
      endpoint: `http://127.0.0.1:${extPort}`,
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
    expect(await page.evaluate<string>("document.getElementById('out').textContent")).toBe("ok:hi");
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
    const alive = await fetch(`http://127.0.0.1:${extPort}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    expect(alive).toBe(true);
    d.close(); // 幂等
  }, 60_000);

  test("大消息 UTF-8 完整性（ws 分片重组回归——中文坏字节）", async () => {
    const d = await createCdpAttachDriver({
      endpoint: `http://127.0.0.1:${extPort}`,
      attachExisting: true,
    });
    const page = await d.createPage();
    // 27000 个多字节字符（~81KB）跨 ws 分片边界——逐字节比较
    const big = await page.evaluate<string>("'中文字符串传输测试'.repeat(3000)");
    expect(big).toBe("中文字符串传输测试".repeat(3000));
    d.close();
  }, 60_000);

  test("大消息完整链路：helper 内 attach + RPC evaluate（deepseek 现场路径）", async () => {
    const helperDir = join(tmpdir(), `bw-att-rpc-h-${process.pid}`);
    rmSync(helperDir, { recursive: true, force: true });
    mkdirSync(helperDir, { recursive: true });
    // helper 内跑 attach 驱动（= --cdp-url 会话的真实形态）
    const h = await spawnHelper({
      sessionDir: helperDir,
      backend: "chrome",
      cdpUrl: `http://127.0.0.1:${extPort}`,
    });
    try {
      const conn = await connectHelper(h.socketPath);
      const page = await conn.createPage();
      const big = await page.evaluate<string>("'中文传输测试'.repeat(4000)");
      expect(big).toBe("中文传输测试".repeat(4000));
      conn.release();
    } finally {
      h.killGroup();
      rmSync(helperDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("端点不可达 → 可读错误", async () => {
    await expect(createCdpAttachDriver({ endpoint: "http://127.0.0.1:1" })).rejects.toThrow(
      "not reachable",
    );
  }, 15_000);
});
