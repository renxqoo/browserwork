/**
 * 轨迹/下载目录清理（B13 §3.5）：年龄策略（mtime > retentionDays 删除）+
 * 容量策略（总量 > maxTotalBytes 按最旧删到达标）。单层 O(n) 不递归。
 * extensions 过滤：目录指错时保护无辜文件（如 ~/.bw 下的 serve.token——审查 P2-6）。
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface JanitorOptions {
  retentionDays?: number;
  maxTotalBytes?: number;
  /** 只清这些后缀的文件（如 [".jsonl"]） */
  extensions?: string[];
  /** 测试注时钟/文件系统锚点 */
  now?: () => number;
}

export interface JanitorResult {
  deleted: number;
  bytesFreed: number;
}

export interface JanitorTarget {
  dir: string;
  /** 该目录的后缀过滤（缺省 = 全部常规文件） */
  extensions?: string[];
  /** 展开一层子目录逐个清扫（downloads 根 = 会话/任务子目录结构——B14 审查 P1-6） */
  subdirs?: boolean;
}

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

interface FileEntry {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

function listFiles(dir: string, extensions?: string[]): FileEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // 目录不存在 = 无事可做
  }
  const out: FileEntry[] = [];
  for (const name of names) {
    if (extensions !== undefined && !extensions.some((ext) => name.endsWith(ext))) {
      continue;
    }
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) {
        out.push({ name, path, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch {
      /* 竞态删除——跳过 */
    }
  }
  return out;
}

/** 单目录清扫（导出供测试）：先年龄后容量 */
export function sweepDir(dir: string, opts?: JanitorOptions): JanitorResult {
  const retentionDays = opts?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  const now = (opts?.now ?? Date.now)();
  let deleted = 0;
  let bytesFreed = 0;
  const ageMs = retentionDays * 24 * 3600 * 1000;

  let files = listFiles(dir, opts?.extensions);
  // 年龄策略
  const expired = files.filter((f) => now - f.mtimeMs > ageMs);
  for (const f of expired) {
    try {
      unlinkSync(f.path);
      deleted += 1;
      bytesFreed += f.size;
    } catch {
      /* 跳过 */
    }
  }
  // 容量策略（剩余文件按最旧删到达标）
  files = listFiles(dir, opts?.extensions).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((acc, f) => acc + f.size, 0);
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(f.path);
      deleted += 1;
      bytesFreed += f.size;
      total -= f.size;
    } catch {
      /* 跳过 */
    }
  }
  return { deleted, bytesFreed };
}

/** 周期清扫（启动即扫 + interval；unref 不阻退出）。返回停止函数。 */
export function startJanitor(
  targets: JanitorTarget[],
  opts?: Omit<JanitorOptions, "extensions"> & { intervalMs?: number },
): () => void {
  const intervalMs = opts?.intervalMs ?? 3600 * 1000;
  const sweepAll = (): void => {
    for (const t of targets) {
      const o = {
        ...opts,
        ...(t.extensions !== undefined ? { extensions: t.extensions } : {}),
      };
      sweepDir(t.dir, o);
      if (t.subdirs === true) {
        let names: string[] = [];
        try {
          names = readdirSync(t.dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch {
          continue;
        }
        for (const name of names) sweepDir(join(t.dir, name), o);
      }
    }
  };
  sweepAll();
  const timer = setInterval(sweepAll, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
