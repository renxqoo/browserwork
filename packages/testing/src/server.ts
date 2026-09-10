/**
 * fixture 站点（docs/02-build-plan.md §2.2）。
 * 静态页住 fixtures/；动态路由（redirect/submitted/long/slow）在此生成。
 * 随机端口、用例自清（close 必回收）；withFixtureServers 提供互为跨源的
 * 双 origin（不同端口 = 不同 origin）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "..", "fixtures");

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}

function longPage(count: number): string {
  const links = Array.from(
    { length: count },
    (_, i) => `<li><a href="/links.html">item-${i + 1}</a></li>`,
  ).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><title>BW Long</title></head>
<body><h1>Long page</h1><ul>${links}</ul></body></html>`;
}

export interface FixtureServer {
  origin: string;
  close(): void;
}

function fixtureHandler(): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/redirect": {
        const to = url.searchParams.get("to") ?? "/index.html";
        return new Response(null, { status: 302, headers: { Location: to } });
      }
      case "/submitted": {
        const q = url.searchParams.get("q") ?? "";
        return new Response(
          `<!doctype html><html lang="zh-CN"><head><title>BW Submitted</title></head>
<body><h1>Submitted</h1><p id="echo">query: ${q.replace(/[<>&]/g, "")}</p>
<a href="/index.html">home</a></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      case "/long": {
        const count = Number(url.searchParams.get("n") ?? "200");
        return new Response(longPage(Math.min(Math.max(count, 0), 2000)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      case "/slow": {
        // navigate 超时测试用：sleep 毫秒后才响应
        const sleep = Math.min(Number(url.searchParams.get("sleep") ?? "1000"), 10_000);
        await new Promise((r) => setTimeout(r, sleep));
        return new Response("<!doctype html><title>BW Slow</title><p>slow</p>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      default: {
        const path = join(FIXTURES_DIR, url.pathname);
        // isFile 防目录请求（根路径 / join 出目录，readFileSync 会 EISDIR）
        if (!path.startsWith(FIXTURES_DIR) || !existsSync(path) || !statSync(path).isFile()) {
          return new Response("not found", { status: 404 });
        }
        return new Response(readFileSync(path), {
          headers: { "content-type": contentType(path) },
        });
      }
    }
  };
}

export async function withFixtureServer<T>(fn: (origin: string) => Promise<T>): Promise<T> {
  const server = Bun.serve({ port: 0, fetch: fixtureHandler() });
  try {
    return await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

/** 双 origin（不同端口 = 互为跨源）——跨源 iframe / S1 跨域测试用 */
export async function withFixtureServers<T>(
  fn: (origins: { a: string; b: string }) => Promise<T>,
): Promise<T> {
  const serverA = Bun.serve({ port: 0, fetch: fixtureHandler() });
  const serverB = Bun.serve({ port: 0, fetch: fixtureHandler() });
  try {
    return await fn({
      a: `http://127.0.0.1:${serverA.port}`,
      b: `http://127.0.0.1:${serverB.port}`,
    });
  } finally {
    serverA.stop(true);
    serverB.stop(true);
  }
}
