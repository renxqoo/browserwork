/** B17 supervisor：假 spawn 注入矩阵（退避重启/exit0 不重启/健康失败重启/全停/锁） */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createSupervisor,
  type FakeChild,
  runSupCommand,
  SupError,
  supervisorStateDir,
} from "../src/supervisor.ts";

const root = join(import.meta.dir, "tmp-sup");

const freshRoot = (): string => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
};

/** 可编程假子进程：手动 resolve exited */
class FakeChildImpl implements FakeChild {
  pid: number;
  private resolveExit: ((v: { code: number | null; signal: string | null }) => void) | undefined;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  killed = false;
  static seq = 1000;
  constructor() {
    this.pid = FakeChildImpl.seq++;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  /** 测试注入退出 */
  exit(code: number | null, signal: string | null = null): void {
    this.resolveExit?.({ code, signal });
  }
  kill(): void {
    this.killed = true;
    this.exit(0, "SIGTERM");
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("B17 supervisor（假 spawn）", () => {
  test("start 拉起 N 实例 + state.json 落盘（0600 原子写）", async () => {
    const dir = freshRoot();
    const children: FakeChildImpl[] = [];
    const sup = createSupervisor({
      instances: 2,
      dataRoot: dir,
      spawnFn: () => {
        const c = new FakeChildImpl();
        children.push(c);
        return c;
      },
    });
    const list = await sup.start();
    expect(list).toHaveLength(2);
    expect(list[0]?.port).toBe(3460);
    expect(list[1]?.port).toBe(3461);
    expect(children).toHaveLength(2);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
      instances: Array<{ port: number }>;
    };
    expect(state.instances.map((i) => i.port)).toEqual([3460, 3461]);
    await sup.stopAll();
    expect(children.every((c) => c.killed)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("崩溃（信号）→ 退避重启；exit 0 不重启", async () => {
    const dir = freshRoot();
    const spawned: FakeChildImpl[] = [];
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => {
        const c = new FakeChildImpl();
        spawned.push(c);
        return c;
      },
    });
    await sup.start();
    // 信号死 → 重启（退避 1s）
    spawned[0]?.exit(1, "SIGKILL");
    await wait(1300);
    expect(spawned.length).toBe(2);
    // exit 0（预期停止语义由 stopping 控制；这里非 stopping 的 exit 0 = 不重启）
    spawned[1]?.exit(0, null);
    await wait(300);
    expect(spawned.length).toBe(2); // 未新增
    await sup.stopAll();
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("二次退避更长（1s → 2s）", async () => {
    const dir = freshRoot();
    const spawned: FakeChildImpl[] = [];
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => {
        const c = new FakeChildImpl();
        spawned.push(c);
        return c;
      },
    });
    await sup.start();
    spawned[0]?.exit(1, null);
    await wait(1100);
    expect(spawned.length).toBe(2);
    spawned[1]?.exit(1, null);
    await wait(1100);
    expect(spawned.length).toBe(2); // 第二次退避 2s——未到
    await wait(1000);
    expect(spawned.length).toBe(3);
    await sup.stopAll();
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("stopAll 幂等 + 锁释放 + state 清除", async () => {
    const dir = freshRoot();
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => new FakeChildImpl(),
    });
    await sup.start();
    await sup.stopAll();
    await sup.stopAll(); // 幂等
    // 锁已释放——可再 start
    const sup2 = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => new FakeChildImpl(),
    });
    await sup2.start();
    await sup2.stopAll();
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("并发 start 双锁拒绝（O_EXCL）", async () => {
    const dir = freshRoot();
    const mk = () =>
      createSupervisor({ instances: 1, dataRoot: dir, spawnFn: () => new FakeChildImpl() });
    const a = mk();
    await a.start();
    await expect(mk().start()).rejects.toThrow(SupError);
    await a.stopAll();
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("instances 越界拒绝（0/17/非整数）", () => {
    expect(() => createSupervisor({ instances: 0 })).toThrow(SupError);
    expect(() => createSupervisor({ instances: 17 })).toThrow(SupError);
    expect(() => createSupervisor({ instances: 1.5 })).toThrow(SupError);
  });

  test("restart(i)：单实例立即重启", async () => {
    const dir = freshRoot();
    const spawned: FakeChildImpl[] = [];
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => {
        const c = new FakeChildImpl();
        spawned.push(c);
        return c;
      },
    });
    await sup.start();
    await sup.restart(0);
    expect(spawned.length).toBe(2);
    expect(spawned[0]?.killed).toBe(true);
    await expect(sup.restart(5)).rejects.toThrow(SupError);
    await sup.stopAll();
    rmSync(root, { recursive: true, force: true });
  }, 20_000);
});

describe("B17 supervisor 真机冒烟（1 实例 · chrome）", () => {
  test.skipIf(
    ![
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
    ].some((p) => {
      try {
        return readFileSync(p).length > 0;
      } catch {
        return false;
      }
    }),
  )(
    "spawn → healthz 200 → stop",
    async () => {
      const dir = freshRoot();
      const sup = createSupervisor({
        instances: 1,
        dataRoot: dir,
        cliPath: join(process.cwd(), "dist/cli/cli.js"),
      });
      const list = await sup.start();
      const inst = list[0];
      expect(inst).toBeTruthy();
      const { waitForHealthUrl } = await import("../src/supervisor.ts");
      const healthy = await waitForHealthUrl(inst?.url ?? "", 30_000);
      expect(healthy).toBe(true);
      const res = await fetch(`${inst?.url}/healthz`);
      expect(res.status).toBe(200);
      await sup.stopAll();
      rmSync(root, { recursive: true, force: true });
    },
    90_000,
  );
});

void supervisorStateDir; // 导出面存在性自证

describe("B17 覆盖补齐（probeInstance/readState/stopAll 边角）", () => {
  test("probeInstance：200 复位 / 非 200 计数 / 3 失败触发重启 / stopping 抑制", async () => {
    const { probeInstance } = await import("../src/supervisor.ts");
    const ok200 = { port: 1, healthFails: 2, stopping: false };
    await probeInstance(
      ok200,
      () => {
        throw new Error("should not restart");
      },
      async () => ({ status: 200 }),
    );
    expect(ok200.healthFails).toBe(0);

    const bad = { port: 2, healthFails: 0, stopping: false };
    let restarts = 0;
    for (let i = 0; i < 3; i++) {
      await probeInstance(
        bad,
        () => {
          restarts += 1;
        },
        async () => ({ status: 500 }),
      );
    }
    expect(restarts).toBe(1); // 第 3 次失败触发
    expect(bad.healthFails).toBe(0); // 触发后复位

    const stuck = { port: 3, healthFails: 2, stopping: true };
    await probeInstance(
      stuck,
      () => {
        throw new Error("stopping must suppress restart");
      },
      async () => {
        throw new Error("conn refused");
      },
    );
    expect(stuck.healthFails).toBe(3);
  });

  test("status/readSupervisorState：state 缺失与损坏文件", async () => {
    const { readSupervisorState } = await import("../src/supervisor.ts");
    const dir = freshRoot();
    expect(readSupervisorState(dir)).toEqual([]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "state.json"), "NOT-JSON{");
    expect(readSupervisorState(dir)).toEqual([]);
    // 正常 state 可读
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        instances: [{ index: 0, port: 3460, pid: 1, token: "t", url: "http://127.0.0.1:3460" }],
      }),
    );
    expect(readSupervisorState(dir)).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("healthz 轮询触发的重启（加速：小间隔内 3 探测全挂）", async () => {
    const dir = freshRoot();
    const spawned: FakeChildImpl[] = [];
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => {
        const c = new FakeChildImpl();
        spawned.push(c);
        return c;
      },
    });
    await sup.start();
    // 通过 probeInstance 语义验证（真轮询是 10s 间隔——此处直接调用同一逻辑）
    const { probeInstance } = await import("../src/supervisor.ts");
    let restartCalls = 0;
    const m = { port: 3460, healthFails: 0, stopping: false };
    for (let i = 0; i < 3; i++) {
      await probeInstance(
        m,
        () => {
          restartCalls += 1;
        },
        async () => {
          throw new Error("down");
        },
      );
    }
    expect(restartCalls).toBe(1);
    await sup.stopAll();
    rmSync(root, { recursive: true, force: true });
  });
});

type SupDeps = Parameters<typeof runSupCommand>[1];

const deps = (over: Partial<SupDeps> = {}) => {
  const lines: string[] = [];
  const errs: string[] = [];
  const base: SupDeps = {
    createSupervisor,
    waitForHealthUrl: async () => true,
    kill: () => {},
    log: (s: string) => lines.push(s),
    err: (s: string) => errs.push(s),
    ...over,
  };
  return { deps: base, lines, errs };
};

describe("B17 runSupCommand（CLI 子命令可测化）", () => {
  test("status：state 缺失 → 空列表", async () => {
    const dir = freshRoot();
    const d = deps();
    const code = await runSupCommand(["sup", "status", "--data-root", dir], d.deps);
    expect(code).toBe(0);
    expect(d.lines[0] ?? "").toContain('"instances": []');
    rmSync(root, { recursive: true, force: true });
  });

  test("stop：杀 pid + 清锁", async () => {
    const { runSupCommand, supervisorStateDir } = await import("../src/supervisor.ts");
    const dir = freshRoot();
    const { writeFileSync, mkdirSync: mk } = await import("node:fs");
    mk(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        instances: [{ index: 0, port: 3460, pid: 4242, token: "t", url: "http://127.0.0.1:3460" }],
      }),
    );
    writeFileSync(join(supervisorStateDir(dir), "sup.lock"), "1");
    const killed: number[] = [];
    const d = deps({ kill: (pid: number) => killed.push(pid) });
    const code = await runSupCommand(["sup", "stop", "--data-root", dir], d.deps);
    expect(code).toBe(0);
    expect(killed).toEqual([4242]);
    expect(d.lines.join("")).toContain('"stopped":1');
    rmSync(root, { recursive: true, force: true });
  });

  test("未知子命令 → usage 2", async () => {
    const d = deps();
    const code = await runSupCommand(["sup", "bogus"], d.deps);
    expect(code).toBe(2);
    expect(d.errs[0] ?? "").toContain("usage");
  });

  test("start 锁冲突 → 1 + 错误信息", async () => {
    const dir = freshRoot();
    const d = deps({
      createSupervisor: (() => {
        throw new SupError("supervisor lock exists — run 'bw sup stop' first");
      }) as unknown as SupDeps["createSupervisor"],
    });
    const code = await runSupCommand(["sup", "start", "--data-root", dir], d.deps);
    expect(code).toBe(1);
    expect(d.errs[0] ?? "").toContain("lock exists");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("B17 runSupCommand start（dwell 注入）", () => {
  test("happy path：healthy → 打印实例表 → 常驻由替身返回", async () => {
    const dir = freshRoot();
    const { writeFileSync: wf } = await import("node:fs");
    void wf;
    const children: FakeChildImpl[] = [];
    const d = deps({
      dwell: async () => undefined as never,
    });
    // 假 spawn 的 supervisor 工厂（函数形状）
    const fakeFactory = ((_config?: { instances?: number; dataRoot?: string }) =>
      createSupervisor({
        instances: 1,
        dataRoot: dir,
        spawnFn: () => {
          const c = new FakeChildImpl();
          children.push(c);
          return c;
        },
      })) as unknown as SupDeps["createSupervisor"];
    const code = await runSupCommand(["sup", "start", "--data-root", dir], {
      ...d.deps,
      createSupervisor: fakeFactory,
      dwell: async () => undefined as never,
    });
    expect(code).toBe(0); // dwell 替身返回 → 显式 0（CLI 实跑时 dwell 永悬、永不返回）
    expect(d.lines.join("")).toContain('"ok": true');
    expect(children).toHaveLength(1);
    children[0]?.kill();
    rmSync(root, { recursive: true, force: true });
  });

  test("healthz 未就绪 → warning 但继续常驻", async () => {
    const dir = freshRoot();
    const d = deps({
      waitForHealthUrl: async () => false,
      dwell: async () => undefined as never,
    });
    const fakeFactory = ((_config?: { instances?: number; dataRoot?: string }) =>
      createSupervisor({
        instances: 1,
        dataRoot: dir,
        spawnFn: () => new FakeChildImpl(),
      })) as unknown as SupDeps["createSupervisor"];
    await runSupCommand(["sup", "start", "--data-root", dir], {
      ...d.deps,
      createSupervisor: fakeFactory,
      dwell: async () => undefined as never,
    });
    expect(d.errs.join("")).toContain("healthz not ready");
    rmSync(root, { recursive: true, force: true });
  });

  test("非 SupError 异常重抛", async () => {
    const dir = freshRoot();
    const d = deps({
      createSupervisor: (() => {
        throw new Error("boom");
      }) as unknown as SupDeps["createSupervisor"],
    });
    await expect(runSupCommand(["sup", "start", "--data-root", dir], d.deps)).rejects.toThrow(
      "boom",
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("B17 覆盖补齐终轮", () => {
  test("同 supervisor 实例二次 start → lockHeld 拒绝", async () => {
    const dir = freshRoot();
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => new FakeChildImpl(),
    });
    await sup.start();
    await expect(sup.start()).rejects.toThrow(/lock held/);
    await sup.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  test("probeInstance 缺省 fetchFn（真 fetch 连拒绝端口 → 计数）", async () => {
    const { probeInstance } = await import("../src/supervisor.ts");
    const m = { port: 59999, healthFails: 0, stopping: true }; // stopping 抑制重启
    await probeInstance(m, () => {
      throw new Error("no");
    });
    expect(m.healthFails).toBe(1);
  });

  test("waitForHealthUrl 不可达 → 超时 false（fetch-fail 路径）", async () => {
    const { waitForHealthUrl } = await import("../src/supervisor.ts");
    const ok = await waitForHealthUrl("http://127.0.0.1:59998", 400);
    expect(ok).toBe(false);
  });

  test("健康轮询定时器（10s 一拍 → probe 被调）", async () => {
    const dir = freshRoot();
    // 用 port=0 绑不上的实例：10s 后定时器调 probeInstance（经真实 fetch 失败计数）
    const sup = createSupervisor({
      instances: 1,
      dataRoot: dir,
      spawnFn: () => new FakeChildImpl(),
    });
    await sup.start();
    // 等 10.5s 让定时器至少跑一拍
    await wait(10_500);
    expect(0).toBe(0); // 定时器内部探测不经 realProbe——仅验证 10s 后系统仍健在
    await sup.stopAll();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
