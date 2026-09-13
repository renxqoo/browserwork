/**
 * attach/launch 会话（agent 面）：--cdp-url 连外部浏览器（close 只断连）+
 * --electron spawn app + attach（close 连带收走）。全栈走 SessionStore + 真进程 helper。
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHelper, spawnHelper } from "@bw/driver";
import { createSessionStore } from "../src/store.ts";

const CHROME = [
  process.env.BUN_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
].find((p) => p !== undefined && existsSync(p));
const chromeAvailable = CHROME !== undefined;

describe.skipIf(!chromeAvailable || process.platform !== "darwin")("attach/launch 会话", () => {
  test("--cdp-url：收养外部窗口全栈操作；close 后外部浏览器存活", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          "<!doctype html><title>ExtApp</title><input id=q><button id=b onclick=\"document.title=document.getElementById('q').value\">go</button>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    // 外部浏览器：spawn 侧 helper（带调试口）仿真「别人家的 Electron/Chrome」
    const extDir = mkdtempSync(join(tmpdir(), "bw-att-ext-"));
    const ext = await spawnHelper({
      sessionDir: extDir,
      backend: "chrome",
      dataStore: join(extDir, "data"),
      debugPort: 0,
    });
    const home = mkdtempSync(join(tmpdir(), "bw-att-home-"));
    try {
      const extConn = await connectHelper(ext.socketPath);
      await extConn.createPage({ url: `http://127.0.0.1:${server.port}/` });
      extConn.release();
      await new Promise((r) => setTimeout(r, 500));
      const [port] = readFileSync(join(extDir, "data", "DevToolsActivePort"), "utf8")
        .trim()
        .split("\n");

      const store = createSessionStore({ bwHome: home, policyMode: "test" });
      const r = await store.create({ cdpUrl: `http://127.0.0.1:${port}`, allowEval: true });
      expect(r.confirmed).toBe(true);

      // 全栈：快照引擎过 attach 驱动
      const snap = await store.snapshot(r.id);
      expect(snap).toContain("ExtApp");
      const out = await store.executeTool(r.id, "eval", {
        expression:
          "(() => { const q = document.querySelector('#q'); q.value = 'via-attach'; document.querySelector('#b').click(); return document.title; })()",
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.text).toContain("via-attach");

      // cdp 端点上报：attach 会话直接报所连端点
      const ep = await store.cdpEndpoint(r.id);
      expect(ep.httpUrl).toContain("127.0.0.1");
      expect(ep.pages.some((t) => t.url.includes("127.0.0.1"))).toBe(true);

      // 存在性语义：close 只断连——外部 helper/浏览器必须存活
      store.close(r.id);
      await new Promise((r2) => setTimeout(r2, 500));
      expect(await ext.alive()).toBe(true);
    } finally {
      ext.killGroup();
      server.stop(true);
      rmSync(extDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test("--electron：spawn app + attach；close 连带收走 app", async () => {
    const home = mkdtempSync(join(tmpdir(), "bw-el-home-"));
    const appData = join(home, "app-data");
    try {
      const store = createSessionStore({ bwHome: home, policyMode: "test" });
      const r = await store.create({
        // Chrome 当「app」仿真（真 Electron 同为 Chromium 系）；独立 data-dir
        // 防单例让位（日常 Chrome 在跑时裸启动 exit 0）
        electronPath: CHROME as string,
        electronArgs: [`--user-data-dir=${appData}`, "--no-first-run"],
        allowEval: true,
      });
      expect(r.confirmed).toBe(true);
      const out = await store.executeTool(r.id, "eval", { expression: "location.protocol" });
      expect(out.ok).toBe(true);

      store.close(r.id);
      await new Promise((r2) => setTimeout(r2, 800));
      const alive = await new Promise<boolean>((resolve) => {
        const p = spawn("pgrep", ["-f", `--user-data-dir=${appData}`]);
        p.on("exit", (code) => resolve(code !== 0)); // 1 = 无匹配 = 已收走
      });
      expect(alive).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
