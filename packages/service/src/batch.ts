/**
 * B22 S3（--jobs）：批量任务执行器——每任务一个子进程（DESIGN §3：chrome 进程级
 * 单例下每任务独立浏览器/profile 的唯一隔离形态；崩溃也只死一个任务）。
 * 行 schema：MIGRATION-cli §4b（goal 必填；startUrl/name/profile/backend/maxSteps 可选）。
 * 非法行 → 记为该行任务失败（行号+原因），批次继续；任一失败 exit 1。
 */
import { spawn } from "node:child_process";

export interface BatchTaskLine {
  goal: string;
  startUrl?: string;
  name?: string;
  profile?: string;
  backend?: "webkit" | "chrome";
  maxSteps?: number;
}

export interface BatchOutcome {
  line: number;
  name: string;
  status: "done" | "failed";
  exitCode?: number;
  error?: string;
}

export interface BatchOptions {
  jobs: number;
  file: string;
  /** 缺省 process.execPath + 本模块推导的 CLI 入口（测试注入用） */
  runCommand?: (task: BatchTaskLine) => { cmd: string; args: string[] };
  /** 测试注时钟外的并发闸（缺省真并发） */
}

const DEFAULT_MAX_JOBS = 8;

/** 解析一行 → 任务或行错误 */
export function parseTaskLine(line: string): { task: BatchTaskLine } | { error: string } {
  if (line.trim() === "") return { error: "empty line" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: `invalid JSON: ${line.slice(0, 60)}` };
  }
  const t = parsed as Partial<BatchTaskLine>;
  if (typeof t.goal !== "string" || t.goal === "") {
    return { error: "missing required field: goal" };
  }
  return {
    task: {
      goal: t.goal,
      ...(t.startUrl !== undefined ? { startUrl: String(t.startUrl) } : {}),
      ...(t.name !== undefined ? { name: String(t.name) } : {}),
      ...(t.profile !== undefined ? { profile: String(t.profile) } : {}),
      ...(t.backend === "webkit" || t.backend === "chrome" ? { backend: t.backend } : {}),
      ...(t.maxSteps !== undefined && Number.isFinite(Number(t.maxSteps))
        ? { maxSteps: Number(t.maxSteps) }
        : {}),
    },
  };
}

/** 默认子进程命令：bun <cli> run "goal" … */
const defaultRunCommand = (task: BatchTaskLine): { cmd: string; args: string[] } => {
  const args = [
    process.argv[1] ?? "cli.js",
    "run",
    task.goal,
    ...(task.startUrl !== undefined ? ["--url", task.startUrl] : []),
    ...(task.backend !== undefined ? ["--backend", task.backend] : []),
    ...(task.maxSteps !== undefined ? ["--max-steps", String(task.maxSteps)] : []),
    ...(task.profile !== undefined ? ["--profile", task.profile] : []),
    "--json",
  ];
  return { cmd: process.execPath, args };
};

export async function runBatchFile(
  opts: BatchOptions,
): Promise<{ outcomes: BatchOutcome[]; exitCode: number }> {
  const jobs = Math.max(
    1,
    Math.min(opts.jobs, Number(process.env.BW_MAX_JOBS ?? DEFAULT_MAX_JOBS)),
  );
  const file = Bun.file(opts.file);
  if (!(await file.exists())) {
    return { outcomes: [], exitCode: 2 };
  }
  const text = await file.text();
  const lines = text.split("\n");

  // 预解析：非法行直接记败（不占并发槽）
  const pending: Array<{ line: number; task: BatchTaskLine }> = [];
  const outcomes: BatchOutcome[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const parsed = parseTaskLine(line);
    if ("error" in parsed) {
      outcomes.push({
        line: i + 1,
        name: `(line ${i + 1})`,
        status: "failed",
        error: parsed.error,
      });
    } else {
      pending.push({ line: i + 1, task: parsed.task });
    }
  });

  const runCommand = opts.runCommand ?? defaultRunCommand;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= pending.length) return;
      const { line, task } = pending[idx] as { line: number; task: BatchTaskLine };
      const { cmd, args } = runCommand(task);
      const code = await new Promise<number>((resolve) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
        child.on("exit", (c) => resolve(c ?? 1));
        child.on("error", () => resolve(1));
      });
      outcomes.push({
        line,
        name: task.name ?? `line ${line}`,
        status: code === 0 ? "done" : "failed",
        exitCode: code,
        ...(code !== 0 ? { error: `exit ${code}` } : {}),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, worker));

  outcomes.sort((a, b) => a.line - b.line);
  return { outcomes, exitCode: outcomes.some((o) => o.status === "failed") ? 1 : 0 };
}

/** 汇总输出（人读面） */
export function renderBatchSummary(outcomes: BatchOutcome[]): string {
  const lines = outcomes.map(
    (o) =>
      `${o.status === "done" ? "✓" : "✗"} line ${o.line} ${o.name}${o.error !== undefined ? ` — ${o.error}` : ""}`,
  );
  const done = outcomes.filter((o) => o.status === "done").length;
  return [`batch: ${done}/${outcomes.length} done`, ...lines].join("\n");
}
