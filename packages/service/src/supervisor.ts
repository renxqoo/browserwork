/**
 * 最小 supervisor（B17 §3.10，用户裁决）：spawn N × bw serve（独立 dataDir/端口/
 * token）+ 监控重启。不处理：请求路由/负载均衡/租户计量——宿主按端口自选。
 * 语义：子进程退出码非 0 或信号 → 指数退避重启（1s/2s/5s 封顶 30s）；exit 0 =
 * 预期停止不重启；/healthz 每 10s 轮询、连续 3 失败 → kill+重启。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** 等 healthz 就绪（CLI sup start 与测试共用；url 无路径时自动补 /healthz） */
export async function waitForHealthUrl(url: string, timeoutMs: number): Promise<boolean> {
  const pathname = new URL(url).pathname;
  const target = pathname === "" || pathname === "/" ? `${url.replace(/\/$/, "")}/healthz` : url;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return true;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export interface SupervisorConfig {
  /** 实例数（1-16，默认 2） */
  instances?: number;
  /** 起始端口（默认 3460；实例 i 用 portBase+i） */
  portBase?: number;
  /** 数据根（默认 ~/.bw/sup）——每实例 <root>/<i>/{profile,trajectories} */
  dataRoot?: string;
  /** CLI 产物路径（默认 dist/cli/cli.js） */
  cliPath?: string;
  /** bun 可执行（默认 bun） */
  bunBin?: string;
  /** 测试注入：spawn 替身 + 时钟加速 */
  spawnFn?: (cmd: string, args: string[], env: Record<string, string>) => FakeChild;
  now?: () => number;
}

/** 测试替身协议（与 ChildProcess 最小面同构） */
export interface FakeChild {
  pid: number;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

export interface SupInstance {
  index: number;
  port: number;
  pid: number;
  token: string;
  url: string;
}

export interface Supervisor {
  start(): Promise<SupInstance[]>;
  status(): SupInstance[];
  stopAll(): Promise<void>;
  /** 单实例立即重启（监控等价入口） */
  restart(i: number): Promise<void>;
}

const MAX_INSTANCES = 16;
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_FAILS = 3;
const BACKOFF_S = [1, 2, 5];

interface ManagedInstance {
  index: number;
  port: number;
  token: string;
  child: FakeChild;
  restarts: number;
  healthFails: number;
  stopping: boolean;
}

/** 单实例健康探测：连续 HEALTH_FAILS 失败 → onRestart（导出供测试注入 fetchFn） */
export async function probeInstance(
  m: { port: number; healthFails: number; stopping: boolean },
  onRestart: () => void,
  fetchFn: (url: string) => Promise<{ status: number }> = (u) =>
    fetch(u, { signal: AbortSignal.timeout(2000) }),
): Promise<void> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${m.port}/healthz`);
    if (res.status === 200) {
      m.healthFails = 0;
      return;
    }
    m.healthFails += 1;
  } catch {
    m.healthFails += 1;
  }
  if (m.healthFails >= HEALTH_FAILS && !m.stopping) {
    m.healthFails = 0;
    onRestart();
  }
}

export class SupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupError";
  }
}

export function supervisorStateDir(dataRoot?: string): string {
  return dataRoot ?? join(process.env.BW_HOME ?? process.env.HOME ?? "/tmp", ".bw", "sup");
}

export function createSupervisor(config?: SupervisorConfig): Supervisor {
  const n = config?.instances ?? 2;
  if (!Number.isInteger(n) || n < 1 || n > MAX_INSTANCES) {
    throw new SupError(`instances must be 1-${MAX_INSTANCES}`);
  }
  const portBase = config?.portBase ?? 3460;
  const root = supervisorStateDir(config?.dataRoot);
  const cliPath = config?.cliPath ?? "dist/cli/cli.js";
  const bunBin = config?.bunBin ?? "bun";
  const spawnFn =
    config?.spawnFn ??
    ((cmd: string, args: string[], env: Record<string, string>): FakeChild => {
      const cp: ChildProcess = spawn(cmd, args, {
        env: { ...process.env, ...env },
        stdio: "ignore",
        detached: false,
      });
      return {
        pid: cp.pid ?? -1,
        exited: new Promise((resolve) => {
          cp.on("exit", (code, signal) => resolve({ code, signal }));
        }),
        kill: () => cp.kill("SIGTERM"),
      };
    });
  const now = config?.now ?? Date.now;

  const instances = new Map<number, ManagedInstance>();
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let lockHeld = false;

  const stateFile = (): string => join(root, "state.json");
  const writeState = (): void => {
    mkdirSync(root, { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    const payload = [...instances.values()].map((m) => ({
      index: m.index,
      port: m.port,
      pid: m.child.pid,
      token: m.token,
    }));
    writeFileSync(tmp, JSON.stringify({ startedAt: now(), instances: payload }, null, 2), {
      mode: 0o600,
    });
    renameSync(tmp, stateFile()); // 原子写（审查 P2-21）
  };
  const readState = (): { instances?: SupInstance[] } | undefined => {
    try {
      return JSON.parse(readFileSync(stateFile(), "utf8")) as { instances?: SupInstance[] };
    } catch {
      return undefined;
    }
  };

  const spawnInstance = async (i: number): Promise<ManagedInstance> => {
    const port = portBase + i;
    const dir = join(root, String(i));
    const token = crypto.randomUUID();
    mkdirSync(join(dir, "profile"), { recursive: true });
    mkdirSync(join(dir, "trajectories"), { recursive: true });
    const child = spawnFn(
      bunBin,
      [
        cliPath,
        "serve",
        "--port",
        String(port),
        "--backend",
        "chrome",
        "--data-dir",
        join(dir, "profile"),
        "--trajectory-dir",
        join(dir, "trajectories"),
      ],
      {
        BW_TOKEN: token,
        BW_DOWNLOADS_DIR: join(dir, "downloads"),
      },
    );
    // 子进程退出监控：非 0/信号 → 退避重启；exit 0 = 预期停止
    void child.exited.then(({ code, signal }) => {
      const m = instances.get(i);
      if (m === undefined || m.stopping) return;
      if (code === 0 && signal === null) return;
      const backoff = BACKOFF_S[Math.min(m.restarts, BACKOFF_S.length - 1)];
      const delay = (backoff ?? 5) * 1000;
      m.restarts += 1;
      setTimeout(() => {
        void superviseRestart(i);
      }, delay);
    });
    return {
      index: i,
      port,
      token,
      child,
      restarts: 0,
      healthFails: 0,
      stopping: false,
    };
  };

  const superviseRestart = async (i: number): Promise<void> => {
    const old = instances.get(i);
    if (old === undefined) return;
    try {
      old.child.kill();
    } catch {
      /* 已死 */
    }
    instances.delete(i);
    const m = await spawnInstance(i);
    m.restarts = old.restarts;
    instances.set(i, m);
    writeState();
  };

  return {
    async start(): Promise<SupInstance[]> {
      if (lockHeld) {
        throw new SupError("another supervisor is running (lock held)");
      }
      mkdirSync(root, { recursive: true });
      const lock = join(root, "sup.lock");
      if (existsSync(lock)) {
        throw new SupError("supervisor lock exists — run 'bw sup stop' first");
      }
      writeFileSync(lock, String(process.pid), { flag: "wx" }); // O_EXCL（审查 P2-21）
      lockHeld = true;

      for (let i = 0; i < n; i++) {
        const m = await spawnInstance(i);
        instances.set(i, m);
      }
      writeState();
      // 健康轮询：连续 3 失败 → 重启（探针逻辑抽 probeInstance——可测）
      healthTimer = setInterval(() => {
        for (const [, m] of instances) {
          void probeInstance(m, () => superviseRestart(m.index));
        }
      }, HEALTH_INTERVAL_MS);
      if (typeof healthTimer.unref === "function") healthTimer.unref();

      const out: SupInstance[] = [];
      for (const [, m] of instances) {
        out.push({
          index: m.index,
          port: m.port,
          pid: m.child.pid,
          token: m.token,
          url: `http://127.0.0.1:${m.port}`,
        });
      }
      return out;
    },

    status(): SupInstance[] {
      const state = readState();
      return state?.instances ?? [];
    },

    async restart(i: number): Promise<void> {
      if (!instances.has(i)) {
        throw new SupError(`instance ${i} not managed by this supervisor`);
      }
      await superviseRestart(i);
    },

    async stopAll(): Promise<void> {
      if (healthTimer !== undefined) clearInterval(healthTimer);
      healthTimer = undefined;
      for (const [, m] of instances) {
        m.stopping = true;
        try {
          m.child.kill();
        } catch {
          /* 已死 */
        }
      }
      instances.clear();
      try {
        unlinkSync(join(root, "sup.lock"));
      } catch {
        /* 无锁 */
      }
      lockHeld = false;
      try {
        rmSync(stateFile(), { force: true });
      } catch {
        /* 尽力 */
      }
    },
  };
}

export function readSupervisorState(dataRoot?: string): SupInstance[] {
  return createSupervisor({ ...(dataRoot !== undefined ? { dataRoot } : {}) }).status();
}

/** CLI 子命令实现（可测；cli.ts 只做薄接线） */
export async function runSupCommand(
  argv: string[],
  deps: {
    createSupervisor: typeof createSupervisor;
    waitForHealthUrl: typeof waitForHealthUrl;
    kill?: (pid: number, sig: NodeJS.Signals) => void;
    exit?: (code: number) => void;
    log?: (s: string) => void;
    err?: (s: string) => void;
    /** 测试注入：常驻等待替身（缺省 = 永悬 promise） */
    dwell?: () => Promise<never>;
  },
): Promise<number> {
  const sub = argv[1];
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const log = deps.log ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const dataRoot = flag("--data-root");
  if (sub === "start") {
    const instances = Number(flag("--instances") ?? "2");
    let list: SupInstance[];
    try {
      const sup = deps.createSupervisor({
        instances,
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
      list = await sup.start();
    } catch (e) {
      if (e instanceof SupError) {
        err(`sup: ${e.message}`);
        return 1;
      }
      throw e;
    }
    for (const inst of list) {
      const healthy = await deps.waitForHealthUrl(inst.url, 30_000);
      if (!healthy) err(`warning: instance ${inst.index} healthz not ready in 30s`);
    }
    log(JSON.stringify({ ok: true, instances: list }, null, 2));
    // 常驻（生产永不返回；测试替身可返回——显式 return 防落穿 usage 兜底）
    await (deps.dwell ?? (() => new Promise<never>(() => {})))();
    return 0;
  }
  if (sub === "status") {
    log(JSON.stringify({ ok: true, instances: readSupervisorState(dataRoot) }, null, 2));
    return 0;
  }
  if (sub === "stop") {
    const state = readSupervisorState(dataRoot);
    let stopped = 0;
    for (const inst of state) {
      try {
        kill(inst.pid, "SIGTERM");
        stopped += 1;
      } catch {
        /* 已死 */
      }
    }
    try {
      (await import("node:fs")).unlinkSync(join(supervisorStateDir(dataRoot), "sup.lock"));
    } catch {
      /* 无锁 */
    }
    log(JSON.stringify({ ok: true, stopped }));
    return 0;
  }
  err("usage: bw sup start [--instances N] [--data-root DIR] | status | stop");
  return 2;
}
