/** B22 S3：CLI 胶合覆盖——自旧 coverage/cli.test 移植保留面（HTTP/serve 面随删除核销），
 * 增补 B18/B19 新参数层断言（未知 flag exit 2 / 数值校验） */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("main auth list/delete 分发（profiles 空家）", async () => {
    process.env.BW_HOME = `/tmp/bw-auth-${Date.now()}`;
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(process.env.BW_HOME, { recursive: true });
    expect(await cliModule.main(["auth", "list"])).toBe(0);
    expect(await cliModule.main(["auth", "delete", "nope"])).toBe(0);
    expect(await cliModule.main(["auth"])).toBe(2); // usage
    expect(await cliModule.main(["auth", "save"])).toBe(2);
    rmSync(process.env.BW_HOME, { recursive: true, force: true });
    delete process.env.BW_HOME;
  });

  test("main s 子命令分发：help 零副作用 exit 0（B16）", async () => {
    expect(await cliModule.main(["s"])).toBe(0);
    expect(await cliModule.main(["s", "--help"])).toBe(0);
  });

  test("main run --jobs 缺 --file → 2", async () => {
    expect(await cliModule.main(["run", "g", "--jobs", "2"])).toBe(2);
  });

  test("main run 未知 flag → 2（经 main 路径）", async () => {
    expect(await cliModule.main(["run", "g", "--nope"])).toBe(2);
  });
});

describe("SDK 装配（sdk.ts 冒烟——bun -e import 即用的进程内面）", () => {
  test("bw.sessions/profiles/run 三面存在 + store 单例语义", async () => {
    process.env.BW_HOME = `/tmp/bw-sdk-${Date.now()}`;
    const { createBwSdk } = await import("../src/sdk.ts");
    const sdk = createBwSdk();
    expect(typeof sdk.sessions.create).toBe("function");
    expect(typeof sdk.sessions.executeTool).toBe("function");
    expect(typeof sdk.sessions.captureProfile).toBe("function");
    expect(typeof sdk.profiles.list).toBe("function");
    expect(typeof sdk.run).toBe("function");
    expect(sdk.sessions.store()).toBe(sdk.sessions.store()); // 单例
    // 无浏览器路径直调（空家：list/gc/profiles.list/delete 全走通）
    expect(sdk.sessions.list()).toEqual([]);
    expect(sdk.sessions.gc().reaped).toEqual([]);
    expect(sdk.profiles.list()).toEqual([]);
    expect(sdk.profiles.delete("nope")).toBe(false);
    expect(sdk.sessions.close("sess-none")).toBe(false); // 幂等
    expect(() => sdk.profiles.load("nope")).toThrow("not found");
    expect(() => sdk.sessions.keep("sess-none")).toThrow("not found"); // NOT_FOUND throw
    const { rmSync } = await import("node:fs");
    rmSync(process.env.BW_HOME as string, { recursive: true, force: true });
    delete process.env.BW_HOME;
  });
});

describe("secrets 解析面（env ref / literal / 缺失）", () => {
  test("env 引用与 literal；未声明名报 SECRET_UNRESOLVED", async () => {
    process.env.BW_HOME = `/tmp/bw-sec-${Date.now()}`;
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(process.env.BW_HOME, ".bw"), { recursive: true });
    writeFileSync(
      join(process.env.BW_HOME, ".bw", "secrets"),
      JSON.stringify({
        fromEnv: { source: "env", ref: "BW_TEST_SECRET" },
        literal: { source: "literal", value: "v1" },
        badRef: { source: "env", ref: "BW_TEST_MISSING" },
        noVal: { source: "literal" },
      }),
    );
    const { resolveSecretValue, secretNames } = await import("../src/secrets.ts");
    process.env.BW_TEST_SECRET = "env-value";
    expect(await resolveSecretValue("fromEnv")).toBe("env-value");
    expect(await resolveSecretValue("literal")).toBe("v1");
    expect(secretNames().sort()).toEqual(["badRef", "fromEnv", "literal", "noVal"]);
    await expect(resolveSecretValue("unknown")).rejects.toThrow("not declared");
    await expect(resolveSecretValue("badRef")).rejects.toThrow("unset");
    await expect(resolveSecretValue("noVal")).rejects.toThrow("missing value");
    delete process.env.BW_TEST_SECRET;
    rmSync(process.env.BW_HOME as string, { recursive: true, force: true });
    delete process.env.BW_HOME;
  });
});

describe("create --help 零副作用（B16 同型——实测曾误建会话）", () => {
  test("runSessionCreate --help 打印用法 exit 0，不建会话", async () => {
    process.env.BW_HOME = `/tmp/bw-ch-${Date.now()}`;
    const { existsSync, mkdirSync, rmSync, readdirSync } = await import("node:fs");
    mkdirSync(process.env.BW_HOME, { recursive: true });
    await import("../src/cli-session.ts");
    // exit 会终止进程——这里只验证不抛（帮助路径 return 0 前打印；真 exit 面由 e2e 断言）
    // 直接调用会 process.exit(0)——用子进程跑最稳：
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `
      process.env.BW_HOME = ${JSON.stringify(process.env.BW_HOME)};
      const { runSessionCreate } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "cli-session.ts"))});
      process.exit(await runSessionCreate(["--help"]));
    `,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--profile");
    expect(r.stdout).toContain("--chrome-path");
    // 无会话被建（help 路径不触发 store——.bw/session 可能整体不存在，存在则必空）
    const bwDir = join(process.env.BW_HOME, ".bw");
    if (existsSync(bwDir)) {
      const sessDir = join(bwDir, "session");
      if (existsSync(sessDir)) expect(readdirSync(sessDir)).toEqual([]);
    }
    rmSync(process.env.BW_HOME, { recursive: true, force: true });
    delete process.env.BW_HOME;
  });
});
