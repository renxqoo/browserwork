/**
 * p14d：flock 互斥（同会话命令串行 + 崩溃自释放）。
 * bun:ffi 调 libc flock(fd, LOCK_EX|LOCK_NB)：
 *  1) 父进程持锁 → 子进程抢锁失败（EWOULDBLOCK）
 *  2) 父释放 → 子抢锁成功
 *  3) 持锁进程被 SIGKILL → 锁自动释放（fd 关闭）——惰性回收安全性的底座
 *  4) 再次抢锁成功
 */

import { dlopen } from "bun:ffi";
import { spawn } from "node:child_process";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  }
};

// libc
const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  open: { args: ["pointer", "int"], returns: "int" },
  flock: { args: ["int", "int"], returns: "int" },
  close: { args: ["int"], returns: "int" },
});
const O_RDWR = 0x2;
const O_CREAT = 0x200; // macOS
const LOCK_EX = 0x2;
const LOCK_NB = 0x4;

const enc = new TextEncoder();
const openLock = (path: string): { fd: number; acquired: boolean } => {
  const fd = lib.symbols.open(enc.encode(`${path}\0`), O_RDWR | O_CREAT, 0o600) as number;
  const r = lib.symbols.flock(fd, LOCK_EX | LOCK_NB) as number;
  return { fd, acquired: r === 0 };
};

/** 子进程：抢锁 → 打印结果退出 */
const CHILD = `
import { dlopen } from "bun:ffi";
const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  open: { args: ["pointer", "int"], returns: "int" },
  flock: { args: ["int", "int"], returns: "int" },
});
const enc = new TextEncoder();
const fd = lib.symbols.open(enc.encode(process.argv[2] + "\\0"), 2 | 0x200, 0o600);
console.log(lib.symbols.flock(fd, 2 | 4) === 0 ? "acquired" : "denied");
process.exit(0);
`;

const LOCK = "/tmp/p14d.lock";
await Bun.write(LOCK, "");

async function childTry(): Promise<"acquired" | "denied"> {
  const tmp = `/tmp/p14d-child-${Date.now()}.ts`;
  await Bun.write(tmp, CHILD);
  const proc = spawn(process.execPath, [tmp, LOCK], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  await new Promise((r) => proc.on("exit", r));
  return out.trim() as "acquired" | "denied";
}

// 1. 父持锁 → 子被拒
const mine = openLock(LOCK);
check("父进程抢到锁", mine.acquired);
check("锁被持有时子进程被拒（非阻塞）", (await childTry()) === "denied");

// 2. 父释放 → 子可得
lib.symbols.close(mine.fd);
check("父释放后子进程可得", (await childTry()) === "acquired");

// 3. 持锁进程 SIGKILL → 锁自动释放
const holder = spawn(
  process.execPath,
  [
    "-e",
    `
import { dlopen } from "bun:ffi";
const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  open: { args: ["pointer", "int"], returns: "int" },
  flock: { args: ["int", "int"], returns: "int" },
});
const enc = new TextEncoder();
const fd = lib.symbols.open(enc.encode(process.argv[1] + "\\0"), 2 | 0x200, 0o600);
if (lib.symbols.flock(fd, 2 | 4) !== 0) { console.log("cannot lock"); process.exit(1); }
console.log("locked");
setInterval(() => {}, 1000);
`,
    LOCK,
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((r) => holder.stdout.on("data", r));
holder.kill("SIGKILL");
await new Promise((r) => holder.on("exit", r));
await new Promise((r) => setTimeout(r, 300));
check("持锁进程被 SIGKILL 后锁自动释放", (await childTry()) === "acquired");

console.log(`\np14d 结论: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
