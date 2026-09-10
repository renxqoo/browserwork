/** p5: 父进程被 SIGKILL 后 webkit host 是否成为孤儿（清理责任验证） */
import { result } from "./helpers/kit.ts";

function bunProcessCount(): number {
  const out = Bun.spawnSync(["pgrep", "-f", "bun-webview/probes/p5-view-holder"]).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;
}

const before = bunProcessCount();
const child = Bun.spawn({
  cmd: [process.execPath, new URL("./p5-view-holder.ts", import.meta.url).pathname],
  stdout: "pipe",
  stderr: "inherit",
});
// 等 READY
const reader = child.stdout.getReader();
await reader.read();
reader.cancel();

const alive = bunProcessCount();
child.kill("SIGKILL");
await child.exited;
await new Promise((r) => setTimeout(r, 2000));
const afterKill = bunProcessCount();
await new Promise((r) => setTimeout(r, 4000));
const afterKill6s = bunProcessCount();
Bun.WebView.closeAll();

result("p5.childStarted", alive > before);
result("p5.remainingAfterSigKill_2s", afterKill);
result("p5.remainingAfterSigKill_6s", afterKill6s);
