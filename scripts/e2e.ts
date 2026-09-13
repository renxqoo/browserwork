/**
 * B22 S6：e2e 双形态进程冒烟（repo-migration-e2e-v2 §8）。
 * 源码形态（bun packages/service/src/cli.ts）与构建产物形态（dist/cli/cli.js）
 * 各起真实进程走全链：create → snap → click → confirm → close；未知 id NOT_FOUND；
 * kill helper → 自动恢复。数据自清（隔离 BW_HOME）。退出码非 0 即失败。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..");
const REPO_CLI = join(ROOT, "packages/service/src/cli.ts");
const DIST_CLI = join(ROOT, "dist/cli/cli.js");

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

/** 起一个 CLI 进程，返回 {code, stdout}（stdout 尾行按 JSON 解析） */
const runCli = (cli: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string; json: Record<string, unknown> | null }>((resolve) => {
    const child = spawn(BUN, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => {
      const lines = out
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"));
      let json: Record<string, unknown> | null = null;
      if (lines.length > 0) {
        try {
          json = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
        } catch {
          json = null;
        }
      }
      resolve({ code: code ?? -1, out, json });
    });
  });

const fixture = Bun.serve({
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/x1") {
      return new Response("<!doctype html><title>X1</title><h1>Page X1</h1>", {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(
      `<!doctype html><title>Home</title><input id="q"><button id="go" onclick="document.getElementById('out').textContent='clicked ' + document.getElementById('q').value">Go</button><p id="out">idle</p>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const origin = `http://127.0.0.1:${fixture.port}`;

async function journey(label: string, cli: string): Promise<void> {
  console.log(`\n== e2e ${label} ==`);
  const home = mkdtempSync(join(tmpdir(), `bw-e2e-${label}-`));
  const env = { BW_HOME: home, BW_POLICY_MODE: "test" };
  try {
    // create → snap
    const created = await runCli(cli, ["s", "create", "--url", origin], env);
    check("create ok exit 0", created.code === 0, created.out.slice(0, 80));
    const sid = (created.json?.sessionId as string | undefined) ?? "";
    check("返回 sessionId", sid.startsWith("sess-"), sid);

    const snap = await runCli(cli, ["s", "snap", sid], env);
    const snapText = String(snap.json?.snapshot ?? snap.out);
    check("snap 含标题", snap.code === 0 && snapText.includes("Home"), `${snapText.length}B`);
    const idx = /\[(\d+)\] input/.exec(snapText)?.[1];
    const btn = /\[(\d+)\] button "Go"/.exec(snapText)?.[1];
    check("快照含可交互索引", idx !== undefined && btn !== undefined, `input=${idx} btn=${btn}`);

    // 工具：type + click + extract
    if (idx !== undefined && btn !== undefined) {
      const typed = await runCli(cli, ["s", "type", sid, idx, "e2e"], env);
      check("type ok", typed.code === 0);
      const clicked = await runCli(cli, ["s", "click", sid, btn], env);
      check("click ok", clicked.code === 0);
      const text = await runCli(cli, ["s", "extract", sid], env);
      check(
        "extract 见点击效果",
        text.code === 0 && text.out.includes("clicked e2e"),
        text.out.slice(0, 60),
      );
    }

    // 未知 id → NOT_FOUND exit 1（B3 裁决）
    const ghost = await runCli(cli, ["s", "snap", "sess-nonexistent"], env);
    check(
      "未知 id → NOT_FOUND exit 1",
      ghost.code === 1 && ghost.json?.code === "NOT_FOUND",
      JSON.stringify(ghost.json ?? {}).slice(0, 60),
    );

    // 确认门：navigate 同源子路径免闸；跨源走 cid（用 /x1 → about 页面新域难造——
    // 用 navigate 到 http://localhost:同端口 不同 host 制造新域）
    const cross = `http://localhost:${fixture.port}/x1`;
    const nav = await runCli(cli, ["s", "navigate", sid, cross], env);
    check(
      "新域 navigate → cid（非阻塞）",
      nav.code === 0 && typeof nav.json?.cid === "string",
      String(nav.json?.result ?? "").slice(0, 50),
    );
    if (typeof nav.json?.cid === "string") {
      const confirmed = await runCli(
        cli,
        ["s", "confirm", sid, String(nav.json.cid), "--yes"],
        env,
      );
      check(
        "confirm 即执行",
        confirmed.code === 0,
        String(confirmed.json?.result ?? "").slice(0, 50),
      );
    }

    // close + list 空
    const closed = await runCli(cli, ["s", "close", sid], env);
    check("close ok", closed.code === 0);
    const list = await runCli(cli, ["s", "list"], env);
    check("close 后 list 空", list.code === 0 && !list.out.includes(sid));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// 恢复旅程（源码形态足够——store.test 已有 SDK 面；这里验 CLI 进程视角）
async function recovery(): Promise<void> {
  console.log("\n== e2e 恢复（CLI 进程视角） ==");
  const home = mkdtempSync(join(tmpdir(), "bw-e2e-recover-"));
  const env = { BW_HOME: home, BW_POLICY_MODE: "test" };
  try {
    const created = await runCli(REPO_CLI, ["s", "create", "--url", origin], env);
    const sid = String(created.json?.sessionId ?? "");
    check("create for recovery", sid.startsWith("sess-"));
    // 杀 helper 组（守卫版——精确杀 bw helper 进程）
    const kill = spawn("/bin/sh", [
      "-c",
      `pkill -f "helper.ts --socket ${join(home, ".bw/session", sid)}" || true`,
    ]);
    await new Promise((r) => kill.on("exit", r));
    await new Promise((r) => setTimeout(r, 500));
    const snap = await runCli(REPO_CLI, ["s", "snap", sid], env);
    check(
      "helper 死 → 下一命令自动恢复",
      snap.code === 0 && snap.out.includes("Home"),
      `${snap.out.length}B`,
    );
    await runCli(REPO_CLI, ["s", "close", sid], env);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- run ----
await journey("源码形态", REPO_CLI);
await recovery();
if (process.argv.includes("--dist")) {
  await journey("构建产物形态", DIST_CLI);
} else {
  console.log("\n(e2e 构建产物形态跳过——--dist 显式开；build 门另验)");
}
fixture.stop(true);
console.log(`\ne2e 结论: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
