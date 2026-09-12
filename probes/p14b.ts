/**
 * p14b：dataStore 跨进程持久化（登录态/profile 快照的可行性底座）。
 * 验证：进程 A 用 dataStore 目录写入 cookie（普通 + httpOnly）与 localStorage →
 * 进程 B（全新进程）用同一目录能读到。httpOnly 经本地 HTTP 服务回显 Cookie 头验证。
 * 两种后端各跑一遍。
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  }
};

/** 本地 HTTP：/set 设普通+httpOnly cookie；/get 回显收到的 Cookie 头；/ 反射页 */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/set") {
      return new Response("<html><body>cookies set</body></html>", {
        headers: [
          ["set-cookie", "plain_cookie=visible; Path=/"],
          ["set-cookie", "http_cookie=hidden; Path=/; HttpOnly"],
        ],
      });
    }
    if (url.pathname === "/get") {
      return new Response(req.headers.get("cookie") ?? "(none)", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("<html><body>hi</body></html>");
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

/** 子进程脚本：读 dataStore 目录里的 cookie/localStorage（写模式=write） */
const CHILD_SRC = `
const mode = process.argv[2]; // write | read
const dir = process.argv[3];
const origin = process.argv[4];
const view = new Bun.WebView({ backend: process.argv[5], dataStore: { directory: dir } });
if (mode === "write") {
  await view.navigate(origin + "/set");
  await view.evaluate("(() => { localStorage.setItem('p14b_ls', 'persisted'); return 1 })()");
  await new Promise(r => setTimeout(r, Number(process.env.P14B_DWELL ?? 0)));
  // chrome 实证：localStorage 按导航事件提交（dwell 无效）——导航离开强制提交再关
  await view.navigate("about:blank");
  view.close();
  console.log("written");
} else {
  await view.navigate(origin + "/set"); // 先导航同源再 fetch（data: 页面无源）
  const header = await view.evaluate("fetch('/get').then(r => r.text())");
  const ls = await view.evaluate("localStorage.getItem('p14b_ls')");
  view.close();
  console.log(JSON.stringify({ header, ls }));
}
process.exit(0);
`;

async function child(mode: "write" | "read", dir: string, backend: string): Promise<string> {
  const tmp = `/tmp/p14b-child-${Date.now()}.ts`;
  await Bun.write(tmp, CHILD_SRC);
  const proc = spawn(process.execPath, [tmp, mode, dir, ORIGIN, backend], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  const code = await new Promise<number>((r) => proc.on("exit", r));
  rmSync(tmp, { force: true });
  if (code !== 0) throw new Error(`child ${mode} exited ${code}`);
  return out.trim();
}

async function run(backend: "webkit" | "chrome"): Promise<void> {
  console.log(`\n== p14b ${backend} ==`);
  const dir = `/tmp/p14b-store-${backend}`;
  rmSync(dir, { recursive: true, force: true });
  const w = await child("write", dir, backend);
  check("进程A 写入完成", w === "written", w);
  const r = await child("read", dir, backend);
  let parsed: { header: string; ls: string | null } = { header: "", ls: null };
  try {
    parsed = JSON.parse(r);
  } catch {
    check("进程B 输出可解析", false, r.slice(0, 120));
    return;
  }
  check(
    "进程B 普通cookie 跨进程持久",
    parsed.header.includes("plain_cookie=visible"),
    parsed.header,
  );
  check(
    "进程B httpOnly cookie 跨进程持久",
    parsed.header.includes("http_cookie=hidden"),
    parsed.header,
  );
  check("进程B localStorage 跨进程持久", parsed.ls === "persisted", JSON.stringify(parsed.ls));
  rmSync(dir, { recursive: true, force: true });
}

await run("webkit");
await run("chrome");
server.stop(true);
console.log(`\np14b 结论: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
