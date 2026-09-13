/** B22 S4：pending 文件生命周期——写入/读取/过期/确认消费（§4b） */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmPending,
  expirePending,
  listPending,
  readPending,
  writePending,
} from "../src/confirmations.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "bw-confirm-"));

describe("pending 生命周期", () => {
  test("write → list/read → confirm approve 消费文件", () => {
    const d = dir();
    try {
      writePending(d, {
        cid: "sc-1",
        reason: "r",
        createdAt: Date.now(),
        action: { kind: "navigate", url: "https://a/" },
      });
      expect(listPending(d).map((p) => p.cid)).toEqual(["sc-1"]);
      expect(readPending(d, "sc-1")?.reason).toBe("r");
      const r = confirmPending(d, "sc-1", true);
      expect("rec" in r).toBe(true);
      expect(existsSync(join(d, "pending", "sc-1.json"))).toBe(false); // 消费
      expect(listPending(d)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("deny 消费；未知 cid 报错；过期（120s）惰性清扫", () => {
    const d = dir();
    try {
      writePending(d, { cid: "sc-old", reason: "r", createdAt: Date.now() - 200_000 });
      writePending(d, { cid: "sc-new", reason: "r", createdAt: Date.now() });
      const expired = expirePending(d);
      expect(expired.map((p) => p.cid)).toEqual(["sc-old"]);
      expect(listPending(d).map((p) => p.cid)).toEqual(["sc-new"]);
      const late = confirmPending(d, "sc-old", true);
      expect("error" in late).toBe(true);
      const denied = confirmPending(d, "sc-new", false);
      expect("rec" in denied).toBe(true);
      const ghost = confirmPending(d, "sc-nope", true);
      expect("error" in ghost).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("空目录 no-throw", () => {
    const d = dir();
    try {
      expect(listPending(d)).toEqual([]);
      expect(expirePending(d)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
