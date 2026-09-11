import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_KINDS, type BrowserAction, isBrowserActionKind } from "../src/index.ts";

describe("BrowserAction 词表封闭（U1）", () => {
  test("kind 词表 == 文档词表（03-units.md U4）", () => {
    expect([...BROWSER_ACTION_KINDS]).toEqual([
      "navigate",
      "click",
      "type",
      "type_text_secret",
      "press",
      "scroll",
      "scroll_to",
      "select",
      "extract_text",
      "look",
      "open_tab",
      "switch_tab",
      "close_tab",
      "wait",
      "resize",
      "reload",
      "download",
      "upload",
      "done",
    ]);
  });

  test("无重复", () => {
    expect(new Set(BROWSER_ACTION_KINDS).size).toBe(BROWSER_ACTION_KINDS.length);
  });

  test("isBrowserActionKind 拒绝词表外", () => {
    for (const k of BROWSER_ACTION_KINDS) expect(isBrowserActionKind(k)).toBe(true);
    expect(isBrowserActionKind("delete_everything")).toBe(false);
    expect(isBrowserActionKind("")).toBe(false);
  });
});

describe("BrowserAction 判别联合穷举（编译期穷举 + 运行时形态抽样）", () => {
  const samples: BrowserAction[] = [
    { kind: "navigate", url: "https://x/" },
    { kind: "click", index: "3" },
    { kind: "type", index: "3", text: "hi" },
    { kind: "type_text_secret", index: "3", secretName: "password" },
    { kind: "press", key: "Enter" },
    { kind: "scroll", direction: "down" },
    { kind: "scroll", direction: "up", amount: 400 },
    { kind: "scroll_to", index: "9" },
    { kind: "select", index: "4", value: "a" },
    { kind: "extract_text" },
    { kind: "look" },
    { kind: "open_tab", url: "https://y/" },
    { kind: "switch_tab", tab: 0 },
    { kind: "close_tab" },
    { kind: "wait", seconds: 1 },
    { kind: "resize", width: 1024, height: 768 },
    { kind: "reload" },
    { kind: "download", index: "5" },
    { kind: "upload", index: "6", files: ["/tmp/a.txt"] },
    { kind: "done", answer: "ok" },
    { kind: "done" },
  ];

  test("每种形态至少一条；kind 均在词表内", () => {
    expect(new Set(samples.map((a) => a.kind))).toEqual(new Set(BROWSER_ACTION_KINDS));
    for (const a of samples) {
      expect(isBrowserActionKind(a.kind)).toBe(true);
    }
  });

  test("穷举 switch（新增 kind 未覆盖时编译失败）", () => {
    const kinds = samples.map((a) => {
      switch (a.kind) {
        case "navigate":
        case "click":
        case "type":
        case "type_text_secret":
        case "press":
        case "scroll":
        case "scroll_to":
        case "select":
        case "extract_text":
        case "look":
        case "open_tab":
        case "switch_tab":
        case "close_tab":
        case "wait":
        case "resize":
        case "reload":
        case "download":
        case "upload":
        case "done":
          return a.kind;
        default: {
          const never: never = a;
          return never;
        }
      }
    });
    expect(kinds.length).toBe(samples.length);
  });
});
