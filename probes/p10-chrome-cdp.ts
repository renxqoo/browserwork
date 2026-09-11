/**
 * p10：chrome 后端 CDP 面探针（B14 前置，05 §6）。
 * 每步带超时护栏（任一步挂死不拖整个脚本）：
 * ① view.cdp() 基本命令 ② CDP 事件订阅 ③ resize ④ goBack+onNavigated
 * ⑤ Emulation.setUserAgentOverride ⑥ Runtime.evaluate objectId
 */
import { result, servePage, withTimeout } from "./helpers/kit.ts";

const page = (title: string): string =>
  `<!doctype html><title>${title}</title><a href="/b">to B</a>`;
const { origin, close } = await servePage(page("P10 A"), {
  "/b": page("P10 B"),
  "/echo-ua": "<!doctype html><script>document.title = navigator.userAgent</script>",
});

const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    const v = await withTimeout(fn(), 12_000, name);
    result(`p10.${name}`, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    result(`p10.${name}`, `ERR: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }
};

const view = new Bun.WebView({ width: 800, height: 600, backend: { type: "chrome", url: false } });
try {
  await withTimeout(view.navigate(`${origin}/`), 20_000, "init navigate");
  await step("cdpCommand", async () => {
    const r = (await view.cdp("DOM.getDocument", {})) as { root?: { nodeId?: number } };
    return r.root?.nodeId;
  });
  await step("cdpEvent", async () => {
    await view.cdp("Network.enable", {});
    let saw = false;
    view.addEventListener("Network.requestWillBeSent", () => {
      saw = true;
    });
    await view.navigate(`${origin}/b`);
    await new Promise((r) => setTimeout(r, 800));
    return saw;
  });
  await step("resize", async () => {
    await view.resize(1024, 768);
    await new Promise((r) => setTimeout(r, 300));
    return view.evaluate("{ w: window.innerWidth, h: window.innerHeight }");
  });
  await step("backOnNavigated", async () => {
    let fired: string | null = null;
    view.onNavigated = (url: string) => {
      fired = url;
    };
    await view.back();
    await new Promise((r) => setTimeout(r, 1000));
    return { url: view.url, fired };
  });
  await step("uaOverride", async () => {
    await view.navigate(`${origin}/`);
    await view.cdp("Emulation.setUserAgentOverride", { userAgent: "BW-Test-Agent/1.0" });
    await view.navigate(`${origin}/echo-ua`);
    await new Promise((r) => setTimeout(r, 600));
    return view.evaluate<string>("navigator.userAgent");
  });
  await step("objectId", async () => {
    const r = (await view.cdp("Runtime.evaluate", {
      expression: "document.querySelector('a')",
      returnByValue: false,
    })) as { result?: { objectId?: string; type?: string } };
    return { has: r.result?.objectId !== undefined, type: r.result?.type };
  });
  await step("setFileInputFiles", async () => {
    const r = (await view.cdp("DOM.getDocument", {})) as { root?: { nodeId?: number } };
    const { nodeId } = (await view.cdp("DOM.querySelector", {
      nodeId: r.root?.nodeId,
      selector: "a",
    })) as { nodeId: number };
    return { querySelectorNodeId: nodeId > 0 };
  });
} catch (e) {
  result("p10.fatal", e instanceof Error ? e.message : String(e));
} finally {
  view.close();
  close();
}
