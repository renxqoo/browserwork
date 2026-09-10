/**
 * U4 真 webkit 集成旅程：表单全链路（输入→提交→落地页）、Enter 提交、
 * select、shadow 点击、look、tab 管理——动作引擎与真实页面行为的闭环。
 */
import { describe, expect, test } from "bun:test";
import type { NavigationIntent } from "@bw/core";
import { createWebViewDriver } from "@bw/driver";
import { withFixtureServer } from "@bw/testing";
import { createActionEngine } from "../src/index.ts";

describe.skipIf(process.platform !== "darwin")("动作引擎真 view 旅程", () => {
  test("表单全链路：输入→点击提交（submit 意图）→落地页 echo", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const intents: NavigationIntent[] = [];
        const engine = createActionEngine(driver, {
          intentSink: (i) => {
            intents.push(i);
          },
          settleQuietMs: 300,
          settleCapMs: 8000,
        });

        const opened = await engine.act({ kind: "open_tab", url: `${origin}/form.html` });
        expect(opened.snapshot?.url).toBe(`${origin}/form.html`);

        const q = opened.snapshot?.nodes.find((n) => n.type === "text");
        expect(q).toBeDefined();
        const typed = await engine.act(
          { kind: "type", index: q?.id ?? "", text: "hello world" },
          opened.snapshot,
        );
        // 复合步重打 id：动作必须引用最新快照（agent 循环同规则）
        const submit = typed.snapshot?.nodes.find((n) => n.text === "Submit query");
        expect(submit).toBeDefined();
        const submitted = await engine.act(
          { kind: "click", index: submit?.id ?? "" },
          typed.snapshot,
        );
        expect(intents).toEqual([{ kind: "submit", href: `${origin}/submitted`, method: "get" }]);
        expect(submitted.snapshot?.url).toContain("/submitted?q=hello+world");

        const text = await engine.act({ kind: "extract_text" });
        expect(text.text).toContain("query: hello world");
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("Enter 提交（enter_submit 意图）与 select 原生 setter", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const intents: NavigationIntent[] = [];
        const engine = createActionEngine(driver, {
          intentSink: (i) => {
            intents.push(i);
          },
          settleQuietMs: 300,
          settleCapMs: 8000,
        });
        const opened = await engine.act({ kind: "open_tab", url: `${origin}/form.html` });

        const q = opened.snapshot?.nodes.find((n) => n.type === "text");
        const sel = opened.snapshot?.nodes.find((n) => n.tag === "select");
        expect(sel).toBeDefined();

        const selected = await engine.act(
          { kind: "select", index: sel?.id ?? "", value: "slow" },
          opened.snapshot,
        );
        const mode = await engine
          .activePage()
          .evaluate<string>("document.getElementById('mode').value");
        expect(mode).toBe("slow");

        const qNow = selected.snapshot?.nodes.find((n) => n.type === "text");
        expect(qNow).toBeDefined();
        await engine.act(
          { kind: "type", index: qNow?.id ?? "", text: "via-enter" },
          selected.snapshot,
        );
        const landed = await engine.act({ kind: "press", key: "Enter" });
        expect(intents).toEqual([
          { kind: "enter_submit", href: `${origin}/submitted`, method: "get" },
        ]);
        expect(landed.snapshot?.url).toContain("via-enter");
        expect(landed.snapshot?.url).toContain("mode=slow");
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("shadow DOM 坐标轨点击 + look 截图 + tab 管理", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const engine = createActionEngine(driver, { settleQuietMs: 300, settleCapMs: 8000 });
        const opened = await engine.act({ kind: "open_tab", url: `${origin}/shadow.html` });

        const shadowBtn = opened.snapshot?.nodes.find((n) => n.text === "shadow button");
        expect(shadowBtn).toBeDefined();
        await engine.act({ kind: "click", index: shadowBtn?.id ?? "" }, opened.snapshot);
        expect(
          await engine.activePage().evaluate<string>("document.getElementById('hit').textContent"),
        ).toBe("shadow-hit");

        const look = await engine.act({ kind: "look" });
        expect(look.image?.base64.length ?? 0).toBeGreaterThan(100);

        const second = await engine.act({ kind: "open_tab", url: `${origin}/links.html` });
        expect(second.snapshot?.headings[0]?.text).toBe("Links");
        const back = await engine.act({ kind: "switch_tab", tab: 0 });
        expect(back.snapshot?.title).toBe("BW Fixture Shadow");
        await engine.act({ kind: "close_tab" });
        expect(driver.pages().length).toBe(1);
      } finally {
        driver.close();
      }
    });
  }, 60_000);

  test("scroll_to 深处元素后可点（below-viewport 链接）", async () => {
    await withFixtureServer(async (origin) => {
      const driver = createWebViewDriver();
      try {
        const engine = createActionEngine(driver, { settleQuietMs: 300, settleCapMs: 8000 });
        const opened = await engine.act({
          kind: "open_tab",
          url: `${origin}/long?n=40`,
        });
        // 视口 720：找 below 的链接
        const deep = opened.snapshot?.nodes.find((n) => n.below && n.tag === "a");
        expect(deep).toBeDefined();
        const landed = await engine.act({ kind: "click", index: deep?.id ?? "" }, opened.snapshot);
        expect(landed.snapshot?.url).toBe(`${origin}/links.html`);
      } finally {
        driver.close();
      }
    });
  }, 60_000);
});
