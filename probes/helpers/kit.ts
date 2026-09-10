/** 探针共用：内联单页服务器 + 超时包装 */
export async function servePage(
  html: string,
  routes: Record<string, string> = {},
): Promise<{
  origin: string;
  close(): void;
}> {
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const hit = routes[path];
      if (hit !== undefined) {
        return new Response(hit, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (path === "/redirect") {
        const to = new URL(request.url).searchParams.get("to") ?? "/";
        return new Response(null, { status: 302, headers: { Location: to } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = "op"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function result(name: string, value: unknown): void {
  console.log(`RESULT ${name} = ${JSON.stringify(value)}`);
}
