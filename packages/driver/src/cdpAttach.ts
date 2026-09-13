/**
 * CDP attach 驱动：主动连接外部浏览器的调试端点（Electron app / 手动开了调试口
 * 的 Chrome / 其他工具 spawn 的 Chromium 系进程）。与 backends.ts 的 spawn 模式
 * 相对——那是「自己拉浏览器 + 开门让别人连」（bw s cdp），这是「去敲别人的门」。
 *
 * 实现要点：
 * - 单条 browser 级 WebSocket + Target.attachToTarget{flatten} 的 sessionId 多路
 *   复用（无 http 依赖——Target.getTargets/createTarget 全走 ws）
 * - url/title/loading 是同步属性，远端只能缓存（helperClient 的 state 缓存同款
 *   模式）：Page 域事件推进（frameNavigated/frameStartedLoading/loadEventFired）
 * - close() 只断连，**绝不碰外部进程**（铁律——attach 目标的生命周期归它的主人）
 * - 与 WebViewPage 行为语义 1:1：evaluate 的 undefined→null、错误分类、click 的
 *   actionable 等待轮询
 */
import { BWError } from "@bw/core";
import { CHROME_CAPABILITIES } from "./backends.ts";
import type {
  ClickOptions,
  Driver,
  NavigationFailedListener,
  NavigationListener,
  Page,
  PageOptions,
  PressModifier,
  ScreenshotOptions,
} from "./types.ts";
import { classifyClickError } from "./types.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 最小 ws RPC 客户端（open 前 send 缓冲；事件按 sessionId 路由） ----

interface RpcPending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

class CdpConn {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, RpcPending>();
  #eventSinks = new Set<(sessionId: string | undefined, method: string, params: unknown) => void>();
  #outbox: string[] = [];
  #opened = false;
  #dead: Error | null = null;

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.onopen = () => {
      this.#opened = true;
      for (const m of this.#outbox.splice(0)) this.#ws.send(m);
    };
    this.#ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.#pending.get(msg.id);
        if (p === undefined) return;
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) {
          const e = msg.error as { message?: string };
          p.reject(new BWError("DRIVER_ERROR", `cdp failed: ${e.message ?? "unknown"}`));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      const method = msg.method;
      if (typeof method === "string") {
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        for (const sink of this.#eventSinks) {
          try {
            sink(sid, method, msg.params);
          } catch {
            /* sink 隔离 */
          }
        }
      }
    };
    this.#ws.onclose = () => {
      this.#died(new BWError("DRIVER_ERROR", "cdp connection closed"));
    };
    this.#ws.onerror = () => {
      this.#died(new BWError("DRIVER_ERROR", "cdp connection error"));
    };
  }

  #died(e: Error): void {
    if (this.#dead !== null) return;
    this.#dead = e;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
  }

  ready(): Promise<void> {
    if (this.#opened) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new BWError("DRIVER_ERROR", "cdp connect timeout")),
        10_000,
      );
      const check = (): void => {
        if (this.#dead !== null) {
          clearTimeout(t);
          reject(this.#dead);
          return;
        }
        if (this.#opened) {
          clearTimeout(t);
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  onEvent(
    sink: (sessionId: string | undefined, method: string, params: unknown) => void,
  ): () => void {
    this.#eventSinks.add(sink);
    return () => this.#eventSinks.delete(sink);
  }

  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.#dead !== null) return Promise.reject(this.#dead);
    const id = this.#nextId;
    this.#nextId += 1;
    const frame = JSON.stringify({
      id,
      method,
      params: params ?? {},
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    const p = new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BWError("TIMEOUT", `cdp timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
    if (this.#opened) this.#ws.send(frame);
    else this.#outbox.push(frame);
    return p;
  }

  close(): void {
    this.#died(new BWError("DRIVER_ERROR", "cdp connection closed"));
    try {
      this.#ws.close();
    } catch {
      /* 已关 */
    }
  }
}

// ---- 键位映射（CDP Input.dispatchKeyEvent 的 US 布局） ----

const MODIFIER_BITS: Record<PressModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const NAMED_KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: "\r" },
  Tab: { code: 9, text: "\t" },
  Escape: { code: 27 },
  Backspace: { code: 8 },
  Delete: { code: 46 },
  ArrowUp: { code: 38 },
  ArrowDown: { code: 40 },
  ArrowLeft: { code: 37 },
  ArrowRight: { code: 39 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  Space: { code: 32, text: " " },
};

const keyOf = (key: string): { key: string; code: number; text?: string } => {
  const f = /^F([1-9]|1[0-2])$/.exec(key);
  if (f !== null) return { key, code: 111 + Number(f[1]) };
  const named = NAMED_KEYS[key];
  if (named !== undefined) return { key, ...named };
  if (key.length === 1) return { key, code: key.toUpperCase().charCodeAt(0), text: key };
  throw new BWError("DRIVER_ERROR", `press failed: unsupported key ${key}`);
};

// ---- Page 实现（per-target session） ----

export class CdpAttachPage implements Page {
  #conn: CdpConn;
  #sessionId: string;
  #targetId: string;
  #url = "about:blank";
  #title = "";
  #loading = false;
  #mainFrameId = "";
  #viewport = { w: 1280, h: 720 };
  #closed = false;
  #navListeners = new Set<NavigationListener>();
  #navFailListeners = new Set<NavigationFailedListener>();
  #cdpListeners = new Map<string, Set<(params: unknown) => void>>();
  #closedListeners = new Set<() => void>();
  #unsub: () => void;
  /** 导航结算信号（loadEventFired / frameStoppedLoading / same-doc） */
  #navSettlers: Array<() => void> = [];

  constructor(conn: CdpConn, targetId: string, sessionId: string) {
    this.#conn = conn;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
    this.#unsub = conn.onEvent((sid, method, params) => {
      if (sid !== this.#sessionId) return;
      this.#onEvent(method, params);
    });
  }

  /** 初始化：启用域 + 主帧/状态抓取。必须在建页后调用一次 */
  async init(): Promise<void> {
    await this.#conn.call("Page.enable", {}, this.#sessionId);
    await this.#conn.call("Runtime.enable", {}, this.#sessionId);
    const tree = await this.#conn.call<{ frameTree?: { frame?: { id?: string; url?: string } } }>(
      "Page.getFrameTree",
      {},
      this.#sessionId,
    );
    const frame = tree?.frameTree?.frame;
    if (frame?.id !== undefined) {
      this.#mainFrameId = frame.id;
      if (frame.url !== undefined) this.#url = frame.url;
    }
    try {
      const t = await this.#rawEval<string>("document.title");
      if (typeof t === "string") this.#title = t;
      const vp = await this.#rawEval<[number, number]>("[window.innerWidth, window.innerHeight]");
      if (Array.isArray(vp)) {
        const w = Number(vp[0]);
        const h = Number(vp[1]);
        if (w > 0 && h > 0) this.#viewport = { w, h };
      }
    } catch {
      /* 页面可能不可评估（chrome:// 等）——缓存保持默认 */
    }
  }

  #onEvent(method: string, params: unknown): void {
    if (method === "Page.frameNavigated") {
      const p = params as { frame?: { id?: string; url?: string; parentId?: string } };
      if (p.frame?.id === this.#mainFrameId || p.frame?.parentId === undefined) {
        if (p.frame?.id !== undefined) this.#mainFrameId = p.frame.id;
        if (p.frame?.url !== undefined && p.frame.url !== this.#url) {
          this.#url = p.frame.url;
          for (const l of this.#navListeners) l(this.#url, this.#title);
        }
        void this.#refreshTitle();
      }
    } else if (method === "Page.navigatedWithinDocument") {
      const p = params as { frameId?: string; url?: string };
      if (p.frameId === this.#mainFrameId && p.url !== undefined && p.url !== this.#url) {
        this.#url = p.url;
        for (const l of this.#navListeners) l(this.#url, this.#title);
        this.#settleNav();
      }
    } else if (method === "Page.frameStartedLoading") {
      const p = params as { frameId?: string };
      if (p.frameId === this.#mainFrameId) this.#loading = true;
    } else if (method === "Page.frameStoppedLoading") {
      const p = params as { frameId?: string };
      if (p.frameId === this.#mainFrameId) {
        this.#loading = false;
        this.#settleNav();
      }
    } else if (method === "Page.loadEventFired") {
      this.#settleNav();
    } else if (method === "Page.javascriptDialogOpening") {
      // dialog 打开时 frameStoppedLoading 可能永不来——不让 navigate 卡死
      this.#settleNav();
    }
    const set = this.#cdpListeners.get(method);
    if (set !== undefined) for (const l of set) l(params);
  }

  #settleNav(): void {
    for (const s of this.#navSettlers.splice(0)) s();
  }

  async #refreshTitle(): Promise<void> {
    try {
      const t = await this.#rawEval<string>("document.title");
      if (typeof t === "string") this.#title = t;
    } catch {
      /* 不可评估页保持旧值 */
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new BWError("DRIVER_ERROR", "page is closed");
  }

  get url(): string {
    this.#assertOpen();
    return this.#url;
  }

  get title(): string {
    this.#assertOpen();
    return this.#title;
  }

  get loading(): boolean {
    this.#assertOpen();
    return this.#loading;
  }

  async navigate(url: string, opts?: { timeoutMs?: number }): Promise<void> {
    this.#assertOpen();
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const settle = new Promise<void>((resolve) => {
      this.#navSettlers.push(resolve);
    });
    let r: { errorText?: string };
    try {
      r = await this.#conn.call<{ errorText?: string }>("Page.navigate", { url }, this.#sessionId);
    } catch (cause) {
      throw new BWError("NAVIGATION_FAILED", `navigation failed: ${url}`, { cause });
    }
    if (r?.errorText !== undefined) {
      this.#settleNav();
      throw new BWError("NAVIGATION_FAILED", `navigation failed: ${url} (${r.errorText})`);
    }
    await Promise.race([
      settle,
      sleep(timeoutMs).then(() => {
        throw new BWError("TIMEOUT", `navigation timeout: ${url}`);
      }),
    ]);
    await this.#refreshTitle();
  }

  /** 裸 evaluate（不做 undefined 归一/异常包装——内部缓存用） */
  async #rawEval<T>(expression: string): Promise<T> {
    const r = await this.#conn.call<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.#sessionId,
    );
    return r?.result?.value as T;
  }

  async evaluate<T>(expression: string): Promise<T> {
    this.#assertOpen();
    const r = await this.#conn.call<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.#sessionId,
    );
    if (r?.exceptionDetails !== undefined) {
      const d = r.exceptionDetails;
      const msg = d.exception?.description ?? d.text ?? "page exception";
      throw new BWError("DRIVER_ERROR", `evaluate failed: ${msg.split("\n")[0]}`);
    }
    const v = r?.result?.value;
    return (v === undefined ? null : v) as T;
  }

  async #mouse(
    type: "mousePressed" | "mouseReleased",
    x: number,
    y: number,
    opts?: { button?: "left" | "right" | "middle"; clickCount?: number },
  ): Promise<void> {
    await this.#conn.call(
      "Input.dispatchMouseEvent",
      {
        type,
        x,
        y,
        button: opts?.button ?? "left",
        buttons: opts?.button === "right" ? 2 : 1,
        clickCount: opts?.clickCount ?? 1,
      },
      this.#sessionId,
    );
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    this.#assertOpen();
    const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
    for (;;) {
      const probe = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return {found:false};el.scrollIntoView({block:"center"});var q=el.getBoundingClientRect();return {found:true,x:q.x+q.width/2,y:q.y+q.height/2,w:q.width,h:q.height};})()`;
      let loc: { found: boolean; x?: number; y?: number; w?: number; h?: number };
      try {
        loc = (await this.#rawEval<typeof loc>(probe)) ?? { found: false };
      } catch (cause) {
        throw new BWError(classifyClickError(cause), `click failed: ${selector}`, { cause });
      }
      if (loc.found === true) {
        if ((loc.w ?? 0) <= 0 || (loc.h ?? 0) <= 0) {
          throw new BWError("ELEMENT_NOT_ACTIONABLE", `click failed: ${selector} (not actionable)`);
        }
        await this.#mouse("mousePressed", loc.x ?? 0, loc.y ?? 0, opts);
        await this.#mouse("mouseReleased", loc.x ?? 0, loc.y ?? 0, opts);
        return;
      }
      if (Date.now() >= deadline) {
        throw new BWError("TIMEOUT", `click timeout (not found): ${selector}`);
      }
      await sleep(120);
    }
  }

  async clickAt(x: number, y: number, opts?: Omit<ClickOptions, "timeoutMs">): Promise<void> {
    this.#assertOpen();
    try {
      await this.#mouse("mousePressed", x, y, opts);
      await this.#mouse("mouseReleased", x, y, opts);
    } catch (cause) {
      throw new BWError(classifyClickError(cause), `clickAt failed: (${x},${y})`, { cause });
    }
  }

  async type(text: string): Promise<void> {
    this.#assertOpen();
    try {
      await this.#conn.call("Input.insertText", { text }, this.#sessionId);
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `type failed: ${text.slice(0, 40)}`, { cause });
    }
  }

  async press(key: string, modifiers?: PressModifier[]): Promise<void> {
    this.#assertOpen();
    try {
      const k = keyOf(key);
      const mods =
        modifiers !== undefined && modifiers.length > 0
          ? modifiers.reduce((acc, m) => acc + (MODIFIER_BITS[m] ?? 0), 0)
          : 0;
      const base = {
        key: k.key,
        windowsVirtualKeyCode: k.code,
        nativeVirtualKeyCode: k.code,
        modifiers: mods,
      };
      await this.#conn.call(
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          ...base,
          ...(k.text !== undefined ? { text: k.text, unmodifiedText: k.text } : {}),
        },
        this.#sessionId,
      );
      await this.#conn.call("Input.dispatchKeyEvent", { type: "keyUp", ...base }, this.#sessionId);
    } catch (cause) {
      if (cause instanceof BWError) throw cause;
      throw new BWError("DRIVER_ERROR", `press failed: ${key}`, { cause });
    }
  }

  async scroll(dx: number, dy: number): Promise<void> {
    this.#assertOpen();
    try {
      await this.#conn.call(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: this.#viewport.w / 2,
          y: this.#viewport.h / 2,
          deltaX: dx,
          deltaY: dy,
        },
        this.#sessionId,
      );
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `scroll failed: (${dx},${dy})`, { cause });
    }
  }

  async scrollTo(
    selector: string,
    opts?: { block?: "start" | "center" | "end" | "nearest"; timeoutMs?: number },
  ): Promise<void> {
    this.#assertOpen();
    const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
    for (;;) {
      const probe = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.scrollIntoView({block:${JSON.stringify(opts?.block ?? "center")}});return true;})()`;
      const ok = await this.#rawEval<boolean>(probe).catch(() => false);
      if (ok === true) return;
      if (Date.now() >= deadline) {
        throw new BWError("TIMEOUT", `scrollTo timeout (not found): ${selector}`);
      }
      await sleep(120);
    }
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Uint8Array> {
    this.#assertOpen();
    try {
      const r = await this.#conn.call<{ data?: string }>(
        "Page.captureScreenshot",
        {
          format: opts?.format ?? "png",
          ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
        },
        this.#sessionId,
      );
      const b64 = r?.data ?? "";
      if (b64 === "") throw new Error("empty screenshot");
      return new Uint8Array(Buffer.from(b64, "base64"));
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", "screenshot failed", { cause });
    }
  }

  async resize(width: number, height: number): Promise<void> {
    this.#assertOpen();
    try {
      await this.#conn.call(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        this.#sessionId,
      );
      this.#viewport = { w: width, h: height };
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `resize failed: ${width}x${height}`, { cause });
    }
  }

  async reload(): Promise<void> {
    this.#assertOpen();
    const settle = new Promise<void>((resolve) => {
      this.#navSettlers.push(resolve);
    });
    await this.#conn.call("Page.reload", {}, this.#sessionId);
    await Promise.race([
      settle,
      sleep(15_000).then(() => {
        throw new BWError("TIMEOUT", "reload timeout");
      }),
    ]);
    await this.#refreshTitle();
  }

  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.#assertOpen();
    return this.#conn.call<T>(method, params, this.#sessionId);
  }

  onCdpEvent(method: string, listener: (params: unknown) => void): () => void {
    let set = this.#cdpListeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.#cdpListeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
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
    this.#assertOpen();
    const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
    interface CdpNode {
      nodeId?: number;
      nodeName?: string;
      nodeValue?: string;
      attributes?: number[];
      children?: CdpNode[];
      shadowRootChildNodes?: CdpNode[];
      contentDocument?: CdpNode;
    }
    const attrOf = (n: CdpNode, name: string): string | undefined => {
      const attrs = n.attributes;
      if (!Array.isArray(attrs)) return undefined;
      for (let i = 0; i < attrs.length; i += 2) {
        if (String(attrs[i]) === name) return String(attrs[i + 1]);
      }
      return undefined;
    };
    const textOf = (n: CdpNode): string | undefined => {
      const parts: string[] = [];
      for (const c of n.children ?? []) {
        if (c.nodeName === "#text" && c.nodeValue !== undefined) parts.push(c.nodeValue);
        if (parts.join("").length >= 80) break;
      }
      const t = parts.join("").replace(/\s+/g, " ").trim();
      return t === "" ? undefined : t.slice(0, 80);
    };
    interface Collected {
      nodeId: number;
      tag: string;
      text?: string;
      href?: string;
      role?: string;
      frameUrl: string;
    }
    const collect: Collected[] = [];
    const walkFrame = (n: CdpNode, url: string): void => {
      if (collect.length >= 30) return;
      const tag = String(n.nodeName ?? "").toUpperCase();
      if (INTERACTIVE.has(tag) && n.nodeId !== undefined) {
        const text = textOf(n);
        const href = tag === "A" ? attrOf(n, "href") : undefined;
        const role = attrOf(n, "role");
        collect.push({
          nodeId: n.nodeId,
          tag: tag.toLowerCase(),
          frameUrl: url,
          ...(text !== undefined ? { text } : {}),
          ...(href !== undefined ? { href } : {}),
          ...(role !== undefined ? { role } : {}),
        });
      }
      for (const c of n.children ?? []) walkFrame(c, url);
      for (const c of n.shadowRootChildNodes ?? []) walkFrame(c, url);
      if (n.contentDocument !== undefined) walkFrame(n.contentDocument, url);
    };
    const doc = await this.cdp<{ root?: CdpNode }>("DOM.getDocument", { depth: -1, pierce: true });
    const walkTop = (n: CdpNode): void => {
      if (n.nodeName === "IFRAME") {
        const frame = n.contentDocument;
        if (frame !== undefined) walkFrame(frame, attrOf(n, "src") ?? "");
        return;
      }
      for (const c of n.children ?? []) walkTop(c);
      for (const c of n.shadowRootChildNodes ?? []) walkTop(c);
    };
    if (doc?.root !== undefined) walkTop(doc.root);
    if (collect.length === 0) return [];
    const out: Array<{
      tag: string;
      text?: string;
      href?: string;
      role?: string;
      frameUrl: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    for (const e of collect) {
      try {
        const quads = await this.cdp<{ quads?: number[][] }>("DOM.getContentQuads", {
          nodeId: e.nodeId,
        });
        const q = quads?.quads?.[0];
        if (q === undefined || q.length < 8) continue;
        out.push({
          tag: e.tag,
          ...(e.text !== undefined ? { text: e.text } : {}),
          ...(e.href !== undefined ? { href: e.href } : {}),
          ...(e.role !== undefined ? { role: e.role } : {}),
          frameUrl: e.frameUrl,
          x: Math.min(q[0] ?? 0, q[4] ?? q[0] ?? 0),
          y: Math.min(q[1] ?? 0, q[5] ?? q[1] ?? 0),
          w: Math.abs((q[4] ?? q[0] ?? 0) - (q[0] ?? 0)),
          h: Math.abs((q[5] ?? q[1] ?? 0) - (q[1] ?? 0)),
        });
      } catch {
        /* 几何失败跳过 */
      }
    }
    return out;
  }

  onNavigated(listener: NavigationListener): () => void {
    this.#navListeners.add(listener);
    return () => this.#navListeners.delete(listener);
  }

  onNavigationFailed(listener: NavigationFailedListener): () => void {
    this.#navFailListeners.add(listener);
    return () => this.#navFailListeners.delete(listener);
  }

  /** driver 注册表用（内部 API，不在 Page 契约上） */
  onClosed(listener: () => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  get targetId(): string {
    return this.#targetId;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsub();
    for (const l of this.#closedListeners) {
      try {
        l();
      } catch {
        /* 隔离 */
      }
    }
  }
}

// ---- Driver ----

export interface CreateAttachDriverOptions {
  /** ws://…/devtools/browser/… 或 http://127.0.0.1:port（后者解析 /json/version） */
  endpoint: string;
  /** true: createPage 优先收养既有 page target（Electron 窗口语义——不新开 tab、
   * 收养时忽略 about:blank 导航请求）。缺省 false = 总是 Target.createTarget */
  attachExisting?: boolean;
}

export async function createCdpAttachDriver(opts: CreateAttachDriverOptions): Promise<Driver> {
  let browserWs = opts.endpoint;
  if (!browserWs.startsWith("ws://") && !browserWs.startsWith("wss://")) {
    const base = opts.endpoint.replace(/\/$/, "");
    const ver = await fetch(`${base}/json/version`)
      .then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>)
      .catch(() => null);
    if (ver?.webSocketDebuggerUrl === undefined) {
      throw new BWError("DRIVER_ERROR", `cdp endpoint not reachable: ${opts.endpoint}`);
    }
    browserWs = ver.webSocketDebuggerUrl;
  }
  const conn = new CdpConn(browserWs);
  await conn.ready();
  const pages = new Set<CdpAttachPage>();
  let closed = false;

  const pageTargets = async (): Promise<Array<{ targetId: string; url: string }>> => {
    const r = await conn.call<{
      targetInfos?: Array<{ targetId: string; url?: string; type: string }>;
    }>("Target.getTargets", {});
    return (r?.targetInfos ?? [])
      .filter((t) => t.type === "page")
      .map((t) => ({ targetId: t.targetId, url: t.url ?? "" }));
  };

  return {
    capabilities: () => CHROME_CAPABILITIES,

    async createPage(pageOpts?: PageOptions): Promise<Page> {
      if (closed) throw new BWError("DRIVER_ERROR", "driver is closed");
      // attachExisting + 首个 createPage：收养第一个非 devtools 页（Electron 的窗口
      // 就是 page target）。后续 createPage（opentab 语义）必须开新 target——
      // 否则 opentab 会误收养旧窗口
      if (opts.attachExisting === true && pages.size === 0) {
        const targets = await pageTargets();
        // 收养优先级：非 about:blank 的真实页 > 非 devtools 页 > 任意（实测：spawn
        // 链条常留一个初始 about:blank target，盲取第一个会收养错窗口）
        const existing =
          targets.find((t) => t.url !== "about:blank" && !t.url.startsWith("devtools://")) ??
          targets.find((t) => !t.url.startsWith("devtools://")) ??
          targets[0];
        if (existing !== undefined) {
          const page = await attach(existing.targetId);
          // about:blank = 「无导航请求」（store 无 url 建会话的信号）——不动外部页面
          if (pageOpts?.url !== undefined && pageOpts.url !== "about:blank") {
            await page.navigate(pageOpts.url, { timeoutMs: 30_000 });
          }
          return page;
        }
      }
      const created = await conn.call<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      const page = await attach(created?.targetId ?? "");
      if (pageOpts?.url !== undefined && pageOpts.url !== "about:blank") {
        await page.navigate(pageOpts.url, { timeoutMs: 30_000 });
      }
      return page;
    },

    pages: () => [...pages],

    close(): void {
      // 铁律：只断连，绝不关闭/杀外部 target——attach 目标生命周期归它的主人
      closed = true;
      for (const p of pages) p.close();
      pages.clear();
      conn.close();
    },
  };

  async function attach(targetId: string): Promise<CdpAttachPage> {
    const s = await conn.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (s?.sessionId === undefined) {
      throw new BWError("DRIVER_ERROR", `attach target failed: ${targetId}`);
    }
    const page = new CdpAttachPage(conn, targetId, s.sessionId);
    await page.init();
    pages.add(page);
    page.onClosed(() => pages.delete(page));
    return page;
  }
}
