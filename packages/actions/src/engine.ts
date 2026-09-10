/**
 * 动作引擎（docs/03-units.md U4）。
 * 每 page 互斥锁吸收平台跨槽并发；复合步 = 校验 → 意图解析 → 执行 →
 * settle → 重提取；错误一律 throw BWError（LLM 自纠通道）。
 */
import { type BrowserAction, BWError, type NavigationIntent } from "@bw/core";
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
} from "@bw/perception";

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
  /** 页面状态读取/写入（锁内，B11）：console/errors 缓冲、cookies、localStorage */
  inspect(kind: InspectKind, params?: InspectParams): Promise<string>;
  /** 受控 eval（锁内 + 超时 + 结果截断，B11）——会话模式须显式 opt-in */
  runExpression(expression: string): Promise<string>;
}

/** inspect 类目（B11：对齐 agent-browser 的 get/debug 面，只取安全子集） */
export type InspectKind =
  | "console"
  | "errors"
  | "cookies"
  | "cookies_set"
  | "cookies_clear"
  | "storage"
  | "storage_set"
  | "storage_clear";

export interface InspectParams {
  key?: string;
  value?: string;
}

const EXTRACT_TEXT_MAX = 4000;
const WAIT_MAX_SECONDS = 30;
const SCROLL_STEP_PX = 600;
const EVAL_TIMEOUT_MS = 10_000;
const EVAL_MAX_RESULT = 8000;

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

  /** JSON 参数安全内嵌（引号/换行转义后拼入页面表达式） */
  const lit = (s: string): string => JSON.stringify(s);

  const inspect = async (kind: InspectKind, params?: InspectParams): Promise<string> => {
    const page = ensureActive();
    return runExclusive(page, async () => {
      switch (kind) {
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

  const runExpression = async (expression: string): Promise<string> => {
    const page = ensureActive();
    return runExclusive(page, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
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
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  };

  return {
    activePage: ensureActive,
    inspect,
    runExpression,

    async act(action: BrowserAction, snapshot?: Snapshot | null): Promise<ActionResult> {
      // open_tab 在锁外创建新页（自身无竞态面）
      if (action.kind === "open_tab") {
        const page = await driver.createPage({ url: action.url });
        active = page;
        const snap = await runExclusive(page, () => settleAndExtract(page));
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
        const snap = await runExclusive(page, () => settleAndExtract(page));
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
        switch (action.kind) {
          case "navigate": {
            await page.navigate(action.url, { timeoutMs: 30_000 });
            const snap = await settleAndExtract(page);
            return { text: `navigated to ${page.url}`, snapshot: snap };
          }
          case "click": {
            if (snapshot === undefined || snapshot === null) {
              throw new BWError("INVALID_TOOL_ARGS", "click requires a snapshot (extract first)");
            }
            const node = findNode(snapshot, action.index);
            const located = await locateAndValidate(page, node);
            const intent = intentFrom(located);
            if (intent !== null) {
              await opts?.intentSink?.(intent, action);
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
            const text = await page.evaluate<string>(
              `(() => { const t = (document.body && document.body.innerText) || ""; return t.replace(/\\s+/g, " ").trim().slice(0, ${EXTRACT_TEXT_MAX}); })()`,
            );
            return { text: text ?? "", snapshot: null };
          }
          case "look": {
            if (secretPages.has(pageKeyOf(page.url))) {
              // S6 尽力而为层；B5 接线后由策略强制
              throw new BWError(
                "POLICY_BLOCKED",
                "screenshot blocked: secret was typed on this page",
              );
            }
            const png = await page.screenshot({ format: "png" });
            return {
              text: "[screenshot captured]",
              snapshot: null,
              image: { base64: Buffer.from(png).toString("base64"), mimeType: "image/png" },
            };
          }
          case "wait": {
            const seconds = Math.min(Math.max(action.seconds, 0), WAIT_MAX_SECONDS);
            await sleep(seconds * 1000);
            const snap =
              snapshot !== undefined && snapshot !== null ? await settleAndExtract(page) : null;
            return { text: `waited ${seconds}s`, snapshot: snap };
          }
          case "done": {
            return { text: action.answer ?? "", snapshot: null, done: true };
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
