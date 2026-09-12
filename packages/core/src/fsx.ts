/**
 * B22 S0（D2/D5）：fs 基础件——BW_HOME 单源解析 + 0600 原子写。
 * 审计 B17：BW_HOME 三分叉（run/replay/serve 各写一套，设 BW_HOME 后轨迹互相找不到）
 * ——本文件是唯一解析点；审计 D2：PID 文件直接 writeFileSync 可读到撕裂 JSON——
 * tmp+rename 原子化在此单实现。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ~/.bw 根目录（BW_HOME 可测试覆写；惰性读取——模块加载时固化会让 env 覆写失效） */
export function resolveBwHome(): string {
  const root = process.env.BW_HOME ?? process.env.HOME ?? "/tmp";
  return join(root, ".bw");
}

/** 会话根目录（DESIGN §1.2 布局的入口） */
export function sessionsRoot(): string {
  return join(resolveBwHome(), "session");
}

/** 任务下载根（bw run：~/.bw/tasks/<taskId>/downloads——B22 迁自 ~/.bw/downloads） */
export function taskDownloadsRoot(): string {
  return join(resolveBwHome(), "tasks");
}

/** bw run 轨迹目录（现状延续，唯一解析点） */
export function trajectoryDir(): string {
  return process.env.BW_TRAJECTORY_DIR ?? join(resolveBwHome(), "trajectories");
}

/** secrets 声明文件（U4：唯一明文来源；与策略层 SecretsConfig 同形） */
export function secretsFile(): string {
  return join(resolveBwHome(), "secrets");
}

/** profiles 根（storageState 快照） */
export function profilesRoot(): string {
  return join(resolveBwHome(), "profiles");
}

/**
 * 0600 + tmp+rename 原子写（读者永远看不到半截文件）。
 * mode 参数：0600（凭据类，默认）或 0644（元数据类）。
 */
export function writeFileAtomic(path: string, data: string, mode?: 0o600 | 0o644): void {
  const m = mode ?? 0o600;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: m });
  try {
    chmodSync(tmp, m); // mkdir 后 umask 可能放宽——显式收紧（沿用 daemon P0-4 习惯）
  } catch {
    /* 最佳努力 */
  }
  renameSync(tmp, path);
}

/** 读 JSON（损坏 → undefined，不 throw——调用方决定重建/清扫） */
export function readJsonIfPossible<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** 建目录（已存在即幂等） */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
