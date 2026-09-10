/**
 * bw serve 后台守护——`bw s` 自动拉起/停止，用户不需要手动管理服务。
 * PID 文件 + 健康检查 + 空闲自动退出（全部会话关闭后 60s 无操作即退）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const PID_DIR = join(process.env.HOME ?? "/tmp", ".bw");
const PID_FILE = join(PID_DIR, "serve.pid");
const DEFAULT_PORT = 3456;
const STARTUP_TIMEOUT_MS = 5000;
const IDLE_EXIT_MS = 60_000; // 无会话 60s 后自动退出

export interface DaemonInfo {
  url: string;
  pid: number;
  port: number;
  token?: string;
}

function readPidFile(): DaemonInfo | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8")) as DaemonInfo;
  } catch {
    unlinkSync(PID_FILE);
    return undefined;
  }
}

function writePidFile(info: DaemonInfo): void {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(info));
}

function removePidFile(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

/** 检查服务器是否在运行（发一个轻量请求） */
export async function isServerRunning(url: string, token?: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sessions`, {
      headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    return res.status !== 0;
  } catch {
    return false;
  }
}

/** 获取或创建后台服务——`bw s` 每次调用前用这个 */
export async function ensureServer(token?: string): Promise<DaemonInfo> {
  // 1. 环境变量指定了地址 → 直接用（不管理生命周期）
  const envUrl = process.env.BW_SERVER_URL;
  if (envUrl !== undefined) {
    const running = await isServerRunning(envUrl, token ?? process.env.BW_TOKEN);
    if (running) {
      return { url: envUrl, pid: 0, port: Number(new URL(envUrl).port) || DEFAULT_PORT };
    }
    throw new Error(`BW_SERVER_URL=${envUrl} but server not responding`);
  }

  // 2. 已有 PID 文件 → 检查是否活着
  const existing = readPidFile();
  if (existing !== undefined) {
    const running = await isServerRunning(existing.url, existing.token);
    if (running) return existing;
    removePidFile(); // 僵尸 PID 文件
  }

  // 3. 没有服务 → 后台拉起
  const port = DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const cliPath = process.argv[1] ?? "bun"; // 当前 CLI 脚本路径（bundled 或源码）

  const autoToken = token ?? crypto.randomUUID();
  const child = spawn("bun", [cliPath, "serve", "--port", String(port), "--token", autoToken], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BW_DAEMON: "1" },
  });
  child.unref();

  // 等服务就绪
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isServerRunning(url, autoToken)) {
      const info: DaemonInfo = { url, pid: child.pid ?? 0, port, token: autoToken };
      writePidFile(info);
      return info;
    }
  }

  throw new Error(`failed to start bw serve on ${url} within ${STARTUP_TIMEOUT_MS}ms`);
}

/** 停止后台服务 */
export async function stopServer(): Promise<boolean> {
  const info = readPidFile();
  if (info === undefined) {
    // 没有 PID 文件——尝试环境变量地址
    const envUrl = process.env.BW_SERVER_URL;
    if (envUrl !== undefined && (await isServerRunning(envUrl))) {
      // 无法杀远程服务
      return false;
    }
    return false;
  }
  removePidFile();
  if (info.pid > 0) {
    try {
      process.kill(info.pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 服务端空闲自动退出（由 createServer 调用） */
export function setupIdleExit(getSessionCount: () => number): void {
  let lastActiveTime = Date.now();
  const timer = setInterval(() => {
    if (getSessionCount() === 0 && Date.now() - lastActiveTime > IDLE_EXIT_MS) {
      removePidFile();
      process.exit(0);
    }
    if (getSessionCount() > 0) {
      lastActiveTime = Date.now();
    }
  }, 10_000);
  if (typeof timer.unref === "function") timer.unref();
}

export function getDaemonInfo(): DaemonInfo | undefined {
  return readPidFile();
}
