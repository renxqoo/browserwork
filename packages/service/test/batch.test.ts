/** B22 S4：--jobs 批量执行器——行解析/容错/并发执行/汇总（runCommand 注入避免真 spawn GLM） */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchTaskLine } from "../src/batch.ts";
import { parseTaskLine, renderBatchSummary, runBatchFile } from "../src/batch.ts";

const HOME = mkdtempSync(join(tmpdir(), "bw-batch-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("parseTaskLine", () => {
  test("goal 必填；可选字段透传；非法行拒绝", () => {
    const ok = parseTaskLine(
      '{"goal":"g","startUrl":"https://a/","name":"n","backend":"chrome","maxSteps":3}',
    );
    expect("task" in ok).toBe(true);
    if ("task" in ok) {
      expect(ok.task.goal).toBe("g");
      expect(ok.task.startUrl).toBe("https://a/");
      expect(ok.task.backend).toBe("chrome");
      expect(ok.task.maxSteps).toBe(3);
    }
    expect("error" in parseTaskLine("{}")).toBe(true);
    expect("error" in parseTaskLine("not json")).toBe(true);
    expect("error" in parseTaskLine("")).toBe(true);
    const badSteps = parseTaskLine('{"goal":"g","maxSteps":"x"}');
    expect("task" in badSteps).toBe(true); // 非数值 maxSteps 静默忽略（可选字段）
    if ("task" in badSteps) expect(badSteps.task.maxSteps).toBeUndefined();
  });
});

describe("runBatchFile（runCommand 注入）", () => {
  const file = (lines: string[]): string => {
    const p = join(HOME, `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
    writeFileSync(p, lines.join("\n"));
    return p;
  };
  const cmd = (exitFor: (t: BatchTaskLine) => number) => (t: BatchTaskLine) => ({
    cmd: "/bin/sh",
    args: ["-c", `exit ${exitFor(t)}`],
  });

  test("全成 → exit 0；混合失败 → exit 1 且非法行记败不中断", async () => {
    const all = await runBatchFile({
      jobs: 2,
      file: file(['{"goal":"a"}', '{"goal":"b"}']),
      runCommand: cmd(() => 0),
    });
    expect(all.exitCode).toBe(0);
    expect(all.outcomes).toHaveLength(2);
    expect(all.outcomes.every((o) => o.status === "done")).toBe(true);

    const mixed = await runBatchFile({
      jobs: 2,
      file: file(['{"goal":"ok"}', "not-json", '{"goal":"boom"}']),
      runCommand: cmd((t) => (t.goal === "boom" ? 3 : 0)),
    });
    expect(mixed.exitCode).toBe(1);
    expect(mixed.outcomes.find((o) => o.line === 2)?.status).toBe("failed"); // 非法行
    expect(mixed.outcomes.find((o) => o.line === 3)?.exitCode).toBe(3);
  }, 30_000);

  test("缺文件 → exit 2", async () => {
    const r = await runBatchFile({ jobs: 1, file: join(HOME, "nope.jsonl") });
    expect(r.exitCode).toBe(2);
  });

  test("汇总渲染", () => {
    const text = renderBatchSummary([
      { line: 1, name: "a", status: "done" },
      { line: 2, name: "b", status: "failed", error: "exit 3" },
    ]);
    expect(text).toContain("1/2 done");
    expect(text).toContain("✗ line 2 b — exit 3");
  });
});
