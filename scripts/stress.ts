/**
 * 并发压测（05 §3.8）：fixture 站 + N 并发会话 × M 操作——p50/p95/错误数。
 * 手动/CI 可选（不进门禁）：bun scripts/stress.ts [--sessions 4] [--ops 8] [--backend webkit]
 */
import { createSessionManager } from "@bw/service";

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? Number(process.argv[i + 1]) : dflt;
};
const SESSIONS = arg("sessions", 4);
const OPS = arg("ops", 8);
const BACKEND = (process.argv.includes("--backend") ? "chrome" : "webkit") as "webkit" | "chrome";

const fixture = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/") {
      const items = Array.from(
        { length: 30 },
        (_, i) => `<li><a href="/x${i}">i${i}</a></li>`,
      ).join("");
      return new Response(`<!doctype html><title>S</title><h1>Stress</h1><ul>${items}</ul>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(`<html><title>x</title></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const origin = `http://127.0.0.1:${fixture.port}`;

const mgr = createSessionManager({
  policyMode: "test",
  maxSessions: SESSIONS + 2,
  driverOptions: {
    backend: BACKEND,
    ...(BACKEND === "chrome"
      ? { chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
      : {}),
  },
});

const results: number[] = [];
let errors = 0;
const t0 = Date.now();

const worker = async (n: number): Promise<void> => {
  let id: string | undefined;
  try {
    const s = await mgr.create(origin);
    id = s.id;
    for (let i = 0; i < OPS; i++) {
      const opStart = Date.now();
      const tool = i % 3 === 0 ? "wait" : i % 3 === 1 ? "extract_text" : "scroll";
      const r = await mgr.executeTool(
        s.id,
        tool,
        tool === "wait"
          ? { seconds: 0.01 }
          : tool === "scroll"
            ? { direction: i % 2 === 0 ? "down" : "up", amount: 300 }
            : {},
      );
      if (!r.ok) throw new Error(`${tool}: ${"error" in r ? r.error : "failed"}`);
      results.push(Date.now() - opStart);
    }
  } catch (e) {
    errors += 1;
    console.error(`[worker ${n}]`, e instanceof Error ? e.message.slice(0, 80) : String(e));
  } finally {
    if (id !== undefined) mgr.close(id);
  }
};

await Promise.all(Array.from({ length: SESSIONS }, (_, i) => worker(i)));
mgr.closeAll();
fixture.stop(true);

results.sort((a, b) => a - b);
const pct = (p: number): number =>
  results.length === 0
    ? -1
    : (results[Math.min(results.length - 1, Math.floor((results.length * p) / 100))] ?? -1);
console.log(`\n== stress（backend=${BACKEND} sessions=${SESSIONS} ops=${OPS}）==`);
console.log(`ops: ${results.length}  errors: ${errors}`);
console.log(`p50: ${pct(50)}ms  p95: ${pct(95)}ms  max: ${results[results.length - 1] ?? -1}ms`);
console.log(`wall: ${Date.now() - t0}ms`);
process.exit(errors > 0 ? 1 : 0);
