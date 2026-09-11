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
  bw serve [--port <port>] [--token <auth-token>]   start HTTP service
         [--trajectory-dir <dir>]
  bw replay <taskId|file>                           print a task trajectory
  bw s [command]                                    session tools (bw s --help)
  bw --version                                      print version
  bw --help                                         show this help`;

interface ParsedArgs {
  command: string | undefined;
  goal: string | undefined;
  url: string | undefined;
  json: boolean;
  port: number | undefined;
  token: string | undefined;
  trajectoryDir: string | undefined;
  backend: string | undefined;
  dataDir: string | undefined;
  chromePath: string | undefined;
  width: number | undefined;
  height: number | undefined;
  ua: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    goal: undefined,
    url: undefined,
    json: false,
    port: undefined,
    token: undefined,
    trajectoryDir: undefined,
    backend: undefined,
    dataDir: undefined,
    chromePath: undefined,
    width: undefined,
    height: undefined,
    ua: undefined,
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
    } else if (a === "--trajectory-dir") {
      out.trajectoryDir = rest[i + 1];
      i += 1;
    } else if (a === "--backend") {
      out.backend = rest[i + 1];
      i += 1;
    } else if (a === "--data-dir") {
      out.dataDir = rest[i + 1];
      i += 1;
    } else if (a === "--chrome-path") {
      out.chromePath = rest[i + 1];
      i += 1;
    } else if (a === "--width") {
      out.width = Number(rest[i + 1]);
      i += 1;
    } else if (a === "--height") {
      out.height = Number(rest[i + 1]);
      i += 1;
    } else if (a === "--ua") {
      out.ua = rest[i + 1];
      i += 1;
    } else if (out.goal === undefined && a !== undefined && !a.startsWith("--")) {
      out.goal = a;
    }
  }
  return out;
}

/** daemon PID 文件清理（有 PID 文件才清）——工厂形态导出供测试 */
export const pidFileCleanup =
  (getInfo: () => unknown, remove: () => void): (() => void) =>
  () => {
    if (getInfo() !== undefined) remove();
  };

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
    return runSessionCli((argv ?? process.argv.slice(2)).slice(1));
  }
  if (cmd === "serve") {
    const { createServer } = await import("./server.ts");
    const explicit = args.token ?? process.env.BW_TOKEN;
    // B13：轨迹默认落盘 + janitor（trajectories/downloads 双目录）
    const bwHome = process.env.BW_HOME ?? process.env.HOME ?? "/tmp";
    const trajectoryDir =
      args.trajectoryDir ?? process.env.BW_TRAJECTORY_DIR ?? `${bwHome}/.bw/trajectories`;
    const { downloadsRoot } = await import("./sessions.ts");
    const server = createServer({
      port: args.port ?? 3456,
      ...(explicit !== undefined ? { authToken: explicit } : {}),
      trajectoryDir,
    });
    // P0-1：未显式给 token → 服务端已自动生成（永不裸奔）；落盘 0600 供 bw s 复用
    if (explicit === undefined) {
      const { persistServeToken } = await import("./daemon.ts");
      const file = persistServeToken(server.token);
      console.log(`auth token: ${server.token} (saved to ${file})`);
    }
    console.log(`bw serve listening on ${server.url} (trajectories: ${trajectoryDir})`);
    console.log("Press Ctrl+C to stop");
    const { startJanitor } = await import("./janitor.ts");
    startJanitor([
      { dir: trajectoryDir, extensions: [".jsonl"] },
      // 下载根为会话/任务子目录结构——一层展开清扫（B14 审查 P1-6）
      { dir: downloadsRoot(), subdirs: true },
    ]);
    // B13：优雅退出（SIGTERM/SIGINT——daemon 停止/容器停止不再裸杀）
    const { installSignalHandlers } = await import("./shutdown.ts");
    const { getDaemonInfo, removePidFile, isServeIdle, setupIdleExit } = await import(
      "./daemon.ts"
    );
    installSignalHandlers({
      stop: server.stop.bind(server),
      cleanup: pidFileCleanup(getDaemonInfo, removePidFile),
      exit: process.exit,
    });
    // B13：daemon 拉起的服务空闲自动退出（BW_DAEMON 由死变量转正；手动 serve 常驻）
    if (process.env.BW_DAEMON === "1") {
      setupIdleExit(isServeIdle(server.stats.bind(server)));
    }
    setInterval(() => {}, 60_000); // 活跃定时器——Bun 事件循环保持进程
    await new Promise(() => {}); // 永不返回——防止 main return 触发 process.exit
  }
  if (cmd === "replay") {
    const target = args.goal;
    if (target === undefined) {
      console.error("bw replay requires a task id or trajectory file: bw replay <id|file>");
      return 2;
    }
    const { replayTrajectory } = await import("./replay.ts");
    const bwHome = process.env.BW_HOME ?? process.env.HOME ?? "/tmp";
    const baseDir = process.env.BW_TRAJECTORY_DIR ?? `${bwHome}/.bw/trajectories`;
    const outcome = replayTrajectory(target, baseDir);
    if (!outcome.ok) {
      console.error(outcome.error);
      return 1;
    }
    for (const line of outcome.lines) console.log(line);
    return 0;
  }
  console.error(`unknown command: ${cmd}`);
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}
