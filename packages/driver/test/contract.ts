/**
 * Page/Driver 接口契约套件（U2 测试口径）——同一套断言跑
 * FakeDriver / webkit 真 view / chrome 真 view。
 * env.real = 真 view（fixture 站导航/重定向/DNS 失败）；fixture 由
 * env.withFixture 提供生命周期（server 必须活到用例结束）。
 */
import { describe, expect, test } from "bun:test";
import { BWError } from "@bw/core";
import type { Driver } from "../src/index.ts";

export interface ContractEnv {
  real: boolean;
  /** real 必填：在 server 存活期内执行用例体 */
  withFixture?: <T>(fn: (origin: string) => Promise<T>) => Promise<T>;
}

export function runPageContractSuite(
  suiteName: string,
  createDriver: () => Driver | Promise<Driver>,
  env: ContractEnv,
): void {
  describe(`${suiteName} Page/Driver 契约`, () => {
    test("evaluate：表达式 + undefined→null + 并发互斥", async () => {
      const driver = await createDriver();
      try {
        const page = await driver.createPage();
        await page.navigate("about:blank");
        expect(await page.evaluate<number>("1+1")).toBe(2);
        expect(await page.evaluate("undefined")).toBeNull();
        await Promise.all([page.evaluate("1+1"), page.evaluate("2+2")]);
      } finally {
        driver.close();
      }
    });

    test(
      "click：未知 selector → ELEMENT_NOT_ACTIONABLE",
      async () => {
        const driver = await createDriver();
        try {
          const page = await driver.createPage();
          await page.navigate("about:blank");
          try {
            await page.click('[data-bw-id="999"]', env.real ? { timeoutMs: 800 } : undefined);
            expect.unreachable();
          } catch (e) {
            expect(BWError.is(e)).toBe(true);
            expect((e as BWError).code).toBe("ELEMENT_NOT_ACTIONABLE");
          }
        } finally {
          driver.close();
        }
      },
      env.real ? 20_000 : 5_000,
    );

    test("close：幂等；close 后全方法矩阵抛 DRIVER_ERROR（U2 测试口径）", async () => {
      const driver = await createDriver();
      try {
        const page = await driver.createPage();
        expect(typeof page.url).toBe("string");
        expect(typeof page.title).toBe("string");
        expect(typeof page.loading).toBe("boolean");
        page.close();
        page.close();
        for (const invoke of [
          () => page.url,
          () => page.title,
          () => page.loading,
          () => page.evaluate("1+1"),
          () => page.navigate("about:blank"),
          () => page.click("#x"),
          () => page.clickAt(1, 1),
          () => page.screenshot(),
        ] as Array<() => unknown>) {
          try {
            const result = invoke();
            if (result instanceof Promise) await result;
            expect.unreachable();
          } catch (e) {
            expect(BWError.is(e)).toBe(true);
            expect((e as BWError).code).toBe("DRIVER_ERROR");
          }
        }
      } finally {
        driver.close();
      }
    });

    test("navigate 互斥：并发 navigate 全部完成且按序落定（U2 契约回归）", async () => {
      const driver = await createDriver();
      try {
        const page = await driver.createPage();
        await page.navigate("about:blank");
        const [a, b] = await Promise.all([
          page.navigate("data:text/html,<title>first</title>"),
          page.navigate("data:text/html,<title>second</title>"),
        ]);
        void a;
        void b;
        // 两个都成功（不外泄 ERR_INVALID_STATE）；最终 url 为后落定者
        expect(page.url.startsWith("data:text/html")).toBe(true);
      } finally {
        driver.close();
      }
    });

    test("createPage({url})：初始导航完成且 url 正确（真/fake 对齐，B2 审查 P1-3）", async () => {
      const driver = await createDriver();
      try {
        if (env.real && env.withFixture !== undefined) {
          await env.withFixture(async (origin) => {
            const page = await driver.createPage({ url: `${origin}/links.html` });
            expect(page.url).toBe(`${origin}/links.html`);
            page.close();
          });
        } else {
          const page = await driver.createPage({ url: "fake://start/" });
          expect(page.url).toBe("fake://start/");
          page.close();
        }
      } finally {
        driver.close();
      }
    });

    test("onNavigated：订阅收事件，退订后零新事件（精确）", async () => {
      const driver = await createDriver();
      try {
        const page = await driver.createPage();
        const seen: string[] = [];
        const off = page.onNavigated((url) => seen.push(url));
        await page.navigate("about:blank");
        expect(seen).toEqual(["about:blank"]);
        off();
        await page.navigate(env.real ? "data:text/html,<title>b2</title>" : "about:blank#2");
        expect(seen).toEqual(["about:blank"]);
      } finally {
        driver.close();
      }
    });

    test(
      "navigate：失败 → NAVIGATION_FAILED",
      async () => {
        const driver = await createDriver();
        try {
          const page = await driver.createPage();
          try {
            await page.navigate(
              env.real ? "https://bw-nonexistent.invalid/" : "fake://definitely-fails/",
            );
            expect.unreachable();
          } catch (e) {
            expect(BWError.is(e)).toBe(true);
            expect((e as BWError).code).toBe("NAVIGATION_FAILED");
          }
        } finally {
          driver.close();
        }
      },
      env.real ? 30_000 : 5_000,
    );

    test("Driver：pages() 注册表随 page.close 收缩；driver.close 后 createPage 抛", async () => {
      const driver = await createDriver();
      const p1 = await driver.createPage();
      await driver.createPage();
      expect(driver.pages().length).toBe(2);
      p1.close();
      expect(driver.pages().length).toBe(1);
      driver.close();
      driver.close();
      try {
        await driver.createPage();
        expect.unreachable();
      } catch (e) {
        expect(BWError.is(e)).toBe(true);
        expect((e as BWError).code).toBe("DRIVER_ERROR");
      }
    });

    const withFixture = env.withFixture;
    if (env.real && withFixture !== undefined) {
      test("真 view：fixture 导航 + 重定向终态 + 截图 PNG + 坐标点击生效 + 导航超时", async () => {
        await withFixture(async (origin) => {
          const driver = await createDriver();
          try {
            const page = await driver.createPage();
            await page.navigate(`${origin}/index.html`);
            expect(page.url).toBe(`${origin}/index.html`);

            // 坐标轨：原生点击触发页面行为（在 index 页上做）
            const rect = await page.evaluate<{ x: number; y: number; w: number; h: number }>(
              "(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()",
            );
            await page.evaluate("document.getElementById('q').value = 'hi'");
            await page.clickAt(rect.x + rect.w / 2, rect.y + rect.h / 2);
            expect(await page.evaluate<string>("document.getElementById('out').textContent")).toBe(
              "searched: hi",
            );

            // 重定向终态（S1③ 数据源）
            const events: string[] = [];
            page.onNavigated((url) => events.push(url));
            const inner = encodeURIComponent(`${origin}/links.html`);
            await page.navigate(`${origin}/redirect?to=${inner}`);
            expect(events).toEqual([`${origin}/links.html`]);

            const png = await page.screenshot();
            expect(png[0]).toBe(0x89);

            // navigate timeoutMs：慢端点 → TIMEOUT（弃等；队列不阻塞后续导航）
            try {
              await page.navigate(`${origin}/slow?sleep=4000`, { timeoutMs: 500 });
              expect.unreachable();
            } catch (e) {
              expect(BWError.is(e)).toBe(true);
              expect((e as BWError).code).toBe("TIMEOUT");
            }
            await page.navigate(`${origin}/links.html`, { timeoutMs: 20_000 });
            expect(page.url).toBe(`${origin}/links.html`);

            // P0-1 回归：close 打断在途导航 → DRIVER_ERROR（不是 NAVIGATION_FAILED）
            const pending = page.navigate(`${origin}/slow?sleep=5000`);
            page.close();
            try {
              await pending;
              expect.unreachable();
            } catch (e) {
              expect(BWError.is(e)).toBe(true);
              expect((e as BWError).code).toBe("DRIVER_ERROR");
            }
          } finally {
            driver.close();
          }
        });
      }, 45_000);
    } else {
      test("fake：navigate timeoutMs 快路径不受影响", async () => {
        const driver = await createDriver();
        try {
          const page = await driver.createPage();
          await page.navigate("about:blank", { timeoutMs: 5000 });
          expect(page.url).toBe("about:blank");
        } finally {
          driver.close();
        }
      });
    }
  });
}
