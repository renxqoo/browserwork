/** p9: chrome 后端 url:false 独立拉起（P1-11 铁律验证）——需本机装有 Chrome/Edge */
import { result, servePage, withTimeout } from "./helpers/kit.ts";

const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const exists = await Bun.file(chromeApp).exists();
if (!exists) {
  result("p9.chromeInstalled", false);
  process.exit(0);
}
result("p9.chromeInstalled", true);

const { origin, close } = await servePage("<title>BW Chrome</title><h1>on chrome</h1>");
let view: Bun.WebView;
try {
  view = new Bun.WebView({ backend: { type: "chrome", url: false } });
} catch (e) {
  result("p9.construct", `ERR: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
  close();
  process.exit(0);
}
try {
  await withTimeout(view.navigate(`${origin}/`), 20_000, "chrome navigate");
  const title = await withTimeout(view.evaluate<string>("document.title"), 10_000, "chrome eval");
  result("p9.navigateAndEvaluate", title);
} catch (e) {
  result(
    "p9.navigateAndEvaluate",
    `ERR: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
  );
} finally {
  view.close();
  close();
}
