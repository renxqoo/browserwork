import { describe, expect, test } from "bun:test";
import {
  domHashOf,
  isSameView,
  renderSnapshot,
  SNAPSHOT_BUDGET_DEFAULT,
  type SnapNode,
} from "../src/index.ts";

function node(partial: Partial<SnapNode> & { id: string }): SnapNode {
  return {
    tag: "link",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    below: false,
    ...partial,
  };
}

describe("domHashOf", () => {
  const a = [
    node({ id: "1", tag: "a", text: "Home", href: "https://x.test/" }),
    node({ id: "2", tag: "button", text: "Submit" }),
  ];

  test("同结构同值稳定", () => {
    expect(domHashOf(a)).toBe(
      domHashOf([
        node({ id: "1", tag: "a", text: "Home", href: "https://x.test/" }),
        node({ id: "2", tag: "button", text: "Submit" }),
      ]),
    );
  });

  test("id 不参与（重编号不影响复用判定）", () => {
    expect(domHashOf(a)).toBe(
      domHashOf([
        node({ id: "9", tag: "a", text: "Home", href: "https://x.test/" }),
        node({ id: "10", tag: "button", text: "Submit" }),
      ]),
    );
  });

  test("文本变化 → hash 变", () => {
    const b = [
      node({ id: "1", tag: "a", text: "Homes", href: "https://x.test/" }),
      node({ id: "2", tag: "button", text: "Submit" }),
    ];
    expect(domHashOf(a)).not.toBe(domHashOf(b));
  });

  test("value 不参与（输入值变化 ≠ 结构变化）", () => {
    expect(domHashOf([node({ id: "1", tag: "input", text: "q", value: "a" })])).toBe(
      domHashOf([node({ id: "1", tag: "input", text: "q", value: "bbb" })]),
    );
  });

  test("href 只取 origin（路径/参数变化不算结构变化）", () => {
    expect(domHashOf([node({ id: "1", href: "https://x.test/a?b=1" })])).toBe(
      domHashOf([node({ id: "1", href: "https://x.test/zzz" })]),
    );
  });

  test("host 变化 → hash 变", () => {
    expect(domHashOf([node({ id: "1", href: "https://x.test/" })])).not.toBe(
      domHashOf([node({ id: "1", href: "https://y.test/" })]),
    );
  });

  test("空数组也有确定值", () => {
    expect(domHashOf([])).toBe(domHashOf([]));
  });
});

describe("isSameView（复用判定）", () => {
  const base = {
    domHash: "aa",
    scroll: { y: 0, docHeight: 100, viewportH: 720 },
    url: "https://a/",
  };
  test("三者未变 → true", () => {
    expect(isSameView(base, { ...base })).toBe(true);
  });
  test("滚动变化 → false", () => {
    expect(isSameView(base, { ...base, scroll: { ...base.scroll, y: 100 } })).toBe(false);
  });
  test("URL 变化 → false", () => {
    expect(isSameView(base, { ...base, url: "https://b/" })).toBe(false);
  });
  test("结构变化 → false", () => {
    expect(isSameView(base, { ...base, domHash: "bb" })).toBe(false);
  });
});

describe("renderSnapshot 预算", () => {
  const snap = {
    formatVersion: 1 as const,
    url: "https://x.test/",
    title: "T",
    headings: [{ tag: "h1", text: "H" }],
    scroll: { y: 0, docHeight: 1000, viewportH: 720 },
    domHash: "aa",
    truncated: false,
    warnings: [],
    nodes: Array.from({ length: 500 }, (_, i) =>
      node({ id: String(i + 1), tag: "a", text: `item-${i + 1}`, href: "https://x.test/i" }),
    ),
  };

  test("默认预算内不截断（100 短元素 ≈ 4K < 12K）", () => {
    const out = renderSnapshot({ ...snap, nodes: snap.nodes.slice(0, 100) });
    expect(out).not.toContain("未显示");
    expect(out.length).toBeLessThanOrEqual(SNAPSHOT_BUDGET_DEFAULT);
  });

  test("小预算 → 元素边界截断 + 剩余数量标注 + 长度不超预算", () => {
    const budget = 700;
    const out = renderSnapshot(snap, budget);
    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out).toMatch(/下方还有 \d+ 个元素未显示/);
    const renderedCount = (out.match(/^\[\d+\] /gm) ?? []).length;
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThan(500);
  });

  test("零元素页面渲染头部不报错", () => {
    const out = renderSnapshot({ ...snap, nodes: [] });
    expect(out).toContain("# Page: T");
    expect(out).not.toContain("未显示");
  });

  test("密码值渲染为 ***（提取脚本保证，渲染层透传断言）", () => {
    const out = renderSnapshot({
      ...snap,
      nodes: [node({ id: "1", tag: "input", type: "password", value: "***", placeholder: "p" })],
    });
    expect(out).toContain("[value: ***]");
  });

  test("below-viewport 标注渲染", () => {
    const out = renderSnapshot({
      ...snap,
      nodes: [node({ id: "1", tag: "button", text: "深处的按钮", below: true })],
    });
    expect(out).toContain("↓below-viewport");
  });
});
