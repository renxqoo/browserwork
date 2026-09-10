/**
 * webkit 后端实现（docs/03-units.md U2；01 §5）。
 * chrome 后端在 B2 批次落地（默认 url:false 铁律在彼处实现）。
 */
import { BWError } from "@bw/core";
import type {
  ClickOptions,
  Driver,
  DriverCapabilities,
  NavigationFailedListener,
  NavigationListener,
  Page,
  PageOptions,
  ScreenshotOptions,
} from "./types.ts";
import { classifyClickError } from "./types.ts";

const WEBKIT_CAPABILITIES: DriverCapabilities = {
  cdp: false,
  upload: false,
  download: false,
  dialogEvents: false, // 探针 p1：dialog 自动处理、不可观测
  userAgentOverride: false,
  pierceClick: false, // 探针 p7：选择器不穿 shadow DOM
};

export interface WebViewDriverOptions {
  /** B1 仅 webkit；chrome 于 B2 落地 */
  backend?: "webkit";
}

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

class WebViewPage implements Page {
  #view: Bun.WebView | null;
  /** evaluate 互斥链：串行化一切本包装层发起的 evaluate（Bun 并发第二个同步抛错） */
  #evalChain: Promise<unknown> = Promise.resolve();
  #navListeners = new Set<NavigationListener>();
  #navFailListeners = new Set<NavigationFailedListener>();

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

  async navigate(url: string, opts?: { timeoutMs?: number }): Promise<void> {
    const view = this.#require();
    const doNavigate = (async () => {
      try {
        await view.navigate(url);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // ERR_INVALID_STATE = 导航在途时二次导航/close 中止等驱动态错误，不是页面加载失败
        const code = message.includes("ERR_INVALID_STATE") ? "DRIVER_ERROR" : "NAVIGATION_FAILED";
        throw new BWError(code, `navigation failed: ${url}`, { cause });
      }
    })();
    if (opts?.timeoutMs === undefined) {
      return doNavigate;
    }
    // 超时即弃等（底层导航无法取消，由 B2 互斥队列收束）；语义 = 等待超时
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
    try {
      await Promise.race([doNavigate, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 互斥链护栏：串行化本包装层发起的一切 evaluate（Bun 并发第二个同步抛
   * ERR_INVALID_STATE）；结果 undefined 归一为 null（01 §4.3）。
   * 链式排队无检查间隙——并发调用方全部安全排队（U2 契约：不外泄 ERR_INVALID_STATE）。
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
    this.#evalChain = p.catch(() => {});
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
      throw new BWError("DRIVER_ERROR", "screenshot failed", { cause });
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
    }
  }
}

export function createWebViewDriver(_opts?: WebViewDriverOptions): Driver {
  const pages = new Set<WebViewPage>();
  let closed = false;
  return {
    capabilities: () => WEBKIT_CAPABILITIES,
    async createPage(opts?: PageOptions): Promise<Page> {
      if (closed) {
        throw new BWError("DRIVER_ERROR", "driver is closed");
      }
      const view = new Bun.WebView({
        width: opts?.width ?? 1280,
        height: opts?.height ?? 720,
        ...(opts?.url !== undefined ? { url: opts.url } : {}),
      });
      const page = new WebViewPage(view);
      pages.add(page);
      return page;
    },
    close(): void {
      closed = true;
      for (const p of pages) p.close();
      pages.clear();
    },
  };
}
