/**
 * bw replay（B13 §3.5）：轨迹 JSONL 只读打印——step/action/url/domHash/结果首行。
 * 入参为 taskId（在 baseDir 找 `<id>.jsonl`）或直接文件路径。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrajectoryEntry } from "@bw/core";

export function resolveTrajectoryPath(target: string, baseDir: string): string {
  if (target.endsWith(".jsonl")) return target;
  return join(baseDir, `${target}.jsonl`);
}

export interface ReplayOutcome {
  ok: boolean;
  lines: string[];
  error?: string;
}

/** 剥离 ESC/C0 控制字符（保留 \t；轨迹内容来自不可信页面——终端注入面，B13 审查 P2-10） */
const stripControl = (s: string): string => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** 读轨迹并渲染行（不触终端——CLI 与测试共用） */
export function replayTrajectory(target: string, baseDir: string): ReplayOutcome {
  const path = resolveTrajectoryPath(target, baseDir);
  if (!existsSync(path)) {
    return { ok: false, lines: [], error: `trajectory not found: ${path}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, lines: [], error: e instanceof Error ? e.message : String(e) };
  }
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let entry: TrajectoryEntry;
    try {
      entry = JSON.parse(line) as TrajectoryEntry;
    } catch {
      lines.push(stripControl(`# (unparseable line) ${line.slice(0, 60)}`));
      continue;
    }
    const action =
      "kind" in entry.action ? entry.action.kind : JSON.stringify(entry.action).slice(0, 40);
    const result = entry.resultText.split("\n")[0]?.slice(0, 120) ?? "";
    lines.push(
      stripControl(`#${entry.step} ${action} ${entry.url} domHash=${entry.domHash} | ${result}`),
    );
  }
  return { ok: true, lines };
}
