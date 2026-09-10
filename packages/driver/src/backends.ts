/**
 * 双后端驱动（docs/03-units.md U2；01 §5）。
 * chrome 铁律：默认 url:false 强制独立拉起（P1-11——防自动连上正在运行的 Chrome）。
 * 两个后端共享同一 WebViewPage 包装（Bun.WebView 对上层 API 同构）。
 */
import { BWError } from "@bw/core";
import { WebViewPage } from "./page.ts";
import type { Driver, DriverCapabilities } from "./types.ts";

const WEBKIT_CAPABILITIES: DriverCapabilities = {
  cdp: false,
  upload: false,
  download: false,
  dialogEvents: false, // 探针 p1：dialog 自动处理、不可观测
  userAgentOverride: false,
  pierceClick: false, // 探针 p7：选择器不穿 shadow DOM
};

const CHROME_CAPABILITIES: DriverCapabilities = {
  cdp: true,
  upload: true,
  download: true,
  dialogEvents: true, // CDP Page.javascriptDialogOpening（B8 前仅声明）
  userAgentOverride: true,
  pierceClick: false, // 未实证穿透前一律 false——坐标轨兜底设计不依赖
};

export type BackendKind = "webkit" | "chrome";

export interface CreateDriverOptions {
  /** 默认 webkit（仅 macOS）；chrome 走 CDP 后端 */
  backend?: BackendKind;
}

export function createWebViewDriver(opts?: CreateDriverOptions): Driver {
  const backend: BackendKind = opts?.backend ?? "webkit";
  const pages = new Set<WebViewPage>();
  let closed = false;

  const makeView = (width: number, height: number): Bun.WebView => {
    if (backend === "chrome") {
      // 铁律：url:false 永远独立拉起，绝不自动连接运行中的 Chrome
      return new Bun.WebView({ width, height, backend: { type: "chrome", url: false } });
    }
    return new Bun.WebView({ width, height });
  };

  return {
    capabilities: () => (backend === "chrome" ? CHROME_CAPABILITIES : WEBKIT_CAPABILITIES),

    async createPage(pageOpts?: {
      width?: number;
      height?: number;
      url?: string;
    }): Promise<WebViewPage> {
      if (closed) {
        throw new BWError("DRIVER_ERROR", "driver is closed");
      }
      const view = makeView(pageOpts?.width ?? 1280, pageOpts?.height ?? 720);
      const page = new WebViewPage(view);
      pages.add(page);
      page.onClosed(() => pages.delete(page));
      // 构造期 url 不透传给 WebView 构造器——统一走 navigate 互斥队列，
      // 消除「构造导航在途 + 立即 navigate」的同步抛错窗口（探针附带事实）。
      // 初始导航失败 → 关闭并注销，调用方拿 rejection 但不泄漏渲染进程
      //（B2 审查 P2-9/P2-12）
      if (pageOpts?.url !== undefined) {
        try {
          await page.navigate(pageOpts.url, { timeoutMs: 30_000 });
        } catch (e) {
          page.close();
          throw e;
        }
      }
      return page;
    },

    pages: () => [...pages],

    close(): void {
      closed = true;
      for (const p of pages) p.close();
      pages.clear();
    },
  };
}
