/**
 * B22 S0（p14d 实证）：flock 非阻塞互斥——同会话命令串行。
 * 分工：fd 用 node:fs（跨环境稳定）；ffi 只做 flock(int,int) 纯整数调用——
 * ffi 的指针编组 open 在 bun test 下不稳定（S0 实测），收缩到最小面。
 * SIGKILL 后锁随 fd 自动释放（惰性回收安全底座，p14d 4/4）。
 */
import { dlopen, suffix } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LIB_PATH = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : `libc.so.${suffix}`;

const LOCK_EX = 0x2;
const LOCK_NB = 0x4;

type FlockFn = (fd: number, op: number) => number;
let flockFn: FlockFn | null = null;

function flockCall(): FlockFn {
  if (flockFn !== null) return flockFn;
  const handle = dlopen(LIB_PATH, {
    flock: { args: ["int", "int"], returns: "int" },
  });
  flockFn = handle.symbols.flock as unknown as FlockFn;
  return flockFn;
}

export interface FileLock {
  release(): void;
}

/**
 * 非阻塞抢锁：拿到 → lock；被占/打不开 → null（调用方报 SESSION_BUSY）。
 * 释放 = close(fd)；进程死亡时内核自动释放（无需 stale-lock 夺锁逻辑）。
 */
export function acquireFlock(path: string): FileLock | null {
  let fd: number;
  try {
    fd = openSync(path, "a+");
  } catch {
    return null;
  }
  if (flockCall()(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    return null;
  }
  return {
    release(): void {
      closeSync(fd);
    },
  };
}
