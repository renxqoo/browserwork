/** p8: 重定向链——onNavigated 上报的是最终 URL 还是中间跳？view.url 终值？（S1③ 事后复检的数据源） */
import { result, servePage } from "./helpers/kit.ts";

const { origin, close } = await servePage("<title>BW Final</title><h1>final</h1>", {
  "/mid": "<title>BW Mid</title><p>mid</p>",
});
const view = new Bun.WebView();
const events: Array<[string, string]> = [];
view.onNavigated = (url, title) => events.push([url, title]);

// 单跳：/redirect → /mid
await view.navigate(`${origin}/redirect?to=${encodeURIComponent(`${origin}/mid`)}`);
result("p8.singleHopEvents", events);
result("p8.singleHopFinalUrl", view.url);
result("p8.singleHopFinalTitle", view.title);

// 三跳链：/redirect → /redirect → /
events.length = 0;
const inner = encodeURIComponent(`${origin}/`);
const middle = encodeURIComponent(`${origin}/redirect?to=${inner}`);
await view.navigate(`${origin}/redirect?to=${middle}`);
result("p8.chain3Events", events);
result("p8.chain3FinalUrl", view.url);
view.close();
close();
