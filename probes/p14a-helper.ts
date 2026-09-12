/**
 * p14a helper 端：detached 进程持 WebView + unix socket RPC。
 * 用法: bun probes/p14a-helper.ts <socketPath> <webkit|chrome> [dataDir]
 * 协议: 换行分隔 JSON —— {id, method, params} → {id, ok, result|error}
 * method: navigate{url} / eval{expr} / shutdown
 * 退出条件: shutdown 或 SIGTERM（先 close 视图再退）
 */
import { spawn } from "node:child_process";

const [, , sockPath, backendArg, dataDir] = process.argv;
if (!sockPath || !backendArg) {
  console.error("usage: p14a-helper.ts <socketPath> <webkit|chrome> [dataDir]");
  process.exit(2);
}
const backend = backendArg as "webkit" | "chrome";

const view = new Bun.WebView({
  backend,
  width: 1280,
  height: 720,
  ...(dataDir ? { dataStore: { directory: dataDir } } : {}),
});

// 单连接即可（探针）；请求串行处理（与引擎页锁同语义）
let buf = "";
const conns: ReturnType<typeof Bun.connect>[] = [];

Bun.listen({
  unix: sockPath,
  socket: {
    data(socket, chunk) {
      buf += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue;
        void handle(socket, JSON.parse(line));
      }
    },
    close() {},
  },
});

async function handle(socket: Bun.Socket, req: { id: number; method: string; params?: unknown }) {
  const reply = (payload: unknown) => socket.write(`${JSON.stringify(payload)}\n`);
  try {
    if (req.method === "navigate") {
      await view.navigate((req.params as { url: string }).url);
      reply({ id: req.id, ok: true, result: view.url });
    } else if (req.method === "eval") {
      const r = await view.evaluate((req.params as { expr: string }).expr);
      reply({ id: req.id, ok: true, result: r });
    } else if (req.method === "shutdown") {
      reply({ id: req.id, ok: true, result: "bye" });
      setTimeout(() => {
        view.close();
        Bun.WebView.closeAll();
        process.exit(0);
      }, 50);
    } else {
      reply({ id: req.id, ok: false, error: `unknown method ${req.method}` });
    }
  } catch (e) {
    reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

process.on("SIGTERM", () => {
  view.close();
  Bun.WebView.closeAll();
  process.exit(0);
});

// 就绪信号：socket 文件由 listen 创建；写 ready 文件让父进程轮询
const { writeFileSync } = await import("node:fs");
writeFileSync(`${sockPath}.ready`, String(process.pid));

// 活跃定时器：WebView 空闲时事件循环不保活（bun 文档语义），显式保持
setInterval(() => {}, 60_000);
export { spawn, conns };
