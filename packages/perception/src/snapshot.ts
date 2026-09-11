/**
 * 快照构建与渲染（docs/03-units.md U3）。
 * domHash/预算截断为纯函数（可脱离页面测试）；extractSnapshot 只做驱动调用。
 * 页面可控内容（title/url/placeholder/text）一律归一为单行并钳长——
 * 防换行伪造快照行、防超长内容击穿预算（B1 对抗审查 P1-2 处置）。
 */
import { BWError } from "@bw/core";
import type { Page } from "@bw/driver";
import { EXTRACT_EXPRESSION } from "./script.ts";

/** 单一真相：渲染输出硬上限字符数（01 §6.3；可被注入覆盖，缺省值只住这里） */
export const SNAPSHOT_BUDGET_DEFAULT = 12_000;

/** 页面可控字段的钳长上限（P1-2：头部自身有界，硬预算才成立） */
export const TITLE_MAX_CHARS = 200;
export const URL_MAX_CHARS = 500;

export interface SnapNode {
  id: string;
  tag: string;
  role?: string;
  text?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  /** checkbox/radio 勾选态（B12：渲染 diff 依赖；不入 domHash——与 value 同属状态非结构） */
  checked?: boolean;
  /** 主视口坐标系（同源 iframe 内元素含递归 frame 偏移 + frame 盒裁剪） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 完全在视口下方（top > viewportH；纵跨视口的容器不算） */
  below: boolean;
  /** 完全在视口上方（bottom ≤ 0） */
  above: boolean;
}

export interface SnapHeading {
  tag: string;
  text: string;
}

export interface SnapshotScroll {
  y: number;
  /** 主文档横向滚动（isSameView 参与；iframe 内部滚动是已登记限制） */
  x: number;
  docHeight: number;
  viewportH: number;
  viewportW?: number;
}

export interface Snapshot {
  formatVersion: 1;
  url: string;
  title: string;
  nodes: SnapNode[];
  headings: SnapHeading[];
  scroll: SnapshotScroll;
  domHash: string;
  truncated: boolean;
  warnings: string[];
}

export interface ExtractOptions {
  budgetChars?: number;
}

interface RawExtract {
  nodes: SnapNode[];
  headings: SnapHeading[];
  warnings?: string[];
  title: string;
  url: string;
  scrollY: number;
  scrollX?: number;
  docHeight: number;
  viewportH: number;
  viewportW?: number;
}

/** FNV-1a 32bit——结构哈希用，不追求密码学强度 */
function fnv1a(bytes: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hrefOrigin(href: string | undefined): string {
  if (href === undefined) return "";
  try {
    return new URL(href).origin;
  } catch {
    return "";
  }
}

function oneLine(value: string, max: number): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
}

/**
 * 结构哈希（U3 契约）：tag + role + 可见文本前 64 字符 + href origin + 控件类型。
 * 不含 class、不含 value（输入值变化 ≠ 结构变化）、不含 below（滚动不变性）。
 */
export function domHashOf(nodes: SnapNode[]): string {
  const fingerprint = nodes
    .map((n) =>
      [n.tag, n.role ?? "", (n.text ?? "").slice(0, 64), hrefOrigin(n.href), n.type ?? ""].join(
        "|",
      ),
    )
    .join("\n");
  return fnv1a(fingerprint);
}

/** 复用判定（01 §6.3）：结构、滚动位置、URL 三者未变才可复用 */
export function isSameView(
  a: Pick<Snapshot, "domHash" | "scroll" | "url">,
  b: Pick<Snapshot, "domHash" | "scroll" | "url">,
): boolean {
  return (
    a.domHash === b.domHash &&
    a.scroll.y === b.scroll.y &&
    (a.scroll.x ?? 0) === (b.scroll.x ?? 0) &&
    a.url === b.url
  );
}

function renderNode(n: SnapNode): string {
  const label = n.tag === "a" ? "link" : n.tag; // 呈现层可读名（数据层保持原标签）
  const parts: string[] = [];
  if (n.role !== undefined && n.role !== "") parts.push(`role=${n.role}`);
  if (n.text !== undefined) parts.push(`"${n.text}"`);
  if (n.placeholder !== undefined) parts.push(`(placeholder: ${n.placeholder})`);
  if (n.value !== undefined) parts.push(`[value: ${n.value}]`);
  if (n.checked === true) parts.push("[checked]");
  if (n.href !== undefined) parts.push(`-> ${n.href}`);
  if (n.below) parts.push("↓below-viewport");
  if (n.above) parts.push("↑above-viewport");
  return `[${n.id}] ${label}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
}

/**
 * LLM 可见文本渲染。硬预算：头部字段有界（title ≤200 / url ≤500，单行化），
 * 元素行超预算时在元素边界截断并标注剩余数量；页脚计入预算——必要时回退
 * 元素行给页脚留位。唯一豁免：预算小于有界头部本身（退化预算，如 budget=50）。
 * 返回值同时给出结构化的 truncated/renderedCount（P2-5：不靠字符串匹配判定）。
 */
/** 元素到视口的纵向距离（below 为正距离，above 为负距离取绝对值） */
function distance(n: SnapNode, viewportH: number): number {
  return n.below ? n.y - viewportH : -(n.y + n.h);
}

export function renderPlan(
  s: Snapshot,
  budgetChars = SNAPSHOT_BUDGET_DEFAULT,
): { text: string; truncated: boolean; renderedCount: number } {
  const head =
    `# Page: ${oneLine(s.title, TITLE_MAX_CHARS)}\n# URL: ${oneLine(s.url, URL_MAX_CHARS)}\n` +
    `# Scroll: ${s.scroll.y}/${s.scroll.docHeight} (viewport ${s.scroll.viewportH})\n` +
    (s.headings.length > 0
      ? `# Headings: ${s.headings.map((h) => `${h.tag} "${h.text}"`).join(", ")}\n`
      : "");
  const footer = (omitted: number): string =>
    `# …${omitted} 个元素未显示（视口优先排序，可 scroll 后重新提取）\n`;
  const footerShort = "# …truncated\n";
  // 视口优先 + 距离次序（P0-3「视口内与附近优先」，B3 审查 P2-3）：
  // 视口内先渲染（组内保持文档序）；视口外按「距视口的纵向距离」升序
  const inViewport = s.nodes.filter((n) => !n.below && !n.above);
  const outViewport = s.nodes
    .filter((n) => n.below || n.above)
    .sort((a, b) => distance(a, s.scroll.viewportH) - distance(b, s.scroll.viewportH));
  const ordered = [...inViewport, ...outViewport];
  const lines: string[] = [head];
  let used = head.length;
  let rendered = 0;
  for (const n of ordered) {
    const line = `${renderNode(n)}\n`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length;
    rendered++;
  }
  const truncated = rendered < s.nodes.length;
  if (truncated) {
    let f = footer(s.nodes.length - rendered);
    // 回退元素行给页脚留位（保留至少头部）
    while (used + f.length > budgetChars && lines.length > 1) {
      const last = lines.pop();
      if (last === undefined) break;
      used -= last.length;
      rendered++;
      f = footer(s.nodes.length - rendered);
    }
    // 全页脚放不下 → 短页脚；连短页脚都放不下 → 无页脚（truncated 由结构化标志承载）
    if (used + f.length <= budgetChars) {
      lines.push(f);
    } else if (used + footerShort.length <= budgetChars) {
      lines.push(footerShort);
    }
  }
  return { text: lines.join(""), truncated, renderedCount: rendered };
}

/** 兼容展示用入口（文本本体）；需要 truncated/计数时用 renderPlan */
export function renderSnapshot(s: Snapshot, budgetChars = SNAPSHOT_BUDGET_DEFAULT): string {
  return renderPlan(s, budgetChars).text;
}

function normalize(raw: RawExtract, budgetWarnings: string[]): Snapshot {
  return {
    formatVersion: 1,
    // 空标题/空 URL 是合法形态（document.write 的新文档）——头部字段防御归一
    url: raw.url ?? "",
    title: raw.title ?? "",
    nodes: raw.nodes,
    headings: raw.headings,
    scroll: {
      y: raw.scrollY,
      x: raw.scrollX ?? 0,
      docHeight: raw.docHeight,
      viewportH: raw.viewportH,
      ...(raw.viewportW !== undefined ? { viewportW: raw.viewportW } : {}),
    },
    domHash: domHashOf(raw.nodes),
    truncated: false,
    warnings: [...(raw.warnings ?? []), ...budgetWarnings],
  };
}

/** 驱动调用 + 归一化。url 取自页面内 location.href（与 nodes 同一瞬间，消除竞态 P2-6）。 */
export async function extractSnapshot(page: Page, opts?: ExtractOptions): Promise<Snapshot> {
  const warnings: string[] = [];
  if (opts?.budgetChars !== undefined && opts.budgetChars !== SNAPSHOT_BUDGET_DEFAULT) {
    warnings.push(`budget override: ${opts.budgetChars}`);
  }
  const raw = await page.evaluate<RawExtract>(EXTRACT_EXPRESSION);
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.nodes)) {
    throw new BWError("DRIVER_ERROR", "extract: unexpected page result shape", { detail: raw });
  }
  const snapshot = normalize(raw, warnings);
  const plan = renderPlan(snapshot, opts?.budgetChars ?? SNAPSHOT_BUDGET_DEFAULT);
  snapshot.truncated = plan.truncated;
  return snapshot;
}
