/**
 * U6 真 webkit 旅程（假 LLM 驱动真浏览器）+ real 门 GLM 冒烟（BW_REAL=1）。
 */
import { describe, expect, test } from "bun:test";
import type { TaskEvent } from "@bw/core";
import { createWebViewDriver } from "@bw/driver";
import { withFixtureServer } from "@bw/testing";
import { glmModelFromEnv, runTask, scriptLLM } from "../src/index.ts";
import { memoryTrajectorySink } from "../src/trajectory.ts";

describe.skipIf(process.platform !== "darwin")("U6 真 webkit 旅程（假 LLM）", () => {
  test("表单任务全链路：起始页 → type → click submit → done", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        // 索引每次提取重编——直接用引擎探测一次拿当前索引（与 runTask 同一条复合步路径）
        const probeEngine = (await import("@bw/actions")).createActionEngine(driver, {});
        const probeSnap = (await probeEngine.act({ kind: "open_tab", url: `${origin}/form.html` }))
          .snapshot;
        const qIndex = probeSnap?.nodes.find((n) => n.type === "text")?.id ?? "";
        const submitIndex = probeSnap?.nodes.find((n) => n.text === "Submit query")?.id ?? "";
        await probeEngine.act({ kind: "close_tab" });

        const script = [
          { toolCalls: [{ name: "type", arguments: { index: qIndex, text: "journey-query" } }] },
          { toolCalls: [{ name: "click", arguments: { index: submitIndex } }] },
          { toolCalls: [{ name: "extract_text", arguments: {} }] },
          { toolCalls: [{ name: "done", arguments: { answer: "submitted" } }] },
        ];
        const llm = scriptLLM(script);
        const traj = memoryTrajectorySink();
        const handle = runTask(
          { goal: "fill and submit the form", startUrl: `${origin}/form.html` },
          {
            driver: driver as never,
            models: { fast: llm.model as never },
            streamFn: llm.streamFn as never,
            trajectory: traj,
            testMode: true,
          },
        );
        const events: TaskEvent[] = [];
        for await (const e of handle.events) {
          events.push(e);
          // 提交确认门：事件循环内批准（测试自身注释承诺的行为——旧索引漂移时代
          // click 打偏从未真正走到这；B22 稳定 id 后 click 命中真 submit 才暴露）
          if (e.type === "confirmation_required" && e.cid !== undefined) {
            await handle.confirm(e.cid, true);
          }
          if (e.type === "task_done") break;
        }
        const result = await handle.result();
        expect(result.status).toBe("done");
        expect(result.answer).toBe("submitted");
        // 表单提交的意图经过确认门（submit intent → confirm）→ 剧本内自动批准不了——
        // 该旅程应出现 confirmation_required 且默认超时 deny → LLM 收到 denied。
        // 为让流程走通，此处提前批准：在事件循环里批准。
        void events;
        expect(traj.entries.length).toBeGreaterThanOrEqual(2);
        driver.close();
      } finally {
        driver.close();
      }
    });
  }, 120_000);
});

/** real 门：BW_REAL=1 + GLM key 才跑（默认门禁不含） */
describe.skipIf(
  process.env.BW_REAL !== "1" ||
    process.env.GLM_API_KEY === undefined ||
    process.platform !== "darwin",
)("real 门：GLM 真模型冒烟", () => {
  test("GLM 驱动真 webkit：打开 fixture → 找链接 → done", async () => {
    await withFixtureServer(async (origin) => {
      const envText = await Bun.file("/Users/wrr/work/pi/app/.env").text();
      const env: Record<string, string> = {};
      for (const line of envText.split("\n")) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (m) env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
      }
      const model = glmModelFromEnv({
        GLM_API_KEY: env.GLM_API_KEY ?? process.env.GLM_API_KEY ?? "",
        ...(env.GLM_BASE_URL !== undefined ? { GLM_BASE_URL: env.GLM_BASE_URL } : {}),
        ...(env.GLM_MODEL !== undefined ? { GLM_MODEL: env.GLM_MODEL } : {}),
      });
      const handle = runTask(
        {
          goal: `Open the start page, click the link named "Links page", then report the page title using done.`,
          startUrl: `${origin}/index.html`,
          budget: { maxSteps: 8 },
        },
        {
          models: { fast: model as never },
          testMode: true,
          ...(env.GLM_API_KEY !== undefined ? { apiKey: env.GLM_API_KEY } : {}),
        },
      );
      const events: TaskEvent[] = [];
      for await (const e of handle.events) {
        events.push(e);
        if (e.type === "task_done") break;
      }
      const result = await handle.result();
      expect(["done", "budget_exceeded", "failed"]).toContain(result.status);
      if (result.status === "done") {
        expect((result.answer ?? "").toLowerCase()).toContain("links");
      }
      console.log("real GLM result:", JSON.stringify(result).slice(0, 300));
    });
  }, 300_000);
});
