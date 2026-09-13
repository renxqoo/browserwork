/**
 * B22 S3：bw s——外部 agent 模式 CLI，直连 SessionStore（文件会话）。
 * 行为规格：audit-service §4.4（输出单行 JSON / 错误码目录 / wire 名映射 / 参数映射）；
 * 已裁决变更：snap 未知 id → NOT_FOUND exit 1（B3）；confirm 即执行带 result（§4b）；
 * stop 退役文案（U1）；extract_code/type_text_secret 补齐（B21 文档超前）；help 零副作用（B16）。
 * 每命令一进程：store 实例随命令生灭。
 */
import { BWError, resolveBwHome } from "@bw/core";
import { mapCliCommand } from "./cli-commands.ts";
import type { SessionStore } from "./store.ts";
import { createSessionStore } from "./store.ts";

function out(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

function fail(sessionId: string | undefined, code: string, error: string, hint?: string): never {
  const payload: Record<string, unknown> = { ok: false, code, error };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  if (hint !== undefined) payload.hint = hint;
  out(payload);
  process.exit(1);
}

function ok(data: Record<string, unknown>): void {
  out({ ok: true, ...data });
  process.exit(0);
}

const store = (): SessionStore =>
  createSessionStore({
    bwHome: resolveBwHome(),
    policyMode: process.env.BW_POLICY_MODE === "test" ? "test" : "production",
  });

/** BWError → CLI 错误码 + hint 目录（§4.4-26 透传面） */
const HINTS: Record<string, string> = {
  ELEMENT_NOT_FOUND: "page changed since last snapshot — run 'bw s snap <id>' for fresh ids",
  ELEMENT_NOT_ACTIONABLE: "element hidden/off-screen — run 'bw s scrollto <id> <index>' first",
  SESSION_BUSY: "another command holds this session — retry after it finishes",
  SESSION_LIMIT: "close or gc sessions first (bw s close / bw s gc)",
  BROWSER_DEAD: "browser endpoint dead — retry (auto-recovers) or run 'bw s gc'",
  NOT_FOUND: "no such session — run 'bw s list'",
  EVAL_DISABLED: "re-create with --allow-eval",
  TIMEOUT: "page JS busy — navigate or close",
};

function failFromBwError(sessionId: string | undefined, e: BWError): never {
  return fail(sessionId, e.code, e.message, HINTS[e.code]);
}

/** flag 解析（create/look 用；其余命令位置参数为主） */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

const HELP = `bw s — session-based browser tools for external agents

Sessions live in ~/.bw/session/<id>/ (file-based; no daemon). Use 'bw s list' to see them.

Usage:
  bw s create [--url U] [--name N] [--profile P] [--backend webkit|chrome] [--data-dir D]
              [--chrome-path P] [--ua U] [--width W] [--height H] [--allow-eval] [--allow-private-network]
  bw s list | gc | stop(retired)
  bw s snap <id> | status <id> | close <id> | keep <id> | rename <id> <name>
  bw s confirm <id> <cid> --yes | --no
  bw s look <id> [--out F]
  bw s extract <id> | extract_code <id> '<fn>'
  bw s click/type/type-secret/press/navigate/scroll/scrollto/select/wait/batch <id> <args…>
  bw s opentab/switchtab/closetab/tabs/console/errors/requests <id> …
  bw s cookies/cookies-set/cookies-clear/cookies-all/storage/storage-set/storage-clear/eval/resize/reload <id> …
  bw s download/upload <id> … (chrome only)`;

export async function runSessionCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const sessionId = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : undefined;
  const args = sessionId !== undefined ? rest.slice(1) : rest;

  // help 零副作用（B16——旧实现先 ensureServer 再打印帮助）。
  // 子命令也认（实测踩坑：bw s create --help 曾被当无名参数误建会话——create 自家
  // --help 已处理，这里兜其余子命令）
  const wantsHelp =
    cmd === undefined ||
    cmd === "--help" ||
    cmd === "-h" ||
    (cmd !== "create" && (rest.includes("--help") || rest.includes("-h")));
  if (wantsHelp) {
    console.log(
      cmd !== undefined && cmd !== "--help" && cmd !== "-h" && cmd !== "create"
        ? `${HELP}\n(子命令 ${cmd} 的参数见上表；create --help 看全部 flag)`
        : HELP,
    );
    return 0;
  }

  // ---- 无会话命令 ----
  if (cmd === "stop") {
    ok({ result: "no daemon in this version — sessions live in ~/.bw/session/ (bw s list)" });
  }
  if (cmd === "list") {
    const s = store();
    ok({
      sessions: s.list().map((i) => ({
        sessionId: i.id,
        ...(i.name !== undefined ? { name: i.name } : {}),
        createdAt: i.createdAt,
        lastActiveAt: i.lastActiveAt,
        keep: i.keep,
        url: i.url,
        steps: i.steps,
        alive: i.alive,
      })),
    });
  }
  if (cmd === "gc") {
    const { reaped, orphans } = store().gc();
    ok({
      result: `reaped ${reaped.length} session(s), swept ${orphans} orphan process(es)`,
      reaped,
      orphans,
    });
  }

  // ---- create（无 sessionId 位置参数，独立解析） ----
  if (cmd === "create") {
    return await runSessionCreate(rest);
  }

  if (sessionId === undefined) {
    fail(undefined, "MISSING_SESSION", "session ID required", "run 'bw s create' first");
  }

  // ---- 会话级命令 ----
  if (cmd === "close") {
    store().close(sessionId);
    ok({ sessionId });
  }
  if (cmd === "keep") {
    if (!store().keep(sessionId, true)) {
      fail(sessionId, "NOT_FOUND", `session not found: ${sessionId}`);
    }
    ok({ sessionId, result: "session kept (TTL exempt)" });
  }
  if (cmd === "rename") {
    const newName = args[0];
    if (newName === undefined) {
      fail(sessionId, "INVALID_ARGS", "usage: bw s rename <sessionId> <name>");
    }
    if (!store().rename(sessionId, newName)) {
      fail(sessionId, "NOT_FOUND", `session not found: ${sessionId}`);
    }
    ok({ sessionId, result: `renamed to ${newName.slice(0, 80)}` });
  }
  if (cmd === "status") {
    try {
      const rec = store().get(sessionId);
      ok({
        sessionId,
        status: rec.status,
        alive: rec.helper.pid > 0,
        url: rec.currentUrl,
        steps: rec.budget.steps,
        backend: rec.backend,
      });
    } catch (e) {
      if (e instanceof BWError) failFromBwError(sessionId, e);
      throw e;
    }
  }
  if (cmd === "snap") {
    try {
      // B3 裁决：未知 id → NOT_FOUND exit 1（旧实现 ok+空串静默成功）
      const snapshot = await store().snapshot(sessionId);
      ok({ sessionId, snapshot });
    } catch (e) {
      if (e instanceof BWError) failFromBwError(sessionId, e);
      throw e;
    }
  }
  if (cmd === "confirm") {
    if (args.length < 1) {
      fail(sessionId, "MISSING_CID", "usage: bw s confirm <sessionId> <cid> --yes | --no");
    }
    try {
      const cidArg = args[0];
      if (cidArg === undefined) {
        fail(sessionId, "MISSING_CID", "usage: bw s confirm <sessionId> <cid> --yes | --no");
      }
      const approve = hasFlag(args, "yes") || hasFlag(args, "y");
      const r = await store().confirm(sessionId, cidArg, approve);
      if (!r.ok) {
        fail(sessionId, r.code ?? "CONFIRM_FAILED", r.error ?? "confirm failed");
      }
      // §4b：确认即执行——superset（旧 {ok,sessionId,cid} + result/snapshot）
      ok({
        sessionId,
        cid: cidArg,
        ...(r.text !== undefined ? { result: r.text } : {}),
        ...(r.snapshot !== undefined && r.snapshot !== "" ? { snapshot: r.snapshot } : {}),
      });
    } catch (e) {
      if (e instanceof BWError) failFromBwError(sessionId, e);
      throw e;
    }
  }
  if (cmd === "look") {
    try {
      const r = await store().executeTool(sessionId, "look", {});
      const outPath = flagValue(args, "out") ?? `/tmp/bw-shot-${Date.now()}.png`;
      if (r.ok && r.image !== undefined) {
        await Bun.write(outPath, Buffer.from(r.image.base64, "base64"));
        // text 带「截图瞬间页面 url+title」——被风控弹走时一眼判断截没截到目标页
        ok({ sessionId, path: outPath, page: r.text ?? undefined });
      }
      ok({ sessionId, result: "screenshot taken (no image data)" });
    } catch (e) {
      if (e instanceof BWError) {
        const hint =
          e.code === "POLICY_BLOCKED"
            ? "secret was typed on this page — screenshot blocked"
            : HINTS[e.code];
        fail(sessionId, e.code, e.message, hint);
      }
      throw e;
    }
  }

  // ---- 工具命令（wire 名归一 + store.executeTool；extract_code/type-secret 补齐） ----
  const mapped = mapCliCommand(cmd, args);
  if ("error" in mapped) {
    fail(sessionId, "INVALID_ARGS", mapped.error);
  }
  // eval --file：文件内容作为表达式（shell 引号搅局 CJK/单引号的稳定通道）
  const params = { ...mapped.params };
  const exprFile = params.expressionFile as string | undefined;
  if (exprFile !== undefined) {
    const f = Bun.file(exprFile);
    if (!(await f.exists())) {
      fail(sessionId, "INVALID_ARGS", `eval file not found: ${exprFile}`);
    }
    params.expression = await f.text();
    delete params.expressionFile;
  }
  try {
    const r = await store().executeTool(sessionId, mapped.tool, params);
    if (!r.ok) {
      fail(sessionId, r.code ?? "TOOL_FAILED", r.error ?? "tool failed", HINTS[r.code ?? ""]);
    }
    ok({
      sessionId,
      tool: cmd,
      ...(r.text !== undefined ? { result: r.text } : {}),
      ...(r.snapshot !== undefined && r.snapshot !== "" ? { snapshot: r.snapshot } : {}),
      ...(r.unchanged !== undefined ? { unchanged: r.unchanged } : {}),
      ...(r.page !== undefined ? { page: r.page } : {}),
      ...(r.cid !== undefined && r.reason !== undefined ? { cid: r.cid, reason: r.reason } : {}),
    });
  } catch (e) {
    if (e instanceof BWError) failFromBwError(sessionId, e);
    throw e;
  }
  return 0; // 不可达——ok/fail 均 process.exit
}

/** create 入口（cli 分发用） */
export async function runSessionCreate(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    // B16 同型：help 零副作用（实测踩坑：--help 曾被当无名参数误建会话）
    console.log(
      [
        "bw s create — 建文件会话",
        "",
        "  --url U                 起始页（免确认入白名单）",
        "  --name N                会话名（≤80 字）",
        "  --profile P             登录态快照注入（bw auth import-chrome / bw auth save 建）",
        "  --backend webkit|chrome 渲染后端（默认 webkit；chrome 支持下载/上传/整页截图）",
        "  --data-dir D            持久存储目录（cookies/localStorage）",
        "  --chrome-path PATH      Chrome 可执行文件路径",
        "  --width W / --height H  视口尺寸",
        "  --ua U                  UA 覆写（仅 chrome）",
        "  --allow-eval            开启 eval（默认禁）",
        "  --allow-private-network 放行内网/本地地址",
      ].join("\n"),
    );
    return 0;
  }
  const url = flagValue(argv, "url") ?? flagValue(argv, "u");
  const name = flagValue(argv, "name");
  const backend = flagValue(argv, "backend") as "webkit" | "chrome" | undefined;
  const dataDir = flagValue(argv, "data-dir");
  const chromePath = flagValue(argv, "chrome-path");
  const width = flagValue(argv, "width");
  const height = flagValue(argv, "height");
  const ua = flagValue(argv, "ua");
  try {
    const r = await store().create({
      ...(url !== undefined ? { url } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(backend !== undefined ? { backend } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(chromePath !== undefined ? { chromePath } : {}),
      ...(width !== undefined ? { width: Number(width) } : {}),
      ...(height !== undefined ? { height: Number(height) } : {}),
      ...(ua !== undefined ? { ua } : {}),
      allowEval: hasFlag(argv, "allow-eval"),
      allowPrivateNetwork: hasFlag(argv, "allow-private-network"),
      ...(flagValue(argv, "profile") !== undefined
        ? { profile: flagValue(argv, "profile") as string }
        : {}),
    });
    if (r.confirmed) {
      ok({ sessionId: r.id, ...(r.result !== undefined ? { result: r.result } : {}) });
    }
    // create 起始导航确认（§4c）：exit 0 + cid（与工具确认一致）
    if (!r.confirmed) {
      ok({
        sessionId: r.id,
        cid: r.cid,
        reason: r.reason,
        result: `CONFIRMATION_REQUIRED: ${r.reason}`,
      });
    }
    return 0; // 不可达
  } catch (e) {
    if (e instanceof BWError) {
      const hint =
        e.code === "POLICY_BLOCKED" && e.message.includes("S4")
          ? "local/private address — re-create with --allow-private-network (S4)"
          : HINTS[e.code];
      fail(undefined, e.code, e.message, hint);
    }
    throw e;
  }
}
