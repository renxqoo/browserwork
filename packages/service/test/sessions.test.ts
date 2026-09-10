/**
 * 外部 agent 会话模式深度测试：
 * 生命周期 · 全工具矩阵 · 安全（S1/S2/S4）· 确认门 · 并发 · 错误处理 · 真 webkit。
 */
import { describe, expect, test } from "bun:test";
import type { SessionManager } from "../src/sessions.ts";
import { createSessionManager } from "../src/sessions.ts";

/** 测试用 fixture 站（内联——避免依赖外部 fixture 目录） */
function startFixtureServer(): Promise<{ origin: string; stop(): void }> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/") {
        return new Response(
          `<!doctype html><html lang="en"><head><title>Test Home</title></head><body>
<h1>Home</h1>
<a href="/page2">Go to Page 2</a>
<input type="text" id="q" placeholder="search" />
<input type="password" id="pw" />
<select id="sel"><option value="a">A</option><option value="b">B</option></select>
<button id="btn" onclick="document.getElementById('out').textContent='clicked'">Click Me</button>
<p id="out">idle</p>
<button id="danger" onclick="void 0">Checkout Now</button>
</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (p === "/page2") {
        return new Response(
          `<!doctype html><html lang="en"><head><title>Page 2</title></head><body><h1>Page 2</h1><a href="/">Back</a></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (p === "/long") {
        const items = Array.from(
          { length: 60 },
          (_, i) => `<li><a href="/page2">Item ${i + 1}</a></li>`,
        ).join("");
        return new Response(
          `<!doctype html><html lang="en"><head><title>Long</title></head><body><h1>Long</h1><ul>${items}</ul></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("nf", { status: 404 });
    },
  });
  return Promise.resolve({
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  });
}

describe.skipIf(process.platform !== "darwin")("外部会话模式", () => {
  let mgr: SessionManager;
  let fixture: { origin: string; stop(): void };

  test("生命周期：创建→快照→工具→关闭", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 60_000, confirmationTimeoutMs: 2000 });
    const info = await mgr.create(fixture.origin);
    expect(info.id).toBeTruthy();
    expect(info.url).toContain(fixture.origin);

    const snap = mgr.snapshot(info.id);
    expect(snap).toContain("# Page: Test Home");
    expect(snap).toContain("[");
    expect(snap).toContain("link");

    const r = await mgr.executeTool(info.id, "extract_text", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Home");

    mgr.close(info.id);
    expect(mgr.get(info.id)).toBeUndefined();
    const closed = await mgr.executeTool(info.id, "click", { index: "1" });
    expect(closed.ok).toBe(false);
  }, 30_000);

  test("工具矩阵：navigate/click/type/press/scroll/extract_text/look/wait/select/scroll_to", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 60_000, confirmationTimeoutMs: 2000 });
    const s = await mgr.create(fixture.origin);

    // 1. extract_text
    let r = await mgr.executeTool(s.id, "extract_text", {});
    expect(r.ok).toBe(true);

    // 2. look（截图）
    r = await mgr.executeTool(s.id, "look", {});
    expect(r.ok).toBe(true);
    if (r.ok && "image" in r && r.image) expect(r.image.base64.length).toBeGreaterThan(100);

    // 3. navigate 到 page2
    r = await mgr.executeTool(s.id, "navigate", { url: `${fixture.origin}/page2` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot).toContain("Page 2");

    // 4. navigate 回 home
    r = await mgr.executeTool(s.id, "navigate", { url: fixture.origin });
    expect(r.ok).toBe(true);

    // 5. type（找 input）
    if (r.ok) {
      const snapText = r.snapshot;
      const inputMatch = /\[(\d+)\] input/.exec(snapText);
      expect(inputMatch).toBeTruthy();
      const inputIdx = inputMatch?.[1];
      r = await mgr.executeTool(s.id, "type", { index: inputIdx ?? "", text: "hello world" });
      expect(r.ok).toBe(true);
    }

    // 6. press
    r = await mgr.executeTool(s.id, "press", { key: "Escape" });
    expect(r.ok).toBe(true);

    // 7. scroll
    r = await mgr.executeTool(s.id, "navigate", { url: `${fixture.origin}/long` });
    r = await mgr.executeTool(s.id, "scroll", { direction: "down" });
    expect(r.ok).toBe(true);

    // 8. scroll_to（找一个 below-viewport 元素）
    if (r.ok) {
      const belowMatch = /\[(\d+)\][^\n]*↓below-viewport/.exec(r.snapshot);
      if (belowMatch !== null) {
        r = await mgr.executeTool(s.id, "scroll_to", { index: belowMatch[1] as string });
        expect(r.ok).toBe(true);
      }
    }

    // 9. wait
    r = await mgr.executeTool(s.id, "wait", { seconds: 0.1 });
    expect(r.ok).toBe(true);

    // 10. navigate 回 home 选 select
    r = await mgr.executeTool(s.id, "navigate", { url: fixture.origin });
    if (r.ok) {
      const selMatch = /\[(\d+)\] select/.exec(r.snapshot);
      if (selMatch !== null) {
        r = await mgr.executeTool(s.id, "select", { index: selMatch[1] as string, value: "b" });
        expect(r.ok).toBe(true);
      }
    }

    mgr.close(s.id);
  }, 60_000);

  test("安全 S4：file:// → POLICY_BLOCKED", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 30_000, confirmationTimeoutMs: 1000 });
    await expect(mgr.create("file:///etc/passwd")).rejects.toThrow();
  }, 15_000);

  test("安全 S1：新域导航 → CONFIRMATION_REQUIRED → 批准后执行", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 30_000, confirmationTimeoutMs: 5000 });
    const s = await mgr.create(fixture.origin);

    // 异步发起新域导航
    const navPromise = mgr.executeTool(s.id, "navigate", { url: "https://example.com" });

    // 等确认事件
    await new Promise((res) => setTimeout(res, 500));
    let cid = "";
    for await (const e of mgr.events(s.id)) {
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        cid = e.cid;
        break;
      }
    }
    expect(cid).toBeTruthy();

    // 批准
    const confirmed = mgr.confirm(s.id, cid, true);
    expect(confirmed).toBe(true);

    const result = await navPromise;
    expect(result.ok).toBe(true); // 批准后执行
    if (result.ok) expect(result.snapshot).toContain("Example");

    mgr.close(s.id);
  }, 30_000);

  test("安全 S1：新域导航 → 拒绝 → CONFIRMATION_DENIED", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 30_000, confirmationTimeoutMs: 5000 });
    const s = await mgr.create(fixture.origin);

    const navPromise = mgr.executeTool(s.id, "navigate", { url: "https://example.com" });

    let cid = "";
    for await (const e of mgr.events(s.id)) {
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        cid = e.cid;
        break;
      }
    }
    mgr.confirm(s.id, cid, false); // deny

    const result = await navPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONFIRMATION_DENIED");

    mgr.close(s.id);
  }, 30_000);

  test("安全 S2：敏感词按钮 → 确认门", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 30_000, confirmationTimeoutMs: 2000 });
    const s = await mgr.create(fixture.origin);

    const snap = mgr.snapshot(s.id);
    const dangerMatch = /\[(\d+)\] button "Checkout Now"/.exec(snap);
    expect(dangerMatch).toBeTruthy();

    const navPromise = mgr.executeTool(s.id, "click", { index: dangerMatch?.[1] ?? "" });

    let cid = "";
    for await (const e of mgr.events(s.id)) {
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        cid = e.cid;
        break;
      }
    }
    expect(cid).toBeTruthy();
    expect(mgr.confirm(s.id, cid, false)).toBe(true);

    const result = await navPromise;
    expect(result.ok).toBe(false);

    mgr.close(s.id);
  }, 30_000);

  test("并发会话：3 个同时运行互不干扰", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({
      sessionTtlMs: 30_000,
      confirmationTimeoutMs: 2000,
      maxSessions: 5,
    });
    const sessions = await Promise.all([
      mgr.create(fixture.origin),
      mgr.create(`${fixture.origin}/page2`),
      mgr.create(`${fixture.origin}/long`),
    ]);
    expect(sessions.length).toBe(3);

    // 各自操作
    const results = await Promise.all([
      mgr.executeTool(sessions[0]?.id ?? "", "extract_text", {}),
      mgr.executeTool(sessions[1]?.id ?? "", "extract_text", {}),
      mgr.executeTool(sessions[2]?.id ?? "", "scroll", { direction: "down" }),
    ]);

    for (const r of results) expect(r.ok).toBe(true);

    // 会话 0 是 home，会话 1 是 page2——url 不同
    // 验证隔离性：会话 0 仍是 home、会话 1 仍是 page2（各自操作互不影响）
    const r0 = await mgr.executeTool(sessions[0]?.id ?? "", "extract_text", {});
    const r1 = await mgr.executeTool(sessions[1]?.id ?? "", "extract_text", {});
    if (r0.ok) expect(r0.text).toContain("Home");
    if (r1.ok) expect(r1.text).toContain("Page 2");

    for (const s of sessions) mgr.close(s.id);
  }, 60_000);

  test("错误处理：不存在的工具/无效参数/不存在的会话", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 30_000, confirmationTimeoutMs: 1000 });
    const s = await mgr.create(fixture.origin);

    // 不存在的工具
    let r = await mgr.executeTool(s.id, "nonexistent_tool", {});
    expect(r.ok).toBe(false);

    // 缺参数
    r = await mgr.executeTool(s.id, "click", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TOOL_ARGS");

    // navigate 缺 url
    r = await mgr.executeTool(s.id, "navigate", {});
    expect(r.ok).toBe(false);

    // 不存在的会话
    r = await mgr.executeTool("fake-session-id", "click", { index: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DRIVER_ERROR");

    mgr.close(s.id);
  }, 30_000);

  test("快照格式验证：含页头/索引/元素标注", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({ sessionTtlMs: 30_000, confirmationTimeoutMs: 1000 });
    const s = await mgr.create(fixture.origin);
    const snap = mgr.snapshot(s.id);

    // 页头
    expect(snap).toContain("# Page: Test Home");
    expect(snap).toContain("# URL:");
    expect(snap).toContain("# Scroll:");
    // 元素
    expect(snap).toMatch(/\[\d+\] link/);
    expect(snap).toMatch(/\[\d+\] input/);
    expect(snap).toMatch(/\[\d+\] button/);
    expect(snap).toMatch(/\[\d+\] select/);

    mgr.close(s.id);
  }, 30_000);

  test("会话列表与 maxSessions 限制", async () => {
    fixture = await startFixtureServer();
    mgr = createSessionManager({
      sessionTtlMs: 30_000,
      confirmationTimeoutMs: 1000,
      maxSessions: 2,
    });
    const s1 = await mgr.create(fixture.origin);
    const s2 = await mgr.create(fixture.origin);
    expect(mgr.list().length).toBe(2);

    await expect(mgr.create(fixture.origin)).rejects.toThrow();

    mgr.close(s1.id);
    const s3 = await mgr.create(fixture.origin); // 有空位了
    expect(mgr.list().length).toBe(2);

    mgr.closeAll();
    expect(mgr.list().length).toBe(0);
  }, 30_000);
});

/** HTTP 层会话端点（外部 agent REST API） */
describe.skipIf(process.platform !== "darwin")("HTTP 会话端点", () => {
  test("POST /sessions → 201 · GET snapshot · POST tools · DELETE", async () => {
    const { createServer } = await import("../src/server.ts");
    const fixture = await startFixtureServer();
    const server = createServer({
      port: 0,
      authToken: "test",
      sessionOptions: { sessionTtlMs: 30_000, confirmationTimeoutMs: 2000 },
    });

    // 创建
    const rc = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ startUrl: fixture.origin }),
    });
    expect(rc.status).toBe(201);
    const session = (await rc.json()) as { id: string; url: string };
    expect(session.id).toBeTruthy();
    expect(session.url).toContain(fixture.origin);

    // 快照
    const rs = await fetch(`${server.url}/sessions/${session.id}/snapshot`, {
      headers: { authorization: "Bearer test" },
    });
    expect(rs.status).toBe(200);
    const snapBody = (await rs.json()) as { snapshot: string };
    expect(snapBody.snapshot).toContain("# Page: Test Home");

    // 工具调用
    const rt = await fetch(`${server.url}/sessions/${session.id}/tools/extract_text`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: "{}",
    });
    expect(rt.status).toBe(200);
    const toolBody = (await rt.json()) as { ok: boolean; text: string };
    expect(toolBody.ok).toBe(true);
    expect(toolBody.text).toContain("Home");

    // 关闭
    const rd = await fetch(`${server.url}/sessions/${session.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(rd.status).toBe(200);

    // 关闭后再访问 → 404
    const r404 = await fetch(`${server.url}/sessions/${session.id}`, {
      headers: { authorization: "Bearer test" },
    });
    expect(r404.status).toBe(404);

    fixture.stop();
    server.stop();
  }, 30_000);

  test("HTTP 鉴权：无 token/错 token 全拒", async () => {
    const { createServer } = await import("../src/server.ts");
    const server = createServer({ port: 0, authToken: "key" });

    const r1 = await fetch(`${server.url}/sessions`);
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${server.url}/sessions`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(r2.status).toBe(401);

    server.stop();
  });

  test("HTTP 确认流：navigate 到新域 → 202 confirmation_required → confirm → 200", async () => {
    const { createServer } = await import("../src/server.ts");
    const fixture = await startFixtureServer();
    const server = createServer({
      port: 0,
      authToken: "t",
      sessionOptions: { sessionTtlMs: 30_000, confirmationTimeoutMs: 5000 },
    });

    const rc = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ startUrl: fixture.origin }),
    });
    const { id } = (await rc.json()) as { id: string };

    // 异步发 navigate
    const navPromise = fetch(`${server.url}/sessions/${id}/tools/navigate`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });

    // 等确认事件从 SSE 流到达——或者直接轮询 confirm 端点
    await new Promise((res) => setTimeout(res, 1000));

    // 用 sessionManager 直接获取 cid（避免 SSE 超时）
    const sm = server.sessionManager;
    let cid = "";
    for await (const e of sm.events(id)) {
      if (e.type === "confirmation_required" && e.cid !== undefined) {
        cid = e.cid;
        break;
      }
    }
    expect(cid).toBeTruthy();

    // 批准
    const rConfirm = await fetch(`${server.url}/sessions/${id}/confirmations/${cid}`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    expect(rConfirm.status).toBe(200);

    const navRes = await navPromise;
    expect(navRes.status).toBe(200); // 批准后 200
    const navBody = (await navRes.json()) as { ok: boolean; snapshot: string };
    expect(navBody.ok).toBe(true);

    fixture.stop();
    server.stop();
  }, 60_000);
});
