/** B22 事故修复回归锚（2026-09-13）：进程组杀守卫。
 * 事故：无守卫 kill(-1) = SIGKILL 用户全部进程（整机崩溃）。这些用例锁死守卫语义。 */
import { describe, expect, test } from "bun:test";
import { killProcessGroup } from "../src/index.ts";

describe("killProcessGroup 守卫（事故回归）", () => {
  test("pid ≤ 1 一律拒绝（-1=全进程 / 1=launchd）", () => {
    for (const pid of [-1, 0, 1]) {
      const r = killProcessGroup(pid);
      expect(r.killed).toBe(false);
      expect(r.reason ?? "").toContain("refusing");
    }
  });

  test("非整数 pid 拒绝", () => {
    expect(killProcessGroup(1.5).killed).toBe(false);
    expect(killProcessGroup(Number.NaN).killed).toBe(false);
  });

  test("不存在的大 pid：不炸、返回 not alive", () => {
    // pid 上限量级（macOS 99998）——几乎必然不存在
    const r = killProcessGroup(99998);
    expect(r.killed).toBe(false);
  });

  test("命令核验：期望标记不匹配 → 拒绝（pid 复用防护）", async () => {
    // 起一个真实子进程（sleep），用故意不匹配的期望标记 → 必须拒绝且子进程活着
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"]);
    await new Promise((r) => setTimeout(r, 200));
    const pid = child.pid ?? 0;
    const r = killProcessGroup(pid, { expectCommandSubstring: "helper.ts" });
    expect(r.killed).toBe(false);
    expect(r.reason ?? "").toContain("mismatch");
    // 子进程未被误杀
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
    child.kill("SIGKILL");
  });
});
