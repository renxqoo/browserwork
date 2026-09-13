/**
 * B22 S1：helper 进程端——持 Driver（WebView）+ unix socket RPC 服务 + 事件上行。
 * 每会话一个 helper（U10 统一模型）；策略/引擎不进 helper（依赖方向：driver → core），
 * 导航事件只记录不判定（S1③ 跨命令检测的事件环，executor 消费）。
 * 优雅退出：导航 away（chrome localStorage 按导航提交，U11）→ driver.close → exit。
 *
 * 两种宿主形态：
 * - 独立进程：bun helper.ts --socket <path> --backend <webkit|chrome> [driver opts]
 * - 进程内（契约套件/测试缝）：runHelperServer(driver, socketPath)
 */
import { chmodSync, writeFileSync } from "node:fs";
import { BWError, maskNetQuery, NET_URL_MAX, type NetEntry } from "@bw/core";
import { createWebViewDriver } from "./backends.ts";
import { createCdpAttachDriver } from "./cdpAttach.ts";
import {
  FrameWriter,
  type HelperErrorResponse,
  type HelperEventFrame,
  type HelperReady,
  type HelperRequest,
  type HelperResponse,
  LineCodec,
  type NavEventEntry,
  type PageState,
  type PageSummary,
} from "./helperProtocol.ts";
import type { ClickOptions, Driver, Page, PressModifier, ScreenshotFormat } from "./types.ts";

/** 导航事件环容量（S1③；DESIGN §1.3） */
const NAV_RING_MAX = 100;

/** 网络请求环容量（requests 工具；05 §4-2 同规格） */
const NET_RING_MAX = 200;
const NET_RESULT_MAX = 50;

interface HelperPage {
  pageId: number;
  page: Page;
}

export interface HelperServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * 在给定 driver 上启动 RPC 服务。返回句柄（close = 拒绝新连接 + driver.close）。
 * readyFile：写入 HelperReady 让 spawn 方轮询就绪。
 */
export interface HelperServerOptions {
  /** attach 会话（--cdp-url/--electron）：shutdown 时**不**把外部页面导到
   * about:blank（U11 的 localStorage 提交语义只适用于自 spawn 的浏览器） */
  skipNavigateAway?: boolean;
}

export async function runHelperServer(
  driver: Driver,
  socketPath: string,
  readyFile?: string,
  opts?: HelperServerOptions,
): Promise<HelperServerHandle> {
  const pages = new Map<number, HelperPage>();
  const navRing: NavEventEntry[] = [];
  const netRing: NetEntry[] = [];
  let navSeq = 0;
  let nextId = 1;
  let closed = false;
  /** 开放 socket 集合：RPC 响应回请求方；事件广播给全部开放连接
   * （P1-2：单 activeSocket 会被探活类短连接劫持/切断在用客户端的事件流） */
  const openSockets = new Set<Bun.Socket>();
  const writers = new Map<Bun.Socket, FrameWriter>();
  const writerOf = (sk: Bun.Socket): FrameWriter => {
    let w = writers.get(sk);
    if (w === undefined) {
      w = new FrameWriter(sk);
      writers.set(sk, w);
    }
    return w;
  };

  const stateOf = (p: Page): PageState => ({ url: p.url, title: p.title, loading: p.loading });
  const summary = (): PageSummary[] =>
    [...pages.values()].map(({ pageId, page }) => ({ pageId, ...stateOf(page) }));

  const push = (frame: HelperEventFrame): void => {
    for (const sk of openSockets) writerOf(sk).write(JSON.stringify(frame));
  };

  const wirePage = (pageId: number, page: Page): Promise<void> => {
    page.onNavigated((url) => {
      navSeq += 1;
      navRing.push({ seq: navSeq, url, ts: Date.now(), pageId });
      if (navRing.length > NAV_RING_MAX) navRing.splice(0, navRing.length - NAV_RING_MAX);
      push({ event: "navigated", pageId, data: { url, title: page.title } });
    });
    page.onNavigationFailed((error) => {
      // P2-13：BWError code 过线（消费者按 code 分诊，不只 message 嗅探）
      push({
        event: "navigationFailed",
        pageId,
        data: {
          error: error.message,
          ...(error instanceof BWError ? { code: error.code } : {}),
        },
      });
    });
    // 网络请求常驻环（agent 实测踩坑：engine 侧缓冲活不过单条命令——B22 每命令
    // 新进程新 engine，navigate 与 requests 分属两条命令时捕获必空。捕获必须住在
    // helper 才跨命令存活；掩码在捕获时做（@bw/core netmask——环里不存明文 secret）
    if (driver.capabilities().networkEvents) {
      return page
        .cdp("Network.enable", {})
        .then(() => {
          page.onCdpEvent("Network.requestWillBeSent", (params) => {
            const p = params as {
              requestId?: string;
              request?: { url?: string; method?: string };
              type?: string;
            };
            const url = p.request?.url ?? "";
            netRing.push({
              url: maskNetQuery(url).slice(0, NET_URL_MAX),
              ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
              ...(p.request?.method !== undefined ? { method: p.request.method } : {}),
              ...(p.type !== undefined ? { type: p.type } : {}),
              truncated: url.length > NET_URL_MAX,
              ts: Date.now(),
            });
            if (netRing.length > NET_RING_MAX) netRing.splice(0, netRing.length - NET_RING_MAX);
          });
          page.onCdpEvent("Network.responseReceived", (params) => {
            const p = params as { requestId?: string; response?: { status?: number } };
            const target = [...netRing]
              .reverse()
              .find((e) => e.requestId !== undefined && e.requestId === p.requestId);
            if (target !== undefined && p.response?.status !== undefined) {
              target.status = p.response.status;
            }
          });
          page.onCdpEvent("Network.loadingFailed", (params) => {
            const p = params as { requestId?: string };
            const target = [...netRing]
              .reverse()
              .find((e) => e.requestId !== undefined && e.requestId === p.requestId);
            if (target !== undefined) target.failed = true;
          });
        })
        .catch(() => {
          /* chrome-only；失败静默（requests 工具按能力面判定） */
        });
    }
    return Promise.resolve();
  };

  const handle = async (
    req: HelperRequest,
  ): Promise<{ resp: HelperResponse | HelperErrorResponse }> => {
    const p: Record<string, unknown> = req.params ?? {};
    const pageOf = (): HelperPage => {
      const pid = p.pageId as unknown as number;
      const hp = pages.get(pid);
      if (hp === undefined) {
        throw new BWError("DRIVER_ERROR", `page ${pid} not found in helper`);
      }
      return hp;
    };
    const reply = (result: unknown, withState?: Page): HelperResponse => ({
      id: req.id,
      ok: true,
      result,
      ...(withState !== undefined ? { state: stateOf(withState) } : {}),
    });

    switch (req.method) {
      case "info":
        return { resp: reply({ capabilities: driver.capabilities() }) };
      case "createPage": {
        // 顺序关键（agent 反馈回归）：先零导航建页 → wirePage（网络监听就位）→
        // 再导航真实 url。若先带 url 建页，加载发生在接线之前——首批请求全错过。
        // about:blank = 「无导航请求」（store 无 url 建会话的信号）——跳过导航：
        // 新建 target 本就在 about:blank；attach 模式收养的外部窗口绝不能被导走
        const { url, ...rest } = p as { url?: string; width?: number; height?: number };
        const page = await driver.createPage(
          rest as { url?: string; width?: number; height?: number },
        );
        const pageId = nextId;
        nextId += 1;
        pages.set(pageId, { pageId, page });
        await wirePage(pageId, page);
        if (url !== undefined && url !== "about:blank") {
          await page.navigate(url, { timeoutMs: 30_000 });
        }
        // state 内嵌进 result——createPage 的 pageId 响应才知道缓存键
        return { resp: reply({ pageId, state: stateOf(page) }) };
      }
      case "pages":
        return { resp: reply(summary()) };
      case "closeDriver":
        closed = true;
        pages.clear(); // P1-6：否则 summary→stateOf(已关页) 抛错，重连误诊
        cdpSubs.clear();
        unsubFns.clear();
        driver.close();
        return { resp: reply({}) };
      case "shutdown": {
        // 优雅退出：先导航 away（chrome localStorage 提交，U11）再关。
        // attach 会话跳过导航（外部页面归它的主人）
        if (opts?.skipNavigateAway !== true) {
          for (const { page } of pages.values()) {
            try {
              await page.navigate("about:blank");
            } catch {
              /* 页面可能已死 */
            }
          }
        }
        driver.close();
        closed = true;
        pages.clear();
        cdpSubs.clear();
        unsubFns.clear();
        // P1-6：回包 flush 后退出进程（setInterval 保活会永生）
        setTimeout(() => {
          server.stop(true);
          process.exit(0);
        }, 100);
        return { resp: reply({}) };
      }
      case "navEvents": {
        const since = (p.since as unknown as number) ?? 0;
        // P1-7：附 oldest——executor 侧 since < oldest 即缺口（fail-safe 重查当前 URL）
        return {
          resp: reply({
            events: navRing.filter((e) => e.seq > since),
            latest: navSeq,
            oldest: navRing.length > 0 ? (navRing[0]?.seq ?? 0) : 0,
          }),
        };
      }
      case "netRequests": {
        // 常驻环读口（requests 工具跨命令捕获——engine 每命令重建，本地缓冲不跨命令）
        return { resp: reply({ entries: netRing.slice(-NET_RESULT_MAX) }) };
      }
      case "pageInfo": {
        const hp = pageOf();
        return { resp: reply(stateOf(hp.page), hp.page) };
      }
      case "navigate": {
        const hp = pageOf();
        const timeoutMs = p.timeoutMs as number | undefined;
        await hp.page.navigate(
          p.url as string,
          timeoutMs !== undefined ? { timeoutMs } : undefined,
        );
        return { resp: reply({}, hp.page) };
      }
      case "evaluate": {
        const hp = pageOf();
        return { resp: reply(await hp.page.evaluate(p.expression as string), hp.page) };
      }
      case "click": {
        const hp = pageOf();
        await hp.page.click(p.selector as string, p as ClickOptions);
        return { resp: reply({}, hp.page) };
      }
      case "clickAt": {
        const hp = pageOf();
        await hp.page.clickAt(p.x as number, p.y as number, p as ClickOptions);
        return { resp: reply({}, hp.page) };
      }
      case "type": {
        const hp = pageOf();
        await hp.page.type(p.text as string);
        return { resp: reply({}, hp.page) };
      }
      case "press": {
        const hp = pageOf();
        await hp.page.press(p.key as string, p.modifiers as PressModifier[] | undefined);
        return { resp: reply({}, hp.page) };
      }
      case "scroll": {
        const hp = pageOf();
        await hp.page.scroll(p.dx as number, p.dy as number);
        return { resp: reply({}, hp.page) };
      }
      case "scrollTo": {
        const hp = pageOf();
        await hp.page.scrollTo(
          p.selector as string,
          p as { block?: "start" | "center" | "end" | "nearest"; timeoutMs?: number },
        );
        return { resp: reply({}, hp.page) };
      }
      case "screenshot": {
        const hp = pageOf();
        const format = p.format as ScreenshotFormat | undefined;
        const quality = p.quality as number | undefined;
        const shot = await hp.page.screenshot({
          ...(format !== undefined ? { format } : {}),
          ...(quality !== undefined ? { quality } : {}),
        });
        return { resp: reply({ base64: Buffer.from(shot).toString("base64") }, hp.page) };
      }
      case "resize": {
        const hp = pageOf();
        await hp.page.resize(p.width as number, p.height as number);
        return { resp: reply({}, hp.page) };
      }
      case "reload": {
        const hp = pageOf();
        await hp.page.reload();
        return { resp: reply({}, hp.page) };
      }
      case "cdp": {
        const hp = pageOf();
        return {
          resp: reply(
            await hp.page.cdp(p.method as string, p.params as Record<string, unknown> | undefined),
            hp.page,
          ),
        };
      }
      case "cdpPierceNodes": {
        const hp = pageOf();
        if (hp.page.cdpPierceNodes === undefined) {
          throw new BWError("DRIVER_ERROR", "cdpPierceNodes not available on this backend");
        }
        return { resp: reply(await hp.page.cdpPierceNodes(), hp.page) };
      }
      case "closePage": {
        const hp = pageOf();
        hp.page.close();
        pages.delete(hp.pageId);
        for (const m of cdpSubs.get(hp.pageId) ?? []) {
          unsubFns.get(`${hp.pageId}:${m}`)?.();
        }
        cdpSubs.delete(hp.pageId); // P2-10：订阅随页清理
        push({ event: "pageClosed", pageId: hp.pageId });
        return { resp: reply({}) };
      }
      case "subscribeCdp": {
        const hp = pageOf();
        const method = p.method as string;
        let subs = cdpSubs.get(hp.pageId);
        if (subs === undefined) {
          subs = new Set();
          cdpSubs.set(hp.pageId, subs);
        }
        if (!subs.has(method)) {
          subs.add(method);
          unsubFns.set(
            `${hp.pageId}:${method}`,
            hp.page.onCdpEvent(method, (params: unknown) => {
              push({ event: "cdp", pageId: hp.pageId, data: { method, params } });
            }),
          );
        }
        return { resp: reply({}) };
      }
      case "unsubscribeCdp": {
        const hp = pageOf();
        const key = `${hp.pageId}:${String(p.method)}`;
        unsubFns.get(key)?.();
        unsubFns.delete(key);
        cdpSubs.get(hp.pageId)?.delete(String(p.method));
        return { resp: reply({}) };
      }
      default:
        throw new BWError("INVALID_TOOL_ARGS", `unknown helper method: ${req.method}`);
    }
  };

  // 请求串行（页锁在命令进程 engine；helper 侧 FIFO 保 WebView slot 语义）
  let queue: Promise<void> = Promise.resolve();
  const codecs = new WeakMap<Bun.Socket, LineCodec>();
  /** CDP 订阅登记：pageId → method → 本地监听（push 上行） */
  const cdpSubs = new Map<number, Set<string>>();
  const unsubFns = new Map<string, () => void>(); // `${pageId}:${method}`

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        openSockets.add(socket);
      },
      drain(socket) {
        writerOf(socket).flush(); // 内核缓冲腾出——续写挂起队列
      },
      data(socket, chunk) {
        const codec = codecs.get(socket) ?? new LineCodec();
        codecs.set(socket, codec);
        for (const line of codec.push(chunk)) {
          let req: HelperRequest;
          try {
            req = JSON.parse(line) as HelperRequest;
          } catch {
            writerOf(socket).write(
              JSON.stringify({
                id: -1,
                ok: false,
                code: "INVALID_TOOL_ARGS",
                error: "unparseable frame",
              } satisfies HelperErrorResponse),
            );
            continue;
          }
          queue = queue.then(async () => {
            try {
              const { resp } = await handle(req);
              writerOf(socket).write(JSON.stringify(resp));
            } catch (e) {
              const code = e instanceof BWError ? e.code : "DRIVER_ERROR";
              const error = e instanceof Error ? e.message : String(e);
              const resp: HelperErrorResponse = { id: req.id, ok: false, code, error };
              writerOf(socket).write(JSON.stringify(resp));
            }
          });
        }
      },
      close(socket) {
        openSockets.delete(socket);
        writers.delete(socket);
      },
    },
  });
  void server;
  // P1-4：DESIGN §1.1 承诺 unix socket 0600——Bun.listen 不设权限（实测 755），显式收紧
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* 最佳努力 */
  }

  if (readyFile !== undefined) {
    const ready: HelperReady = { pid: process.pid, backend: driverBackend(driver) };
    writeFileSync(readyFile, JSON.stringify(ready));
  }

  return {
    socketPath,
    async close(): Promise<void> {
      if (!closed) driver.close();
      closed = true;
      for (const sck of openSockets) sck.end();
      openSockets.clear();
      server.stop(true);
    },
  };
}

function driverBackend(driver: Driver): "webkit" | "chrome" {
  return driver.capabilities().cdp ? "chrome" : "webkit";
}

/** 独立进程入口：bun helper.ts --socket <path> --backend <webkit|chrome> [--data-dir …] [--ua …] [--chrome-path …] [--width --height] [--debug-port N] [--chrome-arg A] */
async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const socketPath = arg("socket");
  const backend = arg("backend") as "webkit" | "chrome" | undefined;
  if (socketPath === undefined || backend === undefined) {
    console.error(
      "usage: helper.ts --socket <path> --backend <webkit|chrome> [--ready <file>] [driver opts]",
    );
    process.exit(2);
  }
  const dataDir = arg("data-dir");
  const chromePath = arg("chrome-path");
  const ua = arg("ua");
  const width = arg("width");
  const height = arg("height");
  const debugPort = arg("debug-port"); // 0=随机；DevToolsActivePort 落 dataStore
  const chromeArgs: string[] = [];
  for (
    let i = process.argv.indexOf("--chrome-arg");
    i !== -1;
    i = process.argv.indexOf("--chrome-arg", i + 1)
  ) {
    const v = process.argv[i + 1];
    if (v !== undefined) chromeArgs.push(v);
  }
  const cdpUrl = arg("cdp-url"); // attach 模式：连外部浏览器（Electron/调试口 Chrome）
  const electronPath = arg("electron"); // launch 模式：spawn Electron app + attach
  if (cdpUrl !== undefined || electronPath !== undefined) {
    // attach/launch 驱动（capabilities 与 spawn-chrome 同面）
    const endpoint = cdpUrl ?? (await launchElectron(electronPath ?? ""));
    const driver = await createCdpAttachDriver({ endpoint, attachExisting: true });
    await runHelperServer(driver, socketPath, arg("ready"), { skipNavigateAway: true });
    process.on("SIGTERM", () => {
      process.exit(0);
    });
    setInterval(() => {}, 60_000);
    return;
  }
  const driver = createWebViewDriver({
    backend,
    ...(dataDir !== undefined ? { dataStore: dataDir } : {}),
    ...(chromePath !== undefined ? { chromePath } : {}),
    ...(ua !== undefined ? { userAgent: ua } : {}),
    ...(width !== undefined ? { width: Number(width) } : {}),
    ...(height !== undefined ? { height: Number(height) } : {}),
    ...(debugPort !== undefined || chromeArgs.length > 0
      ? {
          argv: [
            ...(debugPort !== undefined ? [`--remote-debugging-port=${debugPort}`] : []),
            ...chromeArgs,
          ],
        }
      : {}),
  });
  await runHelperServer(driver, socketPath, arg("ready"));

  process.on("SIGTERM", () => {
    process.exit(0); // 组 kill 场景；优雅路径走 shutdown 方法
  });
  setInterval(() => {}, 60_000); // WebView 空闲不保活——显式保持
}

/** launch 模式：spawn Chromium 系 app（Electron 可执行文件等）带调试口，
 * 轮询 CDP 就绪后返回 endpoint。app 是 helper 的子进程（同进程组）——组杀连带
 * （--electron 会话 close 即收走 app；--cdp-url 外部 app 不受影响） */
async function launchElectron(bin: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  server.close();
  const extraArgs: string[] = [];
  for (
    let i = process.argv.indexOf("--electron-arg");
    i !== -1;
    i = process.argv.indexOf("--electron-arg", i + 1)
  ) {
    const v = process.argv[i + 1];
    if (v !== undefined) extraArgs.push(v);
  }
  const child = spawn(bin, [`--remote-debugging-port=${port}`, ...extraArgs], {
    stdio: "ignore",
  });
  child.unref();
  process.on("exit", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已死 */
    }
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return `http://127.0.0.1:${port}`;
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new BWError(
        "DRIVER_ERROR",
        `electron app failed to start (exit ${child.exitCode ?? "?"}): ${bin}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

const selfPath = process.argv[1] ?? "";
if (
  (selfPath.endsWith("helper.ts") || selfPath.endsWith("helper.js")) &&
  process.argv.includes("--socket")
) {
  await main();
}
