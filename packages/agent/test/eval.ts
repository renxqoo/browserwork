/**
 * B8 评测装置：固定任务集 + 四指标 + 结果报告。
 * 任务 = fixture 站确定性断言（假 LLM 剧本驱动）——基础设施自证。
 * real 门（BW_REAL=1 + GLM）跑真 LLM 任务——对打 playwright-mcp 属 B8 后独立评测。
 */
import { expect } from "bun:test";
import type { TaskResult } from "@bw/core";
import type { ScriptStep } from "../src/index.ts";

export interface EvalTask {
  name: string;
  goal: string;
  /** fixture 路径（/index.html 等） */
  startPath: string;
  /** 假 LLM 剧本（工具调用序列） */
  script: ScriptStep[];
  /** 验收断言（对 TaskResult） */
  verify: (result: TaskResult) => void;
}

/** 生成 fixture 站任务集（20 项——B8 口径下限） */
export function fixtureEvalTasks(): EvalTask[] {
  const done = (answer: string) => ({
    toolCalls: [{ name: "done", arguments: { answer } }],
  });
  const wait = (s = 0.01) => ({
    toolCalls: [{ name: "wait", arguments: { seconds: s } }],
  });
  const s = (name: string, args: Record<string, unknown> = {}) => ({
    toolCalls: [{ name, arguments: args }],
  });

  return [
    {
      name: "nav-home",
      goal: "Open the home page",
      startPath: "/index.html",
      script: [done("home page opened")],
      verify: (r) => {
        expect(r.status).toBe("done");
        expect(r.steps).toBe(0);
      },
    },
    {
      name: "nav-links",
      goal: "Open links page",
      startPath: "/links.html",
      script: [done("links page")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "wait-and-done",
      goal: "Wait 0.01s then finish",
      startPath: "/index.html",
      script: [wait(), done("waited")],
      verify: (r) => {
        expect(r.status).toBe("done");
        expect(r.steps).toBe(1);
      },
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `wait-seq-${i + 1}`,
      goal: `Wait task ${i + 1}`,
      startPath: "/index.html",
      script: [wait(), wait(), done(`task ${i + 1} done`)],
      verify: (r: TaskResult) => {
        expect(r.status).toBe("done");
        expect(r.steps).toBe(2);
      },
    })),
    {
      name: "scroll-down",
      goal: "Scroll down on a long page",
      startPath: "/long?n=30",
      script: [s("scroll", { direction: "down" }), done("scrolled")],
      verify: (r) => {
        expect(r.status).toBe("done");
        expect(r.steps).toBe(1);
      },
    },
    {
      name: "extract",
      goal: "Extract page text",
      startPath: "/index.html",
      script: [s("extract_text"), done("text extracted")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "look-screenshot",
      goal: "Take a screenshot",
      startPath: "/index.html",
      script: [s("look"), done("screenshot taken")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "multi-tab",
      goal: "Open two tabs and switch",
      startPath: "/index.html",
      script: [
        s("open_tab", { url: "/links.html" }),
        s("switch_tab", { tab: 0 }),
        done("tabs managed"),
      ],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "budget-1step",
      goal: "Should hit budget limit",
      startPath: "/index.html",
      script: [wait(), wait(), wait()],
      verify: (r) => expect(r.status).toBe("budget_exceeded"),
    },
    {
      name: "abort-mid",
      goal: "Should be aborted",
      startPath: "/index.html",
      script: [{ toolCalls: [{ name: "wait", arguments: { seconds: 5 } }] }],
      verify: (r) => expect(r.status).toBe("aborted"),
    },
    {
      name: "press-key",
      goal: "Press escape",
      startPath: "/index.html",
      script: [s("press", { key: "Escape" }), done("pressed")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "close-tab",
      goal: "Close the tab",
      startPath: "/index.html",
      script: [s("close_tab"), done("closed")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "scroll-up",
      goal: "Scroll up",
      startPath: "/long?n=30",
      script: [
        s("scroll", { direction: "down", amount: 500 }),
        s("scroll", { direction: "up" }),
        done("scrolled both ways"),
      ],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "form-navigate",
      goal: "Navigate to form",
      startPath: "/form.html",
      script: [done("form page")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "hidden-page",
      goal: "Open hidden test page",
      startPath: "/hidden.html",
      script: [done("hidden page")],
      verify: (r) => expect(r.status).toBe("done"),
    },
    {
      name: "shadow-page",
      goal: "Open shadow DOM test page",
      startPath: "/shadow.html",
      script: [done("shadow page")],
      verify: (r) => expect(r.status).toBe("done"),
    },
  ];
}

export interface EvalResult {
  task: string;
  status: TaskResult["status"] | "error";
  steps: number;
  tokens: { input: number; output: number };
  wallMs: number;
  error?: string;
}

export function printEvalReport(results: EvalResult[]): string {
  const total = results.length;
  const done = results.filter((r) => r.status === "done").length;
  const successRate = ((done / total) * 100).toFixed(1);
  const avgSteps = total > 0 ? (results.reduce((s, r) => s + r.steps, 0) / total).toFixed(1) : "0";
  const totalTokens = results.reduce((s, r) => s + r.tokens.input + r.tokens.output, 0);
  const totalWallMs = results.reduce((s, r) => s + r.wallMs, 0);
  const lines = [
    `# B8 评测报告（fixture 站 · 假 LLM）`,
    ``,
    `| 指标 | 值 |`,
    `|---|---|`,
    `| 任务数 | ${total} |`,
    `| 成功率 | ${successRate}% (${done}/${total}) |`,
    `| 平均步数 | ${avgSteps} |`,
    `| 总 token | ${totalTokens} |`,
    `| 总墙钟 | ${totalWallMs}ms |`,
    ``,
    `| 任务 | 状态 | 步数 | tokens | 墙钟ms |`,
    `|---|---|---|---|---|`,
    ...results.map(
      (r) =>
        `| ${r.task} | ${r.status} | ${r.steps} | ${r.tokens.input + r.tokens.output} | ${r.wallMs} |`,
    ),
  ];
  return lines.join("\n");
}
