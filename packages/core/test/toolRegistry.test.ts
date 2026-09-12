/** B22 S0（D1 单源）：工具词汇表封闭性 + 构造/校验表驱动——会话面与 agent 面的唯一规格锚 */
import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_KINDS, buildAction, TOOL_NAMES } from "../src/index.ts";

describe("词表封闭性", () => {
  test("注册构造器 = 动作词表 − done（done 由终止协议持有）", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [...BROWSER_ACTION_KINDS].filter((k) => k !== "done").sort(),
    );
  });

  test("词表封闭：BROWSER_ACTION_KINDS 无重复", () => {
    expect(new Set(BROWSER_ACTION_KINDS).size).toBe(BROWSER_ACTION_KINDS.length);
  });
});

describe("构造表（成功路径）", () => {
  test("全词表可构造（每词最少参数）", () => {
    const params: Record<string, Record<string, unknown>> = {
      navigate: { url: "https://a.test" },
      click: { index: "1" },
      type: { index: "1", text: "hi" },
      type_text_secret: { index: "1", secretName: "pw" },
      press: { key: "Enter" },
      scroll: { direction: "down" },
      scroll_to: { index: "1" },
      select: { index: "1", value: "a" },
      extract_text: {},
      look: {},
      open_tab: { url: "https://a.test" },
      switch_tab: { tab: 0 },
      close_tab: {},
      wait: { seconds: 1 },
      batch: { steps: [{ kind: "click", index: "1" }] },
      extract_code: { code: "(t) => 1" },
      resize: { width: 800, height: 600 },
      reload: {},
      download: { index: "1" },
      upload: { index: "1", files: ["/tmp/a"] },
    };
    for (const name of TOOL_NAMES) {
      const a = buildAction(name, params[name] ?? {});
      expect((a as { kind: string }).kind).toBe(name);
    }
  });

  test("可选参数保留：scroll amount / wait until=networkIdle", () => {
    expect(buildAction("scroll", { direction: "up", amount: 300 })).toEqual({
      kind: "scroll",
      direction: "up",
      amount: 300,
    });
    expect(buildAction("wait", { seconds: 2, until: "networkIdle" })).toEqual({
      kind: "wait",
      seconds: 2,
      until: "networkIdle",
    });
  });
});

describe("拒绝表（INVALID_TOOL_ARGS）", () => {
  const rejects = (name: string, params: Record<string, unknown>, msg: string): void => {
    expect(() => buildAction(name, params)).toThrow(msg);
  };

  test("未知工具", () => {
    rejects("nope", {}, "unknown tool");
  });

  test("缺参逐词（漂移回归锚）", () => {
    rejects("navigate", {}, "navigate requires url");
    rejects("click", {}, "click requires index");
    rejects("type", { index: "1" }, "type requires");
    rejects("type_text_secret", { index: "1" }, "type_text_secret requires");
    rejects("press", {}, "press requires key");
    rejects("scroll", {}, "scroll requires direction");
    rejects("select", { index: "1" }, "select requires");
    rejects("open_tab", {}, "open_tab requires url");
    rejects("switch_tab", {}, "switch_tab requires tab");
    rejects("wait", {}, "wait requires seconds");
    rejects("extract_code", {}, "extract_code requires code");
    rejects("extract_code", { code: "" }, "extract_code requires code");
    rejects("resize", { width: 1 }, "resize requires");
    rejects("upload", { index: "1" }, "upload requires index and files[]");
  });

  test("类型不符（number 字段给字符串）", () => {
    rejects("switch_tab", { tab: "0" }, "switch_tab requires tab");
    rejects("wait", { seconds: "1" }, "wait requires seconds");
  });

  test("wait until 只认 networkIdle", () => {
    rejects("wait", { seconds: 1, until: "idle" }, "networkIdle");
  });
});

describe("batch 单点（审计 B8 裁决）", () => {
  test("空 steps 拒绝（旧会话面放行——漂移修正）", () => {
    expect(() => buildAction("batch", { steps: [] })).toThrow("at least one step");
  });

  test("超 10 步拒绝", () => {
    const steps = Array.from({ length: 11 }, () => ({ kind: "click", index: "1" }));
    expect(() => buildAction("batch", { steps })).toThrow("exceed limit");
  });

  test("禁 done / 嵌套 batch / 缺 kind / 子步递归校验", () => {
    expect(() => buildAction("batch", { steps: [{ kind: "done" }] })).toThrow("not contain done");
    expect(() => buildAction("batch", { steps: [{ kind: "batch", steps: [] }] })).toThrow(
      "nested batch",
    );
    expect(() => buildAction("batch", { steps: [{}] })).toThrow("missing kind");
    expect(() => buildAction("batch", { steps: [{ kind: "click" }] })).toThrow(
      "click requires index",
    );
  });

  test("steps 非数组拒绝", () => {
    expect(() => buildAction("batch", { steps: "x" })).toThrow("batch requires steps[]");
  });
});
