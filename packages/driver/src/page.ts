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
