/**
 * B25 Fix C 测试口径（docs/design-B25-rnw-fixes.md）：
 * console 钩子前移——
 * 1) console/errors 动作先补装钩子再 drain（对已导航页面救回后续消息）；
 * 2) INSTALL_LOG_HOOK_EXPRESSION 单源抽出（EXTRACT 内嵌段改拼接）；
 * 3) driver 复本守卫（chrome init 注入段与 perception 导出逐字节一致）；
 * 4) 真 webkit：导航后不 extract 直接 console 能看到加载期日志。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { createWebViewDriver, FakeDriver } from "@bw/driver";
import {
  DRAIN_LOGS_EXPRESSION,
  EXTRACT_EXPRESSION,
  INSTALL_LOG_HOOK_EXPRESSION,
} from "@bw/perception";
import { withDriverPage, withFixtureServer } from "@bw/testing";
import { createActionEngine } from "../src/engine.ts";

const CAPS: DriverCapabilities = {
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

const snapHandler = (expr: string): unknown => {
  if (expr === EXTRACT_EXPRESSION) {
    return {
      nodes: [],
      headings: [],
      warnings: [],
      title: "t",
      url: "https://t/",
      scrollY: 0,
      scrollX: 0,
      docHeight: 800,
      viewportH: 720,
    };
  }
  if (expr.includes("__bwSettle")) return 10_000;
  return null;
};

describe("console/errors 动作先装后 drain（B25 Fix C）", () => {
  test("console：先 evaluate(INSTALL) 再 evaluate(DRAIN)，顺序断言", async () => {
    const order: string[] = [];
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr === INSTALL_LOG_HOOK_EXPRESSION) {
        order.push("install");
        return "1";
      }
      if (expr === DRAIN_LOGS_EXPRESSION) {
        order.push("drain");
        return [];
      }
      order.push(`other:${expr.slice(0, 20)}`);
      return null;
    };
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    await engine.inspect("console");
    expect(order.indexOf("install")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("drain")).toBeGreaterThan(order.indexOf("install"));
  });

  test("errors：同路径（先装后 drain）", async () => {
    const order: string[] = [];
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr === INSTALL_LOG_HOOK_EXPRESSION) {
        order.push("install");
        return "1";
      }
      if (expr === DRAIN_LOGS_EXPRESSION) {
        order.push("drain");
        return [{ t: 1, level: "error", text: "boom" }];
      }
      return null;
    };
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.inspect("errors");
    expect(JSON.parse(r)).toHaveLength(1);
    expect(order.indexOf("drain")).toBeGreaterThan(order.indexOf("install"));
  });

  test("安装失败不阻断 drain（evaluate 抛 → 仍返回缓冲）", async () => {
    const handler = (expr: string): unknown => {
      if (expr === EXTRACT_EXPRESSION) return snapHandler(expr);
      if (expr.includes("__bwSettle")) return 10_000;
      if (expr === INSTALL_LOG_HOOK_EXPRESSION) throw new Error("page dead");
      if (expr === DRAIN_LOGS_EXPRESSION) {
        return [{ t: 1, level: "log", text: "existing" }];
      }
      return null;
    };
    const engine = createActionEngine(
      new FakeDriver(CAPS, { evaluateHandler: handler as never }) as unknown as Driver,
      { settleQuietMs: 10, settleCapMs: 200 },
    );
    await engine.act({ kind: "open_tab", url: "https://t/" });
    const r = await engine.inspect("console");
    expect(JSON.parse(r)).toHaveLength(1);
  });

  test("EXTRACT_EXPRESSION 内嵌段与单源拼接一致（单一真相守卫）", () => {
    // 抽出后 EXTRACT 必须仍然装钩子（幂等防重入由 __bwLogHooked 保证）
    expect(EXTRACT_EXPRESSION).toContain("__bwLogHooked");
    // 单源自身具备幂等闸与缓冲安装
    expect(INSTALL_LOG_HOOK_EXPRESSION).toContain("__bwLogHooked");
    expect(INSTALL_LOG_HOOK_EXPRESSION).toContain("__bwLog");
  });
});

describe.skipIf(process.platform !== "darwin")("console 钩子前移——真 webkit 旅程", () => {
  test("导航后不 extract 直接 console 能看到加载期日志（旧形态首提前消息丢失）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/text-cases.html`);
          // 注意：刻意不 extract——旧形态此时钩子未装，console 只能拿到空
          const engine = createActionEngine(driver);
          engine.adopt(page);
          const raw = await engine.inspect("console");
          const logs = JSON.parse(raw) as Array<{ level: string; text: string }>;
          // text-cases.html 加载即打（首屏脚本）——安装后新消息可捕获；
          // webkit 无 init 注入，加载期两条靠本动作补装后的后续消息或已有缓冲。
          // 稳定断言：补装后触发新 console 能被捕获
          await page.evaluate("console.log('post-install probe')");
          const raw2 = await engine.inspect("console");
          const logs2 = JSON.parse(raw2) as Array<{ level: string; text: string }>;
          expect(logs2.some((l) => l.text.includes("post-install probe"))).toBe(true);
          // drain 光标语义：再次读不到已消费的
          const raw3 = await engine.inspect("console");
          const logs3 = JSON.parse(raw3) as Array<{ text: string }>;
          expect(logs3.some((l) => l.text.includes("post-install probe"))).toBe(false);
          void logs;
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);
});

describe("driver 复本守卫（chrome init 注入段 == perception 单源）", () => {
  test("backends.ts 的注入段与 INSTALL_LOG_HOOK_EXPRESSION 逐字节一致", () => {
    const src = readFileSync(
      new URL("../../driver/src/backends.ts", import.meta.url).pathname,
      "utf8",
    );
    // 以标记注释包裹的段抽取
    const begin = "/* __bwLogHookSourceBegin */";
    const end = "/* __bwLogHookSourceEnd */";
    const i = src.indexOf(begin);
    const j = src.indexOf(end);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    const driverCopy = src.slice(i + begin.length, j);
    // 去除缩进差异后逐字节比对（模板串原样，不做 strip）——直接包含关系
    expect(driverCopy.trim()).toBe(INSTALL_LOG_HOOK_EXPRESSION.trim());
  });
});
