/** bw run：CLI 单任务执行（读 .env 或环境变量配置 LLM）。B18：紧凑双行过程输出 + 轨迹默认落盘。 */

import { fileTrajectorySink, glmModelsFromEnv, runTask } from "@bw/agent";
import type { TaskEvent } from "@bw/core";
import { trajectoryDir as trajectoryDirFromCore } from "@bw/core";

export interface RunCliArgs {
  goal: string;
  startUrl?: string;
  json?: boolean;
  verbose?: boolean;
  maxSteps?: number;
  backend?: "webkit" | "chrome";
  dataDir?: string;
  chromePath?: string;
  width?: number;
  height?: number;
  ua?: string;
  /** U5：登录态快照名——任务启动前注入（cookies+localStorage 带态开局） */
  profile?: string;
}

/** 轨迹目录（B17：BW_HOME 单源——@bw/core fsx；env BW_TRAJECTORY_DIR 可改） */
export function runTrajectoryDir(): string {
  return trajectoryDirFromCore();
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const env: Record<string, string> = {};
  for (const line of (await file.text()).split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
  }
  return env;
}

// ---- B18 过程渲染器（纯函数，导出供测试） ----

const argValueOf = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
};

/** `▸ [n/max] tool k=v k=v`（超长 text 参数整段省略——防刷屏） */
export function formatToolStart(
  n: number,
  max: number,
  name: string,
  args?: Record<string, unknown>,
): string {
  const kv =
    args !== undefined
      ? Object.entries(args)
          .filter(([k]) => !(k === "text" && String(args[k]).length > 60))
          .map(([k, v]) => `${k}=${argValueOf(v)}`)
          .join(" ")
      : "";
  return `\n▸ [${n}/${max}] ${name}${kv !== "" ? ` ${kv}` : ""}`;
}

/** `  ✓ result (x.xs)` */
export function formatToolEnd(resultText?: string, ms?: number): string {
  const head = (resultText ?? "").slice(0, 100);
  const time = ms !== undefined ? ` (${(ms / 1000).toFixed(1)}s)` : "";
  return `  ✓${head !== "" ? ` ${head}` : " ok"}${time}`;
}

/** `    ↳ Title · N 元素`（与前一个动作同页则标注未变） */
export function formatPageState(
  pageState: { title: string; url: string; elements: number },
  prev?: { title: string; url: string; elements: number },
): string {
  const same =
    prev !== undefined &&
    prev.title === pageState.title &&
    prev.url === pageState.url &&
    prev.elements === pageState.elements;
  const title = pageState.title === "" ? pageState.url : pageState.title;
  return `    ↳ ${title.slice(0, 60)} · ${pageState.elements} 元素${same ? "（页面未变）" : ""}`;
}

/** token 数 → `3.1K` 形态 */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** 过程事件渲染器状态（渲染器纯函数化——步数/上页状态经显式状态对象） */
export interface ProcessRendererState {
  step: number;
  maxSteps: number;
  verbose: boolean;
  prevPage?: { title: string; url: string; elements: number };
}

export function printEvent(e: TaskEvent, st: ProcessRendererState): void {
  switch (e.type) {
    case "message_update":
      if (e.text !== undefined) process.stdout.write(e.text);
      break;
    case "confirmation_required":
      // 用户裁决 2026-09-12：保持非交互——如实告知去向与预授权途径
      console.log(
        `\n⚠ 确认门 [${e.cid}]: ${e.reason}\n  （CLI 不交互，120s 后自动拒绝；起始域可用 --url 预授权）`,
      );
      break;
    case "budget_warn":
      console.log(`\n⚠ 预算: ${e.dimension} ${e.usedPct}%`);
      break;
    case "stuck_escalated":
      console.log(`\n⚠ 卡死 — 模型升级 ${e.from} → ${e.to}`);
      break;
    case "tool_execution_start":
      st.step += 1;
      console.log(formatToolStart(st.step, st.maxSteps, e.toolName ?? "?", e.args));
      break;
    case "tool_execution_end":
      console.log(formatToolEnd(e.resultText, e.ms));
      if (e.pageState !== undefined) {
        console.log(formatPageState(e.pageState, st.prevPage));
        st.prevPage = e.pageState;
      }
      if (st.verbose && e.snapshotHead !== undefined) {
        for (const line of e.snapshotHead.split("\n")) console.log(`    │ ${line}`);
      }
      break;
    case "task_done":
      break; // 统一在 result 打印
    default:
      break;
  }
}

export async function runCliTask(args: RunCliArgs): Promise<number> {
  // key 优先级：进程 env > .env > ~/.bw/.env
  const envFiles = {
    ...(await loadEnvFile(".env")),
    ...(await loadEnvFile(`${process.env.HOME ?? ""}/.bw/.env`)),
  };
  let key = process.env.GLM_API_KEY;
  let baseUrl = process.env.GLM_BASE_URL;
  let model = process.env.GLM_MODEL;
  let strongModel = process.env.GLM_STRONG_MODEL;
  if (key === undefined) {
    key = envFiles.GLM_API_KEY;
    baseUrl = baseUrl ?? envFiles.GLM_BASE_URL;
    model = model ?? envFiles.GLM_MODEL;
    strongModel = strongModel ?? envFiles.GLM_STRONG_MODEL;
  }
  // 价目表也认 .env（B12 审查 P2-8）——runTask 读 process.env
  if (process.env.BW_PRICES_JSON === undefined && envFiles.BW_PRICES_JSON !== undefined) {
    process.env.BW_PRICES_JSON = envFiles.BW_PRICES_JSON;
  }
  if (key === undefined) {
    console.error("GLM_API_KEY not found (env, .env, or ~/.bw/.env)");
    return 2;
  }

  const models = glmModelsFromEnv({
    GLM_API_KEY: key,
    ...(baseUrl !== undefined ? { GLM_BASE_URL: baseUrl } : {}),
    ...(model !== undefined ? { GLM_MODEL: model } : {}),
    // 05 §3.3：GLM_STRONG_MODEL（env > .env）配了才有升级路径
    ...(strongModel !== undefined ? { GLM_STRONG_MODEL: strongModel } : {}),
  });

  const t0 = Date.now();

  // U5：--profile → 自建带态 driver（注入 cookies+localStorage 后交 runTask——
  // 其新建页面共享同一浏览器实例的 storage/cookie 面）
  let injectedDriver: unknown;
  if (args.profile !== undefined && args.startUrl !== undefined) {
    const { createWebViewDriver } = await import("@bw/driver");
    const { loadProfileFile, writeStorageState } = await import("./profiles.ts");
    const { createActionEngine } = await import("@bw/actions");
    const drv = createWebViewDriver({
      ...(args.backend !== undefined ? { backend: args.backend } : {}),
      ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
      ...(args.chromePath !== undefined ? { chromePath: args.chromePath } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.ua !== undefined ? { userAgent: args.ua } : {}),
    });
    const engine = createActionEngine(drv);
    await engine.act({ kind: "open_tab", url: args.startUrl });
    await writeStorageState(engine.activePage(), drv.capabilities(), loadProfileFile(args.profile));
    await engine.act({ kind: "navigate", url: args.startUrl });
    injectedDriver = drv;
  }

  const handle = runTask(
    {
      goal: args.goal,
      ...(args.startUrl !== undefined ? { startUrl: args.startUrl } : {}),
      ...(args.maxSteps !== undefined ? { budget: { maxSteps: args.maxSteps } } : {}),
      ...(injectedDriver === undefined &&
      (args.backend !== undefined ||
        args.dataDir !== undefined ||
        args.chromePath !== undefined ||
        args.width !== undefined ||
        args.height !== undefined ||
        args.ua !== undefined)
        ? {
            driver: {
              ...(args.backend !== undefined ? { backend: args.backend } : {}),
              ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
              ...(args.chromePath !== undefined ? { chromePath: args.chromePath } : {}),
              ...(args.width !== undefined ? { width: args.width } : {}),
              ...(args.height !== undefined ? { height: args.height } : {}),
              ...(args.ua !== undefined ? { userAgent: args.ua } : {}),
            },
          }
        : {}),
    },
    {
      ...(injectedDriver !== undefined ? { driver: injectedDriver as never } : {}),
      models: {
        fast: models.fast as never,
        ...(models.strong !== undefined ? { strong: models.strong as never } : {}),
      },
      apiKey: key,
      // B18：轨迹默认落盘（与 serve 同目录；bw replay 可回放）
      trajectory: (taskId) => fileTrajectorySink(runTrajectoryDir(), taskId),
      ...(args.startUrl?.startsWith("http://127.0.0.1") === true ? { testMode: true } : {}),
    },
  );

  // G4/B21（审计）：SIGINT/SIGTERM → abort → **等 finalize（轨迹终态落盘）** → 按结果退出；
  // 二次信号立即强退 130（旧实现裸杀 → 轨迹缺终态行）。
  let signaled = 0;
  const onSignal = (): void => {
    signaled += 1;
    if (signaled >= 2) {
      process.exit(130);
    }
    void handle.abort("interrupted");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (args.json !== true) {
      const st: ProcessRendererState = {
        step: 0,
        maxSteps: args.maxSteps ?? 50,
        verbose: args.verbose === true,
      };
      for await (const e of handle.events) {
        printEvent(e, st);
        if (e.type === "task_done") break;
      }
    }
    const result = await handle.result(); // abort 后这里拿到终态（finalize 已落轨迹）
    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `\n── result: ${result.status}${result.answer !== undefined ? ` — ${result.answer}` : ""}`,
      );
      console.log(
        `   steps=${result.steps} · tokens ${fmtTokens(result.tokens.input)}/${fmtTokens(result.tokens.output)} · ${wall}s · trajectory=${result.trajectory}`,
      );
    }
    return result.status === "done" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
