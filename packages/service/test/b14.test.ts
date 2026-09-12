/**
 * B14 服务层：chrome-only 会话工具闸 / upload 路径确认门 / webkit cdp 拒绝 /
 * 会话驱动选项透传（webkit+UA fail fast）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { createWebViewDriver, FakeDriver } from "@bw/driver";
import { EXTRACT_EXPRESSION } from "@bw/perception";
import { createSessionManager } from "../src/index.ts";

const WEBKIT_CAPS = {
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
};

const CHROME_CAPS: DriverCapabilities = {
  ...WEBKIT_CAPS,
  cdp: true,
  upload: true,
  download: true,
  httpOnlyCookies: true,
  networkEvents: true,
  webp: true,
  popups: false, // 未实证——_blank 已标注
};

const makeDriver = (): Driver =>
  new FakeDriver(WEBKIT_CAPS, {
    evaluateHandler: (expr: string) => {
      if (expr === EXTRACT_EXPRESSION) {
        return {
          nodes: [],
          headings: [],
          warnings: [],
          title: "t",
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
  }) as unknown as Driver;

describe("B14 会话 chrome-only 闸", () => {
  test("webkit 会话：download/upload/requests/cookies_all → INVALID_TOOL_ARGS", async () => {
    const mgr = createSessionManager({
      policyMode: "test",
      driverFactory: makeDriver,
    });
    const s = await mgr.create("https://fake.test/page");
    for (const [tool, params] of [
      ["download", { index: "5" }],
      ["upload", { index: "6", files: ["/tmp/x"] }],
      ["requests", {}],
      ["cookies_all", {}],
    ] as const) {
      const r = await mgr.executeTool(s.id, tool, params as Record<string, unknown>);
      expect(r.ok).toBe(false);
      if (!r.ok && "error" in r) expect(r.error).toContain("chrome backend");
    }
    // resize/reload 双端可用
    const rz = await mgr.executeTool(s.id, "resize", { width: 800, height: 600 });
    expect(rz.ok).toBe(true);
    const rl = await mgr.executeTool(s.id, "reload", {});
    expect(rl.ok).toBe(true);
    mgr.closeAll();
  }, 30_000);
});

describe("B14 会话 upload 路径门", () => {
  test("目录外文件 → CONFIRMATION_REQUIRED；批准后执行", async () => {
    // 注意：不能用 os.tmpdir() 子目录——那是默认放行目录；建在仓库测试目录（tmp 之外）
    const dir = join(import.meta.dir, "tmp-b14-outside");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const outside = join(dir, "secret.key");
    writeFileSync(outside, "s");
    // chrome 假驱动：审批后 upload 真执行（performSearch 轨可编程）
    const uploadDriver = (): Driver =>
      new FakeDriver(CHROME_CAPS, {
        selectors: ['[data-bw-id="6"]'],
        evaluateHandler: (expr: string) => {
          if (expr === EXTRACT_EXPRESSION) {
            return {
              nodes: [
                {
                  id: "6",
                  tag: "input",
                  type: "file",
                  x: 5,
                  y: 5,
                  w: 60,
                  h: 20,
                  below: false,
                  above: false,
                },
              ],
              headings: [],
              warnings: [],
              title: "t",
              url: "https://fake.test/page",
              scrollY: 0,
              scrollX: 0,
              docHeight: 1000,
              viewportH: 720,
            };
          }
          if (expr.includes("data-bw-id")) {
            return {
              found: true,
              tag: "input",
              inputType: "file",
              x: 5,
              y: 5,
              w: 60,
              h: 20,
              origin: "https://fake.test",
            };
          }
          if (expr.includes("__bwSettle")) return 10_000;
          return null;
        },
        cdpHandler: (method: string) => {
          if (method === "DOM.performSearch") return { searchId: "s", resultCount: 1 };
          if (method === "DOM.getSearchResults") return { nodeIds: [9] };
          return {};
        },
      }) as unknown as Driver;
    const mgr = createSessionManager({
      policyMode: "test",
      confirmationTimeoutMs: 5_000,
      driverFactory: uploadDriver,
    });
    const s = await mgr.create("https://fake.test/page");
    const pending = mgr.executeTool(s.id, "upload", { index: "6", files: [outside] });
    let cid = "";
    const it = mgr.events(s.id)[Symbol.asyncIterator]();
    const deadline = Date.now() + 3_000;
    while (cid === "" && Date.now() < deadline) {
      let next: IteratorResult<{ type: string; cid?: string }>;
      try {
        next = (await Promise.race([
          it.next(),
          new Promise<never>((_, rj) => setTimeout(() => rj(new Error("tick")), 300)),
        ])) as IteratorResult<{ type: string; cid?: string }>;
      } catch {
        continue; // 等待窗口超时——继续轮询直到 deadline
      }
      if (next.done) break;
      if (next.value.type === "confirmation_required" && next.value.cid !== undefined) {
        cid = next.value.cid;
      }
    }
    expect(cid).not.toBe("");
    expect(mgr.confirm(s.id, cid, true)).toBe(true);
    const r = await pending;
    expect(r.ok).toBe(true); // 批准后上传执行
    mgr.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("B14 驱动选项", () => {
  test("webkit + userAgent → 构造即抛（fail fast，不静默忽略）", () => {
    expect(() => createWebViewDriver({ backend: "webkit", userAgent: "X/1" })).toThrow(
      /requires the chrome backend/,
    );
  });
});
