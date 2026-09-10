/**
 * B4 对抗审查回归（真 webkit）：P0-1 滚动后坐标、P1-2 submit 误报、
 * P1-3 click 后导航快照时效、P1-4 iframe enter_submit、select change、受控输入。
 */
import { describe, expect, test } from "bun:test";
import type { NavigationIntent } from "@bw/core";
import { createWebViewDriver } from "@bw/driver";
import { withFixtureServer } from "@bw/testing";
import { createActionEngine } from "../src/index.ts";

describe.skipIf(process.platform !== "darwin")("B4 审查回归", () => {
  test("P0-1：below-viewport 的 shadow 元素——滚动后重定位再点击，命中非假成功", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const engine = createActionEngine(driver, { settleQuietMs: 250, settleCapMs: 6000 });
        const opened = await engine.act({ kind: "open_tab", url: `${origin}/deep-shadow.html` });
        const deep = opened.snapshot?.nodes.find((n) => n.text === "shadow-deep");
        expect(deep).toBeDefined();
        expect(deep?.below).toBe(true);
        await engine.act({ kind: "click", index: deep?.id ?? "" }, opened.snapshot);
        expect(
          await engine.activePage().evaluate<string>("document.getElementById('hit').textContent"),
        ).toBe("HIT");
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("P1-2：点击表单内普通 input/checkbox 不产生 submit 意图；点 submit 才有", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const intents: NavigationIntent[] = [];
        const engine = createActionEngine(driver, {
          intentSink: (i) => {
            intents.push(i);
          },
          settleQuietMs: 250,
          settleCapMs: 6000,
        });
        let snap = (await engine.act({ kind: "open_tab", url: `${origin}/form.html` })).snapshot;
        const q = snap?.nodes.find((n) => n.type === "text");
        snap = (await engine.act({ kind: "click", index: q?.id ?? "" }, snap)).snapshot;
        expect(intents).toEqual([]); // 聚焦 ≠ 提交

        const pw = snap?.nodes.find((n) => n.type === "password");
        snap = (await engine.act({ kind: "click", index: pw?.id ?? "" }, snap)).snapshot;
        expect(intents).toEqual([]);

        const submit = snap?.nodes.find((n) => n.text === "Submit query");
        await engine.act({ kind: "click", index: submit?.id ?? "" }, snap);
        expect(intents).toEqual([{ kind: "submit", href: `${origin}/submitted`, method: "get" }]);
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("P1-3：click 触发 JS 跳转（立即/延迟 400ms）→ 返回快照是落地页而非旧页", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const engine = createActionEngine(driver, { settleQuietMs: 400, settleCapMs: 8000 });
        for (const id of ["now", "late"]) {
          const opened = await engine.act({ kind: "open_tab", url: `${origin}/late-nav.html` });
          await new Promise((r) => setTimeout(r, 1200)); // 模拟 LLM 延迟（观察者已静默）
          const link = opened.snapshot?.nodes.find(
            (n) => n.href?.includes("late-nav.html#") || n.text?.includes("navigation"),
          );
          const target = opened.snapshot?.nodes.find(
            (n) => n.text === `${id === "now" ? "now" : "late"} navigation`,
          );
          void link;
          const landed = await engine.act(
            { kind: "click", index: target?.id ?? "" },
            opened.snapshot,
          );
          expect(landed.snapshot?.url).toBe(`${origin}/links.html`);
          await engine.act({ kind: "close_tab" });
        }
      } finally {
        driver.close();
      }
    });
  }, 90_000);

  test("P1-4：焦点在同源 iframe 表单内按 Enter → enter_submit 意图可见（深度走查）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const intents: NavigationIntent[] = [];
        const engine = createActionEngine(driver, {
          intentSink: (i) => {
            intents.push(i);
          },
          settleQuietMs: 250,
          settleCapMs: 6000,
        });
        await engine.act({ kind: "open_tab", url: `${origin}/frames.html` });
        const page = engine.activePage();
        // 在同源 iframe 内注入表单输入框
        await page.evaluate(
          `(() => {
            const f = document.getElementById('same-origin');
            f.contentDocument.body.insertAdjacentHTML(
              'beforeend',
              '<form action="${origin}/submitted" method="get"><input id="fi" type="text" name="q" /></form>',
            );
            return 1;
          })()`,
        );
        // 坐标点击聚焦 iframe 内输入框（引擎坐标轨同路径）
        const center = await page.evaluate<{ x: number; y: number }>(
          `(() => {
            const f = document.getElementById('same-origin');
            const i = f.contentDocument.getElementById('fi');
            const fr = f.getBoundingClientRect();
            const r = i.getBoundingClientRect();
            return { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2) };
          })()`,
        );
        await page.clickAt(center.x, center.y);
        await page.type("iframe-query");
        await engine.act({ kind: "press", key: "Enter" });
        expect(intents).toEqual([
          { kind: "enter_submit", href: `${origin}/submitted`, method: "get" },
        ]);
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("select 触发 change 事件（监听器断言）+ 受控输入重渲染后 value 可读", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const engine = createActionEngine(driver, { settleQuietMs: 250, settleCapMs: 6000 });
        const opened = await engine.act({ kind: "open_tab", url: `${origin}/reactish.html` });

        const picker = opened.snapshot?.nodes.find((n) => n.tag === "select");
        const selected = await engine.act(
          { kind: "select", index: picker?.id ?? "", value: "b" },
          opened.snapshot,
        );
        expect(
          await engine
            .activePage()
            .evaluate<string>("document.getElementById('change-log').textContent"),
        ).toBe("changes: b");

        // 受控输入：select 复合步后用最新快照
        const input = selected.snapshot?.nodes.find((n) => n.type === "text");
        const typed = await engine.act(
          { kind: "type", index: input?.id ?? "", text: "live" },
          selected.snapshot,
        );
        expect(
          await engine
            .activePage()
            .evaluate<string>("document.getElementById('mirror').textContent"),
        ).toBe("value: live");
        expect(typed.snapshot?.nodes.some((n) => n.value === "live")).toBe(true);
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("scroll 动作在真 view 上生效（快照滚动位置前进）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const engine = createActionEngine(driver, { settleQuietMs: 250, settleCapMs: 6000 });
        await engine.act({ kind: "open_tab", url: `${origin}/long?n=60` });
        const scrolled = await engine.act({ kind: "scroll", direction: "down" });
        expect(scrolled.snapshot?.scroll.y ?? 0).toBeGreaterThan(100);
      } finally {
        driver.close();
      }
    });
  }, 60_000);
});
