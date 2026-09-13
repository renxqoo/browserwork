/**
 * B22 S1：helper RPC 客户端——连接既有 helper 的 socket，把 Driver/Page 契约
 * 远程化。页面态缓存：每次 RPC 响应搭车的 state + 事件推送就地刷新（零额外往返）。
 * onCdpEvent：本地登记 + 首个监听者触发 subscribeCdp（异步订阅，与真实驱动同构的
 * 迟滞窗口）。
 */
import { BWError, type NetEntry } from "@bw/core";
import {
  FrameWriter,
  type HelperErrorResponse,
  type HelperEventFrame,
  type HelperRequest,
  type HelperResponse,
  LineCodec,
  type PageState,
} from "./helperProtocol.ts";
import type {
  ClickOptions,
  Driver,
  DriverCapabilities,
  NavigationFailedListener,
  NavigationListener,
  Page,
  PageOptions,
  PressModifier,
  ScreenshotOptions,
} from "./types.ts";

interface Pending {
  resolve: (r: HelperResponse) => void;
  reject: (e: BWError) => void;
}

export class HelperConnection {
  private socket: Bun.Socket | null = null;
  private codec = new LineCodec();
  private writer: FrameWriter | null = null;
  private pending = new Map<number, Pending>();
  private eventSinks: ((frame: HelperEventFrame) => void)[] = [];
  private nextId = 1;
  private stateCache = new Map<number, PageState>();
  private connected = false;

  async connect(socketPath: string): Promise<void> {
    try {
      this.socket = await Bun.connect({
        unix: socketPath,
        socket: {
          data: (_s, chunk) => {
            for (const line of this.codec.push(chunk)) {
              this.dispatch(JSON.parse(line));
            }
          },
          drain: () => {
            this.writer?.flush();
          },
          close: () => {
            this.connected = false;
            for (const p of this.pending.values()) {
              p.reject(new BWError("BROWSER_DEAD", `helper socket closed: ${socketPath}`));
            }
            this.pending.clear();
          },
        },
      });
    } catch (e) {
      throw new BWError(
        "BROWSER_DEAD",
        `helper connect failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.connected = true;
  }

  private dispatch(msg: HelperResponse | HelperErrorResponse | HelperEventFrame): void {
    if ("event" in msg) {
      if (msg.event === "navigated") {
        const d = msg.data as { url: string; title?: string };
        const cur = this.stateCache.get(msg.pageId);
        this.stateCache.set(msg.pageId, {
          url: d.url,
          title: d.title ?? cur?.title ?? "",
          loading: false,
        });
      }
      for (const sink of this.eventSinks) sink(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (p === undefined) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new BWError(msg.code as never, msg.error));
  }

  /** RPC 往返 */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected || this.socket === null) {
      return Promise.reject(new BWError("BROWSER_DEAD", "helper connection is down"));
    }
    const id = this.nextId;
    this.nextId += 1;
    const req: HelperRequest =
      params !== undefined
        ? { id, method: method as HelperRequest["method"], params }
        : { id, method: method as HelperRequest["method"] };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => {
          const resp = r as HelperResponse & { result: T };
          if (r.state !== undefined && params?.pageId !== undefined) {
            this.stateCache.set(params.pageId as number, r.state);
          }
          resolve(resp.result);
        },
        reject,
      });
      if (this.writer === null && this.socket !== null) {
        this.writer = new FrameWriter(this.socket);
      }
      this.writer?.write(JSON.stringify(req));
    });
  }

  onEvent(sink: (frame: HelperEventFrame) => void): () => void {
    this.eventSinks.push(sink);
    return () => {
      const i = this.eventSinks.indexOf(sink);
      if (i >= 0) this.eventSinks.splice(i, 1);
    };
  }

  /** 指定页缓存写入 */
  cacheState(pageId: number, state: PageState): void {
    this.stateCache.set(pageId, state);
  }

  stateOf(pageId: number): PageState {
    return this.stateCache.get(pageId) ?? { url: "", title: "", loading: false };
  }

  close(): void {
    this.connected = false;
    this.socket?.end();
    this.socket = null;
  }
}

/** Page 远程代理 */
class RemotePage implements Page {
  private navListeners = new Set<NavigationListener>();
  private navFailedListeners = new Set<NavigationFailedListener>();
  private cdpListeners = new Map<string, Set<(params: unknown) => void>>();

  private closed = false;
  private onSelfClose: (() => void) | undefined;

  constructor(
    private conn: HelperConnection,
    readonly pageId: number,
    onSelfClose?: () => void,
  ) {
    this.onSelfClose = onSelfClose;
  }

  /** 事件路由入口（RemoteDriver 按 pageId 分发） */
  handleEvent(frame: HelperEventFrame): void {
    if (frame.event === "navigated") {
      const d = frame.data as { url: string; title?: string };
      for (const l of this.navListeners.values()) l(d.url, d.title ?? this.title);
    } else if (frame.event === "navigationFailed") {
      const d = frame.data as { error: string; code?: string };
      const err = d.code !== undefined ? new BWError(d.code as never, d.error) : new Error(d.error);
      for (const l of this.navFailedListeners.values()) l(err);
    } else if (frame.event === "cdp") {
      const d = frame.data as { method: string; params: unknown };
      const set = this.cdpListeners.get(d.method);
      if (set !== undefined) for (const l of set) l(d.params);
    }
  }

  /** helper 常驻网络环读口（requests 工具跨命令捕获——engine 每命令重建，本地
   * 缓冲不跨命令；Page 契约外扩展方法，engine 按存在性探测） */
  netRequests(): Promise<NetEntry[]> {
    this.assertOpen();
    return this.conn.call<{ entries: NetEntry[] }>("netRequests", {}).then((r) => r.entries ?? []);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new BWError("DRIVER_ERROR", `page ${this.pageId} closed`);
    }
  }

  get url(): string {
    this.assertOpen();
    return this.conn.stateOf(this.pageId).url;
  }
  get title(): string {
    this.assertOpen();
    return this.conn.stateOf(this.pageId).title;
  }
  get loading(): boolean {
    this.assertOpen();
    return this.conn.stateOf(this.pageId).loading;
  }

  navigate(url: string, opts?: { timeoutMs?: number }): Promise<void> {
    this.assertOpen();
    return this.conn.call("navigate", { pageId: this.pageId, url, ...opts });
  }
  evaluate<T>(expression: string): Promise<T> {
    this.assertOpen();
    return this.conn.call<T>("evaluate", { pageId: this.pageId, expression });
  }
  click(selector: string, opts?: ClickOptions): Promise<void> {
    this.assertOpen();
    return this.conn.call("click", { pageId: this.pageId, selector, ...opts });
  }
  clickAt(x: number, y: number, opts?: Omit<ClickOptions, "timeoutMs">): Promise<void> {
    this.assertOpen();
    return this.conn.call("clickAt", { pageId: this.pageId, x, y, ...opts });
  }
  type(text: string): Promise<void> {
    this.assertOpen();
    return this.conn.call("type", { pageId: this.pageId, text });
  }
  press(key: string, modifiers?: PressModifier[]): Promise<void> {
    this.assertOpen();
    return this.conn.call("press", { pageId: this.pageId, key, modifiers });
  }
  scroll(dx: number, dy: number): Promise<void> {
    this.assertOpen();
    return this.conn.call("scroll", { pageId: this.pageId, dx, dy });
  }
  scrollTo(
    selector: string,
    opts?: { block?: "start" | "center" | "end" | "nearest"; timeoutMs?: number },
  ): Promise<void> {
    this.assertOpen();
    return this.conn.call("scrollTo", { pageId: this.pageId, selector, ...opts });
  }
  async screenshot(opts?: ScreenshotOptions): Promise<Uint8Array> {
    this.assertOpen();
    const r = await this.conn.call<{ base64: string }>("screenshot", {
      pageId: this.pageId,
      ...opts,
    });
    return new Uint8Array(Buffer.from(r.base64, "base64"));
  }
  resize(width: number, height: number): Promise<void> {
    this.assertOpen();
    return this.conn.call("resize", { pageId: this.pageId, width, height });
  }
  reload(): Promise<void> {
    this.assertOpen();
    return this.conn.call("reload", { pageId: this.pageId });
  }
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.conn.call<T>("cdp", { pageId: this.pageId, method, params });
  }
  async cdpPierceNodes(): Promise<
    Array<{
      tag: string;
      text?: string;
      href?: string;
      role?: string;
      frameUrl: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }>
  > {
    return this.conn.call("cdpPierceNodes", { pageId: this.pageId });
  }
  onCdpEvent(method: string, listener: (params: unknown) => void): () => void {
    this.assertOpen();
    let set = this.cdpListeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.cdpListeners.set(method, set);
      void this.conn.call("subscribeCdp", { pageId: this.pageId, method }).catch(() => {});
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      // P2-10：本地归零即发线退订——高频事件不再无监听推送
      if (set !== undefined && set.size === 0) {
        this.cdpListeners.delete(method);
        void this.conn.call("unsubscribeCdp", { pageId: this.pageId, method }).catch(() => {});
      }
    };
  }
  /** Set 键实现——订阅/退订交错不碰撞（S1 审查 P1-1：size 键会覆写既有监听） */
  onNavigated(listener: NavigationListener): () => void {
    this.assertOpen();
    this.navListeners.add(listener);
    return () => {
      this.navListeners.delete(listener);
    };
  }
  onNavigationFailed(listener: NavigationFailedListener): () => void {
    this.assertOpen();
    this.navFailedListeners.add(listener);
    return () => {
      this.navFailedListeners.delete(listener);
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onSelfClose?.();
    void this.conn.call("closePage", { pageId: this.pageId }).catch(() => {});
  }
}

/** Driver 远程代理（页面注册表本地镜像，事件驱动同步） */
export class RemoteDriver implements Driver {
  private pagesById = new Map<number, RemotePage>();
  private caps: DriverCapabilities | null = null;
  private closed = false;

  constructor(
    readonly conn: HelperConnection,
    caps: DriverCapabilities,
    private onGone?: () => void,
  ) {
    this.caps = caps;
    conn.onEvent((frame) => {
      if (frame.event === "pageClosed") {
        this.pagesById.delete(frame.pageId);
        return;
      }
      this.pagesById.get(frame.pageId)?.handleEvent(frame);
    });
  }

  async createPage(opts?: PageOptions): Promise<Page> {
    if (this.closed) {
      throw new BWError("DRIVER_ERROR", "driver closed");
    }
    const { pageId, state } = await this.conn.call<{ pageId: number; state: PageState }>(
      "createPage",
      { ...opts },
    );
    if (state !== undefined) this.conn.cacheState(pageId, state);
    const page = new RemotePage(this.conn, pageId, () => {
      this.pagesById.delete(pageId);
    });
    this.pagesById.set(pageId, page);
    return page;
  }

  capabilities(): DriverCapabilities {
    if (this.caps !== null) return this.caps;
    // capabilities 是同步契约——helper 连接后先 info() 由 connectHelper 预填
    if (this.caps === null) {
      throw new BWError("DRIVER_ERROR", "capabilities not loaded — use connectHelper()");
    }
    return this.caps;
  }

  pages(): Page[] {
    return [...this.pagesById.values()];
  }

  /** 从 helper 拉取页面清单并重建本地代理（跨连接收养既有 tab——每命令新进程的命脉） */
  async syncPages(): Promise<Page[]> {
    const list =
      await this.conn.call<Array<{ pageId: number; url: string; title: string; loading: boolean }>>(
        "pages",
      );
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.pageId);
      this.conn.cacheState(p.pageId, { url: p.url, title: p.title, loading: p.loading });
      if (!this.pagesById.has(p.pageId)) {
        this.pagesById.set(
          p.pageId,
          new RemotePage(this.conn, p.pageId, () => {
            this.pagesById.delete(p.pageId);
          }),
        );
      }
    }
    for (const id of [...this.pagesById.keys()]) {
      if (!seen.has(id)) this.pagesById.delete(id);
    }
    return this.pages();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.conn.call("closeDriver").catch(() => {});
    this.conn.close();
    this.onGone?.();
  }

  /** 仅断开连接——helper 与页面态存续（每命令进程的退出方式；close 才是会话终结） */
  release(): void {
    this.conn.close();
  }
}

/** 连接既有 helper（capabilities 预取——同步 capabilities() 契约需要） */
export async function connectHelper(socketPath: string): Promise<RemoteDriver> {
  const conn = new HelperConnection();
  await conn.connect(socketPath);
  const info = await conn.call<{ capabilities: DriverCapabilities }>("info");
  const driver = new RemoteDriver(conn, info.capabilities);
  await driver.syncPages(); // 水化既有页面（每命令新进程跨连接收养 tab）
  return driver;
}
