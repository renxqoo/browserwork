/**
 * 双后端驱动（docs/03-units.md U2；01 §5；05 §3.7）。
 * chrome 铁律：默认 url:false 强制独立拉起（P1-11——防自动连上正在运行的 Chrome）。
 * 两个后端共享同一 WebViewPage 包装（Bun.WebView 对上层 API 同构）。
 * B14：构造选项全透传（dataStore/path/argv/stdout/stderr/viewport/UA）。
 */
import { BWError } from "@bw/core";
import { WebViewPage } from "./page.ts";
import type { Driver, DriverCapabilities } from "./types.ts";

const WEBKIT_CAPABILITIES: DriverCapabilities = {
  cdp: false,
  upload: false,
  download: false,
  dialogEvents: false, // 探针 p1：dialog 自动处理、不可观测
  userAgentOverride: false, // Bun API 无此选项（受控测试能力仅 chrome）
  pierceClick: false, // 探针 p7：选择器不穿 shadow DOM
  httpOnlyCookies: false,
  networkEvents: false,
  webp: false,
  popups: false,
};

const CHROME_CAPABILITIES: DriverCapabilities = {
  cdp: true, // 探针 p10/p11 实证
  upload: true, // 探针 p11：objectGroup→objectId / performSearch 穿 shadow
  download: true, // 探针 p11：Browser.setDownloadBehavior + Page.downloadWillBegin
  dialogEvents: true, // CDP Page.javascriptDialogOpening（工具面未消费，仅声明）
  userAgentOverride: true, // 探针 p10：Emulation.setUserAgentOverride 生效
  pierceClick: false, // 未实证穿透前一律 false——坐标轨兜底设计不依赖
  httpOnlyCookies: true, // Network.getCookies（值不出域——只回元数据，05 §3.7）
  networkEvents: true, // 探针 p10：Network.requestWillBeSent
  webp: true,
  popups: false, // 未实证——_blank 已标注，实证后置位
};

export type BackendKind = "webkit" | "chrome";

export interface CreateDriverOptions {
  /** 默认 webkit（仅 macOS）；chrome 走 CDP 后端 */
  backend?: BackendKind;
  /** 视口（默认 1280×720；每页一致） */
  width?: number;
  height?: number;
  /**
   * 持久化存储目录（登录态复用）：webkit=每 view 同目录；chrome=进程级首 view 生效
   * （Bun 限制——同进程后续 chrome 会话目录不符时由上层告警）
   */
  dataStore?: string;
  /** chrome 可执行文件路径（缺省 BUN_CHROME_PATH/$PATH/常见安装位） */
  chromePath?: string;
  /** chrome 启动旗标（隐式 spawn 模式） */
  argv?: string[];
  /** 子进程输出透传（Chrome 崩溃诊断） */
  stdout?: "inherit" | "ignore";
  stderr?: "inherit" | "ignore";
  /**
   * UA 覆写（受控测试能力，非隐身手段；仅 chrome）。施加时点：先导航
   * about:blank 建立 CDP 会话再覆写——首个真实请求即带覆写 UA（审查 P19）。
   */
  userAgent?: string;
}

export function createWebViewDriver(opts?: CreateDriverOptions): Driver {
  const backend: BackendKind = opts?.backend ?? "webkit";
  if (opts?.userAgent !== undefined && backend !== "chrome") {
    // fail fast：webkit 无此能力，静默忽略会让调用方以为生效
    throw new BWError("DRIVER_ERROR", "userAgent override requires the chrome backend");
  }
  const width = opts?.width ?? 1280;
  const height = opts?.height ?? 720;
  const pages = new Set<WebViewPage>();
  let closed = false;

  // 反自动化检测（B 站实测）：CDP 默认暴露 navigator.webdriver=true，风控识别
  // 「cookie 来自真实浏览器、环境却是自动化」指纹矛盾即弹校验页。此旗标消掉
  // webdriver 标记；用户显式 argv 追加在后（last-wins 可覆写）
  const CHROME_STEALTH_ARGV = ["--disable-blink-features=AutomationControlled"];
  const chromeArgv =
    opts?.argv !== undefined ? [...CHROME_STEALTH_ARGV, ...opts.argv] : CHROME_STEALTH_ARGV;

  const makeView = (w: number, h: number): Bun.WebView => {
    if (backend === "chrome") {
      // 铁律：url:false 永远独立拉起，绝不自动连接运行中的 Chrome
      return new Bun.WebView({
        width: w,
        height: h,
        backend: {
          type: "chrome",
          url: false,
          ...(opts?.chromePath !== undefined ? { path: opts.chromePath } : {}),
          argv: chromeArgv,
          ...(opts?.stdout !== undefined ? { stdout: opts.stdout } : {}),
          ...(opts?.stderr !== undefined ? { stderr: opts.stderr } : {}),
        },
        ...(opts?.dataStore !== undefined ? { dataStore: { directory: opts.dataStore } } : {}),
      });
    }
    return new Bun.WebView({
      width: w,
      height: h,
      backend: {
        type: "webkit",
        ...(opts?.stdout !== undefined ? { stdout: opts.stdout } : {}),
        ...(opts?.stderr !== undefined ? { stderr: opts.stderr } : {}),
      },
      ...(opts?.dataStore !== undefined ? { dataStore: { directory: opts.dataStore } } : {}),
    });
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
      // 每页尺寸保留（既有契约：withDriverPage 按 pageOpts 设视口）；缺省取驱动级
      const view = makeView(pageOpts?.width ?? width, pageOpts?.height ?? height);
      const page = new WebViewPage(view);
      pages.add(page);
      page.onClosed(() => pages.delete(page));
      // 构造期 url 不透传给 WebView 构造器——统一走 navigate 互斥队列，
      // 消除「构造导航在途 + 立即 navigate」的同步抛错窗口（探针附带事实）。
      // 初始导航失败 → 关闭并注销，调用方拿 rejection 但不泄漏渲染进程
      //（B2 审查 P2-9/P2-12）
      // UA 场景统一「about:blank 建会话 → 覆写 → 目标导航」——首个真实请求即带
      // 覆写 UA（B14 审查 P1-3：先导航后覆写会让首请求带真 UA，实证证伪旧序）
      if (opts?.userAgent !== undefined && backend === "chrome") {
        try {
          await page.navigate("about:blank", { timeoutMs: 10_000 });
          await page.cdp("Emulation.setUserAgentOverride", { userAgent: opts.userAgent });
        } catch (e) {
          page.close();
          throw new BWError("DRIVER_ERROR", "userAgent override failed", { cause: e });
        }
      }
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
