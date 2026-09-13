/** B22 S3：CLI 胶合覆盖——自旧 coverage/cli.test 移植保留面（HTTP/serve 面随删除核销），
 * 增补 B18/B19 新参数层断言（未知 flag exit 2 / 数值校验） */
import { describe, expect, test } from "bun:test";
import * as cliModule from "../src/cli.ts";
import type { ProcessRendererState } from "../src/cli-run.ts";
import { printEvent, runCliTask } from "../src/cli-run.ts";
import * as serviceIndex from "../src/index.ts";
import { VERSION } from "../src/version.ts";

describe("service barrel", () => {
  test("index 导出面（S3：文件会话面——serve/daemon/sup 不复存在）", () => {
    expect(serviceIndex.createSessionStore).toBeDefined();
    expect(serviceIndex.runSessionCli).toBeDefined();
    expect(serviceIndex.runCliTask).toBeDefined();
    expect(serviceIndex.runBatchFile).toBeDefined();
    // 删除面零残留（barrel 不再引用已删模块——import 本身即证明）
    expect(serviceIndex.VERSION).toBe(VERSION);
  });
});

describe("cli-run 分支", () => {
  test("printEvent 各类型分支走一次（非 json 模式）", () => {
    const st: ProcessRendererState = { step: 0, maxSteps: 10, verbose: true };
    printEvent({ type: "message_update", text: "x" } as never, st);
    printEvent({ type: "confirmation_required", cid: "c", reason: "r" } as never, st);
    printEvent({ type: "budget_warn", dimension: "steps", usedPct: 80 } as never, st);
    printEvent({ type: "stuck_escalated", from: "a", to: "b" } as never, st);
    printEvent({ type: "tool_execution_start", toolName: "t", args: { index: "1" } } as never, st);
    printEvent(
      {
        type: "tool_execution_end",
        resultText: "ok",
        ms: 5,
        pageState: { title: "t", url: "u", elements: 1 },
        snapshotHead: "a\nb",
      } as never,
      st,
    );
    printEvent({ type: "task_done" } as never, st);
    expect(st.step).toBe(1);
  });

  test("json 模式 / 缺 key exit 2", async () => {
    const prev = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    const code = await runCliTask({ goal: "x", json: true });
    expect(code).toBe(2);
    if (prev !== undefined) process.env.GLM_API_KEY = prev;
  });
});

describe("cli parseArgs + main（B18/B19 新参数层）", () => {
  test("各 flag 解析", () => {
    const a = cliModule.parseArgs([
      "run",
      "goal text",
      "--url",
      "https://a/",
      "--json",
      "--max-steps",
      "7",
    ]);
    expect(a.goal).toBe("goal text");
    expect(a.url).toBe("https://a/");
    expect(a.json).toBe(true);
    expect(a.maxSteps).toBe(7);
  });

  test("未知 flag → 报错（B18：旧实现静默吞掉拼错的 flag）", () => {
    expect(() => cliModule.parseArgs(["run", "g", "--max-step", "5"])).toThrow("unknown flag");
    expect(() => cliModule.parseArgs(["run", "g", "--frobnicate"])).toThrow("unknown flag");
  });

  test("数值 flag NaN/非正 → 报错（B19）", () => {
    expect(() => cliModule.parseArgs(["run", "g", "--max-steps", "abc"])).toThrow("invalid value");
    expect(() => cliModule.parseArgs(["run", "g", "--width", "-3"])).toThrow("invalid value");
    expect(() => cliModule.parseArgs(["run", "g", "--jobs", "0"])).toThrow("invalid value");
  });

  test("值 flag 缺值 → 报错", () => {
    expect(() => cliModule.parseArgs(["run", "g", "--url"])).toThrow("missing value");
  });

  test("main --version/--help/unknown", async () => {
    expect(await cliModule.main(["--version"])).toBe(0);
    expect(await cliModule.main(["--help"])).toBe(0);
    expect(await cliModule.main(["frobnicate"])).toBe(2);
    // 已删命令的退役文案（U1）
    expect(await cliModule.main(["serve"])).toBe(2);
    expect(await cliModule.main(["sup", "start"])).toBe(2);
  });

  test("main run without goal → 2", async () => {
    expect(await cliModule.main(["run"])).toBe(2);
  });

  test("main run 未知 flag → 2（经 main 路径）", async () => {
    expect(await cliModule.main(["run", "g", "--nope"])).toBe(2);
  });
});
