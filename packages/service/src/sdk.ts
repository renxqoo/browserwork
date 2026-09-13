/**
 * B22 S5（U2）：`bw` SDK 对象——根包 browserwork 直接导出的二次开发面。
 * sessions = 文件会话全动词；run = 内置 agent（TaskHandle 单消费者流）；
 * profiles = 登录态快照。S4 内网门（BW_ALLOW_PRIVATE_NETWORK）在 create 参数消费。
 */

import { runTask } from "@bw/agent";
import { resolveBwHome } from "@bw/core";
import type { StorageStateProfile } from "./profiles.ts";
import { deleteProfile, listProfiles, loadProfileFile } from "./profiles.ts";
import type { CreateSessionOptions, SessionStore, ToolResult } from "./store.ts";
import { createSessionStore } from "./store.ts";

export interface BwRunOptions {
  goal: string;
  startUrl?: string;
  maxSteps?: number;
  /** U5：注入的登录态快照名 */
  profile?: string;
  /** 显式 models（缺省从 env 装配 GLM——与 bw run 同源） */
  models?: never;
}

export interface BwSdk {
  sessions: {
    create(opts?: CreateSessionOptions): ReturnType<SessionStore["create"]>;
    executeTool(id: string, tool: string, params: Record<string, unknown>): Promise<ToolResult>;
    confirm(id: string, cid: string, approve: boolean): Promise<ToolResult>;
    snapshot(id: string): Promise<string>;
    list(): ReturnType<SessionStore["list"]>;
    close(id: string): boolean;
    keep(id: string, on?: boolean): boolean;
    rename(id: string, name: string): boolean;
    gc(): ReturnType<SessionStore["gc"]>;
    captureProfile(id: string, name: string): Promise<{ path: string; cookies: number }>;
    store(): SessionStore;
  };
  profiles: {
    list(): ReturnType<typeof listProfiles>;
    load(name: string): StorageStateProfile;
    delete(name: string): boolean;
  };
  run(req: BwRunOptions): ReturnType<typeof runTask>;
}

export function createBwSdk(opts?: { bwHome?: string }): BwSdk {
  const store = createSessionStore({
    ...(opts?.bwHome !== undefined ? { bwHome: opts.bwHome } : { bwHome: resolveBwHome() }),
  });
  return {
    sessions: {
      create: (o) => store.create(o),
      executeTool: (id, tool, params) => store.executeTool(id, tool, params),
      confirm: (id, cid, approve) => store.confirm(id, cid, approve),
      snapshot: (id) => store.snapshot(id),
      list: () => store.list(),
      close: (id) => store.close(id),
      keep: (id, on) => store.keep(id, on),
      rename: (id, name) => store.rename(id, name),
      gc: () => store.gc(),
      captureProfile: (id, name) => store.captureProfile(id, name),
      store: () => store,
    },
    profiles: {
      list: listProfiles,
      load: loadProfileFile,
      delete: deleteProfile,
    },
    run: (req) =>
      runTask(
        {
          goal: req.goal,
          ...(req.startUrl !== undefined ? { startUrl: req.startUrl } : {}),
          ...(req.maxSteps !== undefined ? { budget: { maxSteps: req.maxSteps } } : {}),
        },
        req.models ?? undefined,
      ) as ReturnType<typeof runTask>,
  };
}

/** 缺省单例（进程内便捷面） */
export const bw: BwSdk = createBwSdk();
