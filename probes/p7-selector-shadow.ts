/** p7: click(selector) 能否命中 shadow DOM 内元素（pierceClick 能力定标） + 坐标轨对照 */
import { result, servePage, withTimeout } from "./helpers/kit.ts";

const { origin, close } = await servePage(
  `<div id="host"></div><span id="hit">no</span>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="inner" data-bw-id="77">shadow btn</button>';
  root.getElementById('inner').addEventListener('click', () => {
    document.getElementById('hit').textContent = 'yes';
  });
</script>`,
);
const view = new Bun.WebView();
await view.navigate(`${origin}/`);

let selectorOutcome = "resolved";
try {
  await withTimeout(
    view.click('[data-bw-id="77"]', { timeout: 4000 }),
    6000,
    "click shadow selector",
  );
} catch (e) {
  selectorOutcome = e instanceof Error ? e.message.slice(0, 110) : String(e);
}

// 坐标轨对照
const rect = await view.evaluate<{ x: number; y: number; w: number; h: number }>(
  `(() => { const r = document.getElementById('host').shadowRoot.getElementById('inner').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
);
await view.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
const hit = await view.evaluate<string>("document.getElementById('hit').textContent");

result("p7.selectorTrack", selectorOutcome);
result("p7.coordinateTrackHit", hit);
view.close();
close();
