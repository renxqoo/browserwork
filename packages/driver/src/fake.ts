/**
 * 测试替身（docs/03-units.md U2）：FakePage/FakeDriver——零进程依赖的可编程 Page。
 * 语义保真范围：错误码、互斥、close 语义、事件订阅；click 模拟「主文档
 * querySelector 命中表」——shadow/iframe 作用域差异由真 view 契约套件保证，
 * 假驱动不假装模拟（防 B1 审查指出的「假驱动测不出选择器作用域」类问题）。
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

/** 1x1 透明 PNG */
const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

export interface FakePageOptions {
  url?: string;
  title?: string;
  /** navigate 到这些 url 时抛 NAVIGATION_FAILED（模拟 DNS/拒连） */
  failUrls?: string[];
  /** evaluate 处理器：未提供时非空表达式返回 null */
  evaluateHandler?: (expression: string) => unknown;
  /** click(selector) 的主文档命中表 */
  selectors?: string[];
  /** selectors 中「可点击」的子集（默认 = selectors 全部） */
  notActionable?: string[];
}

export class FakePage implements Page {
  #opts: FakePageOptions;
  #closed = false;
  #url: string;
  #title: string;
  #loading = false;
  #evalChain: Promise<unknown> = Promise.resolve();
  #navChain: Promise<unknown> = Promise.resolve();
  #navListeners = new Set<NavigationListener>();
  #navFailListeners = new Set<NavigationFailedListener>();
  #closedListeners = new Set<() => void>();
  readonly clicks: Array<{ selector?: string; x?: number; y?: number; opts?: unknown }> = [];
  readonly navHistory: string[] = [];

  constructor(opts: FakePageOptions = {}) {
    this.#opts = opts;
    this.#url = opts.url ?? "about:blank";
    this.#title = opts.title ?? "";
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

  #assertOpen(): void {
    if (this.#closed) {
      throw new BWError("DRIVER_ERROR", "page is closed");
    }
  }

  /**
   * timeoutMs 语义与真驱动一致（超时 TIMEOUT）；fake 的导航即时完成，
   * 超时分支仅在 handler 慢时才可能触发——已文档化的分叉（B2 审查 P2-8）。
   */
  navigate(url: string, opts?: { timeoutMs?: number }): Promise<void> {
    this.#assertOpen(); // closed 同步抛，与其余方法形态一致（B2 审查 P2-10）
    const run = async (): Promise<void> => {
      this.#assertOpen();
      await new Promise((r) => setTimeout(r, 0));
      if (this.#opts.failUrls?.includes(url)) {
        const error = new BWError("NAVIGATION_FAILED", `navigation failed: ${url}`);
        for (const l of this.#navFailListeners) {
          try {
            l(error);
          } catch {
            // 隔离
          }
        }
        throw error;
      }
      this.#url = url;
      this.#loading = false;
      this.navHistory.push(url);
      for (const l of this.#navListeners) {
        try {
          l(url, this.#title);
        } catch {
          // 隔离
        }
      }
    };
    const p = this.#navChain.then(run, run);
    this.#navChain = p.catch(() => {});
    if (opts?.timeoutMs === undefined) {
      return p;
    }
    // 与真驱动对齐：超时弃等 TIMEOUT（fake 导航即时完成，仅 handler 慢时触发）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BWError("TIMEOUT", `navigation timeout: ${url}`)),
        opts.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  evaluate<T>(expression: string): Promise<T> {
    this.#assertOpen();
    const run = async (): Promise<T> => {
      this.#assertOpen();
      try {
        const result = this.#opts.evaluateHandler
          ? await this.#opts.evaluateHandler(expression)
          : null;
        return (result === undefined ? null : result) as T;
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

  async click(selector: string, _opts?: ClickOptions): Promise<void> {
    this.#assertOpen();
    if (!this.#opts.selectors?.includes(selector)) {
      throw new BWError(
        "ELEMENT_NOT_ACTIONABLE",
        `timeout waiting for '${selector}' to be actionable`,
      );
    }
    if (this.#opts.notActionable?.includes(selector)) {
      throw new BWError(
        "ELEMENT_NOT_ACTIONABLE",
        `timeout waiting for '${selector}' to be actionable`,
      );
    }
    this.clicks.push({ selector, opts: _opts });
  }

  async clickAt(x: number, y: number, opts?: Omit<ClickOptions, "timeoutMs">): Promise<void> {
    this.#assertOpen();
    this.clicks.push({ x, y, opts });
  }

  async screenshot(_opts?: ScreenshotOptions): Promise<Uint8Array> {
    this.#assertOpen();
    return TINY_PNG.slice();
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
    if (!this.#closed) {
      this.#closed = true;
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

  /** driver 注册表用（与 WebViewPage 对齐，不在 Page 契约上） */
  onClosed(listener: () => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }
}

export class FakeDriver implements Driver {
  #pages: Page[] = [];
  #closed = false;
  readonly #capabilities: DriverCapabilities;
  readonly #pageOptions: FakePageOptions;

  constructor(
    capabilities: DriverCapabilities = {
      cdp: false,
      upload: false,
      download: false,
      dialogEvents: false,
      userAgentOverride: false,
      pierceClick: false,
    },
    pageOptions: FakePageOptions = {},
  ) {
    this.#capabilities = capabilities;
    this.#pageOptions = pageOptions;
  }

  capabilities(): DriverCapabilities {
    return this.#capabilities;
  }

  async createPage(opts?: PageOptions): Promise<FakePage> {
    if (this.#closed) {
      throw new BWError("DRIVER_ERROR", "driver is closed");
    }
    const page = new FakePage(this.#pageOptions);
    this.#pages.push(page);
    page.onClosed(() => {
      const i = this.#pages.indexOf(page);
      if (i !== -1) this.#pages.splice(i, 1);
    });
    // 与真驱动对齐：opts.url 走 navigate（B2 审查 P1-3）
    if (opts?.url !== undefined) {
      await page.navigate(opts.url, { timeoutMs: 30_000 });
    }
    return page;
  }

  pages(): Page[] {
    return [...this.#pages];
  }

  close(): void {
    this.#closed = true;
    // 迭代副本：close→onClosed→splice 会在迭代中改数组（B2 审查 P1-2）
    for (const p of [...this.#pages]) p.close();
    this.#pages = [];
  }
}
