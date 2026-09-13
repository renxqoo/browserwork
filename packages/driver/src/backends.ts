import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
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

/** chrome 能力面（spawn 与 attach 两驱动共用） */
export const CHROME_CAPABILITIES: DriverCapabilities = {
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

/**
 * CDP console-inspect 泄漏防御（B 站排障过程沉淀，机制认知见注释末）：
 * 包装 console 方法，参数中的对象/函数在传给原生前替换为占位字符串
 * （Object.prototype.toString 不访问自有 getter）。实测（2026-09-14）：
 * - 中性页无泄漏——CDP 只有在订阅 console 事件（console 工具）后才 inspect 参数；
 * - B 站页面的 getter 触发来自其自家 console 包装的 stringify（真人同样触发，
 *   非自动化检测信号）。
 * 保留本防御：console 工具订阅事件后泄漏面真实存在，占位替换无副作用。
 */
const NO_CDP_LEAK_SCRIPT = `(() => {
  if (window.__bwNoleak) return;
  try { Object.defineProperty(window, "__bwNoleak", { value: 1 }); } catch { return; }
  const ph = (a) => {
    if (a === null) return a;
    const t = typeof a;
    if (t !== "object" && t !== "function") return a;
    try { return Object.prototype.toString.call(a); } catch { return "[bw]"; }
  };
  for (const m of ["debug","log","info","warn","error","table","dir","trace"]) {
    try {
      const orig = console[m];
      if (typeof orig !== "function") continue;
      const wrap = (...args) => { try { orig.call(console, ...args.map(ph)); } catch {} };
      Object.defineProperty(wrap, "name", { value: m });
      console[m] = wrap;
    } catch {}
  }
})();`;

/** 活进程检测：命令行带 --user-data-dir=<dir> 的 Chrome 数（0=无人持有） */
function chromeHoldingDataDir(dir: string): number {
  // "--" 分隔：模式以 - 开头会被 pgrep 当选项（illegal option 退出 2——静默匹配不到）
  const r = spawnSync("pgrep", ["-f", "--", `--user-data-dir=${dir}`], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return 0;
  let n = 0;
  for (const line of r.stdout.trim().split("\n")) {
    const pid = Number(line);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) n += 1;
  }
  return n;
}

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
  /** 有头模式（chrome；实测 --headless=false 后 last-wins 生效——真窗口/真渲染，
   * 环境指纹从根上正常。风控对抗向：登录态会话建议开；弹真窗口到桌面是代价） */
  headed?: boolean;
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
  // UA 反泄漏（2026-09-14 实测实锤）：Bun 的 chrome 后端强制 --headless——页面
  // UA/请求头全是 HeadlessChrome/xxx（比 webdriver 更硬的风控信号，B站底分来源）。
  // --user-agent 旗标双端覆写（header 回显 + navigator 均实证）；版本动态取真机
  // Chrome（防硬编码过时），失败回落固定串。Emulation 覆写（opts.userAgent）在
  // page 级别优先于此旗标
  const chromeVersion = (() => {
    try {
      const bin =
        opts?.chromePath ??
        process.env.BUN_CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
      const m = /(\d+(?:\.\d+)*)/.exec(r.stdout ?? "");
      return m?.[1] ?? "131.0.0.0";
    } catch {
      return "131.0.0.0";
    }
  })();
  const CHROME_STEALTH_ARGV = [
    "--disable-blink-features=AutomationControlled",
    `--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
  ];
  const chromeArgv = [
    ...CHROME_STEALTH_ARGV,
    ...(opts?.headed === true ? ["--headless=false"] : []),
    ...(opts?.argv ?? []),
  ];

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
          // 真因探测（实测踩坑：data-dir 被残留 Chrome 占用时新实例当不上 singleton、
          // CDP 连不上，报文只有 "userAgent override failed" 完全看不出真因）。
          // 活进程持有 = 可行动信号（bw s gc 清扫）；SingletonLock 是悬空符号链接，
          // existsSync 跟链会误判不存在——用 lstatSync
          const cause = e instanceof Error ? e.message : String(e);
          const dir = opts?.dataStore;
          const lockIsSymlink = (() => {
            try {
              return lstatSync(join(dir ?? "", "SingletonLock")).isSymbolicLink();
            } catch {
              return false; // 无锁文件——正常首启
            }
          })();
          const held = dir !== undefined && (chromeHoldingDataDir(dir) > 0 || lockIsSymlink);
          throw new BWError(
            "DRIVER_ERROR",
            held
              ? `userAgent override failed — data-dir is held by a leftover Chrome process: ${dir}. Run 'bw s gc' to sweep orphans, or use a fresh --data-dir`
              : `userAgent override failed: ${cause}`,
            { cause: e },
          );
        }
      }
      if (backend === "chrome") {
        // CDP 泄漏反制（B 站实测实锤）：CDP 会话会 inspect 每次 console 调用的参数
        // 对象——站点传带 getter 的对象探 console，getter 被触发即判定自动化，
        // 「一打开就弹 correspond/1 验证页」。反制：页面脚本运行前把 console 参数
        // 中的对象/函数替换为占位（getter 永不暴露给 CDP）；原始值原样（console
        // 工具的文本日志不受影响）。新文档自动注入 + 当前文档立即补一次。
        // 前置 about:blank：未导航时 CDP target 未 attach，注入会静默失败（实测）
        try {
          await page.navigate("about:blank", { timeoutMs: 10_000 });
          await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
            source: NO_CDP_LEAK_SCRIPT,
          });
          await page.cdp("Runtime.evaluate", { expression: NO_CDP_LEAK_SCRIPT });
        } catch {
          /* 注入尽力而为——不阻断建页 */
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
