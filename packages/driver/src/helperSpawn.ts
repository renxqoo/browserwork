/**
 * B22 S1：helper 进程管理——detached spawn（独立进程组）+ 就绪等待 + 组清理 + 活性探测。
 * p14a 实证：kill(-pid, SIGKILL) 整组带走 webkit host / chrome 子进程（residual=0）；
 * dataStore 目录传 helper → WebView 持久（cookies 确定持久，U11）。
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BWError, killHelperGroup } from "@bw/core";
import type { HelperReady } from "./helperProtocol.ts";

export interface HelperSpawnOptions {
  /** 会话目录（socket/ready 文件与 dataStore 都落在这里） */
  sessionDir: string;
  backend: "webkit" | "chrome";
  dataStore?: string;
  userAgent?: string;
  chromePath?: string;
  width?: number;
  height?: number;
  /** CDP 调试口（chrome-only；0=随机端口。DevToolsActivePort 落 dataStore——bw s cdp 读它） */
  debugPort?: number;
  /** 有头模式（chrome：--headless=false 反转 Bun 默认） */
  headed?: boolean;
  /** 就绪超时 ms（默认 20000——webkit host/chrome 冷启动） */
  readyTimeoutMs?: number;
  /** 显式 bun 可执行文件（缺省 process.execPath） */
  bunPath?: string;
  /** helper.ts 模块路径（缺省本文件同目录） */
  helperModule?: string;
}

export interface HelperHandle {
  pid: number;
  socketPath: string;
  ready: HelperReady;
  /** 组杀（close 用；带走 webkit host / chrome 子进程） */
  killGroup(): void;
  /** 活性：pid 存活 && socket RPC 往返（pages——触碰页面态，WebView host 死亦判死） */
  alive(): Promise<boolean>;
}

const HELPER_ARGV = (o: HelperSpawnOptions): string[] => {
  // 模块解析（P2-12）：优先构建产物兄弟文件 helper.js（bundle 内 import.meta.url
  // 指向 dist/cli/cli.js）；否则源码形态的同目录 helper.ts（decodeURIComponent——
  // URL pathname 的百分号编码在含空格/中文目录时失效）
  const sibling = join(
    import.meta.dir,
    existsSync(join(import.meta.dir, "helper.js")) ? "helper.js" : "helper.ts",
  );
  const mod = o.helperModule ?? sibling;
  const argv = [
    mod,
    "--socket",
    join(o.sessionDir, "helper.sock"),
    "--backend",
    o.backend,
    "--ready",
    join(o.sessionDir, "helper.ready"),
  ];
  if (o.dataStore !== undefined) argv.push("--data-dir", o.dataStore);
  if (o.userAgent !== undefined) argv.push("--ua", o.userAgent);
  if (o.chromePath !== undefined) argv.push("--chrome-path", o.chromePath);
  if (o.width !== undefined) argv.push("--width", String(o.width));
  if (o.height !== undefined) argv.push("--height", String(o.height));
  if (o.debugPort !== undefined) argv.push("--debug-port", String(o.debugPort));
  if (o.headed === true) argv.push("--headed");
  return argv;
};

export async function spawnHelper(o: HelperSpawnOptions): Promise<HelperHandle> {
  const socketPath = join(o.sessionDir, "helper.sock");
  const readyPath = join(o.sessionDir, "helper.ready");
  rmSync(socketPath, { force: true });
  rmSync(readyPath, { force: true });

  const bunPath = o.bunPath ?? process.execPath;
  const child = spawn(bunPath, HELPER_ARGV(o), {
    detached: true, // 独立进程组——组杀可带走浏览器子进程（p14a）
    stdio: "ignore",
    env: { ...process.env, BW_HELPER: "1" },
  });
  child.unref();
  const pid = child.pid ?? 0;
  if (pid === 0) {
    throw new BWError("DRIVER_ERROR", "helper spawn failed (no pid)");
  }
  let died = false;
  child.on("exit", () => {
    died = true;
  });

  const deadline = Date.now() + (o.readyTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (died) {
      throw new BWError("BROWSER_DEAD", `helper exited during startup (pid ${pid})`);
    }
    if (existsSync(readyPath) && existsSync(socketPath)) {
      let ready: HelperReady;
      try {
        ready = JSON.parse(await Bun.file(readyPath).text()) as HelperReady;
      } catch {
        await sleep(100);
        continue;
      }
      return {
        pid,
        socketPath,
        ready,
        killGroup(): void {
          if (died) return; // P2-8：已死不再发组信号
          killHelperGroup(pid); // 守卫：pid≤1 拒绝 + ps 命令核验（防复用误杀）
        },
        async alive(): Promise<boolean> {
          if (died) return false;
          try {
            process.kill(pid, 0);
          } catch {
            return false;
          }
          // 真实 RPC 探活（立即 end 的裸探针在 unix socket 上会误报——S1 实测）：
          // 走 pages 而非 info——pages 会触碰页面态，WebView host 死亡时随之失败
          const { HelperConnection } = await import("./helperClient.ts");
          const conn = new HelperConnection();
          try {
            await conn.connect(socketPath);
            await conn.call("pages");
            return true;
          } catch {
            return false;
          } finally {
            conn.close();
          }
        },
      };
    }
    await sleep(120);
  }
  // P1-5：超时必须杀进程——否则泄漏一个继续启动并常驻监听的 helper（恢复循环下放大）
  killHelperGroup(pid);
  throw new BWError("BROWSER_DEAD", `helper not ready within ${o.readyTimeoutMs ?? 20_000}ms`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
