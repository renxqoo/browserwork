/**
 * p14a：统一 helper 模型实证（B22 设计分叉的核心裁决）。
 * 验证四件事：
 *  1) detached helper 持 WebView + unix socket RPC：父进程退出后 helper 仍活
 *  2) 跨进程状态连续：进程 A navigate + 设 DOM 态 → 全新进程 B 经同一 socket
 *     evaluate 能读到（活 DOM 态不丢——这是「Chrome attach 不可 re-attach 目标」的替代解）
 *  3) webkit 与 chrome 两种后端同构可行（chrome 走 pipe 无端口）
 *  4) SIGKILL helper 后进程组清理：kill(-pid) 能带走 webkit host / chrome 子进程
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const SOCK = "/tmp/p14a.sock";
const OUT = (m: string) => console.log(m);

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    pass++;
    OUT(`  ✓ ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    OUT(`  ✗ ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  }
};

/** 起一个 detached helper（独立进程组），返回 pid */
function startHelper(backend: "webkit" | "chrome"): number {
  rmSync(SOCK, { force: true });
  rmSync(`${SOCK}.ready`, { force: true });
  const child = spawn(
    process.execPath,
    [new URL("./p14a-helper.ts", import.meta.url).pathname, SOCK, backend],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return child.pid ?? 0;
}

async function waitReady(deadlineMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (existsSync(`${SOCK}.ready`) && existsSync(SOCK)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 单次 RPC 客户端（新进程里执行——验证跨进程连续性） */
const CLIENT_SRC = `
const sock = process.argv[2];
const reqs = JSON.parse(process.argv[3]);
const state = { buf: "" };
const socket = await Bun.connect({
  unix: sock,
  socket: {
    data(s, chunk) {
      state.buf += new TextDecoder().decode(chunk);
      let nl;
      while ((nl = state.buf.indexOf("\\n")) >= 0) {
        const line = state.buf.slice(0, nl);
        state.buf = state.buf.slice(nl + 1);
        if (line.trim() === "") continue;
        const msg = JSON.parse(line);
        if (msg.id === reqs.length) {
          console.log(JSON.stringify(msg));
          s.end();
          process.exit(0);
        }
      }
    },
  },
});
reqs.forEach((r, i) => socket.write(JSON.stringify({ ...r, id: i + 1 }) + "\\n"));
// 30s 兜底超时（防挂死探针本身）
setTimeout(() => { console.error("client timeout"); process.exit(3); }, 30_000);
`;

async function rpcFromNewProcess(reqs: { method: string; params?: unknown }[]): Promise<unknown> {
  const tmp = `/tmp/p14a-client-${Date.now()}.ts`;
  await Bun.write(tmp, CLIENT_SRC);
  const proc = spawn(process.execPath, [tmp, SOCK, JSON.stringify(reqs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  const code = await new Promise<number>((r) => proc.on("exit", r));
  rmSync(tmp, { force: true });
  if (code !== 0) throw new Error(`client exited ${code}`);
  return JSON.parse(out.trim());
}

const processGroupAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const listBwProcs = (): string => {
  const r = spawn("/bin/sh", ["-c", "ps -axo pid,pgid,command | grep -E 'p14a-helper|bun-webview|Google Chrome' | grep -v grep | head -8 || true"], { stdio: ["ignore", "pipe", "inherit"] });
  return "（见异步检查）";
};
export { listBwProcs };

async function runBackend(backend: "webkit" | "chrome"): Promise<void> {
  OUT(`\n== p14a ${backend} ==`);
  const pid = startHelper(backend);
  check("helper 就绪（socket + ready）", await waitReady(), `pid=${pid}`);

  // 进程 1：导航 + 设置 DOM 态
  const page =
    backend === "chrome"
      ? "data:text/html,<input id=q value=''><script>document.title='p14a-chrome'</script>"
      : "data:text/html,<input id=q value=''><script>document.title='p14a-webkit'</script>";
  const nav = (await rpcFromNewProcess([{ method: "navigate", params: { url: page } }])) as {
    ok: boolean;
    result?: string;
  };
  check("进程1 navigate", nav.ok === true, String(nav.result ?? nav).slice(0, 60));
  const set = await rpcFromNewProcess([
    {
      method: "eval",
      params: {
        expr:
          "(() => { document.getElementById('q').value = 'typed-by-proc-1'; return document.title })()",
      },
    },
  ]);
  check("进程1 设置 DOM 态", (set as { ok: boolean }).ok === true);

  // 进程 2（全新进程）：读回同一页面的 DOM 态 —— 跨进程连续性
  const got = await rpcFromNewProcess([
    { method: "eval", params: { expr: "document.getElementById('q').value + '|' + document.title" } },
  ]);
  const g = got as { ok: boolean; result?: string };
  check(
    "进程2 读回活 DOM 态（跨进程连续）",
    g.ok === true && g.result === "typed-by-proc-1|" + (backend === "chrome" ? "p14a-chrome" : "p14a-webkit"),
    JSON.stringify(g.result),
  );

  // 父进程（本探针）不持有 helper——检查 helper 还活着（detach 生效）
  check("helper 仍活（父进程退出无关）", processGroupAlive(pid));

  // 进程组清理：SIGKILL 整组后 webkit host / chrome 子进程必须消失
  try {
    process.kill(-pid, 0); // 组存在
  } catch {
    /* mac 上进程组 kill 探测可能不可用——不判死活，只做 kill */
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1_500));
  check("helper 已死（组 kill 生效）", !processGroupAlive(pid));
  const leftover = spawn("/bin/sh", [
    "-c",
    `ps -axo pid,command | grep -F '${SOCK}' | grep -v grep | wc -l | tr -d ' '`,
  ]);
  let n = "";
  leftover.stdout.on("data", (c) => (n += c));
  await new Promise((r) => leftover.on("exit", r));
  check("无 helper 残留进程", n.trim() === "0", `residual=${n.trim()}`);
  // chrome 子进程（backend=chrome 时 helper 的子）：按 pgid 查
  const chromeLeft = spawn("/bin/sh", [
    "-c",
    `ps -axo pgid,command | awk -v p=${pid} '$1 == p' | wc -l | tr -d ' '`,
  ]);
  let cn = "";
  chromeLeft.stdout.on("data", (c) => (cn += c));
  await new Promise((r) => chromeLeft.on("exit", r));
  if (backend === "chrome") check("chrome 子进程被组 kill 带走", cn.trim() === "0", `residual=${cn.trim()}`);
  rmSync(SOCK, { force: true });
  rmSync(`${SOCK}.ready`, { force: true });
}

await runBackend("webkit");
await runBackend("chrome");
OUT(`\np14a 结论: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
