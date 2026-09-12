/**
 * B21 §10：DOM 树序列化（冻结副本）——extract_code 的数据源。
 * 双后端同路径（evaluate 一次）；密码→*** 源头掩码（含 attrs 面与 type 归一化，
 * B21 审查 P2-4）；节点/文本上限；表单活态（select 值 / checked）；
 * shadow root 穿透；同源 iframe 下钻；跨域 iframe 占位（与快照同取舍）。
 * body 可能为 null（解析中文档）——占位空树而非抛错（审查 P2-7）。
 */
import type { Page } from "@bw/driver";

/** LLM 代码面向的树节点（冻结 JSON；attrs 平铺；text 只含直属文本） */
export interface DomNode {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  /** input/textarea/select 的当前值（密码恒 ***；掩码在源头——代码无法读到明文） */
  value?: string;
  /** input checkbox/radio 的勾选态（value 恒定不反映勾选，同快照层 B12 裁决） */
  checked?: boolean;
  children?: DomNode[];
}

export interface DomTree {
  root: DomNode;
  nodeCount: number;
  truncated: boolean;
}

export const SERIALIZE_TREE_EXPRESSION = `(() => {
  const CAP_NODES = 10000, CAP_TEXT = 200, CAP_ATTR = 500;
  let count = 0; let truncated = false;
  const attrsOf = (el) => {
    const o = {};
    for (const a of el.attributes) o[a.name] = String(a.value).slice(0, CAP_ATTR);
    // 服务端预填的 value 属性也走源头掩码（审查 P2-4a：<input type=password value=明文>）
    if (el.tagName === "INPUT" && el.type === "password") o.value = "***";
    return o;
  };
  const valueOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      // IDL 属性 el.type 已归一化（type=" password " 也是密码框）——getAttribute 直比会漏（P2-4b）
      if (el.type === "password") return "***"; // 源头掩码——沙箱代码不可读明文
      if (el.value !== "") return String(el.value).slice(0, CAP_TEXT);
    }
    if (tag === "textarea" && el.value !== "") return String(el.value).slice(0, CAP_TEXT);
    // select 的当前选中是活态属性，标记不携带——不序列化则表单态是初始态（P2-8）
    if (tag === "select" && el.value !== "") return String(el.value).slice(0, CAP_TEXT);
    return undefined;
  };
  const ser = (el) => {
    if (count >= CAP_NODES) { truncated = true; return null; }
    count++;
    const node = { tag: el.tagName.toLowerCase(), attrs: attrsOf(el) };
    const v = valueOf(el);
    if (v !== undefined) node.value = v;
    const tag = node.tag;
    if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
      node.checked = el.checked === true;
    }
    let text = "";
    for (const c of el.childNodes) { if (c.nodeType === 3) text += c.textContent; }
    text = text.replace(/\\s+/g, " ").trim().slice(0, CAP_TEXT);
    if (text !== "") node.text = text;
    const kids = [];
    if (el.shadowRoot) {
      for (const c of el.shadowRoot.children) { const s = ser(c); if (s) kids.push(s); }
    }
    for (const c of el.children) {
      if (c.tagName === "IFRAME") {
        kids.push({ tag: "iframe", attrs: { src: String(c.src || "").slice(0, CAP_ATTR) } });
        try {
          const d = c.contentDocument;
          if (d && d.body) { const s = ser(d.body); if (s) kids.push(s); }
        } catch { /* 跨源——占位即可（与快照同取舍） */ }
      } else { const s = ser(c); if (s) kids.push(s); }
    }
    if (kids.length > 0) node.children = kids;
    return node;
  };
  const root = (document.body && ser(document.body)) || { tag: "body" };
  return { root, nodeCount: count, truncated };
})()`;

export async function serializeDomTree(page: Page): Promise<DomTree> {
  const raw = await page.evaluate<DomTree | null>(SERIALIZE_TREE_EXPRESSION);
  if (raw === null || raw === undefined || typeof raw.root !== "object") {
    return { root: { tag: "body" }, nodeCount: 0, truncated: false };
  }
  return raw;
}
