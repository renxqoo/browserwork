import { mapCliCommand } from "./cli-commands.ts";
/**
 * bw s —— 外部 agent 会话 CLI（连接 bw serve 实例）。
 * 命令即工具名，位置参数即工具参数；统一 JSON 输出（ok/error/code/hint）。
 *
 * 用法（agent 视角）：
 *   bw s create --url https://bun.com        → {"ok":true,"sessionId":"sess-xxx",...}
 *   bw s snap sess-xxx                       → {"ok":true,"snapshot":"# Page: ..."}
 *   bw s click sess-xxx 5                    → {"ok":true,"result":"clicked [5]","snapshot":"..."}
 *   bw s type sess-xxx 3 "hello"            → {"ok":true,...}
 *   bw s navigate sess-xxx "https://..."     → {"ok":true,...}
 *   bw s scroll sess-xxx down                → {"ok":true,...}
 *   bw s press sess-xxx Enter               → {"ok":true,...}
 *   bw s extract sess-xxx                    → {"ok":true,"text":"page content"}
 *   bw s look sess-xxx [--out shot.png]      → {"ok":true,"path":"shot.png"}
 *   bw s select sess-xxx 4 "b"              → {"ok":true,...}
 *   bw s scrollto sess-xxx 12               → {"ok":true,...}
 *   bw s wait sess-xxx 2                    → {"ok":true,...}
 *   bw s tabs sess-xxx                       → {"ok":true,"tabs":[...]}
 *   bw s opentab sess-xxx "https://..."      → {"ok":true,...}
 *   bw s switchtab sess-xxx 0               → {"ok":true,...}
 *   bw s closetab sess-xxx                   → {"ok":true,...}
 *   bw s confirm sess-xxx cid --yes          → {"ok":true}
 *   bw s close sess-xxx                      → {"ok":true}
 *   bw s list                                → {"ok":true,"sessions":[...]}
 *   bw s console sess-xxx                    → {"ok":true,"result":"[{t,level,text}...]"}
 *   bw s errors sess-xxx                     → {"ok":true,"result":"[...error entries]"}
 *   bw s cookies sess-xxx                    → {"ok":true,"result":"a=1; b=2"}
 *   bw s cookies-set sess-xxx a 1            → {"ok":true,...}
 *   bw s storage sess-xxx [key]              → {"ok":true,"result":"{...}"}
 *   bw s eval sess-xxx "1+1"                 → {"ok":true,"result":"2"}（create --allow-eval）
 */

export interface SessionCliConfig {
  /** bw serve 地址（默认 http://127.0.0.1:3456；env BW_SERVER_URL） */
  serverUrl: string;
  /** Bearer token（env BW_TOKEN） */
  token?: string;
}

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

async function api(
  cfg: SessionCliConfig,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${cfg.serverUrl}${path}`, {
      method,
      headers: {
        ...(cfg.token !== undefined ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ConnectionRefused") || msg.includes("Unable to connect")) {
      console.error(
        JSON.stringify({
          ok: false,
          code: "SERVER_NOT_RUNNING",
          error: `bw serve is not running on ${cfg.serverUrl}`,
          hint: "run 'bw s stop' then retry (daemon will auto-start), or start manually: bw serve",
        }),
      );
      process.exit(1);
    }
    throw e;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export async function runSessionCli(argv: string[]): Promise<number> {
  const token = process.env.BW_TOKEN;
  const [cmd, ...rest] = argv;

  // stop 命令不需要服务
  if (cmd === "stop") {
    const { stopServer } = await import("./daemon.ts");
    const stopped = await stopServer();
    ok({ result: stopped ? "server stopped" : "no server running" });
  }

  // 其余命令需要服务——自动拉起后台守护
  const { ensureServer } = await import("./daemon.ts");
  const daemon = await ensureServer(token);
  const cfg: SessionCliConfig = {
    serverUrl: daemon.url,
    ...(daemon.token !== undefined ? { token: daemon.token } : {}),
  };

  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(`bw s — session-based browser tools for external agents

Server auto-starts on first use. Use 'bw s stop' to shut it down.

Usage:
  bw s create [--url <url>] [--allow-eval]  create session, returns sessionId
  bw s list                              list active sessions
  bw s snap <id>                         get current snapshot
  bw s extract <id>                      extract page text
  bw s look <id> [--out <file>]          screenshot (saves to file or /tmp)
  bw s click <id> <index>                click element
  bw s type <id> <index> <text>          type text into input
  bw s navigate <id> <url>               navigate to URL
  bw s press <id> <key>                  press key (Enter/Tab/Escape...)
  bw s scroll <id> <dir> [amount]        scroll up/down/left/right
  bw s scrollto <id> <index>             scroll to element
  bw s select <id> <index> <value>       select dropdown option
  bw s wait <id> <seconds> [networkIdle]  wait (networkIdle=chrome 网络静默)
  bw s batch <id> '<json steps>'         run a typed action sequence (B20)
  bw s keep <id>                         mark session kept (TTL exempt)
  bw s rename <id> <name>                rename session
  bw s opentab <id> <url>                open new tab
  bw s switchtab <id> <n>                switch tab
  bw s closetab <id>                     close current tab
  bw s tabs <id>                         list tabs (index + url + title)
  bw s console <id>                      page console messages (new since last call)
  bw s errors <id>                       page errors (onerror/unhandledrejection)
  bw s cookies <id>                      get cookies (document.cookie; httpOnly invisible)
  bw s cookies-set <id> <name> <value>   set cookie (path=/, SameSite=Lax)
  bw s cookies-clear <id>                clear visible cookies
  bw s storage <id> [key]                localStorage all or by key
  bw s storage-set <id> <key> <value>    set localStorage entry
  bw s storage-clear <id>                clear localStorage
  bw s eval <id> <js-expression>         run JS (requires create --allow-eval)
  bw s resize <id> <w> <h>               set viewport size
  bw s reload <id>                       reload current page
  bw s download <id> <index>             click a download link, save file (chrome only)
  bw s upload <id> <index> <file>...     upload files to a file input (chrome only)
  bw s requests <id>                     recent network requests (chrome only)
  bw s cookies-all <id>                  all cookie metadata incl httpOnly (chrome only)
  create also accepts: --backend <webkit|chrome> --data-dir <dir> --chrome-path <p>
                       --width <n> --height <n> --ua <user-agent>
  bw s confirm <id> <cid> --yes|--no     approve/deny confirmation
  bw s close <id>                        close session
  bw s stop                              stop background server

Env:
  BW_SERVER_URL  use remote server (skip auto-start)
  BW_TOKEN       bearer token`);
    return 0;
  }

  // ---- create
  if (cmd === "create") {
    const flagValue = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i !== -1 ? rest[i + 1] : undefined;
    };
    const startUrl = flagValue("--url");
    const allowEval = rest.includes("--allow-eval");
    // B13：生产档 S4 生效——本地/内网地址需显式放行
    const allowPrivate = rest.includes("--allow-private-network");
    // B14：驱动构造透传
    const name = flagValue("--name");
    const backend = flagValue("--backend");
    const dataDir = flagValue("--data-dir");
    const chromePath = flagValue("--chrome-path");
    const width = flagValue("--width");
    const height = flagValue("--height");
    const ua = flagValue("--ua");
    const { status, data } = await api(cfg, "POST", "/sessions", {
      ...(startUrl !== undefined ? { startUrl } : {}),
      ...(allowEval ? { allowEval: true } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(allowPrivate ? { allowPrivateNetwork: true } : {}),
      ...(backend !== undefined ? { backend: backend as "webkit" | "chrome" } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(chromePath !== undefined ? { chromePath } : {}),
      ...(width !== undefined ? { width: Number(width) } : {}),
      ...(height !== undefined ? { height: Number(height) } : {}),
      ...(ua !== undefined ? { userAgent: ua } : {}),
    });
    if (status === 201) {
      const p: Record<string, unknown> = { sessionId: String(data.id) };
      if (data.url !== undefined) p.result = String(data.url);
      ok(p);
    }
    fail(
      undefined,
      "CREATE_FAILED",
      String(data.error ?? "failed to create session"),
      `is bw serve running on ${daemon.url}?`,
    );
  }

  // ---- list
  if (cmd === "list") {
    const { status, data } = await api(cfg, "GET", "/sessions");
    if (status === 200) {
      ok({ sessions: Array.isArray(data) ? data : [data] });
    }
    fail(undefined, "LIST_FAILED", String(data.error ?? "failed"));
  }

  // ---- 以下命令都需要 sessionId
  const sessionId = rest[0];
  if (sessionId === undefined) {
    fail(undefined, "MISSING_SESSION", "session ID required", "run 'bw s create' first");
  }
  const args = rest.slice(1);

  // ---- snap
  if (cmd === "snap") {
    const { status, data } = await api(cfg, "GET", `/sessions/${sessionId}/snapshot`);
    if (status === 200) {
      ok({ sessionId, snapshot: String(data.snapshot) });
    }
    fail(sessionId, "NOT_FOUND", String(data.error ?? "session not found"));
  }

  // ---- B20 §9.5：keep / rename
  if (cmd === "keep") {
    const { status, data } = await api(cfg, "POST", `/sessions/${sessionId}/keep`, {});
    if (status === 200) ok({ sessionId, result: "session kept (TTL exempt)" });
    fail(sessionId, "KEEP_FAILED", String(data.error ?? "failed"));
  }
  if (cmd === "rename") {
    const name = args[0];
    if (name === undefined) fail(sessionId, "INVALID_ARGS", "usage: bw s rename <id> <name>");
    const { status, data } = await api(cfg, "POST", `/sessions/${sessionId}/rename`, { name });
    if (status === 200) ok({ sessionId, result: `renamed to ${name}` });
    fail(sessionId, "RENAME_FAILED", String(data.error ?? "failed"));
  }

  // ---- close
  if (cmd === "close") {
    const { status, data } = await api(cfg, "DELETE", `/sessions/${sessionId}`);
    if (status === 200) {
      ok({ sessionId });
    }
    fail(sessionId, "CLOSE_FAILED", String(data.error ?? "failed"));
  }

  // ---- confirm
  if (cmd === "confirm") {
    const cid = args[0];
    if (cid === undefined) fail(sessionId, "MISSING_CID", "confirmation ID required");
    const approve = args.includes("--yes") || args.includes("-y");
    const { status, data } = await api(cfg, "POST", `/sessions/${sessionId}/confirmations/${cid}`, {
      approve,
    });
    if (status === 200) {
      ok({ sessionId, cid: cid as string });
    }
    fail(sessionId, "CONFIRM_FAILED", String(data.error ?? "failed"));
  }

  // ---- look（截图）
  if (cmd === "look") {
    const outIdx = args.indexOf("--out");
    const filePath: string =
      (outIdx !== -1 ? args[outIdx + 1] : undefined) ?? `/tmp/bw-shot-${Date.now()}.png`;
    const { status, data } = await api(cfg, "POST", `/sessions/${sessionId}/tools/look`, {});
    if (status === 200 && data.ok === true) {
      const image = data.image as { base64: string } | undefined;
      if (image !== undefined) {
        await Bun.write(filePath, Buffer.from(image.base64, "base64"));
        ok({ sessionId, path: filePath as string });
      }
      ok({ sessionId, result: "screenshot taken (no image data)" });
    }
    const code = data.code !== undefined ? String(data.code) : "LOOK_FAILED";
    const error = data.error !== undefined ? String(data.error) : "failed";
    const hint =
      code === "POLICY_BLOCKED" ? "secret was typed on this page — screenshot blocked" : undefined;
    fail(sessionId, code, error, hint);
  }

  // ---- 其余工具（统一走 /tools/:toolName）
  const mapped = mapCliCommand(cmd, args);
  if ("error" in mapped) {
    fail(sessionId, "INVALID_ARGS", mapped.error);
  }

  // 映射层单源于 cli-commands.ts——B22 S0
  const { status, data } = await api(
    cfg,
    "POST",
    `/sessions/${sessionId}/tools/${mapped.tool}`,
    mapped.params,
  );

  if (status === 200 && data.ok === true) {
    ok({
      sessionId,
      tool: cmd,
      ...(data.text !== undefined ? { result: data.text as string } : {}),
      ...(data.snapshot !== undefined && data.snapshot !== ""
        ? { snapshot: data.snapshot as string }
        : {}),
    });
  }

  // 202 = confirmation_required
  if (status === 202) {
    ok({
      sessionId,
      tool: cmd,
      cid: data.cid as string,
      reason: data.reason as string,
      result: `CONFIRMATION_REQUIRED: ${data.reason}`,
    });
  }

  // 错误
  const code = data.code !== undefined ? String(data.code) : `TOOL_FAILED`;
  const error = data.error !== undefined ? String(data.error) : `tool ${cmd} failed`;
  const hints: Record<string, string> = {
    ELEMENT_NOT_FOUND:
      "run 'bw s snap <id>' to get the latest snapshot (ids change after each action)",
    ELEMENT_NOT_ACTIONABLE: "element may be hidden — try 'bw s scrollto <id> <index>' first",
    POLICY_BLOCKED: "blocked by security policy — check allowed origins",
    CONFIRMATION_DENIED: "confirmation was denied or timed out",
    INVALID_TOOL_ARGS: "check argument order — run 'bw s --help'",
    DRIVER_ERROR: "session may have expired — run 'bw s list' to check",
    EVAL_DISABLED: "re-create the session with: bw s create --url <url> --allow-eval",
    TIMEOUT: "page JS may be stuck in a loop — navigate again or close the session",
  };
  const hint = hints[code];
  fail(sessionId, code, error, hint);
}
