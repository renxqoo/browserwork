/**
 * bw serve 后台守护——`bw s` 自动拉起/停止，用户不需要手动管理服务。
 * PID 文件 + 健康检查 + 空闲自动退出（全部会话关闭后 60s 无操作即退）。
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 惰性解析（BW_HOME 可测试覆写；模块加载时固化会让 env 覆写失效） */
const pidDir = (): string => join(process.env.BW_HOME ?? process.env.HOME ?? "/tmp", ".bw");
const PID_FILE = (): string => join(pidDir(), "serve.pid");
const TOKEN_FILE = (): string => join(pidDir(), "serve.token");
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
  if (!existsSync(PID_FILE())) return undefined;
  try {
    return JSON.parse(readFileSync(PID_FILE(), "utf8")) as DaemonInfo;
  } catch {
    unlinkSync(PID_FILE());
    return undefined;
  }
}

function writePidFile(info: DaemonInfo): void {
  mkdirSync(pidDir(), { recursive: true });
  writeFileSync(PID_FILE(), JSON.stringify(info), { mode: 0o600 });
  // P0-4：PID 文件含 token——仅属主可读（mkdir 后 umask 可能放宽，显式收紧）
  try {
    chmodSync(PID_FILE(), 0o600);
  } catch {
    /* 最佳努力 */
  }
}

function removePidFile(): void {
  if (existsSync(PID_FILE())) unlinkSync(PID_FILE());
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

/** 探测「活着且 token 可用」（401 = 活着但不可复用） */
async function probeAuthorized(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 后台 serve 的 argv（P0-2：不含 token——token 经 env 传递，导出以供测试断言） */
export function serveSpawnArgs(port: number): string[] {
  return [process.argv[1] ?? "bun", "serve", "--port", String(port)];
}

/** 手动 `bw serve` 未给 token 时：自动生成的 token 落盘（0600），供 bw s 复用 */
export function persistServeToken(token: string): string {
  mkdirSync(pidDir(), { recursive: true });
  writeFileSync(TOKEN_FILE(), token, { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE(), 0o600);
  } catch {
    /* 最佳努力 */
  }
  return TOKEN_FILE();
}

/** 读取手动 serve 落盘的 token */
export function readServeToken(): string | undefined {
  if (!existsSync(TOKEN_FILE())) return undefined;
  try {
    const t = readFileSync(TOKEN_FILE(), "utf8").trim();
    return t !== "" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** 获取或创建后台服务——`bw s` 每次调用前用这个 */
export async function ensureServer(token?: string): Promise<DaemonInfo> {
  // 1. 环境变量指定了地址 → 直接用（不管理生命周期；空串视为未设置）
  const envUrl = process.env.BW_SERVER_URL?.trim() || undefined;
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

  // 2.5 用户手动 `bw serve`（无 PID 文件）→ 探测默认端口（须 token 验证通过，非仅活着）
  const port = DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  for (const candidate of [token, readServeToken()]) {
    if (candidate === undefined) continue;
    if (await probeAuthorized(url, candidate)) {
      return { url, pid: 0, port, token: candidate };
    }
  }

  // 端口已被占用但候选 token 都不认 → 明确报错（不误收养拿错 token）
  if (await isServerRunning(url)) {
    throw new Error(
      `port ${port} is occupied by a bw serve we cannot authenticate (token mismatch) — ` +
        `stop it with its own 'bw s stop', or export BW_TOKEN with the correct token`,
    );
  }

  // 3. 没有服务 → 后台拉起
  const autoToken = token ?? crypto.randomUUID();
  // P0-2：token 只走 env（BW_TOKEN）——argv 会暴露在 ps 里
  const child = spawn("bun", serveSpawnArgs(port), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BW_DAEMON: "1", BW_TOKEN: autoToken },
  });
  child.unref();
  let childDied = false;
  child.on("exit", () => {
    childDied = true;
  });

  // 等服务就绪（probeAuthorized——防误收养同端口的其它实例）
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    if (childDied) break; // 常见因：端口占用 EADDRINUSE
    await new Promise((r) => setTimeout(r, 200));
    if (await probeAuthorized(url, autoToken)) {
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
    const envUrl = process.env.BW_SERVER_URL?.trim() || undefined;
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
