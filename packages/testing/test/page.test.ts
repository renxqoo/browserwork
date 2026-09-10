import { describe, expect, test } from "bun:test";
import { waitForNavigation } from "../src/index.ts";

function fakePage(get: () => { url: string; loading: boolean }) {
  return {
    get url() {
      return get().url;
    },
    get loading() {
      return get().loading;
    },
  };
}

describe("waitForNavigation", () => {
  test("url 变化且加载完成 → 立即返回新 url", async () => {
    let state = { url: "https://a.test/1", loading: false };
    const page = fakePage(() => state);
    setTimeout(() => {
      state = { url: "https://a.test/2", loading: true };
      setTimeout(() => {
        state = { url: "https://a.test/2", loading: false };
      }, 60);
    }, 30);
    const landed = await waitForNavigation(page, 2000);
    expect(landed).toBe("https://a.test/2");
  });

  test("超时未变 → 返回当前 url 不抛错（同页锚点等合法场景）", async () => {
    const page = fakePage(() => ({ url: "https://a.test/1", loading: false }));
    const started = Date.now();
    const landed = await waitForNavigation(page, 150);
    expect(landed).toBe("https://a.test/1");
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});
