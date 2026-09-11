/**
 * p11：chrome 后端 CDP 深挖（B14 前置续）。
 * ① reload/back/forward 运行时存在性 ② DOM.querySelector 正确场景
 * ③ Runtime.evaluate objectId（objectGroup 变体）④ DOM.performSearch 穿 shadow
 * ⑤ Browser.setDownloadBehavior + Page.downloadWillBegin（下载链路）
 */
import { result, servePage, withTimeout } from "./helpers/kit.ts";

const { origin, close } = await servePage(
  `<!doctype html><title>P11</title>
<input type="file" id="f" data-bw-id="9">
<div id="host"></div>
<script>
  const s = host.attachShadow({ mode: "open" });
  s.innerHTML = '<button id="sb" data-bw-id="7">shadow btn</button>';
</script>`,
  {
    "/dl": "download-target",
    "/file": "x".repeat(64),
  },
);

const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    const v = await withTimeout(fn(), 12_000, name);
    result(`p11.${name}`, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    result(`p11.${name}`, `ERR: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }
};

const view = new Bun.WebView({ width: 800, height: 600, backend: { type: "chrome", url: false } });
const v = view as unknown as Record<string, unknown>;
try {
  await withTimeout(view.navigate(`${origin}/`), 20_000, "init navigate");
  await step("runtimeMethods", async () => ({
    reload: typeof v.reload,
    back: typeof v.back,
    forward: typeof v.forward,
    resize: typeof v.resize,
  }));
  await step("querySelector", async () => {
    const doc = (await view.cdp("DOM.getDocument", { depth: -1 })) as {
      root?: { nodeId?: number };
    };
    const q = (await view.cdp("DOM.querySelector", {
      nodeId: doc.root?.nodeId,
      selector: '[data-bw-id="9"]',
    })) as { nodeId?: number };
    return { rootId: doc.root?.nodeId, hitId: q.nodeId };
  });
  await step("objectIdObjectGroup", async () => {
    const r = (await view.cdp("Runtime.evaluate", {
      expression: "document.querySelector('[data-bw-id=\"9\"]')",
      returnByValue: false,
      objectGroup: "bw-upload",
    })) as { result?: Record<string, unknown> };
    return r.result;
  });
  await step("performSearch", async () => {
    const s = (await view.cdp("DOM.performSearch", {
      query: '[data-bw-id="7"]',
    })) as { searchId?: string; resultCount?: number };
    if (s.searchId === undefined || s.resultCount === 0) return s;
    const nodes = (await view.cdp("DOM.getSearchResults", {
      searchId: s.searchId,
      fromIndex: 0,
      toIndex: s.resultCount,
    })) as { nodeIds?: number[] };
    await view.cdp("DOM.discardSearchResults", { searchId: s.searchId });
    return { count: s.resultCount, nodeIds: nodes.nodeIds };
  });
  await step("downloadEvents", async () => {
    await view.cdp("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: "/tmp/bw-p11-dl",
      eventsEnabled: true,
    });
    let willBegin: unknown = null;
    view.addEventListener("Page.downloadWillBegin", (e: Event) => {
      willBegin = (e as CustomEvent).detail ?? (e as unknown as { data: unknown }).data ?? "fired";
    });
    // anchor click 触发下载（/file 是纯文本——Chrome 对导航到文件也算下载）
    await view.evaluate(
      `(() => { const a = document.createElement('a'); a.href = '/file'; a.download='p11.txt'; document.body.appendChild(a); a.click(); return 'clicked'; })()`,
    );
    await new Promise((r) => setTimeout(r, 2500));
    return { willBegin };
  });
} catch (e) {
  result("p11.fatal", e instanceof Error ? e.message : String(e));
} finally {
  view.close();
  close();
}
