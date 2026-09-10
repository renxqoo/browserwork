/**
 * Fake 世界帮手：用表达式内容特征分发 evaluate（settle/locate/scroll/select/
 * enter-intent/extract/正文），驱动引擎的 fake 单元测试。
 * 真实 seam（表达式字符串 ↔ 引擎）由真 webkit 集成旅程覆盖。
 */

import { FakeDriver, type FakePage } from "@bw/driver";
import type { LocateResult } from "@bw/perception";
import { EXTRACT_EXPRESSION } from "@bw/perception";

export interface FakeWorldOptions {
  locateResults: Record<string, LocateResult>;
  /** extractSnapshot 返回的原始形态 */
  rawExtract: {
    nodes: Array<Record<string, unknown>>;
    headings?: Array<{ tag: string; text: string }>;
    title?: string;
  };
  enterSubmit?: { submit: boolean; action?: string; method?: string };
  bodyText?: string;
  quietMs?: number; // settle 表达式返回值（默认 = 已静默）
  /** 优先分发（返回 undefined 则走默认特征分发）——inspect/eval 类表达式用 */
  extraEvaluate?: (expression: string) => unknown;
}

export interface FakeWorld {
  driver: FakeDriver;
  pageOf(index: number): FakePage;
  /** 记录一切被创建的 page（driver.close 后注册表清空，实例引用仍可用） */
  createdPages: import("@bw/driver").FakePage[];
  setLocate(id: string, result: LocateResult): void;
  setRawNodes(nodes: Array<Record<string, unknown>>): void;
}

export function makeFakeWorld(opts: FakeWorldOptions): FakeWorld {
  const locateResults: Record<string, LocateResult> = { ...opts.locateResults };
  // FakePage.click 命中表（可变数组，与 locate 结果保持同步）
  const selectors: string[] = Object.keys(locateResults).map((id) => `[data-bw-id="${id}"]`);
  let rawNodes: Array<Record<string, unknown>> = [...opts.rawExtract.nodes];
  const createdPages: import("@bw/driver").FakePage[] = [];
  const world: FakeWorld = {
    createdPages,
    driver: new FakeDriver(
      {
        cdp: false,
        upload: false,
        download: false,
        dialogEvents: false,
        userAgentOverride: false,
        pierceClick: false,
      },
      {
        selectors,
        evaluateHandler: (expr) => {
          const extra = opts.extraEvaluate?.(expr);
          if (extra !== undefined) return extra;
          if (expr === EXTRACT_EXPRESSION) {
            return {
              nodes: rawNodes,
              headings: opts.rawExtract.headings ?? [],
              warnings: [],
              title: opts.rawExtract.title ?? "fake",
              url: "https://fake.test/page",
              scrollY: 0,
              scrollX: 0,
              docHeight: 1000,
              viewportH: 720,
            };
          }
          if (expr.includes("__bwSettle")) return opts.quietMs ?? 10_000;
          if (expr.includes("activeElement")) return opts.enterSubmit ?? { submit: false };
          if (expr.includes("document.body") && expr.includes("innerText")) {
            return opts.bodyText ?? "fake body text";
          }
          // bwId 表达式族（locate.ts 的选择器是拼接形式：'[data-bw-id="' + "7" + '"]'）
          const wanted = /'\[data-bw-id="' \+ "([^"]+)"/.exec(expr)?.[1];
          if (wanted !== undefined) {
            if (expr.includes("scrollIntoView")) {
              const r = locateResults[wanted];
              return r?.found === true ? { found: true, scrolled: true } : { found: false };
            }
            if (expr.includes("HTMLSelectElement")) {
              if (!locateResults[wanted]) return { found: false };
              return { found: true, set: true };
            }
            return locateResults[wanted] ?? { found: false };
          }
          return null;
        },
      },
    ),
    pageOf(index: number): FakePage {
      const pages = world.driver.pages();
      const page = pages[index];
      if (page === undefined) throw new Error(`no fake page ${index}`);
      return page as FakePage;
    },
    setLocate(id, result) {
      locateResults[id] = result;
      const sel = `[data-bw-id="${id}"]`;
      if (!selectors.includes(sel)) selectors.push(sel);
    },
    setRawNodes(nodes) {
      rawNodes = nodes;
    },
  };
  const origCreate = world.driver.createPage.bind(world.driver);
  world.driver.createPage = async (opts?: never) => {
    const page = (await origCreate(opts)) as import("@bw/driver").FakePage;
    createdPages.push(page);
    return page;
  };
  return world;
}

/** 便捷：主文档可见 input 节点 + 匹配的 locate 结果；locate 键用于覆写定位结果 */
export function fakeNode(id: string, overrides: Record<string, unknown> = {}) {
  const node = {
    id,
    tag: "input",
    type: "text",
    text: "",
    x: 100,
    y: 200,
    w: 200,
    h: 30,
    below: false,
    above: false,
    ...overrides,
  };
  const { found: _found, ...locateOverride } = (overrides.locate ?? {}) as Partial<LocateResult>;
  const locate: LocateResult = {
    found: true,
    tag: node.tag,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    origin: "https://fake.test",
    inShadow: false,
    inFrame: false,
    ...locateOverride,
  };
  return { node, locate };
}
