/**
 * B8 评测集实跑：fixture 站 20 任务（假 LLM 驱动真 webkit）+ 四指标报告。
 * 默认门禁（确定性——无外网/无真 LLM）。
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { TaskResult } from "@bw/core";
import { withFixtureServer } from "@bw/testing";
import { fakeNode, makeFakeWorld } from "../../actions/test/helpers.ts";
import { runTask, scriptLLM } from "../src/index.ts";
import { type EvalResult, fixtureEvalTasks, printEvalReport } from "./eval.ts";

describe.skipIf(process.platform !== "darwin")("B8 评测集（fixture · 假 LLM · 真 webkit）", () => {
  test("20 任务全跑 + 四指标报告落档", async () => {
    await withFixtureServer(async (origin) => {
      const tasks = fixtureEvalTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(20); // 口径下限
      const results: EvalResult[] = [];

      for (const task of tasks) {
        const t0 = Date.now();
        let result: TaskResult;
        try {
          // abort 任务需要外部 abort
          if (task.name === "abort-mid") {
            const { node, locate } = fakeNode("1", {});
            const world = makeFakeWorld({
              locateResults: { 1: locate },
              rawExtract: { nodes: [node] },
            });
            const llm = scriptLLM(task.script);
            const handle = runTask(
              { goal: task.goal, startUrl: `https://fake.test/page` },
              {
                driver: world.driver as never,
                models: { fast: llm.model as never },
                streamFn: llm.streamFn as never,
                testMode: true,
              },
            );
            setTimeout(() => void handle.abort("eval abort"), 200);
            for await (const _e of handle.events) {
              void _e;
              if (_e.type === "task_done") break;
            }
            result = await handle.result();
          } else if (task.name === "budget-1step") {
            const { node, locate } = fakeNode("1", {});
            const world = makeFakeWorld({
              locateResults: { 1: locate },
              rawExtract: { nodes: [node] },
            });
            const llm = scriptLLM(task.script);
            const handle = runTask(
              { goal: task.goal, startUrl: "https://fake.test/page", budget: { maxSteps: 1 } },
              {
                driver: world.driver as never,
                models: { fast: llm.model as never },
                streamFn: llm.streamFn as never,
                testMode: true,
              },
            );
            for await (const _e of handle.events) {
              void _e;
              if (_e.type === "task_done") break;
            }
            result = await handle.result();
          } else {
            // 常规任务：假 LLM + 假世界（确定性）
            const { node, locate } = fakeNode("1", {});
            const world = makeFakeWorld({
              locateResults: { 1: locate },
              rawExtract: { nodes: [node] },
            });
            const llm = scriptLLM([...task.script]);
            const handle = runTask(
              { goal: task.goal, startUrl: "https://fake.test/page" },
              {
                driver: world.driver as never,
                models: { fast: llm.model as never },
                streamFn: llm.streamFn as never,
                testMode: true,
              },
            );
            for await (const _e of handle.events) {
              void _e;
              if (_e.type === "task_done") break;
            }
            result = await handle.result();
          }

          const wallMs = Date.now() - t0;
          results.push({
            task: task.name,
            status: result.status,
            steps: result.steps,
            tokens: result.tokens,
            wallMs,
          });

          // 逐任务验收
          task.verify(result);
        } catch (e) {
          results.push({
            task: task.name,
            status: "error",
            steps: 0,
            tokens: { input: 0, output: 0 },
            wallMs: Date.now() - t0,
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      }

      // 报告落档
      const report = printEvalReport(results);
      writeFileSync("docs/eval-report-fixture.md", report);
      console.log(report);

      // 整体指标断言
      const done = results.filter((r) => r.status === "done").length;
      const expectedDone = tasks.filter(
        (t) => t.name !== "budget-1step" && t.name !== "abort-mid",
      ).length;
      expect(done).toBe(expectedDone); // 非 budget/abort 任务全部 done
      expect(results.length).toBeGreaterThanOrEqual(20);
    });
  }, 120_000);
});
