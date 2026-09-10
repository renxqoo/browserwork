/** 轨迹文件实现（U6 写 / U7 读；接口在 @bw/core） */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TrajectoryEntry, TrajectorySink } from "@bw/core";

export function fileTrajectorySink(dir: string, taskId: string): TrajectorySink {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId}.jsonl`);
  return {
    path,
    async append(entry: TrajectoryEntry): Promise<void> {
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}

/** 内存实现（测试） */
export function memoryTrajectorySink(): TrajectorySink & { entries: TrajectoryEntry[] } {
  const entries: TrajectoryEntry[] = [];
  return {
    path: "memory://trajectory",
    async append(entry) {
      entries.push(entry);
    },
    entries,
  };
}
