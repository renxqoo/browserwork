/**
 * B13（05 §3.5–3.6）：生产档策略 / SESSION_LIMIT 429 / healthz / 轨迹落盘工厂 /
 * janitor / replay / 空闲退出 / 信号处理 / 崩溃恢复矩阵 / 会话 unchanged。
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptLLM } from "@bw/agent";
import type { Driver } from "@bw/driver";
import { FakeDriver, type FakePageOptions } from "@bw/driver";
import { EXTRACT_EXPRESSION } from "@bw/perception";
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import {
  createServer,
  createSessionManager,
  installSignalHandlers,
  replayTrajectory,
  SessionLimitError,
  setupIdleExit,
  sweepDir,
} from "../src/index.ts";

/** FakeDriver 工厂（extract/settle 表达式可答） */
const CAPS = {
  cdp: false,
  upload: false,
  download: false,
  dialogEvents: false,
  userAgentOverride: false,
  pierceClick: false,
};
const makeFakeDriver = (extra?: Partial<FakePageOptions>): Driver =>
  new FakeDriver(CAPS, {
    evaluateHandler: (expr: string) => {
      if (expr === EXTRACT_EXPRESSION) {
        return {
          nodes: [],
          headings: [],
          warnings: [],
          title: "fake",
          url: "https://fake.test/page",
          scrollY: 0,
          scrollX: 0,
          docHeight: 1000,
          viewportH: 720,
        };
      }
      if (expr.includes("__bwSettle")) return 10_000;
      return null;
    },
    ...extra,
  }) as unknown as Driver;

const resetLedger = async (): Promise<void> => {
  const m = await import("../src/sessions.ts");
  m.__resetRecoveryLedgerForTest();
};

const tmpRoot = join(import.meta.dir, "tmp-b13");
const freshDir = (name: string): string => {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("B13 §3.5 生产档策略", () => {
  test("production 缺省：内网/本地地址被 S4 拦；allowPrivateNetwork 显式放行", async () => {
    const mgr = createSessionManager({
      policyMode: "production",
      driverFactory: () => makeFakeDriver(),
    });
    await expect(mgr.create("http://127.0.0.1:9999/local")).rejects.toThrow(/private|blocked/i);
    const s = await mgr.create("https://fake.test/page"); // 公网 host 放行
    expect(mgr.get(s.id)).toBeTruthy();
    mgr.closeAll();
  }, 15_000);

  test("test 档：本地地址放行（fixture 白名单）", async () => {
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => makeFakeDriver(),
    });
    const s = await mgr.create("http://127.0.0.1:9999/local");
    expect(mgr.get(s.id)).toBeTruthy();
    mgr.closeAll();
  }, 15_000);
});

describe("B13 §2.1 会话触顶 429", () => {
  test("SessionLimitError 直抛 + HTTP 映射 429", async () => {
    const mgr = createSessionManager({
      policyMode: "test",
      maxSessions: 1,
      driverFactory: () => makeFakeDriver(),
    });
    const s1 = await mgr.create("https://fake.test/page");
    expect(mgr.get(s1.id)).toBeTruthy();
    await expect(mgr.create("https://fake.test/page")).rejects.toBeInstanceOf(SessionLimitError);
    mgr.closeAll();

    const server = createServer({
      port: 0,
      authToken: "t",
      sessionOptions: { policyMode: "test", maxSessions: 1, driverFactory: () => makeFakeDriver() },
    });
    const h = { authorization: "Bearer t", "content-type": "application/json" };
    const r1 = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ startUrl: "https://fake.test/page" }),
    });
    expect(r1.status).toBe(201);
    const r2 = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ startUrl: "https://fake.test/page" }),
    });
    expect(r2.status).toBe(429);
    server.stop();
  }, 30_000);
});

describe("B13 /healthz", () => {
  test("loopback 绑定：免 Bearer 返回状态；stats 字段存在", async () => {
    const server = createServer({ port: 0, authToken: "t" });
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeMs).toBe("number");
    expect(body.sessions).toBe(0);
    const stats = server.stats();
    expect(stats.lastRequestAt).toBeGreaterThan(0);
    server.stop();
  });

  test("非 loopback 绑定：404（不暴露）", async () => {
    const server = createServer({ port: 0, host: "0.0.0.0", authToken: "t" });
    const res = await fetch(
      `http://127.0.0.1:${(server.url.match(/:(\d+)/) ?? [])[1] ?? 0}/healthz`,
    );
    expect(res.status).toBe(404);
    server.stop();
  });
});

describe("B13 轨迹落盘", () => {
  test("会话工厂：trajectoryDir → <id>.jsonl 每动作一行", async () => {
    const dir = freshDir("traj-sessions");
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => makeFakeDriver(),
      trajectory: (id) => ({
        path: join(dir, `${id}.jsonl`),
        async append(entry) {
          appendFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(entry)}\n`);
        },
      }),
    });
    const s = await mgr.create("https://fake.test/page");
    await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    const files = readdirSync(dir);
    expect(files.some((f) => f === `${s.id}.jsonl`)).toBe(true);
    mgr.closeAll();
    rmSync(tmpRoot, { recursive: true, force: true });
  }, 20_000);

  test("server.trajectoryDir：任务轨迹经工厂落盘", async () => {
    const dir = freshDir("traj-tasks");
    const { node, locate } = fakeNode("1", {});
    const world = makeFakeWorld({ locateResults: { 1: locate }, rawExtract: { nodes: [node] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "done", arguments: { answer: "ok" } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      trajectoryDir: dir,
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
        settleQuietMs: 10,
        settleCapMs: 200,
      },
    });
    const res = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "x", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await res.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 1500));
    const files = readdirSync(dir);
    expect(files.some((f) => f === `${id}.jsonl`)).toBe(true);
    server.stop();
    rmSync(tmpRoot, { recursive: true, force: true });
  }, 30_000);
});

describe("B13 janitor", () => {
  test("年龄策略：过期删除、新文件保留", () => {
    const dir = freshDir("janitor-age");
    const old = join(dir, "old.jsonl");
    const fresh = join(dir, "fresh.jsonl");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    const now = Date.now();
    utimesSync(old, new Date(now - 8 * 24 * 3600 * 1000), new Date(now - 8 * 24 * 3600 * 1000));
    utimesSync(fresh, new Date(now), new Date(now));
    const r = sweepDir(dir, { retentionDays: 7, maxTotalBytes: 1024 * 1024, now: () => now });
    expect(r.deleted).toBe(1);
    expect(readdirSync(dir)).toEqual(["fresh.jsonl"]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("容量策略：超限按最旧删到达标", () => {
    const dir = freshDir("janitor-size");
    const mk = (name: string, size: number, ageDays: number): void => {
      const p = join(dir, name);
      writeFileSync(p, "x".repeat(size));
      const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
      utimesSync(p, t, t);
    };
    mk("a.jsonl", 600, 3);
    mk("b.jsonl", 600, 2);
    mk("c.jsonl", 600, 1);
    const r = sweepDir(dir, { retentionDays: 7, maxTotalBytes: 1000 });
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const rest = readdirSync(dir);
    const total = rest.length;
    expect(total).toBeLessThan(3);
    expect(rest).not.toContain("a.jsonl"); // 最旧的先删
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("目录不存在：no-throw", () => {
    expect(sweepDir(join(tmpRoot, "nonexistent"))).toEqual({ deleted: 0, bytesFreed: 0 });
  });
});

describe("B13 replay", () => {
  test("JSONL 渲染行 + 缺失文件报错", () => {
    const dir = freshDir("replay");
    const file = join(dir, "task-x.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        ts: 1,
        step: 0,
        action: { kind: "open_tab", url: "https://a/" },
        resultText: "opened\nsecond line",
        url: "https://a/",
        domHash: "aa",
      })}\n${JSON.stringify({
        ts: 2,
        step: 1,
        action: { kind: "llm", text: "hi" },
        resultText: "ok",
        url: "https://a/",
        domHash: "aa",
      })}\nnot-json\n`,
    );
    const out = replayTrajectory("task-x", dir);
    expect(out.ok).toBe(true);
    expect(out.lines[0]).toContain("#0 open_tab https://a/ domHash=aa | opened");
    expect(out.lines[1]).toContain("#1 llm");
    expect(out.lines[2]).toContain("unparseable");
    expect(replayTrajectory("nope", dir).ok).toBe(false);
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe("B13 空闲退出与信号", () => {
  test("setupIdleExit：isIdle 真 → onExit；假 → 不退；返回停止函数", async () => {
    let exited = 0;
    const stop = setupIdleExit(() => true, { intervalMs: 20, onExit: () => (exited += 1) });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(exited).toBeGreaterThanOrEqual(1);

    let exited2 = 0;
    const stop2 = setupIdleExit(() => false, { intervalMs: 20, onExit: () => (exited2 += 1) });
    await new Promise((r) => setTimeout(r, 60));
    stop2();
    expect(exited2).toBe(0);
  });

  test("installSignalHandlers：stop+cleanup+exit(0)；二次信号 exit(1)；可卸载", async () => {
    const calls: string[] = [];
    const exitCodes: number[] = [];
    const uninstall = installSignalHandlers({
      stop: () => {
        calls.push("stop");
      },
      cleanup: () => calls.push("cleanup"),
      exit: (code) => exitCodes.push(code),
    });
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["stop", "cleanup"]);
    expect(exitCodes).toEqual([0]);
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(exitCodes).toEqual([0, 1]);
    uninstall();
    process.emit("SIGINT", "SIGINT");
    expect(exitCodes).toEqual([0, 1]); // 卸载后不再响应
  });
});

describe("B13 §3.6 崩溃恢复", () => {
  test("恢复成功：单页化 + tabs reset 语义 + 挂起确认被 deny", async () => {
    await resetLedger();
    const drivers: Driver[] = [makeFakeDriver(), makeFakeDriver()];
    let seq = 0;
    const mgr = createSessionManager({
      policyMode: "test",
      confirmationTimeoutMs: 60_000,
      driverFactory: () => drivers[Math.min(seq++, drivers.length - 1)] as Driver,
    });
    const s = await mgr.create("https://fake.test/page");

    // 制造挂起确认：导航到未批准域（gate 挂起等待）
    const navP = mgr.executeTool(s.id, "navigate", { url: "https://neworigin.test/" });
    let cid = "";
    const eventsIt = mgr.events(s.id)[Symbol.asyncIterator]();
    const deadline = Date.now() + 3000;
    while (cid === "" && Date.now() < deadline) {
      const next = (await Promise.race([
        eventsIt.next(),
        new Promise<never>((_, rj) => setTimeout(() => rj(new Error("t")), 300)),
      ])) as IteratorResult<{ type: string; cid?: string }>;
      if (next.done) break;
      if (next.value.type === "confirmation_required" && next.value.cid !== undefined) {
        cid = next.value.cid;
      }
    }
    expect(cid).not.toBe("");

    // 杀 driver（host 崩溃模拟）
    (drivers[0] as FakeDriver).close();
    // 另一个工具调用触发崩溃路径 → 探测 → 恢复
    const r = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("recovered");
      expect(r.text).toContain("tabs reset to single page");
      expect(r.snapshot).toContain("# Page:");
    }
    // 挂起确认被 deny（导航 promise 以 DENIED 结束）
    const navResult = await Promise.race([
      navP,
      new Promise<{ ok: true }>((res) => setTimeout(() => res({ ok: true }), 2000)),
    ]);
    expect(navResult.ok === false || "code" in (navResult as object)).toBe(true);
    mgr.closeAll();
  }, 30_000);

  test("限次：5 分钟窗内二次崩溃不再恢复（返回 DRIVER_ERROR，会话保留）", async () => {
    await resetLedger();
    const drivers: Driver[] = [makeFakeDriver(), makeFakeDriver(), makeFakeDriver()];
    let seq = 0;
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => drivers[Math.min(seq++, drivers.length - 1)] as Driver,
    });
    const s = await mgr.create("https://fake.test/page");
    (drivers[0] as FakeDriver).close();
    const r1 = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r1.ok).toBe(true); // 第一次恢复
    (drivers[1] as FakeDriver).close();
    const r2 = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("DRIVER_ERROR");
    expect(mgr.get(s.id)).toBeTruthy(); // 未销毁——限次 ≠ 销毁
    mgr.closeAll();
  }, 30_000);

  test("恢复失败（回滚目标不可达）→ 销毁会话", async () => {
    await resetLedger();
    const drivers: Driver[] = [
      makeFakeDriver(),
      makeFakeDriver({ failUrls: ["https://fake.test/page"] }),
    ];
    let seq = 0;
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => drivers[Math.min(seq++, drivers.length - 1)] as Driver,
    });
    const s = await mgr.create("https://fake.test/page");
    (drivers[0] as FakeDriver).close();
    const r = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error).toContain("recovery failed; session closed");
    expect(mgr.get(s.id)).toBeUndefined(); // 已销毁
    mgr.closeAll();
  }, 30_000);
});

describe("B13 会话 unchanged（05 §3.1 会话侧）", () => {
  test("静态页：第二个动作 unchanged=true，快照照常返回", async () => {
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => makeFakeDriver(),
    });
    const s = await mgr.create("https://fake.test/page");
    const r1 = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    const r2 = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.unchanged).toBe(false);
      expect(r2.unchanged).toBe(true);
      expect(r2.snapshot).toContain("# Page:");
    }
    mgr.closeAll();
  }, 20_000);
});

describe("B13 覆盖补齐（cli 胶合工厂 + startJanitor + replay CLI）", () => {
  test("pidFileCleanup：有 PID 文件才清", async () => {
    const { pidFileCleanup } = await import("../src/cli.ts");
    let removed = 0;
    pidFileCleanup(
      () => ({ pid: 1 }),
      () => (removed += 1),
    )();
    expect(removed).toBe(1);
    pidFileCleanup(
      () => undefined,
      () => (removed += 1),
    )();
    expect(removed).toBe(1);
  });

  test("isServeIdle：空闲谓词矩阵", async () => {
    const { isServeIdle } = await import("../src/daemon.ts");
    const idle = isServeIdle(() => ({
      activeTasks: 0,
      sessions: 0,
      lastRequestAt: Date.now() - 120_000,
    }));
    expect(idle()).toBe(true);
    const busyTasks = isServeIdle(() => ({
      activeTasks: 1,
      sessions: 0,
      lastRequestAt: Date.now() - 120_000,
    }));
    expect(busyTasks()).toBe(false);
    const recentReq = isServeIdle(() => ({
      activeTasks: 0,
      sessions: 0,
      lastRequestAt: Date.now(),
    }));
    expect(recentReq()).toBe(false);
  });

  test("startJanitor：启动即扫 + 周期扫 + 停止", async () => {
    const { startJanitor } = await import("../src/janitor.ts");
    const dir = freshDir("janitor-start");
    const f = join(dir, "old.jsonl");
    writeFileSync(f, "x");
    const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(f, t, t);
    const stop = startJanitor([{ dir, extensions: [".jsonl"] }], {
      intervalMs: 40,
      retentionDays: 7,
    });
    expect(readdirSync(dir)).toEqual([]); // 启动即扫
    writeFileSync(join(dir, "old2.jsonl"), "y");
    utimesSync(join(dir, "old2.jsonl"), t, t);
    await new Promise((r) => setTimeout(r, 120)); // 周期扫
    expect(readdirSync(dir)).toEqual([]);
    stop();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("bw replay CLI：出路径 + 缺文件 exit 1", async () => {
    const dir = freshDir("replay-cli");
    const prev = process.env.BW_TRAJECTORY_DIR;
    process.env.BW_TRAJECTORY_DIR = dir;
    writeFileSync(
      join(dir, "task-y.jsonl"),
      `${JSON.stringify({
        ts: 1,
        step: 0,
        action: { kind: "open_tab", url: "https://a/" },
        resultText: "opened",
        url: "https://a/",
        domHash: "aa",
      })}\n`,
    );
    try {
      const { main } = await import("../src/cli.ts");
      const code = await main(["replay", "task-y"]);
      expect(code).toBe(0);
      const missing = await main(["replay", "nope"]);
      expect(missing).toBe(1);
      const noArg = await main(["replay"]);
      expect(noArg).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.BW_TRAJECTORY_DIR;
      else process.env.BW_TRAJECTORY_DIR = prev;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("B13 审查处置回归", () => {
  const RECOVERED_URL = "https://fake.test/recovered";
  const makeDriverWithUrl = (url: string, extra?: Partial<FakePageOptions>): Driver =>
    new FakeDriver(CAPS, {
      evaluateHandler: (expr: string) => {
        if (expr === EXTRACT_EXPRESSION) {
          return {
            nodes: [],
            headings: [],
            warnings: [],
            title: `t-${url}`,
            url,
            scrollY: 0,
            scrollX: 0,
            docHeight: 1000,
            viewportH: 720,
          };
        }
        if (expr.includes("__bwSettle")) return 10_000;
        return null;
      },
      ...extra,
    }) as unknown as Driver;

  test("P2-11：恢复快照确来自新 driver + unchanged 链路失效", async () => {
    await resetLedger();
    const drivers: Driver[] = [
      makeDriverWithUrl("https://fake.test/page"),
      makeDriverWithUrl(RECOVERED_URL),
    ];
    let seq = 0;
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => drivers[Math.min(seq++, drivers.length - 1)] as Driver,
    });
    const s = await mgr.create("https://fake.test/page");
    (drivers[0] as FakeDriver).close();
    const r = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot).toContain(RECOVERED_URL); // 新 driver 的提取（非缓存）
      expect(r.unchanged).toBe(false); // lastRendered=null 失效
    }
    const r2 = await mgr.executeTool(s.id, "wait", { seconds: 0.01 });
    expect(r2.ok && r2.unchanged).toBe(true); // 恢复后链路正常
    mgr.closeAll();
  }, 30_000);

  test("P1-1/P2-7：claim-at-entry + 进程级限次（两会话各一次后第三会话拒绝）", async () => {
    await resetLedger();
    const pools = [
      {
        d1: makeDriverWithUrl("https://fake.test/a"),
        d2: makeDriverWithUrl("https://fake.test/a"),
      },
      {
        d1: makeDriverWithUrl("https://fake.test/b"),
        d2: makeDriverWithUrl("https://fake.test/b"),
      },
      {
        d1: makeDriverWithUrl("https://fake.test/c"),
        d2: makeDriverWithUrl("https://fake.test/c"),
      },
    ];
    // 每池：第一次工厂调用（create）给 d1，之后（恢复）给 d2
    const poolCalls = [0, 0, 0];
    let pool = 0;
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: () => {
        const calls = poolCalls[pool] ?? 0;
        poolCalls[pool] = calls + 1;
        const p = pools[pool] as { d1: Driver; d2: Driver };
        return calls === 0 ? p.d1 : p.d2;
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      pool = i;
      const s = await mgr.create(`https://fake.test/x${i}`);
      ids.push(s.id);
    }
    pool = 0;
    (pools[0] as unknown as { d1: FakeDriver }).d1.close();
    const r1 = await mgr.executeTool(ids[0] as string, "wait", { seconds: 0.01 });
    expect(r1.ok).toBe(true);
    pool = 1;
    (pools[1] as unknown as { d1: FakeDriver }).d1.close();
    const r2 = await mgr.executeTool(ids[1] as string, "wait", { seconds: 0.01 });
    expect(r2.ok).toBe(true);
    pool = 2;
    (pools[2] as unknown as { d1: FakeDriver }).d1.close();
    const r3 = await mgr.executeTool(ids[2] as string, "wait", { seconds: 0.01 });
    expect(r3.ok).toBe(false);
    expect(mgr.get(ids[2] as string)).toBeTruthy(); // 限次拒绝 ≠ 销毁
    mgr.closeAll();
  }, 40_000);

  test("P1-3：allowPrivateNetwork 经 HTTP 需 serve 级 env 开门", async () => {
    const prev = process.env.BW_ALLOW_PRIVATE_NETWORK;
    delete process.env.BW_ALLOW_PRIVATE_NETWORK;
    const server = createServer({
      port: 0,
      authToken: "t",
      sessionOptions: { policyMode: "test", driverFactory: () => makeFakeDriver() },
    });
    const h = { authorization: "Bearer t", "content-type": "application/json" };
    try {
      const denied = await fetch(`${server.url}/sessions`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ startUrl: "https://fake.test/page", allowPrivateNetwork: true }),
      });
      expect(denied.status).toBe(400);
      expect(String(await denied.text())).toContain("BW_ALLOW_PRIVATE_NETWORK");
      process.env.BW_ALLOW_PRIVATE_NETWORK = "1";
      const allowed = await fetch(`${server.url}/sessions`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ startUrl: "http://127.0.0.1:9999/x", allowPrivateNetwork: true }),
      });
      expect(allowed.status).toBe(201);
    } finally {
      if (prev === undefined) delete process.env.BW_ALLOW_PRIVATE_NETWORK;
      else process.env.BW_ALLOW_PRIVATE_NETWORK = prev;
      server.stop();
    }
  }, 20_000);

  test("P2-12：create 无 startUrl 走 about:blank；导航失败清场不占名额", async () => {
    await resetLedger();
    const mgr = createSessionManager({
      policyMode: "production",
      driverFactory: () => makeFakeDriver(),
    });
    const blank = await mgr.create(undefined);
    expect(mgr.get(blank.id)).toBeTruthy();
    mgr.close(blank.id);

    const bad = createSessionManager({
      policyMode: "test",
      driverFactory: () => makeFakeDriver({ failUrls: ["https://fake.test/dead"] }),
    });
    await expect(bad.create("https://fake.test/dead")).rejects.toThrow();
    expect(bad.list()).toEqual([]);
    bad.closeAll();
  }, 20_000);

  test("P2-4：/healthz 不刷新 lastRequestAt（探活不喂活空闲时钟）", async () => {
    const server = createServer({ port: 0, authToken: "t" });
    const before = server.stats().lastRequestAt;
    await new Promise((r) => setTimeout(r, 30));
    await fetch(`${server.url}/healthz`);
    await fetch(`${server.url}/healthz`);
    expect(server.stats().lastRequestAt).toBe(before);
    await fetch(`${server.url}/sessions`, { headers: { authorization: "Bearer t" } });
    expect(server.stats().lastRequestAt).toBeGreaterThanOrEqual(before + 30);
    server.stop();
  }, 15_000);

  test("P2-6：janitor 后缀过滤——serve.token 等非 .jsonl 不被清", () => {
    const dir = freshDir("janitor-ext");
    const token = join(dir, "serve.token");
    writeFileSync(token, "t");
    writeFileSync(join(dir, "old.jsonl"), "x");
    const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(join(dir, "old.jsonl"), t, t);
    utimesSync(token, t, t);
    const r = sweepDir(dir, { extensions: [".jsonl"], retentionDays: 7, now: () => Date.now() });
    expect(r.deleted).toBe(1);
    expect(readdirSync(dir)).toEqual(["serve.token"]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("P2-10：replay 剥离终端控制字符", () => {
    const dir = freshDir("replay-esc");
    const esc = String.fromCharCode(27);
    writeFileSync(
      join(dir, "task-esc.jsonl"),
      `${JSON.stringify({
        ts: 1,
        step: 0,
        action: { kind: "open_tab", url: `https://a/${esc}]52;c;boom` },
        resultText: "ok",
        url: "https://a/",
        domHash: "aa",
      })}\n`,
    );
    const out = replayTrajectory("task-esc", dir);
    expect(out.ok).toBe(true);
    expect(out.lines.join("")).not.toContain(esc);
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
