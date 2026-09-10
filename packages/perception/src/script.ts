/**
 * 页面内提取表达式（docs/03-units.md U3）。
 * Bun evaluate 包装为 await (<expr>) —— 因此必须是表达式（IIFE）。
 * 结果经 JSON.stringify 往返：只返回可序列化结构。
 *
 * v0 范围（B1 切片）：主文档 light DOM；不可见过滤为基础集（display/visibility/
 * opacity/字号/零面积——防注入的最小面，对交互元素与标题一视同仁）；
 * shadow DOM/同源 iframe/深度定位器/settle 观察者在 B3 扩展。
 * below 语义 v0 = 仅"视口下方"（上方外露与部分可见的完整标注在 B3 坐标表）。
 */
export const EXTRACT_EXPRESSION = `(() => {
  const visible = (el, cs, rect) => {
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const fontSize = Number.parseFloat(cs.fontSize || "16");
    if (Number.isFinite(fontSize) && fontSize < 4) return false;
    return rect.width > 0 && rect.height > 0;
  };
  const clean = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [onclick], [contenteditable=""], [contenteditable="true"], label[for], [role]';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const nodes = [];
  let counter = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!visible(el, cs, rect)) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    let value;
    if (tag === "input" && type === "password") value = "***";
    else if (tag === "input" || tag === "textarea") {
      value = clean(el.value).slice(0, 40) || undefined;
    }
    const id = String(++counter);
    el.setAttribute("data-bw-id", id);
    nodes.push({
      id,
      tag,
      role: el.getAttribute("role") || undefined,
      text: clean(el.innerText || el.textContent).slice(0, 80) || undefined,
      href: tag === "a" ? el.href : undefined,
      type,
      placeholder: clean(el.getAttribute("placeholder")).slice(0, 80) || undefined,
      value,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      below: rect.bottom > vh,
    });
  }
  const headings = [];
  for (const h of document.querySelectorAll("h1, h2, h3")) {
    const cs = getComputedStyle(h);
    const rect = h.getBoundingClientRect();
    if (!visible(h, cs, rect)) continue;
    const text = clean(h.textContent).slice(0, 80);
    if (text) headings.push({ tag: h.tagName.toLowerCase(), text });
    if (headings.length >= 10) break;
  }
  return {
    nodes,
    headings,
    title: clean(document.title).slice(0, 200),
    url: location.href,
    scrollY: Math.round(window.scrollY),
    docHeight: Math.round(document.documentElement.scrollHeight),
    viewportH: vh,
    viewportW: vw,
  };
})()`;
