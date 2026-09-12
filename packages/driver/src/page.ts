/**
 * Bun.WebView 的 Page 包装（后端无关——webkit/chrome 对上层 API 同构）。
 * 契约见 docs/03-units.md U2。navigate/evaluate 均有互斥链：
 * 平台各操作槽的跨槽并发由上层（U4 每 page 互斥锁）吸收，这里先消除
 * 同类操作自身的并发错误（ERR_INVALID_STATE 不外泄）。
 */
import { BWError } from "@bw/core";
import type {
  ClickOptions,
  NavigationFailedListener,
  NavigationListener,
  Page,
  PressModifier,
  ScreenshotOptions,
} from "./types.ts";
import { classifyClickError } from "./types.ts";

const noop = (): void => {};

interface NormalizedClickOpts {
  timeout?: number;
  button?: "left" | "right" | "middle";
  clickCount?: 1 | 2 | 3;
}

function normalizeClickOpts(opts?: ClickOptions): NormalizedClickOpts {
  const out: NormalizedClickOpts = {};
  if (opts?.timeoutMs !== undefined) out.timeout = opts.timeoutMs;
  if (opts?.button !== undefined) out.button = opts.button;
  if (opts?.clickCount !== undefined) out.clickCount = opts.clickCount;
  return out;
}

export class WebViewPage implements Page {
  #view: Bun.WebView | null;
  #evalChain: Promise<unknown> = Promise.resolve();
  #navChain: Promise<unknown> = Promise.resolve();
  #navListeners = new Set<NavigationListener>();
  #navFailListeners = new Set<NavigationFailedListener>();
  #closedListeners = new Set<() => void>();

  constructor(view: Bun.WebView) {
    this.#view = view;
    view.onNavigated = (url, title) => {
      for (const l of this.#navListeners) {
        try {
          l(url, title);
        } catch {
          // 监听器隔离：单个 listener 异常不影响其余与原生回调
        }
      }
    };
    view.onNavigationFailed = (error) => {
      for (const l of this.#navFailListeners) {
        try {
          l(error);
        } catch {
          // 同上
        }
      }
    };
  }

  /** driver 注册表用：page 关闭时回调（内部 API，不在 Page 契约上） */
  onClosed(listener: () => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  #require(): Bun.WebView {
    if (this.#view === null) {
      throw new BWError("DRIVER_ERROR", "page is closed");
    }
    return this.#view;
  }

  get url(): string {
    return this.#require().url;
  }

  get title(): string {
    return this.#require().title;
  }

  get loading(): boolean {
    return this.#require().loading;
  }

  /**
   * navigate 互斥队列：串行化**本包装层发起的**同类导航（并发 navigate 排队，
   * 不外泄 ERR_INVALID_STATE）。click 触发的页面自导航不经此队列——其异步
   * 结算由 U4 settle 吸收（B2 审查 P2-5：注释如实收窄承诺）。
   * timeoutMs 语义 = 调用方提前收到 TIMEOUT（弃等），但导航槽位仍等底层
   * 导航真正结算后才放行下一个——平台只允许一个在途导航，槽位提前释放
   * 会让下一次 navigate 撞 "navigation is already pending"。
   */
  navigate(url: string, opts?: { timeoutMs?: number }): Promise<void> {
    this.#require(); // closed 同步抛（与其余方法形态一致，B2 审查 P2-10）
    const execute = (): { reported: Promise<void>; slot: Promise<void> } => {
      const view = this.#require();
      const underlying = (async () => {
        try {
          await view.navigate(url);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          const codeProp = (cause as { code?: string } | null)?.code;
          const isDriverState =
            codeProp === "ERR_INVALID_STATE" ||
            message.includes("ERR_INVALID_STATE") ||
            message.includes("navigation is already pending") ||
            message.includes("WebView closed") ||
            message.includes("host process") ||
            message.includes("killed by signal");
          throw new BWError(
            isDriverState ? "DRIVER_ERROR" : "NAVIGATION_FAILED",
            `navigation failed: ${url}`,
            { cause },
          );
        }
      })();
      if (opts?.timeoutMs === undefined) {
        return { reported: underlying, slot: underlying.then(noop, noop) };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BWError("TIMEOUT", `navigation timeout: ${url}`, {
                detail: { timeoutMs: opts.timeoutMs },
              }),
            ),
          opts.timeoutMs,
        );
      });
      const reported = Promise.race([underlying, timeout]);
      const slot = underlying.then(noop, noop).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      return { reported, slot };
    };
    const turn = this.#navChain.then(execute, execute);
    this.#navChain = turn.then((r) => r.slot, noop);
    return turn.then((r) => r.reported);
  }

  /**
   * 互斥链护栏：串行化本包装层发起的一切 evaluate（Bun 并发第二个同步抛
   * ERR_INVALID_STATE）；结果 undefined 归一为 null（01 §4.3）。
   */
  evaluate<T>(expression: string): Promise<T> {
    this.#require();
    const run = async (): Promise<T> => {
      const view = this.#require();
      try {
        const result = await view.evaluate<T>(expression);
        return result === undefined ? (null as T) : result;
      } catch (cause) {
        throw new BWError("DRIVER_ERROR", `evaluate failed: ${expression.slice(0, 80)}`, {
          cause,
        });
      }
    };
    const p = this.#evalChain.then(run, run);
    this.#evalChain = p.catch(noop);
    return p;
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    const view = this.#require();
    try {
      await view.click(selector, normalizeClickOpts(opts));
    } catch (cause) {
      throw new BWError(classifyClickError(cause), `click failed: ${selector}`, { cause });
    }
  }

  async clickAt(x: number, y: number, opts?: Omit<ClickOptions, "timeoutMs">): Promise<void> {
    const view = this.#require();
    try {
      await view.click(x, y, normalizeClickOpts(opts));
    } catch (cause) {
      throw new BWError(classifyClickError(cause), `clickAt failed: (${x},${y})`, { cause });
    }
  }

  async type(text: string): Promise<void> {
    const view = this.#require();
    try {
      await view.type(text);
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `type failed: ${text.slice(0, 40)}`, { cause });
    }
  }

  async press(key: string, modifiers?: PressModifier[]): Promise<void> {
    const view = this.#require();
    try {
      const opts =
        modifiers !== undefined && modifiers.length > 0 ? { modifiers: [...modifiers] } : {};
      await view.press(key, opts);
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `press failed: ${key}`, { cause });
    }
  }

  async scroll(dx: number, dy: number): Promise<void> {
    const view = this.#require();
    try {
      await view.scroll(dx, dy);
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `scroll failed: (${dx},${dy})`, { cause });
    }
  }

  async scrollTo(
    selector: string,
    opts?: { block?: "start" | "center" | "end" | "nearest"; timeoutMs?: number },
  ): Promise<void> {
    const view = this.#require();
    try {
      await view.scrollTo(selector, opts ?? {});
    } catch (cause) {
      throw new BWError(classifyClickError(cause), `scrollTo failed: ${selector}`, { cause });
    }
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Uint8Array> {
    const view = this.#require();
    try {
      const buf = await view.screenshot({
        format: opts?.format ?? "png",
        quality: opts?.quality ?? 80,
        encoding: "buffer",
      });
      return new Uint8Array(buf);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new BWError(
        "DRIVER_ERROR",
        message.includes("webp")
          ? "screenshot failed: webp requires the chrome backend"
          : "screenshot failed",
        { cause },
      );
    }
  }

  async resize(width: number, height: number): Promise<void> {
    const view = this.#require();
    try {
      await view.resize(width, height);
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", `resize failed: ${width}x${height}`, { cause });
    }
  }

  async reload(): Promise<void> {
    const view = this.#require();
    try {
      await view.reload();
    } catch (cause) {
      throw new BWError("DRIVER_ERROR", "reload failed", { cause });
    }
  }

  async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const view = this.#require();
    try {
      return (await view.cdp(method, params ?? {})) as T;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("ERR_METHOD_NOT_IMPLEMENTED")) {
        throw new BWError("DRIVER_ERROR", `cdp not available on this backend: ${method}`, {
          cause,
        });
      }
      throw new BWError("DRIVER_ERROR", `cdp failed: ${method}`, { cause });
    }
  }

  onCdpEvent(method: string, listener: (params: unknown) => void): () => void {
    const view = this.#require();
    const wrapped = (event: Event): void => {
      const data = (event as CustomEvent).detail ?? (event as unknown as { data?: unknown }).data;
      listener(data);
    };
    view.addEventListener(method, wrapped as EventListener);
    return () => view.removeEventListener(method, wrapped as EventListener);
  }

  /**
   * B20 §9.2：跨域 iframe 可交互节点（chrome-only；webkit 下可选方法不存在）。
   * 探针 p12 实证：pierce 树含 contentDocument 且节点几何可取；closed shadow 不可达。
   * 实现要点：getDocument 全树一次 → 只走 contentDocument 子树（主文档归 JS shim）→
   * interactive 标签集合 → 每节点 getContentQuads（viewport CSS 坐标）→ ≤30 节点。
   */
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
    const view = this.#require();
    const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
    interface CdpNode {
      nodeId?: number;
      nodeName?: string;
      nodeValue?: string;
      attributes?: number[];
      children?: CdpNode[];
      shadowRootChildNodes?: CdpNode[];
      contentDocument?: CdpNode;
      currentValue?: string;
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
      // 子文本节点拼接（取首 80 字符）
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
      frameUrl: string; // P2-7：随节点携带（原帧循环后复位的可变量恒读到空串）
    }
    const collect: Collected[] = [];
    const walkFrame = (n: CdpNode, url: string): void => {
      if (collect.length >= 30) return;
      const tag = String(n.nodeName ?? "").toUpperCase();
      if (INTERACTIVE.has(tag) && n.nodeId !== undefined) {
        const text = textOf(n);
        const href = tag === "A" ? attrOf(n, "href") : undefined;
        const role = attrOf(n, "role");
        const entry: Collected = {
          nodeId: n.nodeId,
          tag: tag.toLowerCase(),
          frameUrl: url,
          ...(text !== undefined ? { text } : {}),
          ...(href !== undefined ? { href } : {}),
          ...(role !== undefined ? { role } : {}),
        };
        collect.push(entry);
      }
      for (const c of n.children ?? []) walkFrame(c, url);
      for (const c of n.shadowRootChildNodes ?? []) walkFrame(c, url);
      // P2-7：帧内嵌帧下钻
      if (n.contentDocument !== undefined) walkFrame(n.contentDocument, url);
    };
    try {
      const doc = (await view.cdp("DOM.getDocument", { depth: -1, pierce: true })) as {
        root?: CdpNode;
      };
      const walkTop = (n: CdpNode): void => {
        if (n.nodeName === "IFRAME") {
          const frame = n.contentDocument;
          if (frame !== undefined) {
            walkFrame(frame, attrOf(n, "src") ?? "");
          }
          return; // 不深入 iframe 的普通子树（contentDocument 已处理）
        }
        for (const c of n.children ?? []) walkTop(c);
        for (const c of n.shadowRootChildNodes ?? []) walkTop(c);
      };
      if (doc.root !== undefined) walkTop(doc.root);
      if (collect.length === 0) return [];
      // 几何：每节点一次 getContentQuads（失败跳过）
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
          const quads = (await view.cdp("DOM.getContentQuads", { nodeId: e.nodeId })) as {
            quads?: number[][];
          };
          const q = quads?.quads?.[0];
          if (q === undefined || q.length < 8) continue;
          // quad = [x1,y1, x2,y2, x3,y3, x4,y4]（顺时针）——取包围盒
          const xs = [q[0], q[2], q[4], q[6]] as number[];
          const ys = [q[1], q[3], q[5], q[7]] as number[];
          const x = Math.min(...xs);
          const y = Math.min(...ys);
          const w = Math.max(...xs) - x;
          const h = Math.max(...ys) - y;
          if (w <= 0 || h <= 0) continue;
          out.push({
            tag: e.tag,
            frameUrl: e.frameUrl,
            ...(e.text !== undefined ? { text: e.text } : {}),
            ...(e.href !== undefined ? { href: e.href } : {}),
            ...(e.role !== undefined ? { role: e.role } : {}),
            x: Math.round(x),
            y: Math.round(y),
            w: Math.round(w),
            h: Math.round(h),
          });
        } catch {
          /* 节点已变——跳过 */
        }
      }
      return out;
    } catch {
      return []; // CDP 不可用（非 chrome 后端调用方不应调；防御）
    }
  }

  onNavigated(listener: NavigationListener): () => void {
    this.#navListeners.add(listener);
    return () => this.#navListeners.delete(listener);
  }

  onNavigationFailed(listener: NavigationFailedListener): () => void {
    this.#navFailListeners.add(listener);
    return () => this.#navFailListeners.delete(listener);
  }

  close(): void {
    if (this.#view !== null) {
      this.#view.close();
      this.#view = null;
      this.#navListeners.clear();
      this.#navFailListeners.clear();
      for (const l of this.#closedListeners) {
        try {
          l();
        } catch {
          // 隔离
        }
      }
      this.#closedListeners.clear();
    }
  }
}
