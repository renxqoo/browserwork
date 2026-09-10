import { describe, expect, test } from "bun:test";
import { withFixtureServer } from "../src/index.ts";

describe("fixture server 路由（装置自证）", () => {
  test("静态页：内容与 content-type", async () => {
    await withFixtureServer(async (origin) => {
      const res = await fetch(`${origin}/index.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await res.text();
      expect(body).toContain("BW Fixture Home");
    });
  });

  test("/redirect：302 且 Location 透传", async () => {
    await withFixtureServer(async (origin) => {
      const res = await fetch(`${origin}/redirect?to=/links.html`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/links.html");
    });
  });

  test("/submitted：echo 查询参数且转义 <>&", async () => {
    await withFixtureServer(async (origin) => {
      // q 显式编码为 "<script>&x"（& 不当参数分隔符）
      const res = await fetch(`${origin}/submitted?q=${encodeURIComponent("<script>&x")}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("query: scriptx");
      expect(body).not.toContain("<script>");
    });
  });

  test("/long：数量钳制并生成对应条目", async () => {
    await withFixtureServer(async (origin) => {
      const res = await fetch(`${origin}/long?n=5`);
      const body = await res.text();
      expect((body.match(/item-\d+/g) ?? []).length).toBe(5);
      const big = await fetch(`${origin}/long?n=99999`);
      expect(((await big.text()).match(/item-\d+/g) ?? []).length).toBe(2000);
    });
  });

  test("/slow：按 sleep 延迟响应", async () => {
    await withFixtureServer(async (origin) => {
      const t0 = Date.now();
      const res = await fetch(`${origin}/slow?sleep=300`);
      expect(res.status).toBe(200);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      expect(await res.text()).toContain("BW Slow");
    });
  });

  test("未知路径与越界路径 404", async () => {
    await withFixtureServer(async (origin) => {
      expect((await fetch(`${origin}/nope.html`)).status).toBe(404);
      expect((await fetch(`${origin}/../package.json`)).status).toBe(404);
      expect((await fetch(`${origin}/`)).status).toBe(404); // 根路径=目录，不 EISDIR
    });
  });
});
