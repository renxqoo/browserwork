/**
 * 页面内提取表达式（docs/03-units.md U3 完整版，B3 审查处置后）。
 * Bun evaluate 包装为 await (<expr>) —— 必须是表达式（IIFE）。
 *
 * 关键裁决（docs/review-B3.md）：
 * - bw-id 用页面生命周期内全局单调序列（window.__bwIdSeq）——两次提取间元素
 *   显隐变化不会撞号（P0-1）；旧打点残留为无害垃圾（导航/document.open 清空）
 * - 进入 iframe 前检查 iframe 元素自身可见性（P0-2：隐藏 iframe 幽灵节点）
 * - 子帧元素 rect 与 frame 盒求交（P1-1：裁剪坐标可点性）；完全裁剪 → 不入快照
 * - below = 完全在视口下方（y > vh）；above = 完全在上方（y+h ≤ 0）——
 *   纵跨视口的大容器归入 in-viewport（B3 审查 D2）
 * - settle 观察者每次提取无条件重装（防 document.open 死亡/页面伪造，P1-3/P2-7），
 *   并挂到本次 walk 发现的 shadow root 与同源 iframe 文档（P1-2，尽力而为）
 * - 不可见过滤含 aria-hidden 与前景=背景（P1-4）；href/src 钳长 500（P2-5）
 * - 已知限制（登记 U3 不处理）：frameset/frame、<object> 嵌入不遍历；
 *   同源 iframe 内部滚动不参与 isSameView（只有主文档 scrollX/Y）
 */
export const EXTRACT_EXPRESSION = `(() => {
  const clean = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
  const clampText = (s, max) => clean(s).slice(0, max) || undefined;
  const clampUrl = (s) => clean(s).slice(0, 500) || undefined;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [onclick], [contenteditable=""], [contenteditable="true"], label[for], [role]';
  const isInteractive = (el) => {
    try {
      return el.matches(INTERACTIVE);
    } catch {
      return false;
    }
  };
  const isVisible = (el, rect) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const fontSize = Number.parseFloat(cs.fontSize || "16");
    if (Number.isFinite(fontSize) && fontSize < 4) return false;
    if (cs.color !== "rgba(0, 0, 0, 0)" && cs.color === cs.backgroundColor) return false;
    return rect.width > 0 && rect.height > 0;
  };

  // ---- settle 观察者：每次提取无条件重装（主文档 + walk 后挂 shadow/子帧）
  const extraRoots = [];
  const state = { lastChange: Date.now(), __bw: true };
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "data-bw-id") continue;
      state.lastChange = Date.now();
      break;
    }
  });
  const attach = () => {
    try {
      observer.disconnect();
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      for (const root of extraRoots) {
        try {
          observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch {}
      }
      state.observer = observer;
      window.__bwSettle = state;
    } catch {}
  };

  const nodes = [];
  window.__bwIdSeq = (window.__bwIdSeq || 0) + 1;
  const nextId = () => {
    window.__bwIdSeq += 1;
    return String(window.__bwIdSeq);
  };
  let crossOriginFrames = 0;

  /** rect 与所在 frame 盒求交（主文档 frame 盒 = 视口本身） */
  const clampToFrame = (x, y, w, h, box) => {
    if (!box) return { x, y, w, h, empty: w <= 0 || h <= 0 };
    const left = Math.max(x, box.left);
    const top = Math.max(y, box.top);
    const right = Math.min(x + w, box.right);
    const bottom = Math.min(y + h, box.bottom);
    return { x: left, y: top, w: right - left, h: bottom - top, empty: right <= left || bottom <= top };
  };

  const pushNode = (el, box) => {
    const r = el.getBoundingClientRect();
    // 子帧内 rect 是 frame 相对系：先加 frame 左上偏移到主视口系，再与 frame 盒求交
    const ox = box ? box.left : 0;
    const oy = box ? box.top : 0;
    const clamped = clampToFrame(r.x + ox, r.y + oy, r.width, r.height, box);
    if (clamped.empty) return false;
    if (!isVisible(el, { width: clamped.w, height: clamped.h })) return false;
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    let value;
    if (tag === "input" && type === "password") value = "***";
    else if (tag === "input" || tag === "textarea") value = clampText(el.value, 40);
    const id = nextId();
    el.setAttribute("data-bw-id", id);
    nodes.push({
      id,
      tag,
      role: el.getAttribute("role") || undefined,
      text: clampText(el.innerText || el.textContent, 80),
      href: tag === "a" ? clampUrl(el.href) : undefined,
      type,
      placeholder: clampText(el.getAttribute("placeholder"), 80),
      value,
      x: Math.round(clamped.x),
      y: Math.round(clamped.y),
      w: Math.round(clamped.w),
      h: Math.round(clamped.h),
      below: clamped.y > vh,
      above: clamped.y + clamped.h <= 0,
    });
    return true;
  };

  const walk = (root, box) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "IFRAME") {
        const r = el.getBoundingClientRect();
        const pox = box ? box.left : 0;
        const poy = box ? box.top : 0;
        const own = clampToFrame(r.x + pox, r.y + poy, r.width, r.height, box);
        if (own.empty || !isVisible(el, { width: own.w, height: own.h })) continue; // P0-2
        const frameBox = { left: own.x, top: own.y, right: own.x + own.w, bottom: own.y + own.h };
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc && doc.defaultView) {
          extraRoots.push(doc.documentElement);
          walk(doc, frameBox);
        } else {
          // 跨源 iframe：占位节点（P2-1：iframe 专属处理，不走 interactive 分支）
          crossOriginFrames += 1;
          const id = nextId();
          el.setAttribute("data-bw-id", id);
          nodes.push({
            id,
            tag: "iframe",
            role: undefined,
            text: "[cross-origin iframe]",
            href: clampUrl(el.src),
            type: undefined,
            placeholder: undefined,
            value: undefined,
            x: Math.round(own.x),
            y: Math.round(own.y),
            w: Math.round(own.w),
            h: Math.round(own.h),
            below: own.y > vh,
            above: own.y + own.h <= 0,
          });
        }
        continue;
      }
      if (isInteractive(el)) {
        pushNode(el, box);
      }
      const shadow = el.shadowRoot;
      if (shadow) {
        extraRoots.push(shadow); // settle 观察 + 遍历（shadow 共享主帧坐标，box 不变）
        walk(shadow, box);
      }
    }
  };
  walk(document, null);
  attach();

  const headings = [];
  const walkHeadings = (root) => {
    for (const h of root.querySelectorAll("h1, h2, h3")) {
      if (!isVisible(h, h.getBoundingClientRect())) continue;
      const text = clampText(h.textContent, 80);
      if (text) headings.push({ tag: h.tagName.toLowerCase(), text });
      if (headings.length >= 10) return;
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walkHeadings(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument) walkHeadings(el.contentDocument);
        } catch {}
      }
      if (headings.length >= 10) return;
    }
  };
  walkHeadings(document);
  const warnings = [];
  if (crossOriginFrames > 0) {
    warnings.push("cross-origin iframes: " + crossOriginFrames + "（占位节点，坐标轨交互）");
  }

  return {
    nodes,
    headings,
    warnings,
    title: clampText(document.title, 200),
    url: location.href.length > 500 ? location.href.slice(0, 500) : location.href,
    scrollY: Math.round(window.scrollY),
    scrollX: Math.round(window.scrollX),
    docHeight: Math.round(document.documentElement.scrollHeight),
    viewportH: vh,
    viewportW: vw,
  };
})()`;
