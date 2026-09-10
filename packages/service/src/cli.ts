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

function parseArgs(argv: string[]): ParsedArgs {
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
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
  if (cmd === "serve") {
    const { createServer } = await import("./server.ts");
    const server = createServer({
      port: args.port ?? 3456,
      ...(args.token !== undefined ? { authToken: args.token } : {}),
    });
    console.log(`bw serve listening on ${server.url}`);
    // 保持进程
    setInterval(() => {}, 60_000);
    return 0;
  }
  console.error(`unknown command: ${cmd}`);
  return 2;
}

process.exit(await main());
