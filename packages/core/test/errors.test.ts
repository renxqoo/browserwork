import { describe, expect, test } from "bun:test";
import { BWError, ERROR_CODES, isErrorCode } from "../src/index.ts";

/** 词表封闭性：导出枚举 == 基线文档 §4.3 词表（双向） */
describe("ERROR_CODES 词表封闭", () => {
  test("与文档词表逐项相等", () => {
    expect([...ERROR_CODES]).toEqual([
      "ELEMENT_NOT_FOUND",
      "ELEMENT_NOT_ACTIONABLE",
      "NAVIGATION_FAILED",
      "POLICY_BLOCKED",
      "CONFIRMATION_DENIED",
      "BUDGET_EXCEEDED",
      "DRIVER_ERROR",
      "TIMEOUT",
    ]);
  });

  test("无重复项", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe("BWError", () => {
  test("携带 code 与英文 message", () => {
    const e = new BWError("POLICY_BLOCKED", "navigation to origin not allowed");
    expect(e.code).toBe("POLICY_BLOCKED");
    expect(e.message).toBe("navigation to origin not allowed");
    expect(e.name).toBe("BWError");
  });

  test("cause 透传", () => {
    const root = new Error("dns failure");
    const e = new BWError("NAVIGATION_FAILED", "navigation failed", { cause: root });
    expect(e.cause).toBe(root);
  });

  test("detail 可选：未传时 undefined，传入时保留", () => {
    expect(new BWError("TIMEOUT", "t").detail).toBeUndefined();
    expect(new BWError("TIMEOUT", "t", { detail: { waited: 30 } }).detail).toEqual({ waited: 30 });
  });

  test("isErrorCode 只接受词表内的值", () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(isErrorCode("NOT_A_CODE")).toBe(false);
    expect(isErrorCode("")).toBe(false);
  });

  test("is() 只识别 BWError", () => {
    expect(BWError.is(new BWError("TIMEOUT", "t"))).toBe(true);
    expect(BWError.is(new Error("t"))).toBe(false);
    expect(BWError.is(null)).toBe(false);
  });

  test("instanceof Error 链保持（可被普通 catch 消费）", () => {
    try {
      throw new BWError("DRIVER_ERROR", "host died");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
