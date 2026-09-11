/** bw run：CLI 单任务执行（读 .env 或环境变量配置 LLM） */
import { glmModelsFromEnv, runTask } from "@bw/agent";
import type { TaskEvent } from "@bw/core";

export interface RunCliArgs {
  goal: string;
  startUrl?: string;
  json?: boolean;
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

  const handle = runTask(
    { goal: args.goal, ...(args.startUrl !== undefined ? { startUrl: args.startUrl } : {}) },
    {
      models: {
        fast: models.fast as never,
        ...(models.strong !== undefined ? { strong: models.strong as never } : {}),
      },
      apiKey: key,
      ...(args.startUrl?.startsWith("http://127.0.0.1") === true ? { testMode: true } : {}),
    },
  );

  if (args.json !== true) {
    for await (const e of handle.events) {
      printEvent(e);
      if (e.type === "task_done") break;
    }
  }
  const result = await handle.result();
  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `\n── result: ${result.status}${result.answer !== undefined ? ` — ${result.answer}` : ""}`,
    );
    console.log(
      `   steps=${result.steps} tokens(in/out)=${result.tokens.input}/${result.tokens.output} trajectory=${result.trajectory}`,
    );
  }
  return result.status === "done" ? 0 : 1;
}

function printEvent(e: TaskEvent): void {
  switch (e.type) {
    case "message_update":
      if (e.text !== undefined) process.stdout.write(e.text);
      break;
    case "confirmation_required":
      console.log(`\n⚠ confirmation required [${e.cid}]: ${e.reason}`);
      break;
    case "budget_warn":
      console.log(`\n⚠ budget: ${e.dimension} at ${e.usedPct}%`);
      break;
    case "stuck_escalated":
      console.log(`\n⚠ stuck — escalating ${e.from} → ${e.to}`);
      break;
    case "tool_execution_start":
      console.log(`\n▸ ${e.toolName}`);
      break;
    case "task_done":
      break; // 统一在 result 打印
    default:
      break;
  }
}
