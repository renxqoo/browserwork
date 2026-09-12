/**
 * B22 S2（MIGRATION-core §4b）：确认门文件化——pending/<cid>.json 生命周期。
 * 非阻塞：动作+完整上下文写入文件，同步返回 cid；120s 惰性过期（触接时清扫）。
 * 单一账本：violatedHosts 防护在写入时查、批准落 allowedHosts 由 executor 完成。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BWError, readJsonIfPossible, writeFileAtomic } from "@bw/core";

export const CONFIRMATION_TIMEOUT_MS = 120_000;

/** pending 记录（MIGRATION-core §4b schema——单一真相） */
export interface PendingConfirmation {
  cid: string;
  reason: string;
  createdAt: number;
  originHost?: string;
  /** 单动作（普通工具/create 起始导航） */
  action?: { kind: string; [k: string]: unknown };
  /** create 起始导航确认（批准后置 active；拒绝/过期销毁会话） */
  create?: boolean;
  /** batch 中段续行上下文：全量 steps + 已执行进度 */
  batchCtx?: { steps: Array<{ kind: string }>; executed: number; results: string[] };
  /** upload TOCTOU：gate 前 realpath 列表（confirm 时重比对） */
  uploadBefore?: string[];
  /** 批准后放行的 host（S1① origin 确认） */
  approveHost?: string;
}

const pendingDir = (sessionDir: string): string => join(sessionDir, "pending");

export function writePending(sessionDir: string, rec: PendingConfirmation): void {
  mkdirSync(pendingDir(sessionDir), { recursive: true });
  writeFileAtomic(join(pendingDir(sessionDir), `${rec.cid}.json`), JSON.stringify(rec), 0o600);
}

export function readPending(sessionDir: string, cid: string): PendingConfirmation | undefined {
  return readJsonIfPossible<PendingConfirmation>(join(pendingDir(sessionDir), `${cid}.json`));
}

export function removePending(sessionDir: string, cid: string): void {
  const p = join(pendingDir(sessionDir), `${cid}.json`);
  if (existsSync(p)) rmSync(p);
}

export function listPending(sessionDir: string): PendingConfirmation[] {
  const dir = pendingDir(sessionDir);
  if (!existsSync(dir)) return [];
  const out: PendingConfirmation[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = readJsonIfPossible<PendingConfirmation>(join(dir, f));
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

/** 惰性过期：清掉超时 pending，返回被过期拒绝的记录（调用方记 violatedHosts 不动） */
export function expirePending(
  sessionDir: string,
  now = Date.now(),
  timeoutMs = CONFIRMATION_TIMEOUT_MS,
): PendingConfirmation[] {
  const expired: PendingConfirmation[] = [];
  for (const rec of listPending(sessionDir)) {
    if (now - rec.createdAt > timeoutMs) {
      expired.push(rec);
      removePending(sessionDir, rec.cid);
    }
  }
  return expired;
}

/** 确认请求（executor 入口用）——过期即拒 */
export function confirmPending(
  sessionDir: string,
  cid: string,
  approve: boolean,
): { rec: PendingConfirmation } | { error: BWError } {
  const rec = readPending(sessionDir, cid);
  if (rec === undefined) {
    return { error: new BWError("CONFIRMATION_DENIED", `unknown confirmation: ${cid}`) };
  }
  if (Date.now() - rec.createdAt > CONFIRMATION_TIMEOUT_MS) {
    removePending(sessionDir, cid);
    return { error: new BWError("CONFIRMATION_DENIED", `confirmation ${cid} expired (120s)`) };
  }
  if (!approve) {
    removePending(sessionDir, cid);
    return { rec };
  }
  removePending(sessionDir, cid);
  return { rec };
}
