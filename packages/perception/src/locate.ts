/**
 * 深度定位器与 bwId 页内操作（U3，B3 审查处置后）。
 * - 未找到一律返回 {found:false}（契约形态）
 * - 穿 shadow DOM / 同源 iframe；rect 与 frame 盒求交（与提取同规则：
 *   frame 相对坐标先加 frame 左上偏移再裁剪）
 * - 返回主视口坐标、元素所属文档 origin（S3 依据）、导航意图
 *   （linkHref/formAction，S1②/S2 数据源）——同一 walk 一次算齐
 * - scrollToBwId / selectBwId 复用同一 walk（单一实现，命中处单次执行）
 */
export interface LocateResult {
  found: boolean;
  tag?: string;
  role?: string;
  text?: string;
  /** 元素当前计算样式可见（display/visibility/opacity）——坐标轨复核用（B4 审查 P2-9） */
  visible?: boolean;
  /** isContentEditable——type 动作可输入判据（B4 审查 P2-5） */
  editable?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  origin?: string;
  inShadow?: boolean;
  inFrame?: boolean;
  /** click 目标（或祖先）是 a[href] 时的绝对地址（导航意图） */
  linkHref?: string;
  /** click 目标是提交类控件时其表单的绝对 action（提交意图） */
  formAction?: string;
  formMethod?: string;
}

interface Op {
  kind: "locate" | "scroll" | "select";
  value?: string;
}

/** 命中后行为：一次性计算定位信息 + 可选副作用（scroll/select） */
function hitActionFor(op: Op): string {
  const selectValue = JSON.stringify(op.value ?? "");
  const locateInfo = `const doc = el.ownerDocument;
    const cs = doc.defaultView.getComputedStyle(el);
    const info = {
      found: true,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      text: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80) || undefined,
      visible: !(cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0"),
      editable: !!el.isContentEditable,
      x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h),
      origin: doc.location.origin,
      inShadow, inFrame,
      linkHref: (() => { const a = el.closest ? el.closest("a[href]") : null; return a ? a.href : undefined; })(),
    };
    // 提交意图判据 = 目标（或祖先）是 submitter 本身，而非「在表单里」（B4 审查 P1-2）：
    // button[type=submit]、无 type 的 button（隐式 submit）、input[type=submit|image]、带 formaction 的 button
    if (el.closest) {
      const cand = el.closest("button, input[type=submit], input[type=image]");
      let isSubmitter = false;
      if (cand) {
        if (cand.tagName === "BUTTON") {
          const t = (cand.getAttribute("type") || "submit").toLowerCase();
          isSubmitter = t === "submit" || cand.hasAttribute("formaction");
        } else {
          isSubmitter = true;
        }
      }
      if (isSubmitter && cand) {
        const formAttr = cand.getAttribute("form");
        const form =
          (formAttr ? doc.getElementById(formAttr) : null) ||
          cand.form ||
          cand.closest("form");
        const fa = cand.getAttribute("formaction");
        info.formAction = fa
          ? new URL(fa, doc.baseURI).href
          : form
            ? form.action
            : undefined;
        info.formMethod = form ? form.method : undefined;
      }
    }
    return info;`;
  const sideEffect =
    op.kind === "locate"
      ? locateInfo
      : op.kind === "scroll"
        ? `el.scrollIntoView({ block: "center", behavior: "instant" }); return { found: true, scrolled: true };`
        : `if (el.tagName !== "SELECT") return { found: true, error: "not_select" };
           const has = [...el.options].some((o) => o.value === ${selectValue});
           if (!has) return { found: true, error: "invalid_value" };
           const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
           setter.call(el, ${selectValue});
           el.dispatchEvent(new Event("input", { bubbles: true }));
           el.dispatchEvent(new Event("change", { bubbles: true }));
           return { found: true, set: true };`;
  return `(() => { ${sideEffect} })()`;
}

/** 页内 walk + 操作的单源实现；op 决定命中后的行为 */
function bwIdExpression(bwId: string, op: Op): string {
  const wanted = JSON.stringify(bwId);
  return `(() => {
    const selector = '[data-bw-id="' + ${wanted} + '"]';
    const clampToFrame = (x, y, w, h, box) => {
      if (!box) return { x, y, w, h, empty: w <= 0 || h <= 0 };
      const left = Math.max(x, box.left);
      const top = Math.max(y, box.top);
      const right = Math.min(x + w, box.right);
      const bottom = Math.min(y + h, box.bottom);
      return { x: left, y: top, w: right - left, h: bottom - top, empty: right <= left || bottom <= top };
    };
    const find = (root, box, inShadow, inFrame) => {
      let el = null;
      try { el = root.querySelector(selector); } catch { el = null; }
      if (el) {
        const r = el.getBoundingClientRect();
        // 子帧内 rect 是 frame 相对系：先加 frame 偏移再裁剪（与提取同规则）
        const ox = box ? box.left : 0;
        const oy = box ? box.top : 0;
        const c = clampToFrame(r.x + ox, r.y + oy, r.width, r.height, box);
        if (!c.empty) {
          return ${hitActionFor(op)};
        }
      }
      for (const host of root.querySelectorAll("*")) {
        if (host.shadowRoot) {
          const hit = find(host.shadowRoot, box, true, inFrame);
          if (hit && hit.found) return hit;
        }
        if (host.tagName === "IFRAME") {
          let doc = null;
          try { doc = host.contentDocument; } catch { doc = null; }
          if (doc) {
            const r = host.getBoundingClientRect();
            const pox = box ? box.left : 0;
            const poy = box ? box.top : 0;
            const own = clampToFrame(r.x + pox, r.y + poy, r.width, r.height, box);
            if (own.empty) continue;
            const frameBox = { left: own.x, top: own.y, right: own.x + own.w, bottom: own.y + own.h };
            const hit = find(doc, frameBox, inShadow, true);
            if (hit && hit.found) return hit;
          }
        }
      }
      return { found: false };
    };
    return find(document, null, false, false);
  })()`;
}

export function locateExpression(bwId: string): string {
  return bwIdExpression(bwId, { kind: "locate" });
}

/** 滚动目标元素到视口中心（穿 shadow/iframe）；返回 {found, scrolled} */
export function scrollToBwIdExpression(bwId: string): string {
  return bwIdExpression(bwId, { kind: "scroll" });
}

/** select 原生 setter + input/change 合成（React 兼容）；返回 {found, set} | {found, error:"not_select"} */
export function selectBwIdExpression(bwId: string, value: string): string {
  return bwIdExpression(bwId, { kind: "select", value });
}

/**
 * press Enter 的提交意图（B4 审查 P1-4）：
 * 焦点深度走查（同源 iframe / shadow DOM 内的 activeElement 递归下钻），
 * 表单内且非 textarea 才算提交意图。
 */
export const ENTER_SUBMIT_INTENT_EXPRESSION = `(() => {
  const deepActive = (doc, depth) => {
    if (depth > 5) return null;
    let el = doc.activeElement;
    if (!el) return null;
    if (el.tagName === "TEXTAREA") return { el, textarea: true };
    if (el.tagName === "IFRAME") {
      try {
        const inner = el.contentDocument;
        if (inner) {
          const nested = deepActive(inner, depth + 1);
          if (nested) return nested;
        }
      } catch {}
    }
    if (el.shadowRoot) {
      const nested = deepActiveFromShadow(el.shadowRoot, depth + 1);
      if (nested) return nested;
    }
    return { el, textarea: false };
  };
  const deepActiveFromShadow = (root, depth) => {
    const el = root.activeElement;
    if (!el) return null;
    if (el.tagName === "TEXTAREA") return { el, textarea: true };
    if (el.shadowRoot) {
      const nested = deepActiveFromShadow(el.shadowRoot, depth + 1);
      if (nested) return nested;
    }
    if (el.tagName === "IFRAME") {
      try {
        const inner = el.contentDocument;
        if (inner) {
          const nested = deepActive(inner, depth + 1);
          if (nested) return nested;
        }
      } catch {}
    }
    return { el, textarea: false };
  };
  const hit = deepActive(document, 0);
  if (!hit || hit.textarea) return { submit: false };
  const el = hit.el;
  if (!el.closest) return { submit: false };
  const form = el.closest("form");
  if (!form) return { submit: false };
  return { submit: true, action: form.action, method: form.method, inFrame: el.ownerDocument !== document };
})()`;
