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
/**
 * B25 Fix C：console/error 钩子安装表达式（单源）。
 * 旧形态内嵌在 EXTRACT_EXPRESSION 尾部——首次提取前（首屏渲染期）的消息
 * 永久丢失（RNW scrollEventThrottle 告警正属此类）。抽出后三个消费点：
 * 1) EXTRACT_EXPRESSION 拼接（保持既有行为）；
 * 2) engine 的 console/errors 动作先装后 drain（对已导航页面救回后续消息）；
 * 3) driver chrome 分支 init 注入（复本守卫：与 NO_CDP_LEAK_SCRIPT 同位注入）。
 * 幂等闸 __bwLogHooked；环形缓冲 200 条；文本链 500。
 */
export const INSTALL_LOG_HOOK_EXPRESSION = `(() => {
  if (window.__bwLogHooked) return "hooked";
  try {
    window.__bwLogHooked = true;
    const buf = (window.__bwLog = []);
    const push = (level, parts) => {
      try {
        buf.push({
          t: Date.now(),
          level,
          text: parts
          .map((a) => {
            try {
              return typeof a === "string" ? a : JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(" ")
          .slice(0, 500),
        });
        if (buf.length > 200) buf.splice(0, buf.length - 200);
      } catch {}
    };
    for (const m of ["log", "info", "warn", "error", "debug"]) {
      const orig = console[m] && console[m].bind(console);
      if (orig) {
        const wrap = (...args) => { push(m, args); orig(...args); };
        // 指纹伪装（B25 审查 10）：包装后 toString 不得暴露非原生
        try {
          Object.defineProperty(wrap, "toString", {
            value: () => "function " + m + "() { [native code] }",
          });
        } catch {}
        console[m] = wrap;
      }
    }
    window.addEventListener("error", (e) =>
      push("error", [e.message + (e.filename ? " @" + e.filename + ":" + e.lineno : "")]));
    window.addEventListener("unhandledrejection", (e) =>
      push("error", ["UnhandledRejection: " + ((e.reason && e.reason.message) || e.reason)]));
    return "installed";
  } catch { return "failed"; }
})()`;

export const EXTRACT_EXPRESSION = `(() => {
  const clean = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
  const clampText = (s, max) => clean(s).slice(0, max) || undefined;
  const clampUrl = (s) => clean(s).slice(0, 500) || undefined;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [onclick], [contenteditable=""], [contenteditable="true"], label[for], [role], [tabindex], [aria-selected]';
  // B22+（用户实测百度股市通）：React SPA 的 div-tab 无 onclick/无 role——tabindex
  // 与 aria-selected 是 ARIA tab 模式的标准痕迹；无痕 div 用 click_text 按文本兜底
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
  window.__bwIdSeq = (Number(window.__bwIdSeq) || 0) + 1; // Number 强制——页面预置字符串防毒化（B14 审查 P0-1）
  // B22 S2：id 绑定元素生命周期（WeakMap 注册表，按元素身份——页面预植属性无法伪造）。
  // 旧版每次提取重编号——文件会话「snap 取索引 → 下一命令 click」两次提取间索引全漂移。
  // 稳定 id 对旧规则（「用最新快照」）严格更优：元素未替换则旧快照索引继续有效。
  let idMap = window.__bwIdMap;
  if (!(idMap instanceof WeakMap)) {
    idMap = new WeakMap(); // 页面预植毒化对象 → 重建（B14 P0-1 同型防护）
    window.__bwIdMap = idMap;
  }
  const nextId = () => {
    window.__bwIdSeq += 1;
    return String(window.__bwIdSeq);
  };
  const idOf = (el) => {
    let i = idMap.get(el);
    if (i === undefined) {
      i = nextId();
      idMap.set(el, i);
    }
    return i;
  };
  let crossOriginFrames = 0;
  let blankLinks = 0;

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
    // B12 审查 P1-1：checkbox/radio 的 checked 必须进快照——value 恒定不反映勾选态，
    // 渲染 diff 依赖它（05 §3.1「checked 变化改变渲染」承诺）
    const checked =
      tag === "input" && (type === "checkbox" || type === "radio")
        ? el.checked === true
        : undefined;
    // B14：target=_blank 标注（webkit 弹窗被丢弃——探针 p2；提示 agent 慎点）
    const newTab = tag === "a" && (el.getAttribute("target") || "") === "_blank";
    if (newTab) blankLinks += 1;
    // B20 §9.4：稳定 loc——命中优先级 #id > [data-testid] > [aria-label]（防噪：不造脆弱路径）
    // P3-13 修正：a 也用 #id（原 tag!=='a' 排除无依据）；属性值转义 ] 与换行
    const loc =
      el.id ||
      el.getAttribute("data-testid") ||
      el.getAttribute("data-test") ||
      el.getAttribute("aria-label") ||
      undefined;
    const id = idOf(el);
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
      checked,
      newTab: newTab || undefined,
      ...(loc !== undefined && loc !== ""
        ? {
            loc:
              el.id && loc === el.id
                ? "#" + CSS.escape(loc)
                : "[" +
                  (el.getAttribute("data-testid")
                    ? "data-testid"
                    : el.getAttribute("data-test")
                      ? "data-test"
                      : "aria-label") +
                  '="' +
                  encodeURIComponent(String(loc)) +
                  '"]',
          }
        : {}),
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
          const id = idOf(el);
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

  // ---- console/error 捕获（B11）：幂等安装环形缓冲（bw s console/errors 数据源）
  // 每次提取时确保已装——导航后新 document 自动重装。
  // B25 Fix C：安装体单源到 INSTALL_LOG_HOOK_EXPRESSION（此处拼接保持既有行为）
  ${INSTALL_LOG_HOOK_EXPRESSION};

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
  if (blankLinks > 0) {
    warnings.push("target=_blank links: " + blankLinks + "（新标签页——本后端弹窗行为有限，慎点）");
  }
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

/**
 * B25 Fix A：click_text 定位表达式（单源——engine 唯一消费点）。
 * 修复面（docs/design-B25-rnw-fixes.md；场景泛化后覆盖通用网页形态）：
 * - 归一化用 squeeze（删除全部空白——实测裁决：源码换行在 innerText 里是渲染
 *   空格，用户给的文本无空格；折叠为单空格仍会失配，删净才稳。同时修复旧实现
 *   /s+/g 字母-s bug——嵌套 div 的 innerText 含换行必失配）；
 * - 出界判定含横向 x（carousel/wizard/stack 的 transform 屏外副本 display/opacity
 *   全过、rect 合法——纵向判定拦不住，被最小面积规则选中即坐标轨静默丢弃）。
 *   视口默认读 live window.innerWidth/Height（审查 6：烘焙 1280×720 与小视口
 *   打架——出界判定/采样钳制按错误视口算会假 ELEMENT_NOT_FOUND）；参数仅测试
 *   注入用（显式给则优先）。
 * - 祖先裁剪（审查 2）：中心点逐级判定而非全外矩形（半裁剪元素中心可见即可点）；
 *   跳过 fixed/sticky 元素（CSS 语义：overflow 祖先不裁剪 fixed 后代；body
 *   overflow-x:hidden 全站标配下固定横幅不得假阳性）与 html/body 两级。
 * - 遮挡复核（elementFromPoint 中心单采样）：toast/overlay/modal 盖住的元素
 *   不参与竞赛。
 * - 两阶段（审查 1/7）：阶段 1 纯收集不滚动（避免候选间滚动互相顶走 best、
 *   O(matches) 布局抖动）；阶段 2 按分序（精确匹配→最小面积）对选定候选逐个
 *   尝试：滚入（scrollIntoView 覆盖 window + 嵌套 overflow:auto 容器）→
 *   重验出界/裁剪/遮挡 → 首个通过者胜出。
 * - 直接文本（叶子语义）优先于包含匹配；同分取最小面积。
 * 返回：{ found, x, y, w, h, matches, tag?, reason? }——reason ∈ occluded|offscreen
 *（found=false 且 matches>0 时给可行动理由）；offscreenCount/occludedCount 双报
 *（审查 8：混合场景不互相顶掉）。
 */
export const CLICK_TEXT_LOCATE_EXPRESSION = (
  text: string,
  viewportW?: number,
  viewportH?: number,
): string => `/* __bwLocateText */ (() => {
  const squeeze = (s) => String(s ?? "").replace(/\\s+/g, "").toLowerCase();
  const want = squeeze(${JSON.stringify(text)});
  if (want === "") return { found: false, reason: "empty" };
  // live 视口（审查 6）：表达式在页面内执行，读真实视口零成本；参数仅测试注入
  const vw = ${viewportW === undefined ? "window.innerWidth" : String(Math.round(viewportW))};
  const vh = ${viewportH === undefined ? "window.innerHeight" : String(Math.round(viewportH))};
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  // 出界（含横向——B25）：视口外矩形不可点
  const offscreen = (r) => r.x + r.width <= 0 || r.x >= vw || r.y + r.height <= 0 || r.y >= vh;
  // 中心点（遮挡采样与裁剪判定共用）
  const center = (r) => ({
    x: Math.max(1, Math.min(vw - 1, Math.round(r.x + r.width / 2))),
    y: Math.max(1, Math.min(vh - 1, Math.round(r.y + r.height / 2))),
  });
  // 祖先裁剪（B25+审查 2）：中心点逐级判定——半裁剪元素中心可见即可点；
  // fixed/sticky 不受 overflow 祖先裁剪（CSS 语义），html/body 不算裁剪盒
  const clipped = (el, r) => {
    const own = el.ownerDocument.defaultView.getComputedStyle(el);
    if (own.position === "fixed" || own.position === "sticky") return false;
    const c = center(r);
    for (let a = el.parentElement; a !== null; a = a.parentElement) {
      if (a.tagName === "HTML" || a.tagName === "BODY") break;
      const cs = a.ownerDocument.defaultView.getComputedStyle(a);
      if (cs.overflowY === "visible" && cs.overflowX === "visible") continue;
      const b = a.getBoundingClientRect();
      if (c.x < b.left || c.x >= b.right || c.y < b.top || c.y >= b.bottom) return true;
    }
    return false;
  };
  // 遮挡复核：中心点命中元素或其后代才算可点（覆盖层下的副本出局）
  const occluded = (el, r) => {
    const c = center(r);
    const hit = document.elementFromPoint(c.x, c.y);
    if (hit === null) return true;
    return hit !== el && !el.contains(hit) && !hit.contains(el);
  };
  // ---- 阶段 1：纯收集（不滚动——审查 1/7：候选间滚动会互相顶走、布局抖动）----
  const cands = [];
  let matches = 0;
  for (const el of document.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
    if (!vis(el)) continue;
    const direct = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
    const t = squeeze(el.innerText || direct || "");
    if (t === "" || !t.includes(want)) continue;
    matches++;
    const r = el.getBoundingClientRect();
    cands.push({ el, t, r, off: offscreen(r), clip: clipped(el, r) });
  }
  // 分序：精确匹配优先 → 最小面积（best-smallest 语义）
  cands.sort((a, b) => (a.t === want ? 0 : 1) - (b.t === want ? 0 : 1) || a.r.width * a.r.height - b.r.width * b.r.height);
  // ---- 阶段 2：按分序逐个尝试（滚入即验即停——首个通过者胜出）----
  let offscreenCount = 0;
  let occludedCount = 0;
  for (const c of cands) {
    let r = c.r;
    if (c.off || c.clip) {
      try { c.el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
      r = c.el.getBoundingClientRect();
      if (offscreen(r) || clipped(c.el, r)) { offscreenCount++; continue; }
    }
    if (occluded(c.el, r)) { occludedCount++; continue; }
    return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, matches, tag: c.el.tagName.toLowerCase() };
  }
  return {
    found: false,
    matches,
    offscreenCount,
    occludedCount,
    ...((offscreenCount > 0 || occludedCount > 0)
      ? { reason: offscreenCount >= occludedCount ? "offscreen" : "occluded" }
      : {}),
  };
})()`;
/** console/error 缓冲条目（页面侧 __bwLog 元素形状） */
export interface PageLogEntry {
  t: number;
  level: string;
  text: string;
}

/** 光标式读取 console 缓冲（非破坏性——环形裁剪后光标自动钳回，B11） */
export const DRAIN_LOGS_EXPRESSION = `(() => {
  const buf = window.__bwLog || [];
  const from = Math.min(window.__bwLogCursor || 0, buf.length);
  window.__bwLogCursor = buf.length;
  return buf.slice(from);
})()`;
