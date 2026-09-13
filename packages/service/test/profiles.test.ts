/** B22 S4（U5/U11）：登录态快照——fs 层 + webkit 读取面 + store 注入/捕获（fake seam） */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverCapabilities } from "@bw/driver";
import { FakeDriver, type FakePageOptions } from "@bw/driver";
import { EXTRACT_EXPRESSION } from "@bw/perception";
import {
  assertProfileName,
  deleteProfile,
  listProfiles,
  loadProfileFile,
  readStorageState,
  saveProfileFile,
  writeStorageState,
} from "../src/profiles.ts";

const HOME = mkdtempSync(join(tmpdir(), "bw-prof-"));
process.env.BW_HOME = HOME;

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const CAPS: DriverCapabilities = {
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
};

const mkPage = (cookie: string, ls: Record<string, string>) => {
  const d = new FakeDriver(CAPS, {
    evaluateHandler: (expr: string) => {
      if (expr === "document.cookie") return cookie;
      if (expr.startsWith("(() => { try { const o = {}") || expr.includes("localStorage.length")) {
        return [{ origin: "http://127.0.0.1:9", entries: ls }];
      }
      if (expr === EXTRACT_EXPRESSION) {
        return {
          nodes: [],
          headings: [],
          warnings: [],
          title: "t",
          url: "http://127.0.0.1:9/",
          scrollY: 0,
          scrollX: 0,
          docHeight: 800,
          viewportH: 720,
        };
      }
      if (expr.startsWith("document.cookie =")) return 1;
      if (expr.includes("localStorage.setItem")) return 1;
      return null;
    },
  } as Partial<FakePageOptions>) as unknown as Driver;
  return d;
};

describe("profiles fs 层", () => {
  test("名字校验：路径穿越拒绝", () => {
    expect(() => assertProfileName("../evil")).toThrow();
    expect(() => assertProfileName("a/b")).toThrow();
    expect(() => assertProfileName("")).toThrow();
    expect(() => assertProfileName("x".repeat(65))).toThrow();
  });

  test("save → list → load → delete 往返（0600）", () => {
    const path = saveProfileFile({
      schemaVersion: 1,
      name: "github",
      createdAt: Date.now(),
      backend: "webkit",
      cookies: [{ name: "sid", value: "v", domain: "github.com", path: "/" }],
      localStorage: [],
    });
    expect(existsSync(path)).toBe(true);
    expect(listProfiles().some((p) => p.name === "github")).toBe(true);
    const loaded = loadProfileFile("github");
    expect(loaded.cookies[0]?.value).toBe("v");
    expect(deleteProfile("github")).toBe(true);
    expect(deleteProfile("github")).toBe(false);
    expect(() => loadProfileFile("github")).toThrow("not found");
  });
});

describe.skipIf(process.platform !== "darwin")("webkit 读写面（fake page）", () => {
  test("read：document.cookie 可见面 + localStorage", async () => {
    const d = mkPage("sid=abc; theme=dark", { k1: "v1" });
    const page = await d.createPage({ url: "http://127.0.0.1:9/" });
    const state = await readStorageState(page, CAPS);
    expect(state.backend).toBe("webkit"); // U11：可见面
    expect(state.cookies.map((c) => c.name)).toEqual(["sid", "theme"]);
    expect(state.localStorage[0]?.entries).toEqual({ k1: "v1" });
  });

  test("write：cookie + localStorage 注入（可见面尽力而为）", async () => {
    const d = mkPage("", {});
    const page = await d.createPage({ url: "http://127.0.0.1:9/" });
    await writeStorageState(page, CAPS, {
      cookies: [{ name: "sid", value: "v", domain: "", path: "/" }],
      localStorage: [{ origin: "http://127.0.0.1:9", entries: { k: "v" } }],
    });
    const read = await page.evaluate<string>("document.cookie");
    expect(read).toBe(""); // fake 不真写——注入表达式被调用不抛即过（写路径实测在 store 注入面）
  });
});
