/**
 * B16 小规模真跑（BW_REAL=1 + GLM_API_KEY；用户裁决 3-5 任务 × 双端对打）。
 * 本方：runTask（产品自带提示词——被测系统的一部分）
 * 对照：bunx @playwright/mcp --headless（最小通用提示词——提示词差异在报告披露）
 * 运行：bun scripts/eval-b16.ts [--tasks 5] [--runs 1]
 */
import { runTask } from "@bw/agent";
import { grade, McpStdioClient, runMcpAgentLoop, SMALL_TASKS } from "@bw/eval";

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? Number(process.argv[i + 1]) : dflt;
};
const N_TASKS = Math.min(arg("tasks", 5), SMALL_TASKS.length);
const RUNS = arg("runs", 1);

if (process.env.BW_REAL !== "1" || process.env.GLM_API_KEY === undefined) {
  console.error("requires BW_REAL=1 and GLM_API_KEY (real-gate: costs tokens)");
  process.exit(2);
}
const BASE = (
  process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions"
).replace(/\/chat\/completions\/?$/, "");
const MODEL = process.env.GLM_MODEL ?? "glm-5.3-flash";
const KEY = process.env.GLM_API_KEY as string;

interface Row {
  task: string;
  side: "bw" | "pwmcp";
  run: number;
  ok: boolean;
  steps: number;
  inTok: number;
  outTok: number;
  wallMs: number;
  error?: string;
  /** 完整答案（评级用）；报告摘录用前 100 字 */
  answer: string;
  answerHead: string;
}

const rows: Row[] = [];

// ---- 本方 ----
const runBw = async (
  taskId: string,
  goal: string,
  startUrl: string,
  maxSteps: number,
): Promise<Row> => {
  const handle = runTask({ goal, startUrl, budget: { maxSteps } }, { apiKey: KEY });
  const events: Array<{ type: string; text?: string }> = [];
  for await (const e of handle.events) {
    events.push(e as { type: string; text?: string });
  }
  const r = await handle.result();
  return {
    task: taskId,
    side: "bw",
    run: 0,
    ok: r.status === "done",
    steps: r.steps,
    inTok: r.tokens.input,
    outTok: r.tokens.output,
    wallMs: 0,
    ...(r.error !== undefined ? { error: r.error } : {}),
    answer: r.answer ?? "",
    answerHead: (r.answer ?? "").slice(0, 100),
  };
};

// ---- playwright-mcp ----
const PWMCP_SYSTEM = `You are an autonomous web browsing agent. Use the browser tools to complete the task.
Call the tool named "browser_navigate" first if a start URL is given. After each action, read the tool result before deciding.
When the task is complete, output the final answer as plain text (no more tool calls). Be efficient: at most ${30} tool steps.`;

const runPw = async (
  taskId: string,
  goal: string,
  startUrl: string,
  maxSteps: number,
): Promise<Row> => {
  const client = new McpStdioClient({
    command: "bunx",
    args: ["@playwright/mcp@latest", "--headless"],
    startupTimeoutMs: 180_000,
    callTimeoutMs: 180_000,
  });
  try {
    await client.start();
    const tools = await client.listTools();
    void tools;
    const r = await runMcpAgentLoop({
      goal,
      startUrl,
      baseUrl: BASE,
      apiKey: KEY,
      model: MODEL,
      systemPrompt: PWMCP_SYSTEM.replace("${30}", String(maxSteps * 2)),
      finishTool: "__never__",
      tools,
      maxSteps: maxSteps * 2,
      callTool: async (name, args) => {
        const res = await client.callTool(name, args);
        const text = res.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        return { ok: res.isError !== true, text };
      },
    });
    return {
      task: taskId,
      side: "pwmcp",
      run: 0,
      ok: r.ok,
      steps: r.steps.length,
      inTok: r.usage.input,
      outTok: r.usage.output,
      wallMs: r.wallMs,
      ...(r.error !== undefined ? { error: r.error } : {}),
      answer: r.answer,
      answerHead: r.answer.slice(0, 100),
    };
  } finally {
    client.stop();
  }
};

const tasks = SMALL_TASKS.slice(0, N_TASKS);
for (let run = 0; run < RUNS; run++) {
  for (const t of tasks) {
    console.error(`[run ${run}] ${t.id}: bw …`);
    try {
      rows.push(await runBw(t.id, t.goal, t.startUrl, t.maxSteps));
    } catch (e) {
      rows.push({
        task: t.id,
        side: "bw",
        run,
        ok: false,
        steps: 0,
        inTok: 0,
        outTok: 0,
        wallMs: 0,
        error: String(e),
        answer: "",
        answerHead: "",
      });
    }
    console.error(`[run ${run}] ${t.id}: playwright-mcp …`);
    try {
      rows.push(await runPw(t.id, t.goal, t.startUrl, t.maxSteps));
    } catch (e) {
      rows.push({
        task: t.id,
        side: "pwmcp",
        run,
        ok: false,
        steps: 0,
        inTok: 0,
        outTok: 0,
        wallMs: 0,
        error: String(e).slice(0, 120),
        answer: "",
        answerHead: "",
      });
    }
  }
}

// ---- 报告 ----
const tasksById = new Map(SMALL_TASKS.map((t) => [t.id, t]));
const graded = rows.map((r) => {
  const t = tasksById.get(r.task);
  const hit = t !== undefined && r.answer !== "" && grade(t, r.answer);
  return { ...r, graded: hit === true };
});
let md = `# B16 小规模真跑（${new Date().toISOString().slice(0, 10)} · ${MODEL} · 任务×${N_TASKS} 轮×${RUNS}）\n\n`;
md += `> 口径披露：本方用产品自带系统提示词（被测系统的一部分）；playwright-mcp 侧用最小通用提示词（其生态惯例）。同一模型、各自步数预算。锚点命中 = 答案含任务期望关键词（宽松——衡量"完成并给出答案"，非精确断言）。\n\n`;
md += `| task | side | done | 锚点命中 | steps | in | out | error |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of graded) {
  md += `| ${r.task} | ${r.side} | ${r.ok ? "✅" : "❌"} | ${r.graded ? "✅" : "—"} | ${r.steps} | ${r.inTok} | ${r.outTok} | ${r.error?.slice(0, 40) ?? ""} |\n`;
}
for (const side of ["bw", "pwmcp"] as const) {
  const rs = graded.filter((r) => r.side === side);
  const done = rs.filter((r) => r.ok).length;
  const hit = rs.filter((r) => r.graded).length;
  const steps = rs.reduce((a, r) => a + r.steps, 0);
  const inTok = rs.reduce((a, r) => a + r.inTok, 0);
  const outTok = rs.reduce((a, r) => a + r.outTok, 0);
  md += `\n**${side}**：done ${done}/${rs.length} · 锚点 ${hit}/${rs.length} · 总 steps ${steps} · tokens in/out ${inTok}/${outTok}\n`;
}
md += `\n## 答案摘录\n\n`;
for (const r of graded) {
  md += `- **${r.task}/${r.side}**: ${r.answerHead || r.error || "(no answer)"}\n`;
}
console.log(md);
await Bun.write("docs/eval-report-B16.md", md);
console.error("written: docs/eval-report-B16.md");
