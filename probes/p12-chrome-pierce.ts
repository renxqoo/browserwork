/**
 * p12：chrome 后端引擎级提取探针（B20 §9.2 前置）。
 * (a) DOM.getDocument{depth:-1,pierce:true} 能否见 closed shadow DOM 与 iframe 树
 * (b) Target.setAutoAttach + 子会话能否进跨域 OOPIF
 * (c) DOM.getContentQuads 几何可用性
 */
import { result, withTimeout } from "./helpers/kit.ts";

// 跨域 iframe 域先起（主域 HTML 引用其端口）
const serverB = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/frame") {
      return new Response(
        '<!doctype html><title>XF</title><button id="cross-btn">Cross Origin Btn</button>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("nf", { status: 404 });
  },
});
const portB = serverB.port;

const serverA = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/") {
      return new Response(
        `<!doctype html><title>P12</title>
<div id="host"></div>
<iframe id="xf" src="http://127.0.0.1:${portB}/frame"></iframe>
<script>
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<button id="closed-btn" data-testid="shadow-submit">Closed Shadow Btn</button>';
  window.__probeDone = true;
</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("nf", { status: 404 });
  },
});
const originA = `http://127.0.0.1:${serverA.port}`;

const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    const v = await withTimeout(fn(), 12_000, name);
    result(`p12.${name}`, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    result(`p12.${name}`, `ERR: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`);
  }
};

const view = new Bun.WebView({ width: 900, height: 700, backend: { type: "chrome", url: false } });
try {
  await withTimeout(view.navigate(`${originA}/`), 20_000, "init");
  await new Promise((r) => setTimeout(r, 800));

  await step("jsShimBaseline", async () =>
    view.evaluate(
      `(() => ({
        closedRootNull: document.getElementById('host').shadowRoot === null,
        shadowBtnInDom: !!document.querySelector('#closed-btn, [data-testid=shadow-submit]'),
        xfDocBlocked: (() => { try { const d = document.getElementById('xf').contentDocument; return d === null; } catch { return true; } })()
      }))()`,
    ),
  );

  await step("pierceDocument", async () => {
    const doc = (await view.cdp("DOM.getDocument", { depth: -1, pierce: true })) as {
      root?: Record<string, unknown>;
    };
    const root = doc.root ?? {};
    const findFrameContent = (n: unknown): boolean | undefined => {
      const node = n as { nodeName?: string; children?: unknown[]; contentDocument?: unknown };
      if (node?.nodeName === "IFRAME") return node.contentDocument !== undefined;
      for (const c of node?.children ?? []) {
        const r = findFrameContent(c);
        if (r !== undefined) return r;
      }
      return undefined;
    };
    return {
      hasShadowChildren: Array.isArray(root.shadowRootChildNodes),
      shadowChildCount: (root.shadowRootChildNodes as unknown[] | undefined)?.length ?? 0,
      iframeHasContentDoc: findFrameContent(root) === true,
    };
  });

  await step("pierceQuerySelector", async () => {
    const doc = (await view.cdp("DOM.getDocument", { depth: -1, pierce: true })) as {
      root?: { nodeId?: number };
    };
    const q = (await view.cdp("DOM.querySelector", {
      nodeId: doc.root?.nodeId,
      selector: "[data-testid=shadow-submit]",
    })) as { nodeId?: number };
    return { foundInClosedShadow: (q.nodeId ?? 0) > 0, nodeId: q.nodeId };
  });

  await step("deepTreeWalk", async () => {
    // 深树遍历：closed shadow 子树与跨域 iframe 内按钮都以节点形式存在？
    const doc = (await view.cdp("DOM.getDocument", { depth: -1, pierce: true })) as {
      root?: unknown;
    };
    let shadowBtn: number | undefined;
    let crossBtn: number | undefined;
    let shadowHosts = 0;
    const KEY = "attributes" as const;
    const walk = (n: unknown): void => {
      const node = n as {
        nodeId?: number;
        nodeName?: string;
        [KEY]?: number[];
        children?: unknown[];
        shadowRootChildNodes?: unknown[];
        contentDocument?: unknown;
      };
      if (node.shadowRootChildNodes !== undefined) shadowHosts += 1;
      if (Array.isArray(node.attributes)) {
        // attributes 是 [name1,value1,name2,value2...] 扁平数组
        const attrs = node.attributes;
        for (let i = 0; i < attrs.length; i += 2) {
          if (String(attrs[i]) === "data-testid" && String(attrs[i + 1]) === "shadow-submit") {
            shadowBtn = node.nodeId;
          }
          if (String(attrs[i]) === "id" && String(attrs[i + 1]) === "cross-btn") {
            crossBtn = node.nodeId;
          }
        }
      }
      for (const c of node.children ?? []) walk(c);
      for (const c of node.shadowRootChildNodes ?? []) walk(c);
      if (node.contentDocument !== undefined) walk(node.contentDocument);
    };
    walk(doc.root);
    // 几何：两个节点都试 getContentQuads
    const geo = async (id: number | undefined) => {
      if (id === undefined) return null;
      const quads = (await view.cdp("DOM.getContentQuads", { nodeId: id })) as {
        quads?: number[][];
      };
      return (quads?.quads?.length ?? 0) > 0;
    };
    return {
      shadowHosts,
      shadowBtnNodeId: shadowBtn ?? 0,
      crossBtnNodeId: crossBtn ?? 0,
      shadowBtnGeometry: await geo(shadowBtn),
      crossBtnGeometry: await geo(crossBtn),
    };
  });

  await step("contentQuads", async () => {
    const doc = (await view.cdp("DOM.getDocument", { depth: -1, pierce: true })) as {
      root?: { nodeId?: number };
    };
    const q = (await view.cdp("DOM.querySelector", {
      nodeId: doc.root?.nodeId,
      selector: "[data-testid=shadow-submit]",
    })) as { nodeId?: number };
    if ((q.nodeId ?? 0) <= 0) return { skipped: "not found" };
    const quads = (await view.cdp("DOM.getContentQuads", { nodeId: q.nodeId })) as {
      quads?: number[][];
    };
    return { hasGeometry: (quads?.quads?.length ?? 0) > 0 };
  });

  await step("ooifAutoAttach", async () => {
    let attached: unknown = null;
    view.addEventListener("Target.attachedToTarget", (e: Event) => {
      attached =
        (e as CustomEvent).detail ?? (e as unknown as { data?: unknown }).data ?? "event-fired";
    });
    await view.cdp("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await new Promise((r) => setTimeout(r, 1200));
    return { attachedToTarget: attached !== null, payload: attached };
  });
} catch (e) {
  result("p12.fatal", e instanceof Error ? e.message : String(e));
} finally {
  view.close();
  serverA.stop(true);
  serverB.stop(true);
}
