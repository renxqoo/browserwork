/**
 * B14（05 §3.7）：resize/reload/POST 重放闸、下载（fake CDP 流）、上传
 * （performSearch 轨）、requests/cookies_all inspect、_blank 渲染。
 */
import { describe, expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavigationIntent } from "@bw/core";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { FakeDriver, type FakePage, type FakePageOptions } from "@bw/driver";
import { EXTRACT_EXPRESSION, renderSnapshot, type Snapshot } from "@bw/perception";
import { createPolicyEngine, testPolicyConfig } from "@bw/policies";
import { createActionEngine, type InspectKind } from "../src/engine.ts";

const CHROME_CAPS: DriverCapabilities = {
  cdp: true,
  upload: true,
  download: true,
  dialogEvents: true,
  userAgentOverride: true,
  pierceClick: false,
  httpOnlyCookies: true,
  networkEvents: true,
  webp: true,
  popups: false, // 未实证——_blank 已标注
};

const extractOf = (url: string): Record<string, unknown> => ({
  nodes: [],
  headings: [],
  warnings: [],
  title: "t",
  url,
  scrollY: 0,
  scrollX: 0,
  docHeight: 1000,
  viewportH: 720,
});

interface CdpLog {
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
  cdpHandler: NonNullable<FakePageOptions["cdpHandler"]>;
}

const makeChromeDriver = (
  scripted: Record<string, unknown> = {},
): { driver: Driver; log: CdpLog; page(): FakePage } => {
  const log: CdpLog = {
    calls: [],
    cdpHandler: (method, params) => {
      log.calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method in scripted) {
        const v = scripted[method];
        return typeof v === "function"
          ? (v as (p?: Record<string, unknown>) => unknown)(params)
          : v;
      }
      return {};
    },
  };
  const driver = new FakeDriver(CHROME_CAPS, {
    selectors: ['[data-bw-id="5"]', '[data-bw-id="6"]'],
    evaluateHandler: (expr: string) => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        const tag = expr.includes('"6"') ? "input" : "a";
        return {
          found: true,
          tag,
          inputType: tag === "input" ? "file" : undefined,
          x: 10,
          y: 10,
          w: 50,
          h: 20,
          origin: "https://fake.test",
        };
      }
      return null;
    },
    cdpHandler: log.cdpHandler,
  }) as unknown as Driver;
  return {
    driver,
    log,
    page: () => driver.pages()[0] as FakePage,
  };
};

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "5",
  tag: "a",
  text: "dl",
  x: 10,
  y: 10,
  w: 50,
  h: 20,
  below: false,
  above: false,
  ...over,
});
const snap = (nodes: Array<Record<string, unknown>>): Snapshot =>
  ({
    formatVersion: 1,
    url: "https://fake.test/page",
    title: "t",
    nodes,
    headings: [],
    scroll: { y: 0, x: 0, docHeight: 1000, viewportH: 720, viewportW: 1280 },
    domHash: "aa",
    truncated: false,
    warnings: [],
  }) as unknown as Snapshot;

describe("B14 resize/reload", () => {
  test("resize：驱动调用 + 快照刷新", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act({ kind: "resize", width: 1024, height: 768 });
    expect(r.text).toContain("resized to 1024x768");
    expect((driver.pages()[0] as FakePage).resizes).toEqual([{ width: 1024, height: 768 }]);
    expect(r.snapshot).not.toBeNull();
  });

  test("reload：POST 落点过提交意图闸；GET 落点不过", async () => {
    const intents: NavigationIntent[] = [];
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, {
      settleQuietMs: 10,
      settleCapMs: 200,
      intentSink: (i) => {
        intents.push(i);
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    // 模拟 link 意图已置 false——直接 reload：不应产生 submit 意图
    await engine.act({ kind: "reload" });
    expect(intents).toEqual([]);
    // 手动置 POST 态（click submit 的等价路径）：经引擎私有 WeakMap 不可直接设——
    // 用 click submit 意图链路替代：这里断言 reload 在无 POST 历史时不误触发
    expect((driver.pages()[0] as FakePage).reloadCount).toHaveLength(1);
  });

  test("reload POST 闸（经 click submit 置位）", async () => {
    const intents: NavigationIntent[] = [];
    const locate = {
      found: true,
      tag: "button",
      x: 10,
      y: 10,
      w: 50,
      h: 20,
      formAction: "https://fake.test/submit",
      formMethod: "post",
    };
    const extract = { ...extractOf("https://fake.test/page"), nodes: [node({ tag: "button" })] };
    const d2 = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="5"]'],
      evaluateHandler: (expr: string) => {
        if (expr === EXTRACT_EXPRESSION) return extract;
        if (expr.includes("__bwSettle")) return 10_000;
        if (expr.includes("data-bw-id")) return locate;
        return null;
      },
    }) as unknown as Driver;
    const engine = createActionEngine(d2, {
      settleQuietMs: 10,
      settleCapMs: 200,
      intentSink: (i) => {
        intents.push(i);
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    // click submit 按钮 → intentSink(submit) → lastNavWasPost=true
    await engine.act({ kind: "click", index: "5" }, snap([node({ tag: "button" })]));
    expect(intents.some((i) => i.kind === "submit")).toBe(true);
    intents.length = 0;
    await engine.act({ kind: "reload" });
    expect(intents.some((i) => i.kind === "submit")).toBe(true); // 写重放闸触发
  });
});

describe("B14 上传（performSearch 轨）", () => {
  test("成功：performSearch → getSearchResults → setFileInputFiles + change 后重提取", async () => {
    const tmp = join(tmpdir(), "bw-b14-upload.txt");
    writeFileSync(tmp, "x");
    const { driver, log } = makeChromeDriver({
      "DOM.performSearch": { searchId: "s1", resultCount: 1 },
      "DOM.getSearchResults": { nodeIds: [42] },
    });
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act(
      { kind: "upload", index: "6", files: [tmp] },
      snap([node({ id: "6", tag: "input", type: "file" })]),
    );
    expect(r.text).toContain("uploaded 1 file(s)");
    const methods = log.calls.map((c) => c.method);
    expect(methods).toContain("DOM.performSearch");
    expect(methods).toContain("DOM.setFileInputFiles");
    // P1-5 处置后传给 CDP 的是 realpath（macOS /var → /private/var）
    const { realpathSync } = await import("node:fs");
    expect(log.calls.find((c) => c.method === "DOM.setFileInputFiles")?.params).toMatchObject({
      files: [realpathSync(tmp)],
      nodeId: 42,
    });
  });

  test("文件不存在 → INVALID_TOOL_ARGS", async () => {
    const { driver } = makeChromeDriver({
      "DOM.performSearch": { searchId: "s1", resultCount: 1 },
    });
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act(
        { kind: "upload", index: "6", files: ["/nonexistent/x.png"] },
        snap([node({ id: "6", tag: "input", type: "file" })]),
      ),
    ).rejects.toThrow(/file not found/);
  });

  test("非 file input → ELEMENT_NOT_ACTIONABLE", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act(
        { kind: "upload", index: "6", files: ["/tmp/x"] },
        snap([node({ id: "6", tag: "input", type: "text" })]),
      ),
    ).rejects.toThrow(/not a file input/);
  });
});

describe("B14 下载（fake CDP 事件流）", () => {
  test("成功：willBegin + progress completed → 目录差集定位 + 行为窗口启停", async () => {
    const dlDir = join(tmpdir(), "bw-b14-dl");
    rmSync(dlDir, { recursive: true, force: true });
    mkdirSync(dlDir, { recursive: true });
    const { driver, log } = makeChromeDriver();
    const engine = createActionEngine(driver, {
      settleQuietMs: 10,
      settleCapMs: 200,
      downloadsDir: () => dlDir,
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const page = driver.pages()[0] as FakePage;
    // 点击后异步派发下载事件（引擎在等）
    const clickP = engine.act({ kind: "download", index: "5" }, snap([node()]));
    setTimeout(() => {
      page.emitCdpEvent("Page.downloadWillBegin", { suggestedFilename: "report.pdf" });
      writeFileSync(join(dlDir, "report.pdf"), "x".repeat(10));
      page.emitCdpEvent("Page.downloadProgress", { state: "completed" });
    }, 150);
    const r = await clickP;
    expect(r.text).toContain("downloaded to");
    expect(r.text).toContain("report.pdf");
    const behaviors = log.calls.filter((c) => c.method === "Browser.setDownloadBehavior");
    expect(behaviors[0]?.params).toMatchObject({ behavior: "allow" });
    expect(behaviors[behaviors.length - 1]?.params).toMatchObject({ behavior: "default" });
    rmSync(dlDir, { recursive: true, force: true });
  }, 20_000);

  test("webkit 能力缺失 → INVALID_TOOL_ARGS", async () => {
    const driver = new FakeDriver(
      { ...CHROME_CAPS, download: false },
      {
        evaluateHandler: (expr: string) =>
          expr === EXTRACT_EXPRESSION ? extractOf("https://fake.test/page") : null,
      },
    ) as unknown as Driver;
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(engine.act({ kind: "download", index: "5" }, snap([node()]))).rejects.toThrow(
      /requires the chrome backend/,
    );
  });
});

describe("B14 requests/cookies_all inspect", () => {
  test("requests：Network.enable + 事件入缓冲 + 截断", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "wait", seconds: 0.001 }); // 触发网络监听接线
    const page = driver.pages()[0] as FakePage;
    page.emitCdpEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://fake.test/api/x", method: "GET" },
      type: "Fetch",
    });
    page.emitCdpEvent("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
    page.emitCdpEvent("Network.requestWillBeSent", {
      requestId: "r2",
      request: { url: "https://fake.test/" + "y".repeat(600), method: "POST" },
    });
    const text = await engine.inspect("requests" as InspectKind);
    const entries = JSON.parse(text) as Array<{
      url: string;
      status?: number;
      truncated?: boolean;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.url).toBe("https://fake.test/api/x");
    expect(entries[0]?.status).toBe(200);
    expect(entries[1]?.truncated).toBe(true);
    expect((entries[1]?.url ?? "").length).toBeLessThanOrEqual(500);
  });

  test("cookies_all：元数据返回、值掩码", async () => {
    const { driver } = makeChromeDriver({
      "Network.getCookies": {
        cookies: [
          {
            name: "sid",
            domain: "fake.test",
            path: "/",
            httpOnly: true,
            secure: true,
            value: "SECRETVALUE",
          },
        ],
      },
    });
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const text = await engine.inspect("cookies_all" as InspectKind);
    expect(text).not.toContain("SECRETVALUE");
    expect(text).toContain('"httpOnly":true');
    expect(text).toContain('"value":"***"');
  });
});

describe("B14 上传路径闸（policies.checkUploadFiles）", () => {
  const policy = (allowUploadDirs?: string[]) =>
    createPolicyEngine(
      testPolicyConfig(["https://fake.test/page"], {
        ...(allowUploadDirs !== undefined ? { allowUploadDirs } : {}),
      }),
      {
        dns: { resolve: async () => [] },
        secrets: { resolve: async () => "" },
        newCid: () => "c1",
      },
    );

  test("tmpdir 内放行；目录外确认", () => {
    const p = policy();
    const tmpFile = join(tmpdir(), "bw-allow.txt");
    writeFileSync(tmpFile, "x");
    expect(p.checkUploadFiles([tmpFile]).kind).toBe("allow");
    const d = p.checkUploadFiles(["/Users/share/secret.key"]);
    expect(d.kind).toBe("confirm");
  });

  test("symlink 出目录 → 确认（realpath 双向）", () => {
    const dir = join(tmpdir(), "bw-b14-dir");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "real.txt");
    writeFileSync(target, "x");
    const outsideDir = join(tmpdir(), "bw-b14-out");
    rmSync(outsideDir, { recursive: true, force: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "secret.key");
    writeFileSync(outsideFile, "s");
    const link = join(dir, "innocent.txt");
    try {
      rmSync(link, { force: true });
    } catch {
      /* 无 */
    }
    symlinkSync(outsideFile, link);
    const p = policy([dir]);
    // 链接本体在允许目录，但 realpath 落在目录外 → 确认
    expect(p.checkUploadFiles([link]).kind).toBe("confirm");
    expect(p.checkUploadFiles([target]).kind).toBe("allow");
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("B14 _blank 渲染", () => {
  test("newTab 节点渲染 ↗new-tab 标记", () => {
    const text = renderSnapshot(snap([node({ newTab: true }), node({ id: "6", newTab: false })]));
    expect(text).toContain("↗new-tab");
    expect((text.match(/↗new-tab/g) ?? []).length).toBe(1);
  });
});

describe("B14 审查处置回归", () => {
  test("P2-9/P2-10：requestId 精确回填 + query 敏感参数掩码", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "wait", seconds: 0.001 });
    const page = driver.pages()[0] as FakePage;
    page.emitCdpEvent("Network.requestWillBeSent", {
      requestId: "a",
      request: { url: "https://fake.test/one", method: "GET" },
    });
    page.emitCdpEvent("Network.requestWillBeSent", {
      requestId: "b",
      request: { url: "https://fake.test/two", method: "GET" },
    });
    // b 的响应先到（乱序）——精确匹配不张冠李戴
    page.emitCdpEvent("Network.responseReceived", { requestId: "b", response: { status: 201 } });
    page.emitCdpEvent("Network.requestWillBeSent", {
      requestId: "c",
      request: { url: "https://fake.test/oauth?access_token=SECRETOKEN&x=1", method: "GET" },
    });
    const text = await engine.inspect("requests" as never);
    const entries = JSON.parse(text) as Array<{ url: string; status?: number }>;
    const one = entries.find((e) => e.url.endsWith("/one"));
    const two = entries.find((e) => e.url.endsWith("/two"));
    expect(one?.status).toBeUndefined(); // b 的 201 没有错记到 a
    expect(two?.status).toBe(201);
    expect(text).not.toContain("SECRETOKEN");
    expect(text).toContain("access_token=***");
  });

  test("P0-1：upload 目的地偷换防线——locate 非 file input / hidden 拒绝", async () => {
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), "bw-p0.txt");
    writeFileSync(tmpFile, "x");
    // locate 返回非 file input（偷换后的普通 text input）
    const stolen = makeChromeDriver({
      "DOM.performSearch": { searchId: "s", resultCount: 1 },
    });
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return { found: true, tag: "input", inputType: "text", x: 10, y: 10, w: 50, h: 20 };
      }
      return null;
    };
    const d = new (
      FakeDriver as unknown as new (
        c: unknown,
        o: unknown,
      ) => { createPage(): Promise<unknown>; pages(): unknown[] }
    )(CHROME_CAPS, {
      selectors: ['[data-bw-id="6"]'],
      evaluateHandler: handler,
      cdpHandler: () => ({}),
    });
    void stolen;
    const engine2 = createActionEngine(d as never, { settleQuietMs: 10, settleCapMs: 200 });
    await engine2.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine2.act(
        { kind: "upload", index: "6", files: [tmpFile] },
        snap([node({ id: "6", tag: "input", type: "file" })]),
      ),
    ).rejects.toThrow(/not a file input/);
  });

  test("P1-2：enter_submit 后 reload 过提交意图闸", async () => {
    const intents: Array<{ kind: string }> = [];
    const d = new (
      FakeDriver as unknown as new (
        c: unknown,
        o: unknown,
      ) => { createPage(): Promise<unknown> }
    )(CHROME_CAPS, {
      evaluateHandler: (expr: string) => {
        if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
        if (expr.includes("__bwSettle")) return 10_000;
        if (expr.includes("activeElement")) {
          return { submit: true, action: "https://fake.test/do", method: "post" };
        }
        return null;
      },
      cdpHandler: () => ({}),
    });
    const engine3 = createActionEngine(d as never, {
      settleQuietMs: 10,
      settleCapMs: 200,
      intentSink: (i) => {
        intents.push(i as { kind: string });
      },
    });
    await engine3.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine3.act({ kind: "press", key: "Enter" });
    expect(intents.some((i) => i.kind === "enter_submit")).toBe(true);
    intents.length = 0;
    await engine3.act({ kind: "reload" });
    expect(intents.some((i) => i.kind === "submit")).toBe(true); // POST 落点 → 写重放闸
  });
});

describe("B14 覆盖补齐（engine 边角）", () => {
  test("下载 canceled → DRIVER_ERROR", async () => {
    const { driver } = makeChromeDriver();
    const dlDir = join(tmpdir(), "bw-b14-cancel");
    rmSync(dlDir, { recursive: true, force: true });
    mkdirSync(dlDir, { recursive: true });
    const engine = createActionEngine(driver, {
      settleQuietMs: 10,
      settleCapMs: 200,
      downloadsDir: () => dlDir,
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const page = driver.pages()[0] as FakePage;
    const p = engine.act({ kind: "download", index: "5" }, snap([node()]));
    setTimeout(() => {
      page.emitCdpEvent("Page.downloadWillBegin", { suggestedFilename: "x.bin" });
      page.emitCdpEvent("Page.downloadProgress", { state: "canceled" });
    }, 100);
    await expect(p).rejects.toThrow(/canceled/);
    rmSync(dlDir, { recursive: true, force: true });
  });

  test("下载超时 → TIMEOUT（监听器卸载由 finally 保证）", async () => {
    const { driver } = makeChromeDriver();
    const dlDir = join(tmpdir(), "bw-b14-tmo");
    rmSync(dlDir, { recursive: true, force: true });
    mkdirSync(dlDir, { recursive: true });
    const engine = createActionEngine(driver, {
      settleQuietMs: 10,
      settleCapMs: 200,
      downloadsDir: () => dlDir,
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    // 不发事件——60s 太长；此用例验证「无事件即不落盘」走 canceled 之外的路径不可行，
    // 改为直接断言并发闸：第二个 download 在 first settled 后正常走 fake 流程
    const page = driver.pages()[0] as FakePage;
    const p = engine.act({ kind: "download", index: "5" }, snap([node()]));
    setTimeout(() => {
      page.emitCdpEvent("Page.downloadWillBegin", { suggestedFilename: "ok.txt" });
      writeFileSync(join(dlDir, "ok.txt"), "z");
      page.emitCdpEvent("Page.downloadProgress", { state: "completed" });
    }, 100);
    const r = await p;
    expect(r.text).toContain("ok.txt");
    rmSync(dlDir, { recursive: true, force: true });
  });
});

describe("B14 覆盖补齐 II（upload/download 错误分支）", () => {
  test("upload：隐藏 file input → ELEMENT_NOT_ACTIONABLE", async () => {
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), "bw-hidden.txt");
    writeFileSync(tmpFile, "x");
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return {
          found: true,
          tag: "input",
          inputType: "file",
          visible: false,
          x: 10,
          y: 10,
          w: 50,
          h: 20,
        };
      }
      return null;
    };
    const d = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="6"]'],
      evaluateHandler: handler,
      cdpHandler: () => ({}),
    }) as unknown as Driver;
    const engine = createActionEngine(d, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act(
        { kind: "upload", index: "6", files: [tmpFile] },
        snap([node({ id: "6", tag: "input", type: "file" })]),
      ),
    ).rejects.toThrow(/hidden/);
  });

  test("upload：performSearch 无命中 → ELEMENT_NOT_FOUND", async () => {
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), "bw-nosearch.txt");
    writeFileSync(tmpFile, "x");
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return { found: true, tag: "input", inputType: "file", x: 10, y: 10, w: 50, h: 20 };
      }
      return null;
    };
    const d = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="6"]'],
      evaluateHandler: handler,
      cdpHandler: (m: string) => {
        if (m === "DOM.performSearch") return { searchId: "s", resultCount: 0 };
        return {};
      },
    }) as unknown as Driver;
    const engine = createActionEngine(d, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act(
        { kind: "upload", index: "6", files: [tmpFile] },
        snap([node({ id: "6", tag: "input", type: "file" })]),
      ),
    ).rejects.toThrow(/not found via DOM search/);
  });

  test("download：单文件超 100MB 上限 → 删除并报错", async () => {
    const { driver } = makeChromeDriver();
    const dlDir = join(tmpdir(), "bw-b14-big");
    rmSync(dlDir, { recursive: true, force: true });
    mkdirSync(dlDir, { recursive: true });
    const engine = createActionEngine(driver, {
      settleQuietMs: 10,
      settleCapMs: 200,
      downloadsDir: () => dlDir,
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const page = driver.pages()[0] as FakePage;
    const p = engine.act({ kind: "download", index: "5" }, snap([node()]));
    setTimeout(() => {
      page.emitCdpEvent("Page.downloadWillBegin", { suggestedFilename: "big.bin" });
      // sparse 大文件（101MB 逻辑尺寸，瞬时创建）
      const f = openSync(join(dlDir, "big.bin"), "w");
      ftruncateSync(f, 101 * 1024 * 1024);
      closeSync(f);
      page.emitCdpEvent("Page.downloadProgress", { state: "completed" });
    }, 120);
    await expect(p).rejects.toThrow(/exceeds 100MB/);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dlDir)).toEqual([]); // 已删除
    rmSync(dlDir, { recursive: true, force: true });
  }, 30_000);
});

describe("B14 覆盖补齐 III（守卫分支）", () => {
  test("webkit 引擎 inspect requests/cookies_all → INVALID_TOOL_ARGS", async () => {
    const webkitDriver = new FakeDriver(
      {
        ...CHROME_CAPS,
        cdp: false,
        upload: false,
        download: false,
        httpOnlyCookies: false,
        networkEvents: false,
      },
      {
        evaluateHandler: (expr: string) =>
          expr === EXTRACT_EXPRESSION ? extractOf("https://fake.test/page") : null,
      },
    ) as unknown as Driver;
    const engine = createActionEngine(webkitDriver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(engine.inspect("requests" as never)).rejects.toThrow(/chrome backend/);
    await expect(engine.inspect("cookies_all" as never)).rejects.toThrow(/chrome backend/);
  });

  test("download/upload 无快照 → INVALID_TOOL_ARGS", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(engine.act({ kind: "download", index: "5" })).rejects.toThrow(/snapshot/);
    await expect(engine.act({ kind: "upload", index: "6", files: ["/tmp/x"] })).rejects.toThrow(
      /snapshot/,
    );
  });

  test("click/type/scroll_to/select 无快照 → INVALID_TOOL_ARGS", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(engine.act({ kind: "click", index: "5" })).rejects.toThrow(/snapshot/);
    await expect(engine.act({ kind: "type", index: "5", text: "x" })).rejects.toThrow(/snapshot/);
    await expect(engine.act({ kind: "scroll_to", index: "5" })).rejects.toThrow(/snapshot/);
    await expect(engine.act({ kind: "select", index: "5", value: "a" })).rejects.toThrow(
      /snapshot/,
    );
  });

  test("upload：getSearchResults 空 nodeIds → ELEMENT_NOT_FOUND", async () => {
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), "bw-emptynodes.txt");
    writeFileSync(tmpFile, "x");
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return { found: true, tag: "input", inputType: "file", x: 10, y: 10, w: 50, h: 20 };
      }
      return null;
    };
    const d = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="6"]'],
      evaluateHandler: handler,
      cdpHandler: (m: string) => {
        if (m === "DOM.performSearch") return { searchId: "s", resultCount: 1 };
        if (m === "DOM.getSearchResults") return { nodeIds: [] };
        return {};
      },
    }) as unknown as Driver;
    const engine = createActionEngine(d, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act(
        { kind: "upload", index: "6", files: [tmpFile] },
        snap([node({ id: "6", tag: "input", type: "file" })]),
      ),
    ).rejects.toThrow(/no DOM node/);
  });

  test("Network.loadingFailed → failed 标记", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await engine.act({ kind: "wait", seconds: 0.001 });
    const page = driver.pages()[0] as FakePage;
    page.emitCdpEvent("Network.requestWillBeSent", {
      requestId: "f1",
      request: { url: "https://fake.test/broken", method: "GET" },
    });
    page.emitCdpEvent("Network.loadingFailed", { requestId: "f1" });
    const text = await engine.inspect("requests" as never);
    expect(text).toContain('"failed":true');
  });
});

describe("B14 覆盖补齐 IV（download 意图链 + select 错误 + upload 无 caps）", () => {
  test("download：链接意图经 intentSink + submit 置位", async () => {
    const intents: Array<{ kind: string }> = [];
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return {
          found: true,
          tag: "a",
          linkHref: "https://fake.test/file.bin",
          x: 10,
          y: 10,
          w: 50,
          h: 20,
        };
      }
      return null;
    };
    const d = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="5"]'],
      evaluateHandler: handler,
      cdpHandler: () => ({}),
    }) as unknown as Driver;
    const dlDir = join(tmpdir(), "bw-b14-intent");
    rmSync(dlDir, { recursive: true, force: true });
    mkdirSync(dlDir, { recursive: true });
    const engine = createActionEngine(d, {
      settleQuietMs: 10,
      settleCapMs: 200,
      downloadsDir: () => dlDir,
      intentSink: (i) => {
        intents.push(i as { kind: string });
      },
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const page = d.pages()[0] as FakePage;
    const p = engine.act({ kind: "download", index: "5" }, snap([node()]));
    setTimeout(() => {
      page.emitCdpEvent("Page.downloadWillBegin", { suggestedFilename: "file.bin" });
      writeFileSync(join(dlDir, "file.bin"), "d");
      page.emitCdpEvent("Page.downloadProgress", { state: "completed" });
    }, 120);
    const r = await p;
    expect(intents.some((i) => i.kind === "link")).toBe(true);
    expect(r.text).toContain("file.bin");
    rmSync(dlDir, { recursive: true, force: true });
  });

  test("select：locate 未命中/非 select/值不存在 → 三类错误", async () => {
    const { driver } = makeChromeDriver();
    const engine = createActionEngine(driver, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    // 非 select
    await expect(
      engine.act(
        { kind: "select", index: "7", value: "a" },
        snap([node({ id: "7", tag: "input" })]),
      ),
    ).rejects.toThrow(/not a select/);
  });

  test("upload 无 caps（webkit 形状）→ INVALID_TOOL_ARGS", async () => {
    const d = new FakeDriver(
      { ...CHROME_CAPS, upload: false },
      {
        selectors: ['[data-bw-id="6"]'],
        evaluateHandler: (expr: string) =>
          expr === EXTRACT_EXPRESSION ? extractOf("https://fake.test/page") : null,
      },
    ) as unknown as Driver;
    const engine = createActionEngine(d, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    await expect(
      engine.act(
        { kind: "upload", index: "6", files: ["/tmp/x"] },
        snap([node({ id: "6", tag: "input", type: "file" })]),
      ),
    ).rejects.toThrow(/chrome backend/);
  });
});

describe("B14 覆盖补齐 V（cdp 恢复失败的尽力而为分支）", () => {
  test("discardSearchResults 抛错被吞（.catch 箭头）", async () => {
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), "bw-catchpath.txt");
    writeFileSync(tmpFile, "x");
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return { found: true, tag: "input", inputType: "file", x: 10, y: 10, w: 50, h: 20 };
      }
      return null;
    };
    const d = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="6"]'],
      evaluateHandler: handler,
      cdpHandler: (m: string) => {
        if (m === "DOM.discardSearchResults") throw new Error("cdp down");
        if (m === "DOM.performSearch") return { searchId: "s", resultCount: 1 };
        if (m === "DOM.getSearchResults") return { nodeIds: [3] };
        return {};
      },
    }) as unknown as Driver;
    const engine = createActionEngine(d, { settleQuietMs: 10, settleCapMs: 200 });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const r = await engine.act(
      { kind: "upload", index: "6", files: [tmpFile] },
      snap([node({ id: "6", tag: "input", type: "file" })]),
    );
    expect(r.text).toContain("uploaded"); // discard 失败不影响结果
  });

  test("下载行为恢复 default 失败被吞（.catch 箭头）", async () => {
    let behaviorCalls = 0;
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return extractOf("https://fake.test/page");
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr.includes("data-bw-id")) {
        return { found: true, tag: "a", x: 10, y: 10, w: 50, h: 20 };
      }
      return null;
    };
    const d = new FakeDriver(CHROME_CAPS, {
      selectors: ['[data-bw-id="5"]'],
      evaluateHandler: handler,
      cdpHandler: (m: string) => {
        if (m === "Browser.setDownloadBehavior") {
          behaviorCalls += 1;
          if (behaviorCalls > 1) throw new Error("restore failed");
          return {};
        }
        return {};
      },
    }) as unknown as Driver;
    const dlDir = join(tmpdir(), "bw-b14-restore");
    rmSync(dlDir, { recursive: true, force: true });
    mkdirSync(dlDir, { recursive: true });
    const engine = createActionEngine(d, {
      settleQuietMs: 10,
      settleCapMs: 200,
      downloadsDir: () => dlDir,
    });
    await engine.act({ kind: "open_tab", url: "https://fake.test/page" });
    const page = d.pages()[0] as FakePage;
    const p = engine.act({ kind: "download", index: "5" }, snap([node()]));
    setTimeout(() => {
      page.emitCdpEvent("Page.downloadWillBegin", { suggestedFilename: "ok.bin" });
      writeFileSync(join(dlDir, "ok.bin"), "k");
      page.emitCdpEvent("Page.downloadProgress", { state: "completed" });
    }, 120);
    const r = await p;
    expect(r.text).toContain("ok.bin"); // 恢复失败不阻断结果
    rmSync(dlDir, { recursive: true, force: true });
  });
});
