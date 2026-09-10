/**
 * bw CLI 入口 —— build 门禁的真实打包产物（bun build 的 target）。
 * 子命令随批次生长：B6 run / B7 serve / replay。
 * 可测性：逻辑在 runCli，import.meta.main 守卫保证被测试 import 时不执行。
 */
import { VERSION } from "./version.ts";

const HELP = `bw ${VERSION} — Browser Use on Bun.WebView

Usage:
  bw --version        print version
  bw --help           show this help

(子命令随批次交付：run / serve / replay)`;

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export function runCli(argv: string[], io: CliIo = console): number {
  const first = argv[0];
  if (first === "--version" || first === "-v") {
    io.log(VERSION);
    return 0;
  }
  if (first === "--help" || first === "-h" || first === undefined) {
    io.log(HELP);
    return 0;
  }
  io.error(`unknown command: ${first}`);
  return 2;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
