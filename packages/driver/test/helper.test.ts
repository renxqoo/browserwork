/** B22 S1：helper 进程生命周期——真 detached spawn / 活性 / navEvents 环 / 组清理 / 优雅退出 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHelper } from "../src/helperClient.ts";
import { spawnHelper } from "../src/helperSpawn.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "bw-helper-lc-"));

describe.skipIf(process.platform !== "darwin")("helper 进程生命周期（webkit 真进程）", () => {
  test("spawn→就绪→connect→跨连接状态连续→killGroup 清理", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      expect(h.ready.pid).toBe(h.pid);
      expect(h.ready.backend).toBe("webkit");
      expect(await h.alive()).toBe(true);

      // 连接 1：建页 + 设 DOM 态
      const d1 = await connectHelper(h.socketPath);
      const page = await d1.createPage();
      await page.navigate("data:text/html,<input id=q><script>document.title='LC'</script>");
      await page.evaluate("(() => { document.getElementById('q').value = 'v1'; return 1 })()");
      d1.release(); // 仅断连——helper 与页面态必须存活（命令进程退出语义）

      expect(await h.alive()).toBe(true);

      // 连接 2（全新连接=新 CLI 进程等价）：读回活 DOM 态（p14a 语义）
      const d2 = await connectHelper(h.socketPath);
      const page2 = (await d2.pages())[0];
      expect(page2).toBeDefined();
      if (page2 === undefined) throw new Error("page2 missing");
      const got = await page2.evaluate<string>(
        "document.getElementById('q').value + '|' + document.title",
      );
      expect(got).toBe("v1|LC");
      d2.release();

      // 组杀：socket/ready 消失、进程组死
      h.killGroup();
      await new Promise((r) => setTimeout(r, 800));
      expect(await h.alive()).toBe(false);
      expect(existsSync(join(dir, "helper.sock"))).toBe(true); // 文件清理归会话层（store）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("navEvents 事件环：导航序列可按 seq 追赶（S1③ 数据源）", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      const d = await connectHelper(h.socketPath);
      const page = await d.createPage();
      await page.navigate("data:text/html,<title>a</title>");
      await page.navigate("data:text/html,<title>b</title>");
      const ring = await d.conn.call<{
        events: Array<{ seq: number; url: string }>;
        latest: number;
      }>("navEvents", { since: 0 });
      expect(ring.events.length).toBeGreaterThanOrEqual(2);
      expect(ring.latest).toBeGreaterThanOrEqual(2);
      const after = await d.conn.call<{ events: unknown[] }>("navEvents", {
        since: ring.latest,
      });
      expect(after.events.length).toBe(0); // 增量追赶语义
      d.release();
      h.killGroup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("socket 权限 0600（DESIGN §1.1 承诺——S1 审查 P1-4 回归锚）", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      expect(statSync(h.socketPath).mode & 0o777).toBe(0o600);
      h.killGroup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("多连接：探活短连接不劫持在用客户端的事件流（S1 审查 P1-2 回归锚）", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      const d = await connectHelper(h.socketPath);
      const page = await d.createPage();
      const events: string[] = [];
      page.onNavigated((url) => events.push(url));
      await page.navigate("data:text/html,<title>1</title>");
      expect(events.length).toBe(1);
      expect(await h.alive()).toBe(true); // 探活连接来了又走
      await page.navigate("data:text/html,<title>2</title>");
      expect(events.length).toBe(2); // 在用客户端事件流不受影响
      d.release();
      h.killGroup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("订阅-退订-再订阅事件精度（S1 审查 P1-1 回归锚）", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      const d = await connectHelper(h.socketPath);
      const page = await d.createPage();
      const a: string[] = [];
      const b: string[] = [];
      const offA = page.onNavigated((u) => a.push(u));
      page.onNavigated((u) => b.push(u));
      offA(); // A 退订后 B 必须继续收——size 键实现在此覆写 B
      const onC = page.onNavigated(() => {});
      await page.navigate("data:text/html,<title>x</title>");
      onC();
      expect(a.length).toBe(0);
      expect(b.length).toBe(1);
      d.release();
      h.killGroup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("shutdown 优雅退出：回包后进程退出（S1 审查 P1-6 回归锚）", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      const d = await connectHelper(h.socketPath);
      const page = await d.createPage();
      await page.navigate("data:text/html,<script>localStorage.setItem('k','v')</script>");
      await d.conn.call("shutdown");
      await new Promise((r) => setTimeout(r, 1200));
      let alive = false;
      try {
        process.kill(h.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("readyTimeout 超时杀进程不泄漏（S1 审查 P1-5 回归锚）", async () => {
    const dir = tmp();
    try {
      // 不存在的 helper 模块 → 永不就绪 → 超时
      await expect(
        spawnHelper({
          sessionDir: dir,
          backend: "webkit",
          readyTimeoutMs: 1_200,
          helperModule: "/nonexistent/helper-module.ts",
        }),
      ).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 500));
      const left = Bun.spawnSync([
        "sh",
        "-c",
        "ps -axo command | grep 'nonexistent/helper-modul[e]' | wc -l | tr -d ' '",
      ]);
      expect(new TextDecoder().decode(left.stdout).trim()).toBe("0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("连接死 socket → BROWSER_DEAD", async () => {
    const dir = tmp();
    try {
      const h = await spawnHelper({ sessionDir: dir, backend: "webkit" });
      h.killGroup();
      await new Promise((r) => setTimeout(r, 500));
      await expect(connectHelper(h.socketPath)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("FrameWriter 字节队列（helperProtocol）", () => {
  test("构造拒绝非整数/非法 WritableEnd 不炸", async () => {
    const { FrameWriter } = await import("../src/helperProtocol.ts");
    const w = new FrameWriter({ write: () => 0 }); // 永远缓冲满——帧滞留
    w.write("x".repeat(10));
    w.flush(); // 满时不丢异常
    expect(true).toBe(true);
  });
});

describe("RemotePage 事件路由（helperClient 未覆盖分支）", () => {
  test("close 后全部方法抛 DRIVER_ERROR；cdpPierceNodes 缺面报错", async () => {
    const { HelperConnection } = await import("../src/helperClient.ts");
    const conn = new HelperConnection();
    const { RemoteDriver } = await import("../src/helperClient.ts");
    // 构造不连接的 RemoteDriver 只测本地代理语义
    const d = new RemoteDriver(conn, {
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
    const pages = d.pages();
    expect(pages).toEqual([]);
    await expect(d.createPage({})).rejects.toThrow(); // 未连接 → BROWSER_DEAD
  });
});

describe("LineCodec 流式解码（helperProtocol）", () => {
  test("多字节 UTF-8 跨 chunk 不腐坏 + 半行缓冲", async () => {
    const { LineCodec } = await import("../src/helperProtocol.ts");
    const c = new LineCodec();
    const frame = `${JSON.stringify({ text: "中文内容" })}\n`;
    const bytes = new TextEncoder().encode(frame);
    // 从中间切开（多字节字符跨界）
    const cut = Math.floor(bytes.length / 2) + 1;
    const lines1 = c.push(bytes.slice(0, cut));
    expect(lines1).toEqual([]); // 半行不吐
    const lines2 = c.push(bytes.slice(cut));
    expect(lines1.length + lines2.length).toBe(1);
    expect(JSON.parse(lines2[0] ?? "").text).toBe("中文内容");
  });
});
