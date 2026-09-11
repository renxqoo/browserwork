/**
 * 薄 MCP stdio client（B16 §3.9，审查 P22：对打用——不是 MCP server，不违用户裁决）。
 * JSON-RPC over stdio：initialize → tools/list → tools/call。
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpClientOptions {
  /** 启动命令（如 bunx @playwright/mcp@latest --headless） */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 启动+握手超时 ms（默认 60s——bunx 首次要下载） */
  startupTimeoutMs?: number;
  /** call 超时 ms（默认 120s） */
  callTimeoutMs?: number;
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpStdioClient {
  #proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRpc>();
  #buffer = "";
  #started = false;
  readonly #opts: Required<Pick<McpClientOptions, "startupTimeoutMs" | "callTimeoutMs">> &
    McpClientOptions;

  constructor(opts: McpClientOptions) {
    this.#opts = {
      ...opts,
      startupTimeoutMs: opts.startupTimeoutMs ?? 60_000,
      callTimeoutMs: opts.callTimeoutMs ?? 120_000,
    };
  }

  #send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      if (this.#proc === null) {
        reject(new Error(`MCP ${method}: client stopped`));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#proc?.stdin.write(`${msg}\n`);
    });
  }

  /** 通知（无 id 无响应） */
  #notify(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.#proc?.stdin.write(`${msg}\n`);
  }

  #onLine(line: string): void {
    if (line.trim() === "") return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // server 的非 JSON 输出（日志等）
    }
    if (msg.id === undefined) return; // 通知/事件——本装置不消费
    const p = this.#pending.get(msg.id);
    if (p === undefined) return;
    clearTimeout(p.timer);
    this.#pending.delete(msg.id);
    if (msg.error !== undefined) {
      p.reject(new Error(msg.error.message ?? "MCP error"));
    } else {
      p.resolve(msg.result);
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#proc = Bun.spawn([this.#opts.command, ...(this.#opts.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...(this.#opts.env ?? {}) },
    });
    const pump = async (): Promise<void> => {
      const reader = (this.#proc?.stdout as ReadableStream<Uint8Array> | null)?.getReader();
      if (reader === null || reader === undefined) return;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#buffer += decoder.decode(value, { stream: true });
        let nl = this.#buffer.indexOf("\n");
        while (nl !== -1) {
          this.#onLine(this.#buffer.slice(0, nl));
          this.#buffer = this.#buffer.slice(nl + 1);
          nl = this.#buffer.indexOf("\n");
        }
      }
    };
    void pump().catch(() => {});
    const init = await this.#send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bw-eval", version: "0.1.0" },
      },
      this.#opts.startupTimeoutMs,
    );
    void init;
    this.#notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDef[]> {
    const r = (await this.#send("tools/list", {}, this.#opts.callTimeoutMs)) as {
      tools?: McpToolDef[];
    };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = (await this.#send(
      "tools/call",
      { name, arguments: args },
      this.#opts.callTimeoutMs,
    )) as McpCallResult;
    return r ?? { content: [], isError: true };
  }

  stop(): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client stopped"));
    }
    this.#pending.clear();
    try {
      this.#proc?.stdin.end();
    } catch {
      /* 已关 */
    }
    this.#proc?.kill();
    this.#proc = null;
  }
}

/** 假 MCP server 脚本源（测试装置：按剧本回 tools/list 与 tools/call） */
export function fakeServerScript(tools: McpToolDef[]): string {
  return `
const TOOLS = ${JSON.stringify(tools)};
let buf = "";
const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1); nl = buf.indexOf("\\n");
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    } else if (msg.method === "tools/list") {
      write({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + msg.params.name }] } });
    }
  }
});
`;
}
