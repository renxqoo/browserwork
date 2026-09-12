/**
 * B21 §10：extract_code 沙箱执行器——Worker + vm 双层。
 * - Worker 层：CPU 硬杀。p13 探针：vm.runInNewContext 的 timeout 在独立脚本生效、
 *   在 bun test 环境不中断（JSC 中断被 runner 抑制）——所以中断手段是 Worker
 *   terminate（对任何同步代码都硬杀）。
 * - vm 层：realm 隔离。B21 审查 P0：宿主对象（tree/JSON/Math）一旦进 context，
 *   `X.constructor.constructor` 即编译回 Worker realm（process/Bun/fetch 全可达，
 *   审查员实测复现）。修法：context 零宿主对象——tree 以 JSON 字符串字面量内嵌
 *   脚本、在目标 realm 内 parse；JSON/Math 用裸 context 自带 intrinsics。
 *   剩余逃逸面属引擎漏洞类（vm 非硬安全边界，与 Node 同告诫）——但默认面
 *   无宿主引用可达，与 eval（页面内任意代码）是两个量级。
 * Worker 源码内嵌字符串——单文件 build 无外部依赖。
 */
import { Worker } from "node:worker_threads";

export const EXTRACT_CODE_MAX_CHARS = 4_000;
export const EXTRACT_RESULT_MAX_CHARS = 8_000;
export const EXTRACT_CODE_TIMEOUT_MS = 3_000;

export interface ExtractCodeResult {
  ok: boolean;
  /** 结果 JSON 字符串 */
  text?: string;
  error?: string;
}

/** Worker 内运行的脚本（vm 执行 + 单条消息返回） */
const WORKER_SRC = `
const vm = require("node:vm");
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (m) => {
  try {
    // 跨隔离带不走宿主对象：tree 内嵌为字符串字面量、目标 realm 内 parse
    const script =
      "(() => { const fn = (" + m.code + ");" +
      ' if (typeof fn !== "function") throw new Error("code must be a function expression like (tree) => ...");' +
      " return fn(JSON.parse(" + JSON.stringify(JSON.stringify(m.tree)) + ")); })()";
    let result;
    try { result = vm.runInNewContext(script, {}); } catch (e) {
      parentPort.postMessage({ ok: false, error: "runtime error: " + (e && e.message ? e.message : String(e)) });
      return;
    }
    if (result === undefined) {
      parentPort.postMessage({ ok: false, error: "code returned undefined" });
      return;
    }
    let text;
    try { text = JSON.stringify(result); } catch {
      parentPort.postMessage({ ok: false, error: "result is not JSON-serializable (circular reference?)" });
      return;
    }
    if (text === undefined) {
      parentPort.postMessage({ ok: false, error: "result is not JSON-serializable (function/symbol?)" });
      return;
    }
    if (text.length > ${EXTRACT_RESULT_MAX_CHARS}) {
      // 超限拒绝而非裁断——截断的 JSON 是无效 JSON，违背「返回值 JSON 化」契约（审查 P2-5）
      parentPort.postMessage({ ok: false, error: "result too large (" + text.length + " chars > ${EXTRACT_RESULT_MAX_CHARS}) — project to fewer fields or shorter strings" });
      return;
    }
    parentPort.postMessage({ ok: true, text });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
});
`;

export function runTreeCode(
  code: string,
  tree: unknown,
  opts?: { timeoutMs?: number },
): Promise<ExtractCodeResult> {
  if (code.length > EXTRACT_CODE_MAX_CHARS) {
    return Promise.resolve({
      ok: false,
      error: `code exceeds limit (${EXTRACT_CODE_MAX_CHARS} chars)`,
    });
  }
  const timeoutMs = opts?.timeoutMs ?? EXTRACT_CODE_TIMEOUT_MS;
  return new Promise<ExtractCodeResult>((resolve) => {
    let settled = false;
    let worker: import("node:worker_threads").Worker;
    try {
      worker = new Worker(WORKER_SRC, { eval: true });
    } catch (e) {
      resolve({
        ok: false,
        error: `worker spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const finish = (r: ExtractCodeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    worker.on("message", (m: ExtractCodeResult) => finish(m));
    worker.on("error", (e: Error) => finish({ ok: false, error: e.message.slice(0, 200) }));
    worker.on("exit", (code2: number) => {
      if (!settled && code2 !== 0) finish({ ok: false, error: `worker exited (${code2})` });
    });
    worker.postMessage({ code, tree });
  });
}
