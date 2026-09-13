/**
 * B22 S3（事故修复 2026-09-13）：进程组杀——带守卫的唯一实现。
 * 事故：destroySessionDir 无守卫 `process.kill(-pid, SIGKILL)`，测试假 pid=1 时
 * kill(-1) = SIGKILL 当前用户可信号的所有进程（POSIX 语义）——用户整机进程被清。
 * 守卫三道：
 *  1) pid ≤ 1 拒绝（1 = launchd/init；-1 = 全进程——绝对不可作为组目标）
 *  2) 进程存在性（kill 0 探测）
 *  3) **命令行核验**（pid 复用防护）：ps 读该 pid 的 command，不含期望标记则拒绝——
 *     重启后 session.json 里的旧 pid 已被系统复用给无辜进程，凭 pid 杀=误杀
 */
import { spawnSync } from "node:child_process";

/** 组杀（SIGKILL）。返回是否真的发了信号；拒绝时静默返回 false 并可给原因。 */
export function killProcessGroup(
  pid: number,
  opts?: { expectCommandSubstring?: string },
): { killed: boolean; reason?: string } {
  if (!Number.isInteger(pid) || pid <= 1) {
    return {
      killed: false,
      reason: `refusing to signal process group ${pid} (pid<=1 or non-integer — -1 means ALL processes)`,
    };
  }
  // 存在性探测（信号 0 = 不发送，仅查权限/存在）
  try {
    process.kill(pid, 0);
  } catch {
    return { killed: false, reason: `process ${pid} not alive` };
  }
  // 命令行核验（macOS/Linux 双平台 ps 形态）
  if (opts?.expectCommandSubstring !== undefined) {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    const cmd = (r.stdout ?? "").trim();
    if (cmd === "" || !cmd.includes(opts.expectCommandSubstring)) {
      return {
        killed: false,
        reason: `pid ${pid} command mismatch (pid reuse?): "${cmd.slice(0, 80)}"`,
      };
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
    return { killed: true };
  } catch {
    // 组已不在（主进程死即组散）——再兜底杀主进程本身
    try {
      process.kill(pid, "SIGKILL");
      return { killed: true };
    } catch {
      return { killed: false, reason: `process ${pid} disappeared during kill` };
    }
  }
}

/** 会话 helper 的组杀（命令核验锚：helper.ts——store/close/恢复共用） */
export function killHelperGroup(pid: number): boolean {
  return killProcessGroup(pid, { expectCommandSubstring: "helper.ts" }).killed;
}
