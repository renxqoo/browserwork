/**
 * B20 小规模真跑：batch 生效验证（表单任务 + 简单对照）——只跑本方侧。
 * 运行：BW_REAL=1 bun scripts/eval-b20.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileTrajectorySink, runTask } from "@bw/agent";
import { grade, SMALL_TASKS } from "@bw/eval";

if (process.env.BW_REAL !== "1" || process.env.GLM_API_KEY === undefined) {
  console.error("requires BW_REAL=1 and GLM_API_KEY");
  process.exit(2);
}
const dir = process.env.BW_TRAJECTORY_DIR ?? join(homedir(), ".bw", "trajectories");

const tasks = SMALL_TASKS.filter((t) => ["httpbin-form-fill", "example-title"].includes(t.id));
const rows: Array<Record<string, unknown>> = [];
for (const t of tasks) {
  const h = runTask(
    { goal: t.goal, startUrl: t.startUrl, budget: { maxSteps: t.maxSteps } },
    { apiKey: process.env.GLM_API_KEY, trajectory: (id) => fileTrajectorySink(dir, id) },
  );
  for await (const _e of h.events) void _e;
  const r = await h.result();
  let batchUses = 0;
  let trajActions = 0;
  try {
    for (const line of readFileSync(r.trajectory, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const e = JSON.parse(line) as {
        action?: { kind?: string; text?: string };
      };
      trajActions += 1;
      // B20 审查 P1-4 修正：batch 整体条目以 llm 文本标记落轨迹
      if (e.action?.kind === "llm" && (e.action.text ?? "").startsWith("batch:")) {
        batchUses += 1;
      }
    }
  } catch {
    /* 轨迹读失败不阻塞 */
  }
  rows.push({
    task: t.id,
    status: r.status,
    hit: grade(t, r.answer ?? ""),
    steps: r.steps,
    in: r.tokens.input,
    out: r.tokens.output,
    batchUses,
    trajActions,
    answer: (r.answer ?? r.error ?? "").slice(0, 90),
  });
}
console.log(JSON.stringify(rows, null, 2));
