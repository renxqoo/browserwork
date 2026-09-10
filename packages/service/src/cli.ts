#!/usr/bin/env bun
import { runCliTask } from "./cli-run.ts";
/**
 * bw CLI 入口 —— build 门禁的真实打包产物（bun build 的 target）。
 * 子命令：run / serve / replay。
 */
import { VERSION } from "./version.ts";

const HELP = `bw ${VERSION} — Browser Use on Bun.WebView

Usage:
  bw run "goal text" [--url <start-url>] [--json]   run a task
  bw serve [--port <port>] [--token <auth-token>]    start HTTP service
  bw --version                                      print version
  bw --help                                         show this help`;

interface ParsedArgs {
  command: string | undefined;
  goal: string | undefined;
  url: string | undefined;
  json: boolean;
  port: number | undefined;
  token: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    goal: undefined,
    url: undefined,
    json: false,
    port: undefined,
    token: undefined,
  };
  const [cmd, ...rest] = argv;
  out.command = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--url" || a === "-u") {
      out.url = rest[i + 1];
      i += 1;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--port" || a === "-p") {
      out.port = Number(rest[i + 1]);
      i += 1;
    } else if (a === "--token" || a === "-t") {
      out.token = rest[i + 1];
      i += 1;
    } else if (out.goal === undefined && a !== undefined && !a.startsWith("--")) {
      out.goal = a;
    }
  }
  return out;
}

export async function main(argv?: string[]): Promise<number> {
  const args = parseArgs(argv ?? process.argv.slice(2));
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
    if (args.goal === undefined) {
      console.error('bw run requires a goal: bw run "do something"');
      return 2;
    }
    return runCliTask({
      goal: args.goal,
      ...(args.url !== undefined ? { startUrl: args.url } : {}),
      ...(args.json ? { json: true } : {}),
    });
  }
  if (cmd === "s" || cmd === "session") {
    const { runSessionCli } = await import("./cli-session.ts");
    return runSessionCli((argv ?? process.argv.slice(2)).slice(1));
  }
  if (cmd === "serve") {
    const { createServer } = await import("./server.ts");
    const server = createServer({
      port: args.port ?? 3456,
      ...(args.token !== undefined ? { authToken: args.token } : {}),
    });
    console.log(`bw serve listening on ${server.url}`);
    console.log("Press Ctrl+C to stop");
    setInterval(() => {}, 60_000); // 活跃定时器——Bun 事件循环保持进程
    await new Promise(() => {}); // 永不返回——防止 main return 触发 process.exit
  }
  console.error(`unknown command: ${cmd}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}
