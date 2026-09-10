/** p1: 点击触发 alert() 的按钮——click 会挂死、报错还是被自动处理？后续 evaluate 是否被阻塞？ */
import { result, servePage, withTimeout } from "./helpers/kit.ts";

const { origin, close } = await servePage(
  `<button id="b" onclick="alert('boom')">go</button><span id="after">idle</span>`,
);
const view = new Bun.WebView();
await view.navigate(`${origin}/`);

let clickOutcome = "resolved";
try {
  await withTimeout(view.click("#b"), 6000, "click(alert button)");
} catch (e) {
  clickOutcome = e instanceof Error ? e.message.slice(0, 100) : String(e);
}

let evalOutcome = "ok";
try {
  await withTimeout(view.evaluate("1+1"), 4000, "evaluate after alert");
} catch (e) {
  evalOutcome = e instanceof Error ? e.message.slice(0, 100) : String(e);
}

let afterText: string | null = null;
try {
  afterText = await withTimeout(
    view.evaluate<string | null>("document.querySelector('#after')?.textContent ?? null"),
    4000,
    "evaluate text",
  );
} catch {
  afterText = null;
}

result("p1.clickOutcome", clickOutcome);
result("p1.evalAfterClick", evalOutcome);
result("p1.afterText", afterText);
view.close();
close();
