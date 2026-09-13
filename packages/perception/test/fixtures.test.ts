/**
 * U3 感知层 fixture 矩阵（真 webkit）：shadow DOM / 同源 iframe 坐标换算 /
 * 跨源 iframe 占位 / above 标注 / settle 观察者 / 深度定位器。
 */
import { describe, expect, test } from "bun:test";
import { createWebViewDriver } from "@bw/driver";
import { withDriverPage, withFixtureServer, withFixtureServers } from "@bw/testing";
import {
  extractSnapshot,
  type LocateResult,
  locateExpression,
  renderSnapshot,
  serializeDomTree,
} from "../src/index.ts";

describe.skipIf(process.platform !== "darwin")("感知 fixture 矩阵", () => {
  test("shadow DOM：内层按钮/链接入快照且可定位（同帧坐标）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/shadow.html`);
          const snap = await extractSnapshot(page);
          const shadowBtn = snap.nodes.find((n) => n.text === "shadow button");
          const shadowLink = snap.nodes.find((n) => n.text === "shadow link");
          expect(shadowBtn).toBeDefined();
          expect(shadowLink).toBeDefined();
          expect(shadowLink?.href).toBe(`${origin}/links.html`);

          // 深度定位器：穿 shadow 找到，坐标在主视口系
          const located = await page.evaluate<LocateResult>(locateExpression(shadowBtn?.id ?? ""));
          expect(located.found).toBe(true);
          expect(located.inShadow).toBe(true);
          expect(located.origin).toBe(origin);
          expect(located.x).toBe(shadowBtn?.x);
          expect(located.y).toBe(shadowBtn?.y);

          // 坐标轨点击 shadow 内按钮真实生效
          await page.clickAt(
            Math.round((located.x ?? 0) + (located.w ?? 0) / 2),
            Math.round((located.y ?? 0) + (located.h ?? 0) / 2),
          );
          expect(await page.evaluate<string>("document.getElementById('hit').textContent")).toBe(
            "shadow-hit",
          );
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("同源 iframe：内层元素入快照、坐标含 frame 偏移、密码恒 ***、定位器可达", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/frames.html`);
          const snap = await extractSnapshot(page);

          const innerBtn = snap.nodes.find((n) => n.text === "inner button");
          expect(innerBtn).toBeDefined();
          const outerBtn = snap.nodes.find((n) => n.text === "outer button");
          expect(outerBtn).toBeDefined();

          // iframe 元素位置（页面布局：outer 之后 margin-top 20px）
          const frameRect = await page.evaluate<{ x: number; y: number }>(
            "(() => { const r = document.getElementById('same-origin').getBoundingClientRect(); return { x: r.x, y: r.y }; })()",
          );
          // 内层按钮主视口坐标 ≈ frame 偏移 + frame 内坐标（用定位器交叉验证）
          const located = await page.evaluate<LocateResult>(locateExpression(innerBtn?.id ?? ""));
          expect(located.found).toBe(true);
          expect(located.inFrame).toBe(true);
          expect(located.origin).toBe(origin);
          expect(located.y).toBeGreaterThanOrEqual(Math.round(frameRect.y));
          expect(innerBtn?.y).toBe(located.y); // 快照坐标 == 定位器坐标（同一换算）
          expect(outerBtn && innerBtn ? innerBtn.y - outerBtn.y : 0).toBeGreaterThan(20);

          // 内层密码框照常掩码
          const pw = snap.nodes.find((n) => n.type === "password");
          expect(pw?.value).toBe("***");
          expect(renderSnapshot(snap)).not.toContain("inner-secret");

          // 内层标题收集
          expect(snap.headings.some((h) => h.text === "Inner heading")).toBe(true);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("跨源 iframe：占位节点 + 警告 + 定位器不可达 + 坐标可点（导航由 S1 后检兜底）", async () => {
    await withFixtureServers(async ({ a, b }) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${a}/frames.html`);
          // 动态注入跨源 iframe（指向另一 origin）
          await page.evaluate(
            `(() => { const d = document.createElement('div'); d.innerHTML = '<iframe id="cross" src="${b}/index.html" width="400" height="200"></iframe>'; document.getElementById('cross-slot').appendChild(d.firstChild); return 1; })()`,
          );
          await new Promise((r) => setTimeout(r, 500)); // 等子帧加载
          const snap = await extractSnapshot(page);
          const placeholder = snap.nodes.find((n) => n.tag === "iframe");
          expect(placeholder).toBeDefined();
          expect(placeholder?.text).toBe("[cross-origin iframe]");
          expect(placeholder?.href).toBe(`${b}/index.html`);
          expect(snap.warnings.some((w) => w.includes("cross-origin"))).toBe(true);

          // 深度定位器：跨源内容不可达
          const inner = snap.nodes.find((n) => n.text === "inner button");
          const located = await page.evaluate<LocateResult>(locateExpression(inner?.id ?? ""));
          expect(located.found).toBe(true); // 同源 iframe 内可达
          const crossLocate = await page.evaluate<LocateResult>(
            locateExpression(placeholder?.id ?? ""),
          );
          // 占位 iframe 元素本身可定位（在主文档），其内部不可达
          expect(crossLocate.found).toBe(true);
          expect(crossLocate.tag).toBe("iframe");
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("above 标注：滚动后视口上方元素带 ↑", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, { width: 400, height: 300 }, async (page) => {
          await page.navigate(`${origin}/long?n=30`);
          const top = await extractSnapshot(page);
          expect(top.nodes[0]?.above).toBe(false);
          await page.evaluate("window.scrollTo(0, 900)");
          const scrolled = await extractSnapshot(page);
          const aboveNodes = scrolled.nodes.filter((n) => n.above);
          expect(aboveNodes.length).toBeGreaterThan(0);
          expect(renderSnapshot(scrolled)).toContain("↑above-viewport");
          // above/below 不进 domHash（U3 契约）
          expect(scrolled.domHash).toBe(top.domHash);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("settle 观察者：每次提取重装（document.open 后复活）、主文档/shadow/iframe 变化均可见、bw-id 打点不触发", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/shadow.html`);
          await extractSnapshot(page);

          // shadow 内变化 → lastChange 前进（B3 审查 P1-2 回归）
          const t0 = await page.evaluate<number>("window.__bwSettle.lastChange");
          await new Promise((r) => setTimeout(r, 30));
          await page.evaluate(
            "document.getElementById('host').shadowRoot.querySelector('button').textContent = 'changed'",
          );
          await new Promise((r) => setTimeout(r, 50));
          const t1 = await page.evaluate<number>("window.__bwSettle.lastChange");
          expect(t1).toBeGreaterThan(t0);

          // bw-id 打点不更新 lastChange
          await new Promise((r) => setTimeout(r, 30));
          const before = await page.evaluate<number>("window.__bwSettle.lastChange");
          await page.evaluate(
            "document.querySelector('button').setAttribute('data-bw-id', 'manual')",
          );
          await new Promise((r) => setTimeout(r, 50));
          const after = await page.evaluate<number>("window.__bwSettle.lastChange");
          expect(after).toBe(before);

          // document.open() 杀死观察者 → 重新提取即复活（B3 审查 P1-3 回归）
          await page.evaluate(
            '(() => { document.open(); document.write(\'<html lang="zh-CN"><body><button id="nb">new doc</button></body></html>\'); document.close(); return 1; })()',
          );
          await extractSnapshot(page);
          const t2 = await page.evaluate<number>("window.__bwSettle.lastChange");
          await new Promise((r) => setTimeout(r, 30));
          await page.evaluate("document.getElementById('nb').textContent = 'mutated'");
          await new Promise((r) => setTimeout(r, 50));
          const t3 = await page.evaluate<number>("window.__bwSettle.lastChange");
          expect(t3).toBeGreaterThan(t2);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("iframe 内变化 → settle lastChange 前进（B3 审查 P1-2 回归）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/frames.html`);
          await extractSnapshot(page); // 挂上子帧观察者
          const t0 = await page.evaluate<number>("window.__bwSettle.lastChange");
          await new Promise((r) => setTimeout(r, 30));
          await page.evaluate(
            "document.getElementById('same-origin').contentDocument.querySelector('#inner-btn').textContent = 'inner-mut'",
          );
          await new Promise((r) => setTimeout(r, 50));
          const t1 = await page.evaluate<number>("window.__bwSettle.lastChange");
          expect(t1).toBeGreaterThan(t0);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("懒加载页：滚动后新元素进入快照（domHash 随内容变化）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, { width: 400, height: 300 }, async (page) => {
          await page.navigate(`${origin}/lazy.html`);
          const before = await extractSnapshot(page);
          expect(before.nodes.length).toBe(1);
          await page.evaluate("window.scrollTo(0, 1200)");
          await new Promise((r) => setTimeout(r, 400)); // 等 scroll handler 追加
          const after = await extractSnapshot(page);
          expect(after.nodes.length).toBeGreaterThan(1);
          expect(after.domHash).not.toBe(before.domHash);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("视口优先截断：视口内元素先渲染，视口外排后", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, { width: 400, height: 300 }, async (page) => {
          await page.navigate(`${origin}/long?n=120`);
          const snap = await extractSnapshot(page, { budgetChars: 900 });
          expect(snap.truncated).toBe(true);
          const rendered = renderSnapshot(snap, 900);
          // 首个渲染的元素必须是视口内的（非 ↓below）
          const firstElement = rendered.split("\n").find((l) => l.startsWith("["));
          expect(firstElement).toBeDefined();
          expect(firstElement).not.toContain("↓below-viewport");
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("id 元素生命周期稳定：显隐变化后同元素同 id、新元素不撞号、locate 不错位（B22 S2 裁决改写 P0-1）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/index.html`);
          const s1 = await extractSnapshot(page);
          const linksId = s1.nodes.find((n) => n.text === "Links page")?.id;
          // 隐藏一个交互元素——存留元素 id 不变（文件会话跨命令索引连续的根基）
          await page.evaluate("document.querySelector('input').style.display = 'none'");
          const s2 = await extractSnapshot(page);
          const linksId2 = s2.nodes.find((n) => n.text === "Links page")?.id;
          expect(linksId2).toBeDefined();
          expect(linksId2).toBe(linksId); // B22 S2：同元素两次提取 id 稳定（WeakMap 身份）
          // 文档中不存在两个元素带同一 id（撞号会让 locate 命中隐藏元素）
          const duplicates = await page.evaluate<number>(
            `document.querySelectorAll('[data-bw-id="${linksId2}"]').length`,
          );
          expect(duplicates).toBe(1);
          // locate 用该 id 命中正确元素
          const located = await page.evaluate<LocateResult>(locateExpression(linksId2 ?? ""));
          expect(located.found).toBe(true);
          expect(located.text).toBe("Links page");
          // 替换元素（旧节点移除、新节点入树）→ 新元素拿全新 id，不与任何陈旧标记撞号
          const freshId = await page.evaluate<string>(
            "(() => { const a = document.createElement('a'); a.textContent = 'Fresh link'; a.href = '/fresh'; document.body.appendChild(a); const s = window.__bwIdSeq; return s; })()",
          );
          const s3 = await extractSnapshot(page);
          const freshNode = s3.nodes.find((n) => n.text === "Fresh link");
          expect(freshNode).toBeDefined();
          expect(Number(freshNode?.id)).toBeGreaterThan(Number(freshId));
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("隐藏 iframe 内容不入快照（P0-2 回归：display/visibility/opacity 三态）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/frames.html`);
          await page.evaluate(
            `(() => {
              const mk = (style) => {
                const f = document.createElement('iframe');
                f.src = '${origin}/iframe-inner.html';
                f.style.cssText = style + ';width:200px;height:80px';
                f.title = 'hidden-frame';
                document.body.appendChild(f);
              };
              mk('display:none'); mk('visibility:hidden'); mk('opacity:0');
              return 1;
            })()`,
          );
          await new Promise((r) => setTimeout(r, 600)); // 等子帧加载
          const snap = await extractSnapshot(page);
          const innerButtons = snap.nodes.filter((n) => n.text === "inner button");
          expect(innerButtons.length).toBe(1); // 只有可见 iframe 的那一个
          const innerPw = snap.nodes.filter((n) => n.type === "password");
          expect(innerPw.length).toBe(1);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("locate 未找到返回 {found:false}（P0-3 回归，不返回裸 null）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/index.html`);
          await extractSnapshot(page);
          const r = await page.evaluate<LocateResult>(locateExpression("999999"));
          expect(r).not.toBeNull();
          expect(r.found).toBe(false);
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("frame 裁剪：元素滚出 frame 顶边 → 坐标钳在 frame 盒内（P1-1 回归）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, { width: 800, height: 600 }, async (page) => {
          await page.navigate(`${origin}/frames.html`);
          await page.evaluate(
            `(() => {
              const f = document.createElement('iframe');
              f.src = '${origin}/iframe-inner.html';
              f.style.cssText = 'width:300px;height:100px;border:0';
              f.title = 'clip-frame';
              document.body.appendChild(f);
              return 1;
            })()`,
          );
          await new Promise((r) => setTimeout(r, 600));
          // 让注入 frame 的内文档上滚 40：其顶部元素被裁出 frame 顶边
          await page.evaluate(
            "document.querySelectorAll('iframe')[1].contentWindow.scrollTo(0, 40)",
          );
          await new Promise((r) => setTimeout(r, 200));
          const snap = await extractSnapshot(page);
          const boxes = await page.evaluate<
            Array<{ top: number; bottom: number; left: number; right: number }>
          >(
            `[...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })`,
          );
          expect(boxes.length).toBe(2);
          // 每个 iframe 内的 inner 元素节点，其渲染矩形必须完整落在某个 frame 盒内（1px 容差）
          const innerNodes = snap.nodes.filter(
            (n) => n.text === "inner link" || n.text === "inner button",
          );
          expect(innerNodes.length).toBeGreaterThan(0);
          for (const n of innerNodes) {
            const contained = boxes.some(
              (b) =>
                n.y >= Math.floor(b.top) - 1 &&
                n.y + n.h <= Math.ceil(b.bottom) + 1 &&
                n.x >= Math.floor(b.left) - 1 &&
                n.x + n.w <= Math.ceil(b.right) + 1,
            );
            expect(contained).toBe(true);
          }
          // 完全滚出顶边的元素（inner link 在内文档 y≈70，滚 40 后仍可见于 100 高 frame）；
          // 关键不变量：不存在越出任何 frame 盒的「可交互」坐标
          for (const n of snap.nodes) {
            expect(n.y).toBeGreaterThanOrEqual(-1);
          }
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("aria-hidden 与同色文本被过滤（P1-4 回归）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/index.html`);
          await page.evaluate(
            `(() => {
              const b1 = document.createElement('button');
              b1.type = 'button'; b1.textContent = 'aria-hidden-button';
              b1.setAttribute('aria-hidden', 'true');
              const b2 = document.createElement('button');
              b2.type = 'button'; b2.textContent = 'same-color-button';
              b2.style.color = 'rgb(255, 255, 255)'; b2.style.backgroundColor = 'rgb(255, 255, 255)';
              document.body.append(b1, b2);
              const h = document.createElement('h2');
              h.textContent = 'same-color-heading';
              h.style.color = 'rgb(255,255,255)'; h.style.backgroundColor = 'rgb(255,255,255)';
              document.body.append(h);
              return 1;
            })()`,
          );
          const snap = await extractSnapshot(page);
          expect(snap.nodes.some((n) => n.text === "aria-hidden-button")).toBe(false);
          expect(snap.nodes.some((n) => n.text === "same-color-button")).toBe(false);
          expect(snap.headings.some((h) => h.text === "same-color-heading")).toBe(false);
          expect(renderSnapshot(snap)).not.toContain("aria-hidden-button");
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("href 钳长 500（P2-5 回归：单条垃圾 URL 掏不空预算）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        await withDriverPage(driver, undefined, async (page) => {
          await page.navigate(`${origin}/index.html`);
          await page.evaluate(
            `(() => {
              const a = document.createElement('a');
              a.href = '${origin}/links.html?' + 'x'.repeat(11000);
              a.textContent = 'junk-url-link';
              document.body.appendChild(a);
              return 1;
            })()`,
          );
          const snap = await extractSnapshot(page);
          const junk = snap.nodes.find((n) => n.text === "junk-url-link");
          expect(junk).toBeDefined();
          expect(junk?.href?.length).toBeLessThanOrEqual(501);
          const rendered = renderSnapshot(snap);
          expect(rendered.length).toBeLessThanOrEqual(12000);
          // 其余元素仍然可渲染（预算没被单条 URL 吃光）
          expect(rendered).toContain('"Links page"');
        });
      } finally {
        driver.close();
      }
    });
  }, 60_000);
});

test("serializeDomTree 空返回兜底（tree.ts 兜底行）", async () => {
  await withFixtureServer(async (origin) => {
    const driver = createWebViewDriver();
    try {
      await withDriverPage(driver, undefined, async (page) => {
        await page.navigate(`${origin}/index.html`);
        // 正常路径已覆盖；兜底行需 evaluate 异常——以双后端行为一致性为准（chrome 契约行覆盖）
        const t = await serializeDomTree(page);
        expect(t.root.tag).toBe("body");
      });
    } finally {
      driver.close();
    }
  });
}, 30_000);

test("serializeDomTree 兜底：evaluate 返回 null → 占位空树（tree.ts:87）", async () => {
  const { FakeDriver } = await import("@bw/driver");
  const d = new FakeDriver(
    {
      cdp: false,
      upload: false,
      download: false,
      dialogEvents: false,
      userAgentOverride: false,
      pierceClick: false,
      httpOnlyCookies: false,
      networkEvents: false,
      webp: false,
      popups: false,
    },
    { evaluateHandler: () => null } as never,
  );
  const page = await d.createPage();
  const t = await serializeDomTree(page as never);
  expect(t).toEqual({ root: { tag: "body" }, nodeCount: 0, truncated: false });
});

test("serializeDomTree 兜底：返回无 root 的坏对象 → 占位空树", async () => {
  const { FakeDriver } = await import("@bw/driver");
  const d = new FakeDriver(
    {
      cdp: false,
      upload: false,
      download: false,
      dialogEvents: false,
      userAgentOverride: false,
      pierceClick: false,
      httpOnlyCookies: false,
      networkEvents: false,
      webp: false,
      popups: false,
    },
    { evaluateHandler: () => ({ nope: true }) } as never,
  );
  const page = await d.createPage();
  const t = await serializeDomTree(page as never);
  expect(t.root.tag).toBe("body");
});
