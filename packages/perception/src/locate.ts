/**
 * 深度定位器表达式（U3，B3 审查 P0-3/P1-1 处置后）：
 * - 未找到一律返回 {found:false}（契约形态，消费方免判空）
 * - 穿 shadow DOM / 同源 iframe；rect 与 frame 盒求交（与提取同规则）
 * - 返回主视口坐标与元素所属文档 origin（S3 依据）；跨源 iframe 内部不可达
 */
export interface LocateResult {
  found: boolean;
  tag?: string;
  role?: string;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  origin?: string;
  inShadow?: boolean;
  inFrame?: boolean;
}

export function locateExpression(bwId: string): string {
  const id = JSON.stringify(bwId);
  return `(() => {
    const wanted = ${id};
    const selector = '[data-bw-id="' + wanted + '"]';
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
      try {
        el = root.querySelector(selector);
      } catch { el = null; }
      if (el) {
        const r = el.getBoundingClientRect();
        // 子帧内 rect 是 frame 相对系：先加 frame 偏移再裁剪（与提取同规则）
        const ox = box ? box.left : 0;
        const oy = box ? box.top : 0;
        const clamped = clampToFrame(r.x + ox, r.y + oy, r.width, r.height, box);
        if (!clamped.empty) {
          return {
            found: true,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || undefined,
            text: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80) || undefined,
            x: Math.round(clamped.x),
            y: Math.round(clamped.y),
            w: Math.round(clamped.w),
            h: Math.round(clamped.h),
            origin: el.ownerDocument.location.origin,
            inShadow,
            inFrame,
          };
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
