/**
 * 动作引擎（docs/03-units.md U4）。
 * 每 page 互斥锁吸收平台跨槽并发；复合步 = 校验 → 意图解析 → 执行 →
 * settle → 重提取；错误一律 throw BWError（LLM 自纠通道）。
 */
import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type BrowserAction, BWError, type NavigationIntent, taskDownloadsRoot } from "@bw/core";
import type { Driver, Page } from "@bw/driver";
import {
  DRAIN_LOGS_EXPRESSION,
  ENTER_SUBMIT_INTENT_EXPRESSION,
  extractSnapshot,
  type LocateResult,
  locateExpression,
  type PageLogEntry,
  type SnapNode,
  type Snapshot,
  scrollToBwIdExpression,
  selectBwIdExpression,
  serializeDomTree,
} from "@bw/perception";
import { runTreeCode } from "./sandbox.ts";

export interface ActionEngineOptions {
  /** settle 静默窗口 ms（默认 500，01 §6.5） */
  settleQuietMs?: number;
  /** settle 上限 ms（默认 10_000；到点照常继续，不报错） */
  settleCapMs?: number;
  /** selector 轨 actionable 等待（默认 30_000） */
  clickTimeoutMs?: number;
  /** rect 漂移容差 px（超过视为 DOM 已变 → ELEMENT_NOT_FOUND 重提取） */
  driftTolerancePx?: number;
  /** S3：凭据解析（B5 接线；缺省 → type_text_secret 抛 SECRET_UNRESOLVED） */
  resolveSecret?: (name: string, targetOrigin: string) => Promise<string>;
  /** S1②/S2：导航/提交意图上报（B5 前检消费；可异步——B5 在此做 DNS/白名单前检并等待） */
  intentSink?: (intent: NavigationIntent, action: BrowserAction) => void | Promise<void>;
  /** B14 下载落盘目录工厂（缺省 ~/.bw/downloads/default；会话模式注入 per-session 目录） */
  downloadsDir?: () => string;
}

export interface ActionResult {
  text: string;
  /** 复合步后的新快照（DOM 类动作必有；look/wait/done 可为 null） */
  snapshot: Snapshot | null;
  /** look 的截图（base64，供 U6 组多模态消息） */
  image?: { base64: string; mimeType: "image/png" };
  /** done 动作标记（U6 终止协议消费） */
  done?: boolean;
  /** 本次动作解析出的导航意图（同时经 intentSink 上报） */
  intent?: NavigationIntent;
}

export interface ActionEngine {
  act(action: BrowserAction, snapshot?: Snapshot | null): Promise<ActionResult>;
  activePage(): Page;
  /** B22 S2：跨命令收养既有页（文件会话——命令进程重建 engine 后接上 helper 里的活动 tab） */
  adopt(page: Page): void;
  /** B22 S2：现提取当前活动页快照（命令开始——S2 词面闸/索引查找/unchanged 判定） */
  currentSnapshot(): Promise<Snapshot>;
  /** 页面状态读取/写入（锁内，B11）：console/errors 缓冲、cookies、localStorage */
  inspect(kind: InspectKind, params?: InspectParams): Promise<string>;
  /** 受控 eval（锁内 + 超时 + 结果截断，B11）——会话模式须显式 opt-in */
  runExpression(expression: string): Promise<string>;
}

/** inspect 类目（B11：对齐 agent-browser 的 get/debug 面，只取安全子集；B14 增网络/cookie 元数据） */
export type InspectKind =
  | "console"
  | "errors"
  | "cookies"
  | "cookies_set"
  | "cookies_clear"
  | "storage"
  | "storage_set"
  | "storage_clear"
  | "requests"
  | "cookies_all";

export interface InspectParams {
  key?: string;
  value?: string;
}

const EXTRACT_TEXT_MAX = 4000;
const WAIT_MAX_SECONDS = 30;
const SCROLL_STEP_PX = 600;
const EVAL_TIMEOUT_MS = 10_000;
const EVAL_MAX_RESULT = 8000;
/** B14 下载预算（05 §4-8：并发 ≤1 / 单文件 ≤100MB / 会话累计 ≤1GB） */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** 网络监听环形缓冲（05 §4-2：200 条，url ≤500 字符） */
const NETWORK_BUFFER_MAX = 200;
const NETWORK_URL_MAX = 500;

/** 每 page 互斥锁：串行化引擎发起的一切驱动调用 + settle 轮询（01 §6.1） */
const pageLocks = new WeakMap<object, Promise<unknown>>();

function runExclusive<T>(page: Page, fn: () => T | Promise<T>): Promise<T> {
  const prev = pageLocks.get(page) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  pageLocks.set(
    page,
    p.catch(() => {}),
  );
  return p;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 快照携带的视口尺寸（缺省 1280x720） */
const viewportOf = (snapshot: Snapshot | null | undefined): { w: number; h: number } => ({
  w: (snapshot as { scroll?: { viewportW?: number } } | null)?.scroll?.viewportW ?? 1280,
  h: snapshot?.scroll.viewportH ?? 720,
});

export function createActionEngine(driver: Driver, opts?: ActionEngineOptions): ActionEngine {
  const settleQuietMs = opts?.settleQuietMs ?? 500;
  const settleCapMs = opts?.settleCapMs ?? 10_000;
  const clickTimeoutMs = opts?.clickTimeoutMs ?? 30_000;
  const driftTol = opts?.driftTolerancePx ?? 12;
  /** S6：输入过 secret 的页面集合（origin+path 归一——query/hash 变化不换页，B4 审查 P2-3） */
  const secretPages = new Set<string>();
  const pageKeyOf = (url: string): string => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return url;
    }
  };

  let active: Page | null = null;

  const ensureActive = (): Page => {
    if (active === null) {
      throw new BWError("DRIVER_ERROR", "no active page (recover with open_tab)");
    }
    return active;
  };

  /**
   * settle（01 §6.5 + B4 审查 P1-3）：
   * 1) 最小观察窗 = settleQuietMs（从 settle 起算）——click 触发的异步导航
   *    在此窗内变为 loading/url 变化，避免「lastChange 是上次提取时刻」导致零等待放行；
   * 2) 之后：URL 已变且不在加载 → 立即完成（导航已落地）；
   *    URL 未变 → 等观察者静默 settleQuietMs 且不在加载；
   * 3) 上限到点照常继续（非错误）。
   */
  const settle = async (page: Page, baselineUrl: string): Promise<void> => {
    const started = Date.now();
    const deadline = started + settleCapMs;
    const minWindowEnd = started + settleQuietMs;
    for (;;) {
      if (Date.now() >= deadline) return;
      if (page.loading) {
        await sleep(120);
        continue;
      }
      if (Date.now() >= minWindowEnd) {
        if (page.url !== baselineUrl) return; // 导航已落地
        const quiet = await page.evaluate<number>(
          "(window.__bwSettle ? Date.now() - window.__bwSettle.lastChange : 1e9)",
        );
        if (quiet >= settleQuietMs) return;
      }
      await sleep(120);
    }
  };

  const findNode = (snapshot: Snapshot, index: string): SnapNode => {
    const node = snapshot.nodes.find((n) => n.id === index);
    if (node === undefined) {
      throw new BWError("ELEMENT_NOT_FOUND", `index ${index} not in snapshot`);
    }
    return node;
  };

  /** 动作前校验：深度定位 + rect 漂移比对（P1-17 处置：主键 = bw-id） */
  const locateAndValidate = async (page: Page, node: SnapNode): Promise<LocateResult> => {
    const located = await page.evaluate<LocateResult>(locateExpression(node.id));
    if (located?.found !== true) {
      throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} no longer in page`);
    }
    const drift =
      Math.abs((located.x ?? 0) - node.x) > driftTol ||
      Math.abs((located.y ?? 0) - node.y) > driftTol ||
      Math.abs((located.w ?? 0) - node.w) > driftTol * 2 ||
      Math.abs((located.h ?? 0) - node.h) > driftTol * 2;
    if (drift) {
      throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} moved since snapshot (DOM drift)`);
    }
    return located;
  };

  const intentFrom = (located: LocateResult): NavigationIntent | null => {
    if (located.linkHref !== undefined && located.linkHref !== "") {
      return { kind: "link", href: located.linkHref };
    }
    if (located.formAction !== undefined && located.formAction !== "") {
      return located.formMethod !== undefined
        ? { kind: "submit", href: located.formAction, method: located.formMethod }
        : { kind: "submit", href: located.formAction };
    }
    return null;
  };

  /**
   * 双轨分派（P0-2 裁决）：shadow/iframe → 坐标轨；主文档 → selector 轨。
   * 坐标轨（B4 审查 P0-1）：滚动后**重新 locate** 取新视口坐标再点击——
   * 滚动前坐标是陈旧的，WebKit 对视口外坐标静默丢弃（假成功）。
   * 可见性复核（P2-9）：hidden 元素过校验后被盲点 → ELEMENT_NOT_ACTIONABLE。
   */
  const executeClick = async (
    page: Page,
    node: SnapNode,
    located: LocateResult,
    viewport: { w: number; h: number },
  ): Promise<void> => {
    const selector = `[data-bw-id="${node.id}"]`;
    if (located.visible === false) {
      throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is hidden`);
    }
    if (located.inShadow || located.inFrame) {
      const outside =
        (located.y ?? 0) < 0 ||
        (located.y ?? 0) + (located.h ?? 0) > viewport.h ||
        (located.x ?? 0) < 0 ||
        (located.x ?? 0) + (located.w ?? 0) > viewport.w;
      if (outside) {
        const scrolled = await page.evaluate<{ found: boolean; scrolled?: boolean }>(
          scrollToBwIdExpression(node.id),
        );
        if (scrolled?.found !== true) {
          throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} not scrollable`);
        }
        const fresh = await page.evaluate<LocateResult>(locateExpression(node.id));
        if (fresh?.found !== true) {
          throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} lost after scroll`);
        }
        located = fresh;
        if (located.visible === false) {
          throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is hidden`);
        }
      }
      await page.clickAt(
        Math.round((located.x ?? 0) + (located.w ?? 0) / 2),
        Math.round((located.y ?? 0) + (located.h ?? 0) / 2),
      );
      return;
    }
    if (node.below || node.above) {
      await page.scrollTo(selector, { block: "center", timeoutMs: clickTimeoutMs });
    }
    await page.click(selector, { timeoutMs: clickTimeoutMs });
  };

  const typeInto = async (
    page: Page,
    node: SnapNode,
    located: LocateResult,
    text: string,
    viewport: { w: number; h: number },
  ): Promise<void> => {
    const typable =
      node.tag === "input" ||
      node.tag === "textarea" ||
      node.role === "textbox" ||
      located.editable === true;
    if (!typable) {
      throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is not a text input`);
    }
    await executeClick(page, node, located, viewport); // 聚焦
    await page.type(text);
  };

  const settleAndExtract = async (page: Page, baselineUrl?: string): Promise<Snapshot> => {
    await settle(page, baselineUrl ?? page.url);
    return extractSnapshot(page);
  };

  // ---- B14：网络监听（chrome；环形缓冲 200 条，url ≤500 截断）----
  interface NetEntry {
    url: string;
    requestId?: string;
    method?: string;
    type?: string;
    status?: number;
    failed?: boolean;
    truncated?: boolean;
    ts: number;
  }
  /** query 敏感参数掩码（requests 工具出域面——B14 审查 P2-10） */
  const SENSITIVE_QUERY_KEYS =
    /(^|&)(token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|sig|signature|secret|password|passwd|authorization|credential|client_secret|session[_-]?id)=([^&]*)/gi;
  const maskUrl = (raw: string): string => {
    if (!raw.includes("?")) return raw;
    const i = raw.indexOf("?");
    const masked = raw.slice(i + 1).replace(SENSITIVE_QUERY_KEYS, "$1$2=***");
    return `${raw.slice(0, i)}?${masked}`;
  };
  const netBuffers = new WeakMap<Page, NetEntry[]>();
  const netWired = new WeakSet<Page>();
  const ensureNetworkMonitor = async (page: Page): Promise<void> => {
    if (!driver.capabilities().networkEvents || netWired.has(page)) return;
    const entries: NetEntry[] = [];
    netBuffers.set(page, entries);
    const push = (e: NetEntry): void => {
      if (entries.length >= NETWORK_BUFFER_MAX) entries.shift();
      entries.push(e);
    };
    try {
      await page.cdp("Network.enable", {});
      netWired.add(page); // enable 成功才标记——瞬态失败可重试（B14 审查 P2-13）
      page.onCdpEvent("Network.requestWillBeSent", (params) => {
        const p = params as {
          requestId?: string;
          request?: { url?: string; method?: string };
          type?: string;
        };
        const url = p.request?.url ?? "";
        push({
          url: maskUrl(url).slice(0, NETWORK_URL_MAX),
          ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
          ...(p.request?.method !== undefined ? { method: p.request.method } : {}),
          ...(p.type !== undefined ? { type: p.type } : {}),
          truncated: url.length > NETWORK_URL_MAX,
          ts: Date.now(),
        });
      });
      page.onCdpEvent("Network.responseReceived", (params) => {
        // 按 requestId 精确匹配（并发乱序下「最新未定条目」启发式会张冠李戴——B14 审查 P2-9）
        const p = params as { requestId?: string; response?: { status?: number } };
        const target = [...entries]
          .reverse()
          .find((e) => e.requestId !== undefined && e.requestId === p.requestId);
        if (target !== undefined && p.response?.status !== undefined) {
          target.status = p.response.status;
        }
      });
      page.onCdpEvent("Network.loadingFailed", (params) => {
        const p = params as { requestId?: string };
        const target = [...entries]
          .reverse()
          .find((e) => e.requestId !== undefined && e.requestId === p.requestId);
        if (target !== undefined) target.failed = true;
      });
    } catch {
      // chrome-only；失败静默（requests 工具将不可用——工具注册按能力判定）
    }
  };

  /** B20 §9.3：网络静默等待——requests 缓冲无新增持续 1500ms（上限 settleCap 照常继续） */
  const waitForNetworkIdle = (page: Page): Promise<void> => {
    const quietMs = 1500;
    const deadline = Date.now() + settleCapMs;
    // P2-6 处置：空/缺失缓冲 = 已静默（立即返回）——否则 about:blank/零请求页白等满 cap
    const lastEntryTs = (): number | null => {
      const entries = netBuffers.get(page);
      if (entries === undefined || entries.length === 0) return null;
      return entries[entries.length - 1]?.ts ?? null;
    };
    if (lastEntryTs() === null) return Promise.resolve();
    return (async () => {
      for (;;) {
        if (Date.now() >= deadline) return; // 上限到点照常继续（非错误——与 settle 同语义）
        const last = lastEntryTs();
        if (last === null || Date.now() - last >= quietMs) return;
        await sleep(120);
      }
    })();
  };

  // ---- B14 下载（chrome；预算：并发≤1 / 单文件≤100MB / 累计≤1GB）----
  let downloadInFlight = false;
  let downloadTotalBytes = 0;
  const sanitizeFilename = (name: string): string => {
    const base = name.split("/").pop() ?? "download";
    const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned === "" || cleaned === "." || cleaned === ".." ? "download" : cleaned;
  };
  const listDir = (dir: string): Set<string> => {
    try {
      return new Set(readdirSync(dir));
    } catch {
      return new Set();
    }
  };
  const performDownload = async (
    page: Page,
    node: SnapNode,
    located: LocateResult,
    snapshot: Snapshot,
  ): Promise<string> => {
    const dir = opts?.downloadsDir?.() ?? join(taskDownloadsRoot(), "default", "downloads"); // B22 §1.2：任务下载面（BW_HOME 单源）
    if (downloadInFlight) throw new BWError("INVALID_TOOL_ARGS", "another download is in flight");
    if (downloadTotalBytes > DOWNLOAD_MAX_TOTAL_BYTES) {
      throw new BWError("INVALID_TOOL_ARGS", "download budget exhausted (1GB per session)");
    }
    downloadInFlight = true;
    // 下载行为只在本动作窗口启用（S1③ 违规窗口期不可触发下载——05 §3.7 审查 P7）
    // behavior "allow"：保留原文件名（冲突自动去重）；"allowAndName" 会改存 UUID 名
    // （契约实测）——目录差集 + 名字前缀匹配定位落盘文件
    const enable = await page
      .cdp("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: true,
      })
      .catch(() => undefined);
    const before = listDir(dir);
    try {
      let filename = "";
      let offBegin: () => void = () => {};
      let offProgress: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new BWError("TIMEOUT", "download timed out after 60s")),
          DOWNLOAD_TIMEOUT_MS,
        );
        offBegin = page.onCdpEvent("Page.downloadWillBegin", (params) => {
          filename = sanitizeFilename(
            (params as { suggestedFilename?: string }).suggestedFilename ?? "download",
          );
        });
        offProgress = page.onCdpEvent("Page.downloadProgress", (params) => {
          const state = (params as { state?: string }).state;
          if (state === "completed") {
            resolve();
          } else if (state === "canceled") {
            reject(new BWError("DRIVER_ERROR", "download canceled"));
          }
        });
      }).finally(() => {
        // 任一终态（含 TIMEOUT reject）卸载监听与计时——防永久泄漏（B14 审查 P2-7）
        if (timer !== undefined) clearTimeout(timer);
        offBegin();
        offProgress();
      });
      await executeClick(page, node, located, {
        w: snapshot.scroll.viewportW ?? 1280,
        h: snapshot.scroll.viewportH,
      });
      await done;
      // 落盘定位：目录差集（冲突自动去重改名）+ 名字前缀匹配 + 最新 mtime
      await new Promise((r) => setTimeout(r, 200));
      const added = [...listDir(dir)].filter((f) => !before.has(f));
      let path = "";
      let size = 0;
      let newest = 0;
      const stem = filename !== "" ? filename.replace(/\.[^.]+$/, "") : "";
      for (const f of added) {
        if (stem !== "" && !f.includes(stem)) continue;
        const p = join(dir, f);
        try {
          const st = statSync(p);
          // 首个匹配（path===""）或更新 mtime 的候选（0 字节照常参与——B14 审查 P2-8）
          if (st.isFile() && (path === "" || st.mtimeMs > newest)) {
            path = p;
            size = st.size;
            newest = st.mtimeMs;
          }
        } catch {
          /* 竞态 */
        }
      }
      if (path === "") throw new BWError("DRIVER_ERROR", "downloaded file not found on disk");
      if (size > DOWNLOAD_MAX_FILE_BYTES) {
        try {
          unlinkSync(path);
        } catch {
          /* 尽力 */
        }
        downloadTotalBytes += size;
        throw new BWError(
          "INVALID_TOOL_ARGS",
          `download exceeds 100MB limit (${size} bytes); deleted`,
        );
      }
      downloadTotalBytes += size;
      return path;
    } finally {
      downloadInFlight = false;
      if (enable !== undefined) {
        await page.cdp("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
      }
    }
  };

  // ---- B14 上传（chrome；performSearch 穿 shadow/iframe → setFileInputFiles）----
  const performUpload = async (
    page: Page,
    node: SnapNode,
    files: string[],
    located: LocateResult,
  ): Promise<void> => {
    // P0-1 处置（B14 审查）：定位校验防「页面偷换目的地」——元素必须仍是可见的
    // file input 且坐标未漂移（与 click/type 轨同一防线）
    if (located.tag !== "input" || located.inputType !== "file") {
      throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is not a file input`);
    }
    if (located.visible === false) {
      throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is hidden`);
    }
    // realpath 解析（压缩路径闸检查与使用的 TOCTOU 窗口——审查 P1-5）
    const resolved: string[] = [];
    for (const f of files) {
      if (!existsSync(f)) {
        throw new BWError("INVALID_TOOL_ARGS", `file not found: ${f}`);
      }
      try {
        resolved.push(realpathSync(f));
      } catch {
        resolved.push(f);
      }
    }
    const search = (await page.cdp("DOM.performSearch", {
      query: `[data-bw-id="${node.id}"]`,
    })) as { searchId?: string; resultCount?: number };
    if (search.searchId === undefined || (search.resultCount ?? 0) === 0) {
      throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} not found via DOM search`);
    }
    const results = (await page.cdp("DOM.getSearchResults", {
      searchId: search.searchId,
      fromIndex: 0,
      toIndex: search.resultCount,
    })) as { nodeIds?: number[] };
    await page.cdp("DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
    const nodeId = results.nodeIds?.[0];
    if (nodeId === undefined || nodeId <= 0) {
      throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} has no DOM node`);
    }
    await page.cdp("DOM.setFileInputFiles", { files: resolved, nodeId });
  };

  /** JSON 参数安全内嵌（引号/换行转义后拼入页面表达式） */
  const lit = (s: string): string => JSON.stringify(s);

  /** 最近一次落定导航是否为 POST（submit/enter_submit 置位）——reload 写重放闸（05 §3.7 审查 P6） */
  const lastNavWasPost = new WeakMap<Page, boolean>();

  const inspect = async (kind: InspectKind, params?: InspectParams): Promise<string> => {
    const page = ensureActive();
    return runExclusive(page, async () => {
      switch (kind) {
        case "requests": {
          if (!driver.capabilities().networkEvents) {
            throw new BWError("INVALID_TOOL_ARGS", "requests requires the chrome backend");
          }
          const entries = netBuffers.get(page) ?? [];
          return JSON.stringify(entries.slice(-50));
        }
        case "cookies_all": {
          // B14：httpOnly cookie 元数据（值永不出域——05 §0/§3.7 审查 P4 处置）
          if (!driver.capabilities().httpOnlyCookies) {
            throw new BWError("INVALID_TOOL_ARGS", "cookies_all requires the chrome backend");
          }
          const raw = (await page.cdp<{ cookies?: Array<Record<string, unknown>> }>(
            "Network.getCookies",
            { urls: [page.url] },
          )) ?? { cookies: [] };
          const masked = (raw.cookies ?? []).map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly === true,
            secure: c.secure === true,
            sameSite: c.sameSite,
            value: "***",
          }));
          return JSON.stringify(masked);
        }
        case "console":
        case "errors": {
          const logs = (await page.evaluate<PageLogEntry[]>(DRAIN_LOGS_EXPRESSION)) ?? [];
          const out = kind === "errors" ? logs.filter((l) => l.level === "error") : logs;
          return JSON.stringify(out);
        }
        case "cookies":
          return (await page.evaluate<string>("document.cookie")) ?? "";
        case "cookies_set": {
          if (params?.key === undefined || params?.value === undefined) {
            throw new BWError("INVALID_TOOL_ARGS", "cookies_set requires name and value");
          }
          await page.evaluate(
            `document.cookie = encodeURIComponent(${lit(params.key)}) + "=" + encodeURIComponent(${lit(params.value)}) + "; path=/; SameSite=Lax", "ok"`,
          );
          return `cookie ${params.key} set`;
        }
        case "cookies_clear": {
          const n = await page.evaluate<number>(
            `(() => { let n = 0; for (const c of document.cookie.split(";")) { const name = c.split("=")[0].trim(); if (name) { document.cookie = name + "=; path=/; max-age=0"; n += 1; } } return n; })()`,
          );
          return `cleared ${n ?? 0} cookie(s)`;
        }
        case "storage": {
          if (params?.key !== undefined) {
            return (
              (await page.evaluate<string | null>(`localStorage.getItem(${lit(params.key)})`)) ?? ""
            );
          }
          const all = await page.evaluate<Record<string, string>>(
            `(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; })()`,
          );
          return JSON.stringify(all ?? {});
        }
        case "storage_set": {
          if (params?.key === undefined || params?.value === undefined) {
            throw new BWError("INVALID_TOOL_ARGS", "storage_set requires key and value");
          }
          await page.evaluate(
            `localStorage.setItem(${lit(params.key)}, ${lit(params.value)}), "ok"`,
          );
          return `storage ${params.key} set`;
        }
        case "storage_clear": {
          await page.evaluate(`localStorage.clear(), "ok"`);
          return "localStorage cleared";
        }
      }
    });
  };

  const runExpression = async (rawExpression: string): Promise<string> => {
    const page = ensureActive();
    return runExclusive(page, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 自动 IIFE：语句序列（a.click(); b.className）不是合法表达式——Bun evaluate
      // 包 await(<expr>) 会 SyntaxError。先试表达式；语句合法则包 (() => { ... })()
      let expression = rawExpression;
      try {
        new Function(`return (${rawExpression})`);
      } catch {
        try {
          new Function(rawExpression);
          expression = `(() => { ${rawExpression} })()`;
        } catch (e) {
          throw new BWError(
            "EVAL_ERROR",
            `SyntaxError: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      try {
        const result = await Promise.race([
          page.evaluate(expression),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new BWError("TIMEOUT", `eval timed out after ${EVAL_TIMEOUT_MS}ms`)),
              EVAL_TIMEOUT_MS,
            );
          }),
        ]);
        let text: string;
        try {
          text = JSON.stringify(result ?? null) ?? "undefined";
        } catch {
          text = String(result);
        }
        return text.slice(0, EVAL_MAX_RESULT);
      } catch (e) {
        // 页面 JS 异常（非超时）→ EVAL_ERROR：真实消息 + 与驱动故障分离
        if (e instanceof BWError && e.code === "DRIVER_ERROR") {
          throw new BWError("EVAL_ERROR", e.message);
        }
        throw e;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  };

  return {
    activePage: ensureActive,
    adopt(page: Page): void {
      active = page;
    },
    async currentSnapshot(): Promise<Snapshot> {
      const page = ensureActive();
      return runExclusive(page, () => settleAndExtract(page));
    },
    inspect,
    runExpression,

    async act(action: BrowserAction, snapshot?: Snapshot | null): Promise<ActionResult> {
      // open_tab 在锁外创建新页（自身无竞态面）
      if (action.kind === "open_tab") {
        const page = await driver.createPage({ url: action.url });
        active = page;
        const snap = await runExclusive(page, async () => {
          await ensureNetworkMonitor(page); // 新 tab 即接线（B14 审查 P2-13）
          return settleAndExtract(page);
        });
        return { text: `opened tab: ${page.url}`, snapshot: snap };
      }
      if (action.kind === "switch_tab") {
        const pages = driver.pages();
        const page = pages[action.tab];
        if (page === undefined) {
          throw new BWError(
            "INVALID_TOOL_ARGS",
            `tab ${action.tab} does not exist (${pages.length} open)`,
          );
        }
        active = page;
        const snap = await runExclusive(page, async () => {
          await ensureNetworkMonitor(page); // 切回旧 tab 补接线（B14 审查 P2-13）
          return settleAndExtract(page);
        });
        return { text: `switched to tab ${action.tab}: ${page.url}`, snapshot: snap };
      }
      if (action.kind === "close_tab") {
        const page = ensureActive();
        // 关闭走目标页锁内（U4 契约：互斥覆盖一切驱动调用；B4 审查 P2-2）
        await runExclusive(page, () => {
          page.close();
        });
        const remaining = driver.pages();
        active = remaining[0] ?? null;
        if (active === null) {
          return { text: "closed last tab (no pages open)", snapshot: null };
        }
        const snap = await runExclusive(active, () => settleAndExtract(active as Page));
        return { text: `closed tab; active now ${active.url}`, snapshot: snap };
      }

      const page = ensureActive();
      return runExclusive(page, async () => {
        await ensureNetworkMonitor(page); // chrome 侧幂等（webkit no-op）
        switch (action.kind) {
          case "navigate": {
            await page.navigate(action.url, { timeoutMs: 30_000 });
            lastNavWasPost.set(page, false);
            const snap = await settleAndExtract(page);
            return { text: `navigated to ${page.url}`, snapshot: snap };
          }
          case "click": {
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "click requires a snapshot (extract first)");
            }
            const node = findNode(snapshot, action.index);
            // B20 §9.2：跨域 iframe 节点——页面 JS 定位不可达（同源策略），坐标轨直达。
            // 意图前检跳过（跨域目标的 href 页面侧拿不到——S1③ 落定复检兜底）。
            if (node.crossOrigin === true) {
              if (node.below || node.above) {
                throw new BWError(
                  "ELEMENT_NOT_ACTIONABLE",
                  `cross-frame element ${node.id} outside viewport — scroll the parent page first`,
                );
              }
              // P1-2 处置：跨帧节点也过意图闸——submit 类（button/input[type=submit|button]）
              // 强制确认（跨帧内导航主帧 onNavigated 兜不住，事前闸是唯一防线）；
              // 带(href,#)的 crossOrigin a 不存在（shim 只给跨域 iframe 占位，不给 href）——
              // CDP 并入节点 href 是帧内绝对地址，作为 link 意图上报
              const isSubmitish =
                node.tag === "button" ||
                (node.tag === "input" && (node.type === "submit" || node.type === "button"));
              if (isSubmitish) {
                await opts?.intentSink?.({ kind: "submit" }, action);
              } else if (node.href !== undefined && node.href !== "") {
                await opts?.intentSink?.({ kind: "link", href: node.href }, action);
              }
              await page.clickAt(Math.round(node.x + node.w / 2), Math.round(node.y + node.h / 2));
              const snap = await settleAndExtract(page);
              return {
                text: `clicked [${node.id}] ${node.text ?? node.tag} (cross-frame, coordinate track)`,
                snapshot: snap,
              };
            }
            const located = await locateAndValidate(page, node);
            const intent = intentFrom(located);
            if (intent !== null) {
              await opts?.intentSink?.(intent, action);
              lastNavWasPost.set(page, intent.kind === "submit");
            }
            const baselineUrl = page.url;
            const viewport = {
              w: snapshot.scroll.viewportW ?? 1280,
              h: snapshot.scroll.viewportH,
            };
            await executeClick(page, node, located, viewport);
            const snap = await settleAndExtract(page, baselineUrl);
            const result: ActionResult = {
              text: `clicked [${node.id}] ${node.text ?? node.tag}`,
              snapshot: snap,
            };
            if (intent !== null) {
              result.intent = intent;
            }
            return result;
          }
          case "type": {
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "type requires a snapshot");
            }
            const node = findNode(snapshot, action.index);
            const located = await locateAndValidate(page, node);
            await typeInto(page, node, located, action.text, viewportOf(snapshot));
            const snap = await settleAndExtract(page);
            return { text: `typed into [${node.id}]`, snapshot: snap };
          }
          case "type_text_secret": {
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "type_text_secret requires a snapshot");
            }
            if (opts?.resolveSecret === undefined) {
              throw new BWError("SECRET_UNRESOLVED", "no secret resolver configured");
            }
            const node = findNode(snapshot, action.index);
            const located = await locateAndValidate(page, node);
            let targetOrigin = located.origin ?? "";
            if (targetOrigin === "") {
              try {
                targetOrigin = new URL(page.url).origin;
              } catch {
                targetOrigin = "";
              }
            }
            const value = await opts.resolveSecret(action.secretName, targetOrigin);
            await typeInto(page, node, located, value, viewportOf(snapshot));
            secretPages.add(pageKeyOf(page.url)); // S6：本页 look 门禁
            const snap = await settleAndExtract(page);
            return {
              text: `typed secret '${action.secretName}' into [${node.id}]`,
              snapshot: snap,
            };
          }
          case "press": {
            if (action.key === "Enter") {
              const intentInfo = await page.evaluate<{
                submit: boolean;
                action?: string;
                method?: string;
              }>(ENTER_SUBMIT_INTENT_EXPRESSION);
              if (intentInfo?.submit) {
                const intent: NavigationIntent =
                  intentInfo.action !== undefined && intentInfo.method !== undefined
                    ? { kind: "enter_submit", href: intentInfo.action, method: intentInfo.method }
                    : { kind: "enter_submit" };
                await opts?.intentSink?.(intent, action);
                // POST 落点记账（含 Enter 提交——B14 审查 P1-2：reload 写重放闸缺口）
                lastNavWasPost.set(page, intent.method === undefined || intent.method !== "get");
              }
            }
            await page.press(action.key);
            const snap = await settleAndExtract(page);
            return { text: `pressed ${action.key}`, snapshot: snap };
          }
          case "scroll": {
            const amount = action.amount ?? SCROLL_STEP_PX;
            const [dx, dy] =
              action.direction === "down"
                ? [0, amount]
                : action.direction === "up"
                  ? [0, -amount]
                  : action.direction === "right"
                    ? [amount, 0]
                    : [-amount, 0];
            await page.scroll(dx, dy);
            const snap = await settleAndExtract(page);
            return { text: `scrolled ${action.direction} ${amount}px`, snapshot: snap };
          }
          case "scroll_to": {
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "scroll_to requires a snapshot");
            }
            const node = findNode(snapshot, action.index);
            const scrolled = await page.evaluate<{ found: boolean; scrolled?: boolean }>(
              scrollToBwIdExpression(node.id),
            );
            if (scrolled?.found !== true) {
              throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} no longer in page`);
            }
            const snap = await settleAndExtract(page);
            return { text: `scrolled to [${node.id}]`, snapshot: snap };
          }
          case "select": {
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "select requires a snapshot");
            }
            const node = findNode(snapshot, action.index);
            if (node.tag !== "select") {
              throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is not a select`);
            }
            const result = await page.evaluate<{ found: boolean; set?: boolean; error?: string }>(
              selectBwIdExpression(node.id, action.value),
            );
            if (result?.found !== true) {
              throw new BWError("ELEMENT_NOT_FOUND", `element ${node.id} no longer in page`);
            }
            if (result.error === "not_select") {
              throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is not a select`);
            }
            if (result.error === "invalid_value") {
              throw new BWError(
                "INVALID_TOOL_ARGS",
                `value "${action.value}" is not an option of select [${node.id}]`,
              );
            }
            const snap = await settleAndExtract(page);
            return { text: `selected "${action.value}" in [${node.id}]`, snapshot: snap };
          }
          case "extract_text": {
            // 截断可见：达上限附标记+总长（用户实测「看不出哪里截断了」）
            const rawText = await page.evaluate<string>(
              `(() => { const t = (document.body && document.body.innerText) || ""; const c = t.replace(/\\s+/g, " ").trim(); return JSON.stringify({ n: c.length, t: c.slice(0, ${EXTRACT_TEXT_MAX}) }); })()`,
            );
            let parsed: { n: number; t: string };
            try {
              parsed = JSON.parse(String(rawText ?? '{"n":0,"t":""}')) as { n: number; t: string };
            } catch {
              parsed = { n: 0, t: String(rawText ?? "") };
            }
            const text =
              parsed.n > EXTRACT_TEXT_MAX
                ? `${parsed.t}\n[truncated at ${EXTRACT_TEXT_MAX}/${parsed.n} chars — scroll or extract_code for the rest]`
                : parsed.t;
            return { text, snapshot: null };
          }
          case "click_text": {
            // 用户实测（百度股市通）：React SPA 的 div-tab 无 onclick/无 role——快照
            // 收录不到，索引制失灵。按文本找可见元素→坐标轨点击（事件委托也能命中）。
            let located = await page.evaluate<{
              found: boolean;
              x?: number;
              y?: number;
              w?: number;
              h?: number;
              matches?: number;
              tag?: string;
            }>(
              `(() => {
                const want = ${JSON.stringify(action.text)}
                  .replace(/s+/g, " ")
                  .trim()
                  .toLowerCase();
                const norm = (s) => (s ?? "").replace(/s+/g, " ").trim().toLowerCase();
                const vis = (el) => {
                  const r = el.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) return false;
                  const cs = getComputedStyle(el);
                  return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
                };
                const all = [...document.querySelectorAll("*")].filter(
                  (el) =>
                    !["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) && vis(el),
                );
                // 直接文本匹配优先（叶子语义）；否则包含匹配取最小面积（最具体元素）
                let best = null;
                let matches = 0;
                for (const el of all) {
                  const direct = [...el.childNodes]
                    .filter((n) => n.nodeType === 3)
                    .map((n) => n.textContent)
                    .join("");
                  const t = norm(el.innerText || direct || "");
                  if (t === "" || !t.includes(want)) continue;
                  matches++;
                  const r = el.getBoundingClientRect();
                  const score = (t === want ? 0 : 1) * 1e9 + r.width * r.height;
                  if (best === null || score < best.score) {
                    best = { score, x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
                  }
                }
                if (best === null) return { found: false };
                return { found: true, x: best.x, y: best.y, w: best.w, h: best.h, matches, tag: best.tag };
              })()`,
            );
            if (located?.found !== true) {
              throw new BWError(
                "ELEMENT_NOT_FOUND",
                `no visible element with text "${action.text}"`,
              );
            }
            // 视口外先滚入（WebKit 对视口外坐标静默丢弃——P0-1 同教训）
            const viewport = viewportOf(snapshot ?? null);
            const outside =
              (located.y ?? 0) < 0 || (located.y ?? 0) + (located.h ?? 0) > viewport.h;
            if (outside) {
              await page.scroll(0, Math.max(0, (located.y ?? 0) - viewport.h / 2));
              const fresh = await page.evaluate<typeof located>(
                `(() => { const el = [...document.querySelectorAll("*")].find((e) => (e.innerText || "").replace(/s+/g, " ").trim().toLowerCase().includes(${JSON.stringify(action.text.toLowerCase())}) && e.getBoundingClientRect().width > 0); if (!el) return { found: false }; const r = el.getBoundingClientRect(); return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, matches: ${located.matches ?? 1}, tag: ${JSON.stringify(located.tag ?? "*")} }; })()`,
              );
              if (fresh?.found === true) located = fresh;
            }
            await page.clickAt(
              Math.round((located.x ?? 0) + (located.w ?? 0) / 2),
              Math.round((located.y ?? 0) + (located.h ?? 0) / 2),
            );
            await settle(page, page.url);
            return {
              text: `clicked <${located.tag ?? "*"} "${action.text}">${(located.matches ?? 1) > 1 ? ` (${located.matches} matches, clicked smallest/best)` : ""}`,
              snapshot: await settleAndExtract(page),
            };
          }
          case "look": {
            if (secretPages.has(pageKeyOf(page.url))) {
              // S6 尽力而为层；B5 接线后由策略强制
              throw new BWError(
                "POLICY_BLOCKED",
                "screenshot blocked: secret was typed on this page",
              );
            }
            if (action.fullPage === true) {
              // 整页截图（chrome CDP captureBeyondViewport；webkit 无对应面诚实拒绝）
              if (!driver.capabilities().cdp) {
                throw new BWError(
                  "INVALID_TOOL_ARGS",
                  "full-page screenshot requires the chrome backend (webkit has no capture-beyond-viewport)",
                );
              }
              await settle(page, page.url); // 先稳定再拍（与视口截图同语义）
              const shot = await page.cdp<{ data: string }>("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: true,
              });
              return {
                text: `[full-page screenshot captured] ${page.url} · ${page.title}`,
                snapshot: await settleAndExtract(page),
                image: { base64: shot.data, mimeType: "image/png" },
              };
            }
            await settle(page, page.url); // 截图前等待渲染稳定（实测：刚导航即拍会白屏）
            const png = await page.screenshot({ format: "png" });
            return {
              // 带页面状态：截图瞬间被风控弹走时 agent 一眼判断「截没截到目标页」
              text: `[screenshot captured] ${page.url} · ${page.title}`,
              snapshot: null,
              image: { base64: Buffer.from(png).toString("base64"), mimeType: "image/png" },
            };
          }
          case "wait": {
            const seconds = Math.min(Math.max(action.seconds, 0), WAIT_MAX_SECONDS);
            await sleep(seconds * 1000);
            // B20 §9.3：networkIdle——requests 缓冲无新增持续 1500ms 即返回（chrome-only）
            if (action.until === "networkIdle") {
              if (!driver.capabilities().networkEvents) {
                throw new BWError(
                  "INVALID_TOOL_ARGS",
                  "networkIdle requires the chrome backend (no network events on webkit)",
                );
              }
              await waitForNetworkIdle(page);
            }
            const snap =
              snapshot !== undefined && snapshot !== null ? await settleAndExtract(page) : null;
            return {
              text:
                action.until === "networkIdle"
                  ? `waited ${seconds}s + network idle`
                  : `waited ${seconds}s`,
              snapshot: snap,
            };
          }
          case "resize": {
            // 复合步强制重提取——缓存坐标全失效（B14 审查 P2-10）
            const w = Math.min(Math.max(Math.round(action.width), 1), 16384);
            const h = Math.min(Math.max(Math.round(action.height), 1), 16384);
            await page.resize(w, h);
            const snap = await settleAndExtract(page);
            return { text: `resized to ${w}x${h}`, snapshot: snap };
          }
          case "reload": {
            // 写重放闸：栈顶是 POST 落点时过 S2 提交意图（05 §3.7 审查 P6）
            if (lastNavWasPost.get(page) === true) {
              await opts?.intentSink?.({ kind: "submit", href: page.url }, action);
            }
            await page.reload();
            const snap = await settleAndExtract(page);
            return { text: `reloaded ${page.url}`, snapshot: snap };
          }
          case "download": {
            if (!driver.capabilities().download) {
              throw new BWError("INVALID_TOOL_ARGS", "download requires the chrome backend");
            }
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "download requires a snapshot");
            }
            await ensureNetworkMonitor(page);
            const node = findNode(snapshot, action.index);
            const located = await locateAndValidate(page, node);
            const intent = intentFrom(located);
            if (intent !== null) {
              await opts?.intentSink?.(intent, action);
              lastNavWasPost.set(page, intent.kind === "submit");
            }
            const path = await performDownload(page, node, located, snapshot);
            const snap = await settleAndExtract(page);
            return { text: `downloaded to ${path}`, snapshot: snap };
          }
          case "upload": {
            if (!driver.capabilities().upload) {
              throw new BWError("INVALID_TOOL_ARGS", "upload requires the chrome backend");
            }
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "upload requires a snapshot");
            }
            const node = findNode(snapshot, action.index);
            if (node.tag !== "input" || node.type !== "file") {
              throw new BWError("ELEMENT_NOT_ACTIONABLE", `element ${node.id} is not a file input`);
            }
            // 定位校验（P0-1：目的地偷换防线——漂移/可见性/inputType 三查）
            const located = await locateAndValidate(page, node);
            await performUpload(page, node, action.files, located);
            const snap = await settleAndExtract(page);
            return {
              text: `uploaded ${action.files.length} file(s) to [${node.id}]`,
              snapshot: snap,
            };
          }
          case "done": {
            return { text: action.answer ?? "", snapshot: null, done: true };
          }
          case "extract_code": {
            // B21 §10：冻结树 + vm 沙箱（p13 实证：timeout 可中断；realm 隔离见 sandbox.ts）。
            // 序列化在页锁内（evaluate）；沙箱执行纯内存无锁竞争。
            // snapshot:null——提取不改 DOM，缓存快照仍有效（extract_text 同例）；
            // 附新快照反而让压缩器把提取数据当快照淘汰（B21 审查 P2-6），还白付 settle 等待
            const tree = await serializeDomTree(page);
            const r = await runTreeCode(action.code, tree.root);
            if (!r.ok) {
              throw new BWError("INVALID_TOOL_ARGS", `extract_code: ${r.error}`);
            }
            return {
              // 截断必须可见——树超 10000 节点被裁时结果可能不完整，
              // 静默丢数据比告警更糟（LLM/调用方可据此换策略或分块提取）
              text: tree.truncated
                ? `${r.text ?? "null"}\n[warn] DOM tree truncated at 10000-node cap — data may be incomplete`
                : (r.text ?? "null"),
              snapshot: null,
            };
          }
          case "batch": {
            // B20：引擎不执行 batch——agent/sessions 两层各自逐步闸执行（B20 审查 P3-14
            // 删除三份重复循环；此分支防御「直调引擎的调用方」并给出可自纠错误）
            throw new BWError(
              "INVALID_TOOL_ARGS",
              "batch must go through the tool layer (agent batch tool / sessions batch) — not the engine",
            );
          }
          default: {
            const never: never = action;
            throw new BWError("DRIVER_ERROR", `unhandled action: ${JSON.stringify(never)}`);
          }
        }
      });
    },
  };
}
