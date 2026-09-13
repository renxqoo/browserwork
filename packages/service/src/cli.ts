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
  const input = argv ?? process.argv.slice(2);
  // 子命令语法域：s/auth 的位置参数不归顶层 parser 管——直接分发（严格 B18 解析只管 run/replay）
  const rawCmd = input[0];
  if (rawCmd === "s" || rawCmd === "session") {
    const { runSessionCli } = await import("./cli-session.ts");
    return runSessionCli(input.slice(1));
  }
  if (rawCmd === "auth") {
    return await mainAuth(input);
  }
  let args: ParsedArgs;
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
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
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

/** bw auth 子命令（U5：登录态快照管理——save/list/delete） */
async function mainAuth(input: string[]): Promise<number> {
  {
    const [sub, ...authRest] = input.slice(1);
    const { createSessionStore } = await import("./store.ts");
    const { deleteProfile, listProfiles } = await import("./profiles.ts");
    const jout = (d: Record<string, unknown>): void => {
      console.log(JSON.stringify(d));
    };
    if (sub === "list") {
      jout({ ok: true, profiles: listProfiles() });
      return 0;
    }
    if (sub === "delete") {
      const name = authRest[0];
      if (name === undefined) {
        console.error("usage: bw auth delete <name>");
        return 2;
      }
      jout({ ok: true, deleted: deleteProfile(name) });
      return 0;
    }
    if (sub === "save") {
      const sessionId = authRest[0];
      const asIdx = input.indexOf("--as");
      const name = asIdx >= 0 ? input[asIdx + 1] : undefined;
      if (sessionId === undefined || name === undefined) {
        console.error("usage: bw auth save <sessionId> --as <name>");
        return 2;
      }
      try {
        const store = createSessionStore({
          bwHome: (await import("@bw/core")).resolveBwHome(),
        });
        const r = await store.captureProfile(sessionId, name);
        jout({ ok: true, name, path: r.path, cookies: r.cookies });
        return 0;
      } catch (e) {
        jout({
          ok: false,
          code:
            e instanceof Error && "code" in e
              ? String((e as { code: unknown }).code)
              : "AUTH_FAILED",
          error: e instanceof Error ? e.message : String(e),
        });
        return 1;
      }
    }
    if (sub === "import-chrome") {
      const hostIdx = input.indexOf("--host");
      const host = hostIdx >= 0 ? input[hostIdx + 1] : undefined;
      const asIdx = input.indexOf("--as");
      const asName = asIdx >= 0 ? input[asIdx + 1] : undefined;
      const browserIdx = input.indexOf("--browser");
      const browser = browserIdx >= 0 ? input[browserIdx + 1] : undefined;
      if (host === undefined) {
        console.error(
          "usage: bw auth import-chrome --host <域名> [--as <name>] [--browser chrome|edge|brave|chromium]",
        );
        return 2;
      }
      console.error("即将读取 Keychain「Chrome Safe Storage」——macOS 会弹授权框，请点「始终允许」");
      try {
        const { importChromeCookies } = await import("./authImport.ts");
        const r = importChromeCookies({
          host,
          ...(asName !== undefined ? { name: asName } : {}),
          ...(browser !== undefined ? { browser: browser as never } : {}),
        });
        jout({
          ok: true,
          name: asName ?? host,
          path: r.path,
          cookies: r.cookies,
          detail: `decrypted=${r.decrypted} plaintext=${r.plaintext} skipped=${r.undecryptable}`,
        });
        return 0;
      } catch (e) {
        jout({
          ok: false,
          code:
            e instanceof Error && "code" in e
              ? String((e as { code: unknown }).code)
              : "AUTH_IMPORT_FAILED",
          error: e instanceof Error ? e.message : String(e),
        });
        return 1;
      }
    }
    console.error(
      "usage: bw auth save <sessionId> --as <name> | list | delete <name> | import-chrome --host <域名>",
    );
    return 2;
  }
}

/** 进程入口（源码/构建产物双形态） */
if (process.argv[1]?.endsWith("cli.ts") === true || process.argv[1]?.endsWith("cli.js") === true) {
  process.exit(await main());
}
