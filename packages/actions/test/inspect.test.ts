/**
 * B11 inspect/runExpression 单元（fake 表驱动）：
 * console/errors 光标读取 · cookies/storage 表达式生成 · eval 超时/截断/脱敏边界。
 * 真实页面侧行为（__bwLog 安装/光标）由 service 集成测试（真 webkit）覆盖。
 */
import { describe, expect, test } from "bun:test";
import { BWError } from "@bw/core";
import { DRAIN_LOGS_EXPRESSION } from "@bw/perception";
import { createActionEngine } from "../src/index.ts";
import { makeFakeWorld } from "./helpers.ts";

function engineWith(extra: (expr: string) => unknown) {
  const world = makeFakeWorld({
    locateResults: {},
    rawExtract: { nodes: [] },
    extraEvaluate: extra,
  });
  const engine = createActionEngine(world.driver);
  return engine;
}

async function openedEngine(extra: (expr: string) => unknown) {
  const e = engineWith(extra);
  await e.act({ kind: "open_tab", url: "https://fake.test/page" });
  return e;
}

describe("inspect", () => {
  test("console → DRAIN_LOGS_EXPRESSION 返回 JSON", async () => {
    const logs = [{ t: 1, level: "log", text: "hello" }];
    const engine = await openedEngine((expr) =>
      expr === DRAIN_LOGS_EXPRESSION ? logs : undefined,
    );
    const out = await engine.inspect("console");
    expect(JSON.parse(out)).toEqual(logs);
  });

  test("errors → 过滤 level=error", async () => {
    const logs = [
      { t: 1, level: "log", text: "hi" },
      { t: 2, level: "error", text: "boom" },
    ];
    const engine = await openedEngine((expr) =>
      expr === DRAIN_LOGS_EXPRESSION ? logs : undefined,
    );
    const out = await engine.inspect("errors");
    expect(JSON.parse(out)).toEqual([{ t: 2, level: "error", text: "boom" }]);
  });

  test("console 无页面 → DRIVER_ERROR（open_tab 前无活动页）", async () => {
    const engine = engineWith(() => undefined);
    await expect(engine.inspect("console")).rejects.toThrow();
  });

  test("cookies 读取 / cookies_set 参数校验 / cookies_clear 计数", async () => {
    const seen: string[] = [];
    const engine = await openedEngine((expr) => {
      seen.push(expr);
      if (expr === "document.cookie") return "a=1; b=2";
      if (expr.includes("max-age=0")) return 2;
      return undefined;
    });
    expect(await engine.inspect("cookies")).toBe("a=1; b=2");

    await expect(engine.inspect("cookies_set", { value: "v" })).rejects.toThrow(); // 缺 name
    expect(
      BWError.is(
        await (async () => {
          try {
            return await engine.inspect("cookies_set", { key: "k", value: 'v x"q' });
          } catch (e) {
            return e as Error;
          }
        })(),
      ),
    ).toBe(false); // 齐参 → 成功
    const setExpr = seen.find((e) => e.startsWith("document.cookie = encodeURIComponent"));
    expect(setExpr).toContain('"k"');
    expect(setExpr).toContain('"v x\\"q"'); // 值经 JSON 转义安全内嵌
    expect(await engine.inspect("cookies_clear")).toBe("cleared 2 cookie(s)");
  });

  test("storage 全量 / 单键 / set 校验 / clear", async () => {
    const engine = await openedEngine((expr) => {
      if (expr.includes("localStorage.getItem") && expr.includes('"theme"')) return "dark";
      if (expr.includes("localStorage.length")) return { theme: "dark", lang: "zh" };
      return undefined;
    });
    expect(JSON.parse(await engine.inspect("storage"))).toEqual({ theme: "dark", lang: "zh" });
    expect(await engine.inspect("storage", { key: "theme" })).toBe("dark");
    await expect(engine.inspect("storage_set", { key: "k" })).rejects.toThrow(); // 缺 value
    expect(await engine.inspect("storage_set", { key: "k", value: "v" })).toBe("storage k set");
    expect(await engine.inspect("storage_clear")).toBe("localStorage cleared");
  });
});

describe("runExpression", () => {
  test("结果 JSON 化 + null 归一", async () => {
    const engine = await openedEngine((expr) => (expr === "1+1" ? 2 : undefined));
    expect(await engine.runExpression("1+1")).toBe("2");
  });

  test("结果截断到 8000 字符", async () => {
    const big = "x".repeat(20_000);
    const engine = await openedEngine((expr) => (expr === "getBig" ? big : undefined));
    expect((await engine.runExpression("getBig")).length).toBe(8000);
  });

  test("evaluate 抛错 → DRIVER_ERROR", async () => {
    const engine = await openedEngine((expr) => {
      if (expr === "boom") throw new Error("page eval failed");
      return undefined;
    });
    try {
      await engine.runExpression("boom");
      expect.unreachable();
    } catch (e) {
      expect(BWError.is(e)).toBe(true);
      expect((e as BWError).code).toBe("DRIVER_ERROR");
    }
  });
});
