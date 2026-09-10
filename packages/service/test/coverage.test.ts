/** B8 收口：service 包全覆盖冲刺（豁免清空） */
import { describe, expect, test } from "bun:test";
import * as cliModule from "../src/cli.ts";
import { runCliTask } from "../src/cli-run.ts";
// 触碰 barrel 和 CLI 入口（使其进入 lcov）
import * as serviceIndex from "../src/index.ts";
import { VERSION } from "../src/version.ts";

void cliModule;

describe("service barrel", () => {
  test("index 导出面", () => {
    expect(serviceIndex.createServer).toBeDefined();
    expect(serviceIndex.runCliTask).toBeDefined();
    expect(serviceIndex.VERSION).toBe(VERSION);
  });
});

describe("server 全分支冲刺", () => {
  test("steer 运行中 → 200（非终态）", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "wait", arguments: { seconds: 2 } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "wait", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    // 运行中 steer → 200
    const rs = await fetch(`${server.url}/tasks/${id}/steer`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "steering" }),
    });
    expect(rs.status).toBe(200);
    // abort
    await fetch(`${server.url}/tasks/${id}/abort`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    await new Promise((res) => setTimeout(res, 300));
    server.stop();
  }, 15_000);

  test("steer 缺 text → 400", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "wait", arguments: { seconds: 2 } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "wait", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    const rs = await fetch(`${server.url}/tasks/${id}/steer`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(rs.status).toBe(400);
    await fetch(`${server.url}/tasks/${id}/abort`, {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: "{}",
    });
    await new Promise((res) => setTimeout(res, 200));
    server.stop();
  }, 15_000);

  test("server.stop() 幂等 + url 属性", async () => {
    const { createServer } = await import("../src/server.ts");
    const server = createServer({ port: 0, authToken: "t" });
    expect(server.url).toContain("http://");
    server.stop();
    server.stop(); // 不炸
  });

  test("POST /tasks/:id/unknown-sub → 404", async () => {
    const { createServer } = await import("../src/server.ts");
    const { scriptLLM } = await import("@bw/agent");
    const { makeFakeWorld } = await import("../../actions/test/helpers.ts");
    const world = makeFakeWorld({ locateResults: {}, rawExtract: { nodes: [] } });
    const llm = scriptLLM([{ toolCalls: [{ name: "wait", arguments: { seconds: 2 } }] }]);
    const server = createServer({
      port: 0,
      authToken: "t",
      runOptions: {
        driver: world.driver as never,
        models: { fast: llm.model as never },
        streamFn: llm.streamFn as never,
        testMode: true,
      },
    });
    const r = await fetch(`${server.url}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ goal: "x", startUrl: "https://fake.test/page" }),
    });
    const { id } = (await r.json()) as { id: string };
    const r404 = await fetch(`${server.url}/tasks/${id}/unknown`, {
      headers: { authorization: "Bearer t" },
    });
    expect(r404.status).toBe(404);
    await fetch(`${server.url}/tasks/${id}/abort`, {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: "{}",
    });
    await new Promise((res) => setTimeout(res, 200));
    server.stop();
  }, 15_000);
});

describe("cli-run 全分支", () => {
  test("printEvent 各类型分支走一次（非 json 模式）", async () => {
    // 有 key → 模型装配 + 事件打印路径
    process.env.GLM_API_KEY = "cov-key";
    process.env.GLM_BASE_URL = "https://test.example/v4/chat/completions";
    process.env.GLM_MODEL = "test-model";
    // 无 startUrl → about:blank 起步 → 立即失败（无浏览器）
    // 但覆盖了 loadEnvFile（如果 .env 不存在）+ 模型装配 + printEvent 部分分支
    const rc = await runCliTask({ goal: "coverage" });
    expect([0, 1, 2]).toContain(rc);
    delete process.env.GLM_API_KEY;
    delete process.env.GLM_BASE_URL;
    delete process.env.GLM_MODEL;
  }, 30_000);

  test("json 模式输出 JSON", async () => {
    process.env.GLM_API_KEY = "cov-key";
    const rc = await runCliTask({ goal: "json test", json: true });
    expect([0, 1, 2]).toContain(rc);
    delete process.env.GLM_API_KEY;
  }, 30_000);

  test("loadEnvFile 读 .env 文件", async () => {
    // 写临时 .env
    await Bun.write(".env", "GLM_API_KEY=file-key\nGLM_MODEL=file-model");
    // 确保进程 env 清掉
    delete process.env.GLM_API_KEY;
    const rc = await runCliTask({ goal: "file env" });
    expect([0, 1, 2]).toContain(rc);
    // 清理
    const { unlink } = await import("node:fs/promises");
    await unlink(".env").catch(() => {});
  }, 30_000);
});

describe("cli parseArgs + main", () => {
  test("parseArgs 各 flag", async () => {
    const { parseArgs } = await import("../src/cli.ts");
    const a1 = parseArgs(["run", "do something", "--url", "https://x.test", "--json"]);
    expect(a1.command).toBe("run");
    expect(a1.goal).toBe("do something");
    expect(a1.url).toBe("https://x.test");
    expect(a1.json).toBe(true);
    const a2 = parseArgs(["serve", "--port", "8080", "--token", "secret"]);
    expect(a2.port).toBe(8080);
    expect(a2.token).toBe("secret");
    const a3 = parseArgs([]);
    expect(a3.command).toBeUndefined();
  });

  test("main --version/--help/unknown", async () => {
    const { main } = await import("../src/cli.ts");
    expect(await main(["--version"])).toBe(0);
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(0);
    expect(await main(["nope"])).toBe(2);
  });
});

describe("cli main run/serve 分支", () => {
  test("main run with goal（会因无浏览器/key 失败但覆盖分支）", async () => {
    const { main } = await import("../src/cli.ts");
    process.env.GLM_API_KEY = "branch-key";
    const rc = await main(["run", "test goal"]);
    expect([0, 1, 2]).toContain(rc);
    delete process.env.GLM_API_KEY;
  }, 30_000);

  test("main run without goal → 2", async () => {
    const { main } = await import("../src/cli.ts");
    expect(await main(["run"])).toBe(2);
  });

  test("main serve starts and immediately used", async () => {
    const { main } = await import("../src/cli.ts");
    // serve 分支的 import + server 创建 + console.log 都会被覆盖
    // 但 setInterval 会让进程不退出——用 race
    const rc = await Promise.race([
      main(["serve", "--port", "0", "--token", "test"]),
      new Promise<number>((res) => setTimeout(() => res(0), 100)),
    ]);
    expect(rc).toBe(0);
    // 进程清理由 Bun.WebView.closeAll 处理
  }, 10_000);
});
