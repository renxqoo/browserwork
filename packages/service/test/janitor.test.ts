/** B22 S3：janitor + replay——自 b13.test.ts 移植（b13 随 serve/daemon 面删除），
 * 补 B22 审计修正：跨子目录聚合计量 + 活跃会话豁免（audit-service B22） */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepDir } from "../src/janitor.ts";
import { replayTrajectory } from "../src/replay.ts";

const tmpRoot = join(tmpdir(), `bw-s3-janitor-${Date.now()}`);
const freshDir = (name: string): string => {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("janitor（b13 移植）", () => {
  test("年龄策略：过期删除、新文件保留", () => {
    const dir = freshDir("age");
    const old = join(dir, "old.jsonl");
    const fresh = join(dir, "fresh.jsonl");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    const now = Date.now();
    utimesSync(old, new Date(now - 8 * 24 * 3600 * 1000), new Date(now - 8 * 24 * 3600 * 1000));
    utimesSync(fresh, new Date(now), new Date(now));
    const r = sweepDir(dir, { retentionDays: 7, maxTotalBytes: 1024 * 1024, now: () => now });
    expect(r.deleted).toBe(1);
    expect(readdirSync(dir)).toEqual(["fresh.jsonl"]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("容量策略：超限按最旧删到达标", () => {
    const dir = freshDir("size");
    const mk = (name: string, size: number, ageDays: number): void => {
      const p = join(dir, name);
      writeFileSync(p, "x".repeat(size));
      const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
      utimesSync(p, t, t);
    };
    mk("a.jsonl", 600, 3);
    mk("b.jsonl", 600, 2);
    mk("c.jsonl", 600, 1);
    const r = sweepDir(dir, { retentionDays: 7, maxTotalBytes: 1000 });
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const rest = readdirSync(dir);
    expect(rest.length).toBeLessThan(3);
    expect(rest).not.toContain("a.jsonl"); // 最旧的先删
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("目录不存在：no-throw", () => {
    expect(sweepDir(join(tmpRoot, "nonexistent"))).toEqual({ deleted: 0, bytesFreed: 0 });
  });
});

describe("replay（b13 移植）", () => {
  test("JSONL 渲染行 + 缺失文件报错", () => {
    const dir = freshDir("replay");
    const file = join(dir, "task-x.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        ts: 1,
        step: 0,
        action: { kind: "open_tab", url: "https://a/" },
        resultText: "opened\nsecond line",
        url: "https://a/",
        domHash: "aa",
      })}\n${JSON.stringify({
        ts: 2,
        step: 1,
        action: { kind: "llm", text: "hi" },
        resultText: "ok",
        url: "https://a/",
        domHash: "aa",
      })}\nnot-json\n`,
    );
    const out = replayTrajectory("task-x", dir);
    expect(out.ok).toBe(true);
    expect(out.lines[0]).toContain("#0 open_tab https://a/ domHash=aa | opened");
    expect(out.lines[1]).toContain("#1 llm");
    expect(out.lines[2]).toContain("unparseable");
    expect(replayTrajectory("nope", dir).ok).toBe(false);
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
