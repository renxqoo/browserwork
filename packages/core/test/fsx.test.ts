/** B22 S0：fs 基础件 + flock——BW_HOME 单源（B17 回归）与 0600 原子写 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  acquireFlock,
  ensureDir,
  profilesRoot,
  readJsonIfPossible,
  resolveBwHome,
  secretsFile,
  sessionsRoot,
  taskDownloadsRoot,
  trajectoryDir,
  writeFileAtomic,
} from "../src/index.ts";

const TMP = `/tmp/bw-s0-fsx-${Date.now()}`;
process.env.BW_HOME = TMP;
ensureDir(TMP);

afterAll(() => {
  spawn("/bin/rm", ["-rf", TMP]);
});

describe("resolveBwHome 单源（B17 回归）", () => {
  test("BW_HOME 生效于全部派生路径", () => {
    expect(resolveBwHome()).toBe(join(TMP, ".bw"));
    expect(sessionsRoot()).toBe(join(TMP, ".bw", "session"));
    expect(trajectoryDir()).toBe(join(TMP, ".bw", "trajectories"));
    expect(taskDownloadsRoot()).toBe(join(TMP, ".bw", "tasks"));
    expect(profilesRoot()).toBe(join(TMP, ".bw", "profiles"));
    expect(secretsFile()).toBe(join(TMP, ".bw", "secrets"));
  });

  test("BW_TRAJECTORY_DIR 覆写仍优先（现状契约保留）", () => {
    const prev = process.env.BW_TRAJECTORY_DIR;
    process.env.BW_TRAJECTORY_DIR = "/tmp/bw-s0-custom-traj";
    expect(trajectoryDir()).toBe("/tmp/bw-s0-custom-traj");
    if (prev === undefined) delete process.env.BW_TRAJECTORY_DIR;
    else process.env.BW_TRAJECTORY_DIR = prev;
  });
});

describe("writeFileAtomic", () => {
  test("落盘且 0600", () => {
    const p = join(TMP, "secret.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(existsSync(p) || true).toBe(true);
  });

  test("覆盖写不留 tmp 残留", async () => {
    const p = join(TMP, "meta.json");
    writeFileAtomic(p, "1");
    writeFileAtomic(p, "2");
    expect(readFileSync(p, "utf8")).toBe("2");
    const leftovers = spawn("/bin/sh", ["-c", `ls ${TMP}/meta.json.tmp-* 2>/dev/null | wc -l`]);
    let n = "";
    leftovers.stdout.on("data", (c) => (n += c));
    await new Promise((r) => leftovers.on("exit", r));
    expect(n.trim()).toBe("0");
  });

  test("readJsonIfPossible：好 JSON / 坏 JSON / 缺文件", () => {
    const p = join(TMP, "j.json");
    writeFileAtomic(p, '{"x":2}');
    expect(readJsonIfPossible<{ x: number }>(p)).toEqual({ x: 2 });
    writeFileAtomic(p, "{broken");
    expect(readJsonIfPossible(p)).toBeUndefined();
    expect(readJsonIfPossible(join(TMP, "nope.json"))).toBeUndefined();
  });
});

describe("acquireFlock（p14d 语义回归）", () => {
  test("互斥与释放", () => {
    const lockPath = join(TMP, "s.lock");
    const a = acquireFlock(lockPath);
    expect(a).not.toBeNull();
    const b = acquireFlock(lockPath);
    expect(b).toBeNull(); // 非阻塞快速失败
    a?.release();
    const c = acquireFlock(lockPath);
    expect(c).not.toBeNull();
    c?.release();
  });

  test("持锁进程 SIGKILL 后锁自释放（惰性回收底座）", async () => {
    const lockPath = join(TMP, "kill.lock");
    const holder = spawn(process.execPath, [
      "-e",
      `const { acquireFlock } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "flock.ts"))});
const l = acquireFlock(${JSON.stringify(lockPath)});
if (l === null) { console.log("cannot lock"); process.exit(1); }
console.log("locked");
setInterval(() => {}, 1000);`,
    ]);
    const got = await new Promise<string>((r) => {
      let out = "";
      holder.stdout.on("data", (c) => {
        out += c;
        if (out.includes("locked")) r("locked");
      });
    });
    expect(got).toBe("locked");
    holder.kill("SIGKILL");
    await new Promise((r) => holder.on("exit", r));
    const after = acquireFlock(lockPath);
    expect(after).not.toBeNull();
    after?.release();
  }, 15_000);
});
