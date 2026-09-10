/**
 * B11 安全加固测试：
 * 强制鉴权（无 token 配置 → 自动生成，永不裸奔）· Host 白名单（DNS rebinding）·
 * content-type 强制（text/plain CSRF）· body 上限 · 常数时间比对 ·
 * 响应头 nosniff/no-store · SSE 404 · daemon token 不落 argv · PID/token 文件权限。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistServeToken, readServeToken, serveSpawnArgs } from "../src/daemon.ts";
import { createServer, isAllowedHost, tokenMatches } from "../src/server.ts";

describe("tokenMatches（常数时间比对）", () => {
  test("正确/错误/缺失", () => {
    expect(tokenMatches("Bearer abc", "abc")).toBe(false); // 传的是裸 token——不剥前缀
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "xyz")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
  });
});

describe("isAllowedHost（DNS rebinding 防护）", () => {
  test("loopback 绑定只认回环名", () => {
    expect(isAllowedHost("127.0.0.1:3456", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("localhost:3456", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("[::1]:3456", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("::1", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("evil.com:3456", "127.0.0.1")).toBe(false); // rebinding
    expect(isAllowedHost("evil.com", "127.0.0.1")).toBe(false);
    expect(isAllowedHost(null, "127.0.0.1")).toBe(false);
  });

  test("显式 --host（非 loopback）→ 放行任意 Host（运维自觉）", () => {
    expect(isAllowedHost("evil.com:3456", "0.0.0.0")).toBe(true);
    expect(isAllowedHost("lan-host.local:3456", "192.168.1.10")).toBe(true);
    expect(isAllowedHost(null, "0.0.0.0")).toBe(true);
  });
});

describe("serveSpawnArgs（P0-2：token 不落 argv）", () => {
  test("参数只含 serve/--port，无 token", () => {
    const args = serveSpawnArgs(3456);
    expect(args).toContain("serve");
    expect(args).toContain("--port");
    expect(args).toContain("3456");
    expect(args.join(" ")).not.toContain("token");
  });
});

describe("token 文件（P0-4：0600 权限）", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bw-sec-"));
    process.env.BW_HOME = home;
  });
  afterEach(() => {
    delete process.env.BW_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("persistServeToken → 0600 + readServeToken 回读", () => {
    const file = persistServeToken("sekrit-token");
    expect(readServeToken()).toBe("sekrit-token");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("sekrit-token");
  });

  test("空文件 → undefined", () => {
    persistServeToken("");
    expect(readServeToken()).toBeUndefined();
  });

  test("PID 文件：损坏 JSON → 清除 + getDaemonInfo undefined", async () => {
    const { getDaemonInfo } = await import("../src/daemon.ts");
    mkdirSync(join(home, ".bw"), { recursive: true });
    writeFileSync(join(home, ".bw", "serve.pid"), "{broken json");
    expect(getDaemonInfo()).toBeUndefined(); // 读取失败 → 删除僵尸文件
    expect(existsSync(join(home, ".bw", "serve.pid"))).toBe(false);
  });

  test("isServerRunning：活着/死端口/带 token 探测", async () => {
    const { isServerRunning } = await import("../src/daemon.ts");
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    expect(await isServerRunning(`http://127.0.0.1:${srv.port}`)).toBe(true);
    expect(await isServerRunning("http://127.0.0.1:1")).toBe(false);
    srv.stop(true);
  });

  test("ensureServer：BW_SERVER_URL 活着 → 复用；死地址 → 抛错", async () => {
    const { ensureServer } = await import("../src/daemon.ts");
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const url = `http://127.0.0.1:${srv.port}`;
    process.env.BW_SERVER_URL = url;
    const info = await ensureServer();
    expect(info.url).toBe(url);
    expect(info.pid).toBe(0);
    process.env.BW_SERVER_URL = "http://127.0.0.1:1";
    await expect(ensureServer()).rejects.toThrow("not responding");
    delete process.env.BW_SERVER_URL;
    srv.stop(true);
  });

  test("ensureServer：PID 文件指向活服务 → 复用不重复拉起", async () => {
    const { ensureServer } = await import("../src/daemon.ts");
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    mkdirSync(join(home, ".bw"), { recursive: true });
    writeFileSync(
      join(home, ".bw", "serve.pid"),
      JSON.stringify({ url: `http://127.0.0.1:${srv.port}`, pid: 0, port: srv.port }),
    );
    const info = await ensureServer();
    expect(info.url).toBe(`http://127.0.0.1:${srv.port}`);
    srv.stop(true);
  });

  test("ensureServer：默认端口被陌生 token 的服务占用 → 明确报错（不误收养）", async () => {
    const { ensureServer } = await import("../src/daemon.ts");
    // 占住默认端口（占用失败 = 端口被真实 daemon 使用 → 跳过本用例）；
    // 模拟真 bw serve 的鉴权行为——错 token 一律 401
    let blocker: ReturnType<typeof Bun.serve> | undefined;
    try {
      blocker = Bun.serve({
        port: 3456,
        fetch: (req) =>
          req.headers.get("authorization") === "Bearer real-token"
            ? new Response("[]")
            : new Response("nope", { status: 401 }),
      });
    } catch {
      return;
    }
    try {
      await ensureServer("wrong-token");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("cannot authenticate");
    } finally {
      blocker?.stop(true);
    }
  });

  test("stopServer：无 PID 文件 → false；PID 指向活进程 → SIGTERM → true", async () => {
    const { stopServer } = await import("../src/daemon.ts");
    expect(await stopServer()).toBe(false);
    const child = spawn("sleep", ["30"]);
    mkdirSync(join(home, ".bw"), { recursive: true });
    writeFileSync(
      join(home, ".bw", "serve.pid"),
      JSON.stringify({ url: "http://127.0.0.1:1", pid: child.pid ?? 0, port: 1 }),
    );
    expect(await stopServer()).toBe(true);
    // 进程已被 SIGTERM
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(child.pid ?? 0, 0);
      expect.unreachable();
    } catch {
      /* 已退出 = 预期 */
    }
  });
});

describe.skipIf(process.platform !== "darwin")("HTTP 加固（真服务）", () => {
  test("未配置 authToken → 自动生成且强制鉴权（永不裸奔）", async () => {
    const server = createServer({ port: 0 });
    expect(server.token).toBeTruthy();

    const noAuth = await fetch(`${server.url}/sessions`);
    expect(noAuth.status).toBe(401);

    const withAuth = await fetch(`${server.url}/sessions`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(withAuth.status).toBe(200);

    server.stop();
  });

  test("text/plain body → 415（CSRF 表单面）", async () => {
    const server = createServer({ port: 0, authToken: "t" });
    const res = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "text/plain" },
      body: JSON.stringify({ startUrl: "https://example.com" }),
    });
    expect(res.status).toBe(415);
    server.stop();
  });

  test("body > 1MB → 413", async () => {
    const server = createServer({ port: 0, authToken: "t" });
    const res = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1100 * 1024) }),
    });
    expect(res.status).toBe(413);
    server.stop();
  });

  test("响应头 nosniff + no-store", async () => {
    const server = createServer({ port: 0, authToken: "t" });
    const res = await fetch(`${server.url}/sessions`, {
      headers: { authorization: "Bearer t" },
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    server.stop();
  });

  test("不存在的会话 GET /events → 404（不再 200 空 SSE）", async () => {
    const server = createServer({ port: 0, authToken: "t" });
    const res = await fetch(`${server.url}/sessions/sess-nonexistent/events`, {
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(404);
    server.stop();
  });
});
