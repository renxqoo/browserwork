/** B22 S0 金测试：bw s 命令面纯映射（audit-service §4.4-22/23 行为锚——S3 重写 CLI 前先锁定） */
import { describe, expect, test } from "bun:test";
import { mapCliCommand, WIRE_NAMES } from "../src/cli-commands.ts";

describe("wire 名映射（§4.4-22，B11 回归锚）", () => {
  test("10 个 CLI 名归一为工具规范名", () => {
    expect(WIRE_NAMES).toEqual({
      scrollto: "scroll_to",
      opentab: "open_tab",
      switchtab: "switch_tab",
      closetab: "close_tab",
      extract: "extract_text",
      "cookies-set": "cookies_set",
      "cookies-clear": "cookies_clear",
      "storage-set": "storage_set",
      "storage-clear": "storage_clear",
      "cookies-all": "cookies_all",
    });
  });

  test("mapCliCommand 归一并透传规范名", () => {
    expect(mapCliCommand("scrollto", ["7"])).toEqual({ tool: "scroll_to", params: { index: "7" } });
    expect(mapCliCommand("click", ["3"])).toEqual({ tool: "click", params: { index: "3" } });
  });
});

describe("参数映射细节（§4.4-23）", () => {
  test("eval 表达式 args.join（可含空格）", () => {
    expect(mapCliCommand("eval", ["1", "+", "1"])).toEqual({
      tool: "eval",
      params: { expression: "1 + 1" },
    });
  });

  test("wait 第二参字面量 networkIdle → until", () => {
    expect(mapCliCommand("wait", ["2"])).toEqual({ tool: "wait", params: { seconds: 2 } });
    expect(mapCliCommand("wait", ["2", "networkIdle"])).toEqual({
      tool: "wait",
      params: { seconds: 2, until: "networkIdle" },
    });
  });

  test("scroll amount / resize 宽高数值化", () => {
    expect(mapCliCommand("scroll", ["down", "300"])).toEqual({
      tool: "scroll",
      params: { direction: "down", amount: 300 },
    });
    expect(mapCliCommand("resize", ["1280", "720"])).toEqual({
      tool: "resize",
      params: { width: 1280, height: 720 },
    });
  });

  test("upload 多文件 args.slice(1)", () => {
    expect(mapCliCommand("upload", ["5", "/a.txt", "/b.txt"])).toEqual({
      tool: "upload",
      params: { index: "5", files: ["/a.txt", "/b.txt"] },
    });
  });

  test("batch 参数整体 join 后 JSON.parse；坏 JSON → 专属错误", () => {
    expect(mapCliCommand("batch", ['[{"kind":"click","index":"1"}]'])).toEqual({
      tool: "batch",
      params: { steps: [{ kind: "click", index: "1" }] },
    });
    const bad = mapCliCommand("batch", ["{not json"]);
    expect("error" in bad && bad.error).toBe("steps must be a JSON array of actions");
  });

  test("storage 可选 key", () => {
    expect(mapCliCommand("storage", [])).toEqual({ tool: "storage", params: {} });
    expect(mapCliCommand("storage", ["k"])).toEqual({ tool: "storage", params: { key: "k" } });
  });

  test("cookies-set / storage-set 双 key-value 形", () => {
    expect(mapCliCommand("cookies-set", ["a", "1"])).toEqual({
      tool: "cookies_set",
      params: { key: "a", value: "1" },
    });
    expect(mapCliCommand("storage-set", ["k", "v"])).toEqual({
      tool: "storage_set",
      params: { key: "k", value: "v" },
    });
  });

  test("无参命令组", () => {
    for (const c of [
      "extract",
      "look",
      "closetab",
      "console",
      "errors",
      "cookies",
      "cookies-all",
      "requests",
      "reload",
      "cookies-clear",
      "storage-clear",
      "tabs",
    ]) {
      const r = mapCliCommand(c, []);
      expect("error" in r).toBe(false);
    }
  });
});

describe("usage 错误文案（§4.4-26 逐字锚）", () => {
  const usageOf = (cmd: string, args: string[]): string => {
    const r = mapCliCommand(cmd, args);
    return "error" in r ? r.error : "(no error)";
  };

  test("缺参 usage 文案", () => {
    expect(usageOf("click", [])).toBe("usage: bw s click <sessionId> <index>");
    expect(usageOf("type", ["1"])).toBe("usage: bw s type <sessionId> <index> <text>");
    expect(usageOf("navigate", [])).toBe("usage: bw s navigate <sessionId> <url>");
    expect(usageOf("press", [])).toBe("usage: bw s press <sessionId> <key>");
    expect(usageOf("select", ["1"])).toBe("usage: bw s select <sessionId> <index> <value>");
    expect(usageOf("wait", [])).toBe("usage: bw s wait <sessionId> <seconds> [networkIdle]");
    expect(usageOf("resize", ["1"])).toBe("usage: bw s resize <sessionId> <width> <height>");
    expect(usageOf("upload", ["1"])).toBe(
      "usage: bw s upload <sessionId> <index> <file> [file...]",
    );
    expect(usageOf("batch", [])).toBe("usage: bw s batch <sessionId> '<json steps array>'");
  });

  test("未知命令", () => {
    expect(usageOf("frobnicate", [])).toBe(
      "unknown tool \"frobnicate\" — run 'bw s --help' for list",
    );
  });
});

describe("旧 CLI 面边界（S0 锚——S3 增面时引用 MIGRATION-cli §4）", () => {
  test("extract_code / type_text_secret 不在旧 CLI 词表（B21 文档超前，S3 补）", () => {
    expect("extract_code" in WIRE_NAMES).toBe(false);
    const r = mapCliCommand("extract_code", ["(t) => 1"]);
    expect("error" in r).toBe(true);
  });
});
