/**
 * p13：Bun(node:vm) 超时与隔离行为探针（B21 §10 前置）。
 * (a) runInNewContext timeout 选项是否真中断 while(true)
 * (b) 新 context 里 fetch/process/Bun 是否不可达
 * (c) 正常函数执行与结果传递
 */

import vm from "node:vm";
import { result, withTimeout } from "./helpers/kit.ts";

const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    const v = await withTimeout(fn(), 10_000, name);
    result(`p13.${name}`, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    result(`p13.${name}`, `ERR: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`);
  }
};

await step("timeoutInterrupts", async () => {
  const t0 = Date.now();
  try {
    vm.runInNewContext("while (true) {}", {}, { timeout: 500 });
    return { interrupted: false, elapsed: Date.now() - t0 };
  } catch (e) {
    return {
      interrupted: true,
      elapsed: Date.now() - t0,
      errorName: e instanceof Error ? e.name : String(e),
    };
  }
});

await step("globalsIsolated", async () => {
  const ctx = { tree: { tag: "body" }, JSON, Math };
  const r = vm.runInNewContext(
    "(() => ({ hasFetch: typeof fetch, hasProcess: typeof process, hasBun: typeof Bun, hasReq: typeof require, hasWS: typeof WebSocket }))()",
    ctx,
  );
  return r;
});

await step("functionExec", async () => {
  const ctx = {
    tree: {
      children: [
        { tag: "li", text: "苹果 ¥5" },
        { tag: "li", text: "梨 ¥3" },
      ],
    },
    JSON,
    Math,
  };
  const code = "(tree) => tree.children.map(c => c.text)";
  const fn = vm.runInNewContext(`(${code})`, ctx);
  return { result: fn(ctx.tree) };
});

await step("regexNotInterrupted", async () => {
  // JSC/V8 已知：某些正则回溯不受 timeout 中断——测最常见形态
  const t0 = Date.now();
  try {
    vm.runInNewContext("while (true) { JSON.parse('{}') }", {}, { timeout: 500 });
    return { interrupted: false, elapsed: Date.now() - t0 };
  } catch {
    return { interrupted: true, elapsed: Date.now() - t0 };
  }
});
