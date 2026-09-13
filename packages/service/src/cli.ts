#!/usr/bin/env bun
import { runCliTask } from "./cli-run.ts";
/**
 * bw CLI 入口 —— build 门禁的真实打包产物（bun build 的 target）。
 * B22 S3：serve/sup/daemon 删除（U1/U9）；+ gc/jobs；未知 flag → exit 2（B18）；
 * 数值 flag 校验（B19）。
 */
import { VERSION } from "./version.ts";

const HELP = `bw ${VERSION} — Browser Use on Bun.WebView

Usage:
  bw run "goal text" [--url <start-url>] [--json]      run a task
         [--verbose] [--max-steps N]
         [--jobs N --file tasks.jsonl]                 batch tasks (child process each)
  bw s [command]                                    session tools (bw s --help)
  bw replay <taskId|file>                           print a task trajectory
  bw --version                                      print version
  bw --help                                         show this help`;

interface ParsedArgs {
  command: string | undefined;
  goal: string | undefined;
  url: string | undefined;
  json: boolean;
  verbose: boolean;
  maxSteps: number | undefined;
  jobs: number | undefined;
  file: string | undefined;
  profile: string | undefined;
  backend: string | undefined;
  dataDir: string | undefined;
  chromePath: string | undefined;
  width: number | undefined;
  height: number | undefined;
  ua: string | undefined;
}

/** 值 flag 词表（其余 --x 一律拒绝——B18：静默吞未知 flag 曾让拼错参数静默走默认） */
const VALUE_FLAGS = new Set([
  "--url",
  "-u",
  "--max-steps",
  "--jobs",
  "--file",
  "--profile",
  "--backend",
  "--data-dir",
  "--chrome-path",
  "--width",
  "--height",
  "--ua",
]);

function numFlag(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid value for ${name}: ${raw} (expect positive number)`);
  }
  return n;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    goal: undefined,
    url: undefined,
    json: false,
    verbose: false,
    maxSteps: undefined,
    jobs: undefined,
    file: undefined,
    profile: undefined,
    backend: undefined,
    dataDir: undefined,
    chromePath: undefined,
    width: undefined,
    height: undefined,
    ua: undefined,
  };
  const [cmd, ...rest] = argv;
  out.command = cmd;
  const flagTarget: Record<string, keyof ParsedArgs> = {
    "--url": "url",
    "-u": "url",
    "--max-steps": "maxSteps",
    "--jobs": "jobs",
    "--file": "file",
    "--profile": "profile",
    "--backend": "backend",
    "--data-dir": "dataDir",
    "--chrome-path": "chromePath",
    "--width": "width",
    "--height": "height",
    "--ua": "ua",
  };
  for (let i = 0; i < rest.length; i++) {
    const a: string | undefined = rest[i];
    if (a === undefined) continue;
    if (a === "--json") {
      out.json = true;
    } else if (a === "--verbose") {
      out.verbose = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`missing value for ${a}`);
      }
      i += 1;
      const key = flagTarget[a] as keyof ParsedArgs | undefined;
      if (key !== undefined) {
        (out as unknown as Record<string, unknown>)[key] = v;
      }
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a} (run 'bw --help')`);
    } else if (out.goal === undefined) {
      out.goal = a;
    } else {
      throw new Error(`unexpected argument: ${a} (goal takes one positional)`);
    }
  }
  // 数值校验（B19：NaN 一路传到驱动曾致未定义崩溃）
  out.maxSteps = numFlag(
    "--max-steps",
    out.maxSteps === undefined ? undefined : String(out.maxSteps),
  );
  out.jobs = numFlag("--jobs", out.jobs === undefined ? undefined : String(out.jobs));
  out.width = numFlag("--width", out.width === undefined ? undefined : String(out.width));
  out.height = numFlag("--height", out.height === undefined ? undefined : String(out.height));
  return out;
}

export async function main(argv?: string[]): Promise<number> {
  let args: ParsedArgs;
  const input = argv ?? process.argv.slice(2);
  try {
    args = parseArgs(input);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const cmd = args.command;
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    console.log(HELP);
    return 0;
  }
  if (cmd === "run") {
    // --jobs：批量执行器（每任务子进程——chrome 单例隔离，DESIGN §3）
    if (args.jobs !== undefined || args.file !== undefined) {
      if (args.file === undefined) {
        console.error("--jobs requires --file <tasks.jsonl>");
        return 2;
      }
      const { runBatchFile, renderBatchSummary } = await import("./batch.ts");
      const { outcomes, exitCode } = await runBatchFile({
        jobs: args.jobs ?? 4,
        file: args.file,
      });
      console.log(renderBatchSummary(outcomes));
      return exitCode;
    }
    if (args.goal === undefined) {
      console.error('bw run requires a goal: bw run "do something"');
      return 2;
    }
    return runCliTask({
      goal: args.goal,
      ...(args.url !== undefined ? { startUrl: args.url } : {}),
      ...(args.json ? { json: true } : {}),
      ...(args.verbose ? { verbose: true } : {}),
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.backend !== undefined ? { backend: args.backend as "webkit" | "chrome" } : {}),
      ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
      ...(args.chromePath !== undefined ? { chromePath: args.chromePath } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.ua !== undefined ? { ua: args.ua } : {}),
    });
  }
  if (cmd === "s" || cmd === "session") {
    const { runSessionCli } = await import("./cli-session.ts");
    return runSessionCli(input.slice(1));
  }
  if (cmd === "replay") {
    const target = args.goal;
    if (target === undefined) {
      console.error("bw replay requires a task id or trajectory file: bw replay <id|file>");
      return 2;
    }
    const { replayTrajectory } = await import("./replay.ts");
    const { trajectoryDir } = await import("@bw/core");
    const baseDir = trajectoryDir();
    const outcome = replayTrajectory(target, baseDir);
    if (!outcome.ok) {
      console.error(outcome.error);
      return 1;
    }
    for (const line of outcome.lines) console.log(line);
    return 0;
  }
  console.error(
    `unknown command: ${cmd}${cmd === "serve" || cmd === "sup" ? " (removed in B22 — sessions are file-based now; see bw s)" : ""}`,
  );
  return 2;
}
