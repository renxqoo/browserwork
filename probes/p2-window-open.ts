/** p2: window.open 的归宿——新 view？替换当前页？静默丢弃？ */
import { result, servePage, withTimeout } from "./helpers/kit.ts";

const { origin, close } = await servePage(
  `<button id="b" onclick="window.open('/target.html')">open</button>`,
  { "/target.html": "<title>BW Target</title><h1>target page</h1>" },
);
const view = new Bun.WebView();
const navEvents: Array<[string, string]> = [];
view.onNavigated = (url, title) => navEvents.push([url, title]);
await view.navigate(`${origin}/`);
navEvents.length = 0;

let clickOutcome = "resolved";
try {
  await withTimeout(view.click("#b"), 6000, "click(window.open)");
} catch (e) {
  clickOutcome = e instanceof Error ? e.message.slice(0, 100) : String(e);
}
await new Promise((r) => setTimeout(r, 1500)); // 给潜在导航留时间

result("p2.clickOutcome", clickOutcome);
result("p2.navEventsAfterClick", navEvents);
result("p2.finalUrl", view.url);
result("p2.finalTitle", view.title);
result(
  "p2.domStillSource",
  await view
    .evaluate<string | null>(
      "document.body ? document.body.textContent?.slice(0, 60) ?? null : null",
    )
    .catch((e: unknown) => `ERR: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`),
);
view.close();
close();
