/** p6: data-bw-id 在页面自渲染（模拟 hydration/重渲染）下的存活 */
import { EXTRACT_EXPRESSION } from "@bw/perception";
import { result, servePage, withTimeout } from "./helpers/kit.ts";

interface RawSnap {
  nodes: Array<{ id: string; text?: string }>;
}

const { origin, close } =
  await servePage(`<div id="zone"><button id="btn">重渲染区按钮</button></div>
<script>
  setInterval(() => {
    const z = document.getElementById('zone');
    if (z) z.innerHTML = '<button id="btn">重渲染区按钮</button>';
  }, 120);
</script>`);

const view = new Bun.WebView();
await view.navigate(`${origin}/`);
const snap1 = await withTimeout(view.evaluate<RawSnap>(EXTRACT_EXPRESSION), 5000, "extract 1");
const target = snap1.nodes.find((n) => n.text?.includes("重渲染区按钮"));
const idAtT0 = target?.id;

await new Promise((r) => setTimeout(r, 600)); // 经历 ≥4 次重渲染
const survives = await withTimeout(
  view.evaluate<boolean>(`Boolean(document.querySelector('[data-bw-id="${idAtT0}"]'))`),
  4000,
  "check id survival",
);
const snap2 = await withTimeout(view.evaluate<RawSnap>(EXTRACT_EXPRESSION), 5000, "extract 2");
const target2 = snap2.nodes.find((n) => n.text?.includes("重渲染区按钮"));

result("p6.idAtT0", idAtT0);
result("p6.survivesRerender", survives);
result("p6.reextractAssignsNewId", target2?.id);
result("p6.reextractWorks", Boolean(target2));
view.close();
close();
