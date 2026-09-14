/**
 * B22 S2：SessionStore——文件会话（~/.bw/session/<id>/）。
 * 无常驻注册表：目录即事实源；每命令进程 = flock → connectHelper（死则恢复）→
 * policy 重建（session.json policy 段 + secrets 无状态重解析）→ S1③ 事件消费 →
 * 现提取快照 → 单源 buildAction → 闸 → engine.act → redact（全工具面）→ 落盘。
 * 行为规格基线：audit-sessions-driver §5（SessionManager 十方法）；确认门按
 * MIGRATION-core §4b/§4c（非阻塞 cid + create 状态机 + batch 续行）。
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ActionEngine } from "@bw/actions";
import { createActionEngine } from "@bw/actions";
import type { BrowserAction } from "@bw/core";
import {
  acquireFlock,
  BWError,
  buildAction,
  killChromeByDataDir,
  killHelperGroup,
  readJsonIfPossible,
  resolveBwHome,
  sessionsRoot,
  writeFileAtomic as wfs,
  writeFileAtomic,
} from "@bw/core";
import type { Driver, RemoteDriver } from "@bw/driver";
import { connectHelper, spawnHelper } from "@bw/driver";
import type { Snapshot } from "@bw/perception";
import { renderSnapshot } from "@bw/perception";
import type { PolicyEngine } from "@bw/policies";
import { createPolicyEngine } from "@bw/policies";
import { confirmPending, expirePending, writePending } from "./confirmations.ts";
import {
  loadProfileFile,
  readStorageState,
  saveProfileFile,
  writeStorageState,
} from "./profiles.ts";
import { resolveSecretValue, secretNames } from "./secrets.ts";

export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_TTL_MS_DEFAULT = 30 * 60_000;
const RECOVERY_WINDOW_MS = 5 * 60_000;
const SESSION_JSON_MAX_BYTES = 100 * 1024;

export interface SessionRecord {
  schemaVersion: number;
  id: string;
  name?: string;
  backend: "webkit" | "chrome";
  createdAt: number;
  lastActiveAt: number;
  keep: boolean;
  status: "pending-create" | "active";
  currentUrl: string;
  lastAllowedUrl: string;
  lastRendered: string | null;
  navEventSeq: number;
  policy: {
    mode: "production" | "test";
    allowEval: boolean;
    allowPrivateNetwork: boolean;
    allowUploadDirs?: string[];
    allowedHosts: string[];
    violatedHosts: string[];
  };
  budget: { steps: number };
  recoveries: number[];
  helper: { pid: number; socketPath: string; backend: "webkit" | "chrome" };
  driver: {
    width?: number;
    height?: number;
    ua?: string;
    chromePath?: string;
    dataStore: string;
    /** CDP 调试口（chrome-only；0=随机。bw s cdp 读 DevToolsActivePort） */
    debugPort?: number;
    /** chrome 启动旗标透传（proxy/窗口类） */
    chromeArgs?: string[];
    /** attach 模式：连外部 CDP 端点（Electron/调试口 Chrome）——close 只断连不杀对方 */
    cdpUrl?: string;
    /** launch 模式：spawn Electron app + attach（app 随会话 close 收走） */
    electronPath?: string;
    electronArgs?: string[];
  };
  downloadsBytes: number;
  activePageId: number;
}

export interface CreateSessionOptions {
  url?: string;
  name?: string;
  backend?: "webkit" | "chrome";
  allowEval?: boolean;
  allowPrivateNetwork?: boolean;
  width?: number;
  height?: number;
  ua?: string;
  chromePath?: string;
  dataDir?: string;
  /** CDP 调试口（chrome-only；缺省不开——pipe-only 是默认安全态。0=随机端口） */
  debugPort?: number;
  /** 有头模式（chrome 真窗口）。实现 = launch 模式映射（spawn 真 Chrome 二进制 +
   * attach）——Bun 强制 --headless 且 last-wins 无法反转（2026-09-14 实测定论），
   * --headless=false 通道已撤除。会话 close 连带收走窗口（与 spawn 语义一致） */
  headed?: boolean;
  /** chrome 启动旗标透传（proxy/窗口类；可多个） */
  chromeArgs?: string[];
  /** attach 模式：连外部 CDP 端点（http://127.0.0.1:port 或 ws://…）。会话 close
   * 只断连——外部浏览器/Electron app 生命周期不受影响 */
  cdpUrl?: string;
  /** launch 模式：spawn Electron app（或任意 Chromium 系可执行文件）+ attach；
   * app 是 helper 子进程，随会话 close 收走 */
  electronPath?: string;
  electronArgs?: string[];
  /** B14 上传路径闸：允许直接上传的目录（realpath 前缀匹配；缺省仅 os.tmpdir()） */
  allowUploadDirs?: string[];
  /** U5：注入的登录态快照名（~/.bw/profiles/<name>.json） */
  profile?: string;
  policyMode?: "production" | "test";
}

export interface ToolResult {
  ok: boolean;
  text?: string;
  snapshot?: string;
  unchanged?: boolean;
  code?: string;
  error?: string;
  cid?: string;
  reason?: string;
  image?: { base64: string; mimeType: string };
  intent?: { kind: string; href?: string };
  /** 读取类动作（look/extract/extract_code）附页面状态「url · title」——弹跳/跳转可见 */
  page?: string;
}

export interface SpawnedHelper {
  pid: number;
  socketPath: string;
  killGroup(): void;
}

export interface SessionStoreOptions {
  bwHome?: string;
  maxSessions?: number;
  ttlMs?: number;
  /** 测试缝：注入假 helper 连接工厂（MIGRATION-core §4） */
  helperFactory?: (
    record: SessionRecord,
  ) => Promise<{ driver: RemoteDriver | Driver; release: () => void; kill: () => void }>;
  /** 测试缝：create 的 helper 拉起（缺省真 spawnHelper；测试配 FakeDriver 用） */
  helperSpawner?: (rec: SessionRecord, dir: string) => Promise<SpawnedHelper>;
  policyMode?: "production" | "test";
}

export class SessionBusyError extends BWError {
  constructor(id: string) {
    super("SESSION_BUSY", `session ${id} is busy (another command holds the lock)`);
  }
}

const sessionDirOf = (root: string, id: string): string => join(root, id);
const recordPath = (dir: string): string => join(dir, "session.json");

function readRecord(root: string, id: string): SessionRecord {
  const rec = readJsonIfPossible<SessionRecord>(recordPath(sessionDirOf(root, id)));
  if (rec === undefined) {
    throw new BWError("NOT_FOUND", `session not found: ${id}`);
  }
  if (rec.schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new BWError(
      "DRIVER_ERROR",
      `session ${id} schema v${rec.schemaVersion} unsupported (expect v${SESSION_SCHEMA_VERSION})`,
    );
  }
  return rec;
}

function writeRecord(root: string, rec: SessionRecord): void {
  rec.lastActiveAt = Date.now();
  const json = JSON.stringify(rec);
  if (json.length > SESSION_JSON_MAX_BYTES) {
    // 预算护栏（DESIGN §3）：超限即缺陷——lastRendered 截断而非静默膨胀
    rec.lastRendered = rec.lastRendered?.slice(0, 60_000) ?? null;
    const retried = JSON.stringify(rec);
    if (retried.length > SESSION_JSON_MAX_BYTES) {
      rec.lastRendered = null;
    }
  }
  wfs(recordPath(sessionDirOf(root, rec.id)), JSON.stringify(rec), 0o644);
}

/** 活动页收养：syncPages 后按 activePageId 找代理页（tab 关了则回落第一个） */
async function adoptActive(
  engine: ActionEngine,
  driver: RemoteDriver | Driver,
  rec: SessionRecord,
): Promise<void> {
  const pages =
    driver instanceof Object && "syncPages" in driver
      ? await (driver as RemoteDriver).syncPages()
      : driver.pages();
  if (pages.length === 0) {
    throw new BWError("BROWSER_DEAD", "helper has no pages");
  }
  const target =
    pages.find((p) => (p as unknown as { pageId?: number }).pageId === rec.activePageId) ??
    pages[0];
  if (target !== undefined) engine.adopt(target);
}

/** 每命令重建 policy（session.json policy 段 + secrets 无状态重解析） */
/** U4 关键：redact 集建库预热——全部声明 secret 预解析入集（type 命令只是消费者）；
 * 否则「命令 A 注入 → 命令 B 读 console」在无状态模型下裸奔（B1 实测） */
async function rebuildPolicy(rec: SessionRecord): Promise<PolicyEngine> {
  const policy = createPolicyEngine(
    {
      allowedHosts: rec.policy.allowedHosts,
      allowSecretsHosts: rec.policy.allowedHosts,
      allowPrivateNetwork: rec.policy.allowPrivateNetwork || rec.policy.mode === "test",
      ...(rec.policy.mode === "test"
        ? { sensitiveWords: ["checkout", "删除", "delete", "支付", "pay"] satisfies string[] }
        : {}),
      ...(rec.policy.allowUploadDirs !== undefined
        ? { allowUploadDirs: rec.policy.allowUploadDirs }
        : {}),
      budget: {
        maxSteps: Number.MAX_SAFE_INTEGER,
        maxTokensInput: Number.MAX_SAFE_INTEGER,
        maxTokensOutput: Number.MAX_SAFE_INTEGER,
        wallClockMs: Number.MAX_SAFE_INTEGER,
      }, // 会话预算在 store 层单维记账（steps）；策略层闸面不设限
    },
    {
      dns: {
        async resolve(hostname) {
          const { lookup } = await import("node:dns/promises");
          return (await lookup(hostname, { all: true })).map((a) => a.address);
        },
      },
      secrets: {
        async resolve(name: string) {
          return resolveSecretValue(name);
        },
      },
      newCid: () => `sc-${Math.random().toString(36).slice(2, 10)}`,
    },
  );
  const warmOrigin = (() => {
    try {
      return new URL(rec.lastAllowedUrl).origin;
    } catch {
      return "about:blank";
    }
  })();
  for (const name of secretNames()) {
    try {
      await policy.resolveSecret(name, warmOrigin);
    } catch {
      /* 域绑定不符/解析失败——本命令未必用，跳过 */
    }
  }
  return policy;
}

export interface SessionInfo {
  id: string;
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  keep: boolean;
  url: string;
  title: string;
  steps: number;
  alive: boolean;
  pending: number;
}

export function createSessionStore(opts?: SessionStoreOptions) {
  const root = opts?.bwHome !== undefined ? join(opts.bwHome, "session") : sessionsRoot();
  const maxSessions = opts?.maxSessions ?? Number(process.env.BW_MAX_SESSIONS ?? 16);
  const ttlMs = opts?.ttlMs ?? SESSION_TTL_MS_DEFAULT;
  const defaultMode = opts?.policyMode ?? "production";
  mkdirSync(root, { recursive: true });

  /** 默认 helper 工厂：连既有 → 死则重拉（恢复） */
  const defaultHelperFactory = async (
    rec: SessionRecord,
  ): Promise<{ driver: RemoteDriver | Driver; release: () => void; kill: () => void }> => {
    try {
      const driver = await connectHelper(rec.helper.socketPath);
      return {
        driver,
        release: () => driver.release(),
        kill: () => {
          driver.close();
          killHelperGroup(rec.helper.pid);
        },
      };
    } catch {
      // 端点死 → 重拉 helper（dataStore 沿用——cookies 保登录态，U11）
      const h = await spawnHelper({
        sessionDir: sessionDirOf(root, rec.id),
        backend: rec.backend,
        dataStore: rec.driver.dataStore,
        ...(rec.driver.ua !== undefined ? { userAgent: rec.driver.ua } : {}),
        ...(rec.driver.chromePath !== undefined ? { chromePath: rec.driver.chromePath } : {}),
        ...(rec.driver.width !== undefined ? { width: rec.driver.width } : {}),
        ...(rec.driver.height !== undefined ? { height: rec.driver.height } : {}),
        ...(rec.driver.debugPort !== undefined ? { debugPort: rec.driver.debugPort } : {}),
        ...(rec.driver.chromeArgs !== undefined ? { chromeArgs: rec.driver.chromeArgs } : {}),
        ...(rec.driver.cdpUrl !== undefined ? { cdpUrl: rec.driver.cdpUrl } : {}),
        ...(rec.driver.electronPath !== undefined
          ? {
              electronPath: rec.driver.electronPath,
              ...(rec.driver.electronArgs !== undefined
                ? { electronArgs: rec.driver.electronArgs }
                : {}),
            }
          : {}),
      });
      rec.helper = { pid: h.pid, socketPath: h.socketPath, backend: rec.backend };
      rec.navEventSeq = 0; // 新 helper 的事件环从 0 起编
      const driver = await connectHelper(h.socketPath);
      // 恢复语义（旧 recoverSession）：新 helper 无页 → 重建页面并导航回 lastAllowedUrl
      // （dataStore 沿用——cookies 保登录态；DOM 态本就不跨进程存活）
      let pages = await driver.syncPages();
      if (pages.length === 0) {
        const page = await driver.createPage({ url: rec.lastAllowedUrl });
        rec.activePageId = (page as unknown as { pageId: number }).pageId;
        pages = await driver.syncPages();
      }
      void pages;
      return {
        driver,
        release: () => driver.release(),
        kill: () => h.killGroup(),
      };
    }
  };
  const helperFactory = opts?.helperFactory ?? defaultHelperFactory;

  /** 恢复记账：会话级滑动窗 5min ≤1（DESIGN §2.1） */
  const withinRecoveryWindow = (rec: SessionRecord): boolean => {
    const cutoff = Date.now() - RECOVERY_WINDOW_MS;
    const recent = rec.recoveries.filter((t) => t > cutoff);
    return recent.length === 0;
  };

  const recordRecovery = (rec: SessionRecord): void => {
    const cutoff = Date.now() - RECOVERY_WINDOW_MS;
    rec.recoveries = [...rec.recoveries.filter((t) => t > cutoff), Date.now()].slice(-3);
  };

  const appendTrajectory = (dir: string, line: unknown): void => {
    const path = join(dir, "trajectory.jsonl");
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  };

  return {
    root,

    async create(
      createOpts: CreateSessionOptions = {},
    ): Promise<
      { id: string; record: SessionRecord } & (
        | { confirmed: true; result?: string }
        | { confirmed: false; cid: string; reason: string }
      )
    > {
      // G11：全局 create 锁内计数+建目录（check-then-at 竞态防护）
      mkdirSync(root, { recursive: true });
      const globalLock = acquireFlock(join(root, ".create.lock"));
      if (globalLock === null) {
        throw new SessionBusyError("(create)");
      }
      try {
        const dirs = readdirSync(root).filter((d) => d.startsWith("sess-"));
        if (dirs.length >= maxSessions) {
          throw new BWError(
            "SESSION_LIMIT",
            `session limit reached (${maxSessions}) — close or gc first`,
          );
        }
        const id = `sess-${crypto.randomUUID().slice(0, 13)}`;
        const dir = sessionDirOf(root, id);
        mkdirSync(dir);
        const dataStore = createOpts.dataDir ?? join(dir, "datastore");
        mkdirSync(dataStore, { recursive: true });
        mkdirSync(join(dir, "downloads"), { recursive: true });
        // launch 模式的起始 URL（headed 映射或显式 --electron）：必须作为 Chrome
        // 位置参数传入——store 的 url 走 helper RPC createPage({url}) 导航收养页，
        // 但收养时目标 target 可能尚未出现（等窗 20s）——Chrome 直开最可靠
        const electronLaunchUrl = createOpts.url;
        // headed → launch 模式映射（在 electronOpts 里组装——下方 rec 构建消费）
        const electronOpts =
          createOpts.headed === true &&
          createOpts.cdpUrl === undefined &&
          createOpts.electronPath === undefined
            ? (() => {
                const bin = createOpts.chromePath ?? detectChromeBinary();
                if (bin === null) {
                  throw new BWError(
                    "DRIVER_ERROR",
                    "--headed requires a Chrome binary (set --chrome-path or install Chrome)",
                  );
                }
                return {
                  electronPath: bin,
                  electronArgs: [
                    `--user-data-dir=${dataStore}`,
                    // URL 作位置参数直开目标页（否则 Chrome 裸启开 NTP——zhipin 实测）
                    ...(createOpts.url !== undefined ? [createOpts.url] : []),
                  ],
                };
              })()
            : {};
        const rec: SessionRecord = {
          schemaVersion: SESSION_SCHEMA_VERSION,
          id,
          ...(createOpts.name !== undefined ? { name: createOpts.name.slice(0, 80) } : {}),
          // attach/launch 模式驱动能力面 = chrome（归一记录，list/status 不误导）
          backend:
            createOpts.cdpUrl !== undefined ||
            createOpts.electronPath !== undefined ||
            createOpts.headed === true
              ? "chrome"
              : (createOpts.backend ?? "webkit"),
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          keep: false,
          status: "pending-create",
          currentUrl: "about:blank",
          lastAllowedUrl: "about:blank",
          lastRendered: null,
          navEventSeq: 0,
          policy: {
            mode: createOpts.policyMode ?? defaultMode,
            allowEval: createOpts.allowEval === true,
            allowPrivateNetwork: createOpts.allowPrivateNetwork === true,
            ...(createOpts.allowUploadDirs !== undefined
              ? { allowUploadDirs: createOpts.allowUploadDirs }
              : {}),
            allowedHosts: [],
            violatedHosts: [],
          },
          budget: { steps: 0 },
          recoveries: [],
          helper: { pid: 0, socketPath: "", backend: createOpts.backend ?? "webkit" },
          driver: {
            dataStore,
            ...(createOpts.width !== undefined ? { width: createOpts.width } : {}),
            ...(createOpts.height !== undefined ? { height: createOpts.height } : {}),
            ...(createOpts.ua !== undefined ? { ua: createOpts.ua } : {}),
            ...(createOpts.chromePath !== undefined ? { chromePath: createOpts.chromePath } : {}),
            ...(createOpts.debugPort !== undefined ? { debugPort: createOpts.debugPort } : {}),
            ...(createOpts.chromeArgs !== undefined ? { chromeArgs: createOpts.chromeArgs } : {}),
            ...(createOpts.cdpUrl !== undefined ? { cdpUrl: createOpts.cdpUrl } : {}),
            ...(createOpts.electronPath !== undefined
              ? {
                  electronPath: createOpts.electronPath,
                  // URL 追加为位置参数（Chrome 直开目标页——不传则裸启 NTP）
                  electronArgs: [
                    ...(createOpts.electronArgs ?? []),
                    ...(electronLaunchUrl !== undefined ? [electronLaunchUrl] : []),
                  ],
                }
              : electronOpts),
          },
          downloadsBytes: 0,
          activePageId: 0,
        };
        if (rec.policy.mode === "production" && !rec.policy.allowPrivateNetwork) {
          // S4 生产档：本地/内网地址默认封锁（create 参数放行）
          const u = createOpts.url;
          if (u !== undefined) {
            const host = safeHost(u);
            if (host !== null && isPrivateHost(host)) {
              throw new BWError(
                "POLICY_BLOCKED",
                `private/local address blocked by S4: ${host} (allowPrivateNetwork to override)`,
              );
            }
          }
        }
        // 拉 helper + 写记录 + 首页导航（spawner 缝：测试注入 FakeDriver 形态）
        const spawner =
          opts?.helperSpawner ??
          (async (r: SessionRecord, d: string): Promise<SpawnedHelper> => {
            const h = await spawnHelper({
              sessionDir: d,
              backend: r.backend,
              dataStore: r.driver.dataStore,
              ...(r.driver.width !== undefined ? { width: r.driver.width } : {}),
              ...(r.driver.height !== undefined ? { height: r.driver.height } : {}),
              ...(r.driver.ua !== undefined ? { userAgent: r.driver.ua } : {}),
              ...(r.driver.chromePath !== undefined ? { chromePath: r.driver.chromePath } : {}),
              ...(r.driver.debugPort !== undefined ? { debugPort: r.driver.debugPort } : {}),
              ...(r.driver.chromeArgs !== undefined ? { chromeArgs: r.driver.chromeArgs } : {}),
              ...(r.driver.cdpUrl !== undefined ? { cdpUrl: r.driver.cdpUrl } : {}),
              ...(r.driver.electronPath !== undefined
                ? {
                    electronPath: r.driver.electronPath,
                    ...(r.driver.electronArgs !== undefined
                      ? { electronArgs: r.driver.electronArgs }
                      : {}),
                  }
                : {}),
            });
            return { pid: h.pid, socketPath: h.socketPath, killGroup: () => h.killGroup() };
          });
        const h = await spawner(rec, dir);
        rec.helper = { pid: h.pid, socketPath: h.socketPath, backend: rec.backend };
        writeRecord(root, rec);
        const url = createOpts.url;
        const dir2 = sessionDirOf(root, id);
        if (url === undefined) {
          // 无起始 URL：开 about:blank 活动页（旧语义 b13 P2-12——会话立即可交互）。
          // attach/launch 会话（--cdp-url/--electron）的页面由外部 app 自己打开——
          // 收养的是真实页面。必须把收养页的 host 入 S1 白名单 + 推进回滚点，否则
          // 全部导航被 S1③ 判违规回滚 + violatedHosts 污染 → 确认门死锁（实测踩坑）
          const { driver, release } = await helperFactory(rec);
          try {
            const engine = createActionEngine(driver as Driver, {
              downloadsDir: () => join(dir2, "downloads"),
            });
            const page = await driver.createPage({ url: "about:blank" });
            rec.activePageId = (page as unknown as { pageId?: number }).pageId ?? 0;
            engine.adopt(page);
            const adoptedUrl = engine.activePage().url;
            const adoptedHost = safeHost(adoptedUrl);
            if (adoptedUrl !== "about:blank" && adoptedHost !== null && adoptedHost !== "") {
              if (!rec.policy.allowedHosts.includes(adoptedHost)) {
                rec.policy.allowedHosts.push(adoptedHost);
              }
              rec.currentUrl = adoptedUrl;
              rec.lastAllowedUrl = adoptedUrl;
            } else {
              rec.currentUrl = "about:blank";
              rec.lastAllowedUrl = "about:blank";
            }
            rec.status = "active";
            writeRecord(root, rec);
            return { id, record: rec, confirmed: true };
          } catch (e) {
            destroySessionDir(dir2, rec);
            throw e;
          } finally {
            release();
          }
        }
        // S1① 前检（起始域默认入白名单——与旧 create 同语义）
        const startHost = safeHost(url) ?? "";
        if (startHost !== "") rec.policy.allowedHosts.push(startHost);
        const policy = await rebuildPolicy(rec);
        const decision = await policy.onNavigate(url);
        if (decision.kind === "confirm") {
          writePending(dir2, {
            cid: decision.cid,
            reason: decision.reason,
            createdAt: Date.now(),
            originHost: startHost,
            action: { kind: "navigate", url },
            create: true,
            approveHost: startHost,
          });
          writeRecord(root, rec);
          return { id, record: rec, confirmed: false, cid: decision.cid, reason: decision.reason };
        }
        if (decision.kind === "block") {
          // 拒绝 → 清场不占名额（§4c）
          killHelperGroup(h.pid);
          rmSync(dir2, { recursive: true, force: true });
          throw new BWError("POLICY_BLOCKED", decision.reason);
        }
        // 免确认 → 执行导航（失败清场不占名额——§4c，S2R P1-8）
        const { driver, release } = await helperFactory(rec);
        try {
          const engine = createActionEngine(driver as Driver, {
            downloadsDir: () => join(dir2, "downloads"),
          });
          const page = await (driver as RemoteDriver).createPage({ url });
          rec.activePageId = (page as unknown as { pageId: number }).pageId;
          engine.adopt(page);
          if (createOpts.profile !== undefined) {
            // U5：快照注入（chrome 含 httpOnly；webkit 可见面）→ 重新导航让页面带态加载
            await writeStorageState(
              page,
              (driver as Driver).capabilities(),
              loadProfileFile(createOpts.profile),
            );
            await engine.act({ kind: "navigate", url });
          }
          const snap = await engine.currentSnapshot();
          rec.status = "active";
          rec.currentUrl = url;
          rec.lastAllowedUrl = url;
          rec.lastRendered = renderSnapshot(snap);
          writeRecord(root, rec);
          return { id, record: rec, confirmed: true, result: url };
        } catch (e) {
          destroySessionDir(dir2, rec);
          throw e;
        } finally {
          release();
        }
      } finally {
        globalLock.release();
      }
    },

    list(): SessionInfo[] {
      const out: SessionInfo[] = [];
      if (!existsSync(root)) return out;
      for (const d of readdirSync(root)) {
        if (!d.startsWith("sess-")) continue;
        const rec = readJsonIfPossible<SessionRecord>(recordPath(sessionDirOf(root, d)));
        if (rec === undefined) continue;
        out.push({
          id: rec.id,
          ...(rec.name !== undefined ? { name: rec.name } : {}),
          createdAt: rec.createdAt,
          lastActiveAt: rec.lastActiveAt,
          keep: rec.keep,
          url: rec.currentUrl,
          title: "",
          steps: rec.budget.steps,
          alive: existsSync(rec.helper.socketPath),
          pending: 0,
        });
      }
      return out;
    },

    get(id: string): SessionRecord {
      return readRecord(root, id);
    },

    async snapshot(id: string): Promise<string> {
      readRecord(root, id); // NOT_FOUND 先于锁
      const rec = readRecord(root, id);
      const lock = acquireFlock(join(sessionDirOf(root, id), "lock"));
      if (lock === null) throw new SessionBusyError(id);
      try {
        const { driver, release } = await helperFactory(rec);
        try {
          const engine = createActionEngine(driver as Driver);
          await adoptActive(engine, driver, rec);
          const snap = await engine.currentSnapshot();
          rec.currentUrl = engine.activePage().url;
          writeRecord(root, rec);
          return renderSnapshot(snap);
        } finally {
          release();
        }
      } finally {
        lock.release();
      }
    },

    /** CDP 调试端点（--debug-port 会话）：DevToolsActivePort 发现 + page target 列表 */
    async cdpEndpoint(id: string): Promise<{
      httpUrl: string;
      browserWs: string;
      pages: Array<{ url: string; title: string; ws: string }>;
    }> {
      const rec = readRecord(root, id); // NOT_FOUND 先于一切
      if (rec.driver.cdpUrl !== undefined) {
        // attach 会话：端点就是所连的外部浏览器
        const base = rec.driver.cdpUrl.replace(/\/$/, "");
        const list =
          (await fetch(`${base}/json/list`)
            .then((r) => r.json() as Promise<Array<Record<string, string>>>)
            .catch(() => [])) ?? [];
        const ver =
          (await fetch(`${base}/json/version`)
            .then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>)
            .catch(() => ({}) as { webSocketDebuggerUrl?: string })) ?? {};
        return {
          httpUrl: base,
          browserWs: ver.webSocketDebuggerUrl ?? "",
          pages: list
            .filter((t) => t.type === "page")
            .map((t) => ({
              url: t.url ?? "",
              title: t.title ?? "",
              ws: t.webSocketDebuggerUrl ?? "",
            })),
        };
      }
      if (rec.driver.electronPath !== undefined) {
        throw new BWError(
          "INVALID_TOOL_ARGS",
          "electron sessions don't persist their debug endpoint — attach again with --cdp-url after recreate",
        );
      }
      if (rec.driver.debugPort === undefined) {
        throw new BWError(
          "INVALID_TOOL_ARGS",
          `session ${id} has no debug port — recreate with: bw s create --backend chrome --debug-port 0`,
        );
      }
      const f = join(rec.driver.dataStore, "DevToolsActivePort");
      if (!existsSync(f)) {
        throw new BWError(
          "DRIVER_ERROR",
          `DevToolsActivePort not found (${f}) — browser may be dead; retry`,
        );
      }
      const [port, wsPath] = readFileSync(f, "utf8").trim().split("\n");
      if (port === undefined || wsPath === undefined) {
        throw new BWError("DRIVER_ERROR", `DevToolsActivePort malformed (${f})`);
      }
      const list =
        (await fetch(`http://127.0.0.1:${port}/json/list`)
          .then((r) => r.json() as Promise<Array<Record<string, string>>>)
          .catch(() => [])) ?? [];
      return {
        httpUrl: `http://127.0.0.1:${port}`,
        browserWs: `ws://127.0.0.1:${port}${wsPath}`,
        pages: list
          .filter((t) => t.type === "page")
          .map((t) => ({
            url: t.url ?? "",
            title: t.title ?? "",
            ws: t.webSocketDebuggerUrl ?? "",
          })),
      };
    },

    close(id: string): boolean {
      const dir = sessionDirOf(root, id);
      const rec = readJsonIfPossible<SessionRecord>(recordPath(dir));
      if (rec === undefined) return false; // 幂等（rm -rf 语义）
      killHelperGroup(rec.helper.pid);
      killChromeByDataDir(rec.driver.dataStore); // 组杀兜底（实测泄漏修）
      rmSync(dir, { recursive: true, force: true });
      return true;
    },

    keep(id: string, on = true): boolean {
      readRecord(root, id); // NOT_FOUND 先于锁（未知 id 的 lock openSync 失败会误报 SESSION_BUSY）
      const lock = acquireFlock(join(sessionDirOf(root, id), "lock"));
      if (lock === null) throw new SessionBusyError(id);
      try {
        const rec = readRecord(root, id);
        rec.keep = on;
        if (on) rmSync(join(sessionDirOf(root, id), "downloads"), { recursive: true, force: true });
        writeRecord(root, rec);
        return true;
      } finally {
        lock.release();
      }
    },

    rename(id: string, name: string): boolean {
      readRecord(root, id); // NOT_FOUND 先于锁
      const lock = acquireFlock(join(sessionDirOf(root, id), "lock"));
      if (lock === null) throw new SessionBusyError(id);
      try {
        const rec = readRecord(root, id);
        rec.name = name.trim().slice(0, 80);
        writeRecord(root, rec);
        return true;
      } finally {
        lock.release();
      }
    },

    /** 惰性回收 + 显式清扫（gc 分类法：IMPLEMENTATION §3） */
    gc(): { reaped: string[]; orphans: number } {
      const reaped: string[] = [];
      let orphans = 0;
      // 孤儿浏览器进程清扫：Chrome 命令行 --user-data-dir 指向已删除的会话 datastore（前次泄漏残留）
      {
        const r = spawnSync("pgrep", ["-f", "--", `--user-data-dir=${root}/sess-`], {
          encoding: "utf8",
        });
        if (r.status === 0 && r.stdout.trim()) {
          const liveStores = new Set(
            existsSync(root)
              ? readdirSync(root)
                  .filter((d) => d.startsWith("sess-"))
                  .map((d) => join(root, d, "datastore"))
              : [],
          );
          for (const line of r.stdout.trim().split("\n")) {
            const pidNum = Number(line.trim());
            if (!Number.isInteger(pidNum) || pidNum <= 1 || pidNum === process.pid) continue;
            const ps = spawnSync("ps", ["-p", String(pidNum), "-o", "command="], {
              encoding: "utf8",
            });
            const cmd = (ps.stdout ?? "").trim();
            const mm = /--user-data-dir=([^\s]+)/.exec(cmd);
            if (mm === null) continue;
            const dataDirArg = mm[1] ?? "";
            if (!dataDirArg.startsWith(`${root}/sess-`)) continue;
            const store = dataDirArg.replace(/\/datastore$/, "");
            if (!liveStores.has(store)) {
              try {
                process.kill(pidNum, "SIGKILL");
                orphans++;
              } catch {
                /* 已死 */
              }
            }
          }
        }
      }
      // 孤儿 helper 清扫：socket 所在会话目录已不存在（旧泄漏 bug 残留的僵尸 helper；
      // create 先建目录再拉 helper——目录在=可能活着，目录没了=任何 store 都连不上它）
      {
        const r = spawnSync("pgrep", ["-f", "helper\\.(ts|js) --socket"], { encoding: "utf8" });
        if (r.status === 0 && r.stdout.trim()) {
          for (const line of r.stdout.trim().split("\n")) {
            const pidNum = Number(line.trim());
            if (!Number.isInteger(pidNum) || pidNum <= 1 || pidNum === process.pid) continue;
            const ps = spawnSync("ps", ["-p", String(pidNum), "-o", "command="], {
              encoding: "utf8",
            });
            const cmd = (ps.stdout ?? "").trim();
            if (!cmd.includes("helper.") || !cmd.includes("--socket")) continue;
            const socket = /--socket (\S+)/.exec(cmd)?.[1];
            if (socket === undefined) continue;
            if (!existsSync(dirname(socket))) {
              try {
                process.kill(pidNum, "SIGKILL");
                orphans++;
              } catch {
                /* 已死 */
              }
            }
          }
        }
      }
      if (!existsSync(root)) return { reaped, orphans };
      for (const d of readdirSync(root)) {
        if (!d.startsWith("sess-")) continue;
        const dir = sessionDirOf(root, d);
        const rec = readJsonIfPossible<SessionRecord>(recordPath(dir));
        if (rec === undefined) {
          rmSync(dir, { recursive: true, force: true }); // 坏目录（无 session.json）
          reaped.push(d);
          continue;
        }
        if (!rec.keep && Date.now() - rec.lastActiveAt > ttlMs) {
          killHelperGroup(rec.helper.pid);
          rmSync(dir, { recursive: true, force: true });
          reaped.push(d);
        }
      }
      return { reaped, orphans };
    },

    async executeTool(
      id: string,
      tool: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> {
      const dir = sessionDirOf(root, id);
      readRecord(root, id); // NOT_FOUND 校验
      const lock = acquireFlock(join(dir, "lock"));
      if (lock === null) throw new SessionBusyError(id);
      try {
        return await this.runLocked(id, tool, params);
      } catch (e) {
        // 行为等价（旧 §5）：参数/闸面错误是工具结果不是异常——SDK/CLI 面同构
        if (e instanceof BWError) {
          return { ok: false, code: e.code, error: e.message };
        }
        throw e;
      } finally {
        lock.release();
      }
    },

    /** 锁内执行体（executeTool 与 confirm 重放共用——调用方必须已持 flock） */
    async runLocked(
      id: string,
      tool: string,
      params: Record<string, unknown>,
      replay?: { approvedSig?: string; uploadBefore?: string[] },
    ): Promise<ToolResult> {
      {
        const dir = sessionDirOf(root, id);
        let rec = readRecord(root, id);
        for (const expired of expirePending(dir)) {
          if (expired.create === true) {
            // §4c 状态机：create 确认 120s 过期 → 清场（杀组 + rm，S2R P1-8）
            destroySessionDir(dir, rec);
            throw new BWError(
              "CONFIRMATION_DENIED",
              `create confirmation ${expired.cid} expired — session destroyed`,
            );
          }
        }
        rec = readRecord(root, id);
        // helper 连接（死则恢复——滑动窗限次）
        let recovered = false;
        let conn: Awaited<ReturnType<typeof helperFactory>>;
        try {
          conn = await helperFactory(rec);
        } catch {
          if (!withinRecoveryWindow(rec)) {
            throw new BWError(
              "BROWSER_DEAD",
              `session ${id} browser dead and recovery window exhausted (5min ≤1)`,
            );
          }
          recordRecovery(rec);
          writeRecord(root, rec); // S2R P1-7：先落盘再重读——否则时间戳被磁盘旧值覆盖
          rec = readRecord(root, id);
          try {
            conn = await helperFactory(rec);
          } catch (e2) {
            // 重拉也失败 → 销毁会话（旧语义：恢复失败不留僵尸循环）
            destroySessionDir(dir, rec);
            throw new BWError(
              "BROWSER_DEAD",
              `session ${id} unrecoverable: ${e2 instanceof Error ? e2.message : String(e2)}`,
            );
          }
          recovered = true;
        }
        const { driver, release } = conn;
        try {
          if (rec.status !== "active") {
            throw new BWError(
              "CONFIRMATION_DENIED",
              `session ${id} is pending create confirmation — confirm or deny first`,
            );
          }
          const policy = await rebuildPolicy(rec);
          /** 批准放行集（S2R P0-1）：confirm 重放的动作签名——同签名跳闸一次性放行 */
          const approvedSigs = new Set<string>();
          const sigOf = (a: BrowserAction): string => JSON.stringify(a);
          const engine = createActionEngine(driver as Driver, {
            resolveSecret: (name, origin) => policy.resolveSecret(name, origin),
            // S2R P0-2：S1② 意图前检接线（旧 sessions.ts:395-409 的 sink 语义——
            // 非阻塞模型下：confirm → 写 pending + 抛 CONFIRMATION_REQUIRED 中止本动作）
            intentSink: async (intent, action) => {
              if (approvedSigs.has(sigOf(action))) return;
              const d = await policy.onNavigationIntent(intent, action);
              if (d.kind === "confirm") {
                const host = safeHost(intent.href ?? "");
                writePending(dir, {
                  cid: d.cid,
                  reason: d.reason,
                  createdAt: Date.now(),
                  ...(host !== null ? { originHost: host, approveHost: host } : {}),
                  action: { ...action } as { kind: string },
                });
                throw new BWError("CONFIRMATION_REQUIRED", d.reason);
              }
              if (d.kind === "block") {
                throw new BWError("POLICY_BLOCKED", d.reason);
              }
            },
            // S2R P1-9：会话下载目录（DESIGN §1.2——隔离 + close/keep 清理有对象）
            downloadsDir: () => join(dir, "downloads"),
          });
          await adoptActive(engine, driver, rec);

          // S1③：消费 navEventSeq 之后的导航事件——违规回滚（下次触接模型）
          let rolledBack = false;
          const remote =
            driver instanceof Object && "conn" in driver ? (driver as RemoteDriver) : null;
          if (remote === null) {
            // FakeDriver seam 无事件环——无 S1③ 面
          } else {
            const ring = await remote.conn.call<{
              events: Array<{ seq: number; url: string; pageId: number }>;
              latest: number;
              oldest: number;
            }>("navEvents", { since: rec.navEventSeq });
            // S2R P2-11：环溢出缺口（since < oldest）——事件已丢，按当前 URL 保守补判
            const gap = rec.navEventSeq > 0 && rec.navEventSeq < ring.oldest;
            const toJudge = gap
              ? [
                  ...ring.events,
                  {
                    seq: ring.latest,
                    url: engine.activePage().url,
                    pageId: rec.activePageId,
                    __current: true,
                  },
                ]
              : ring.events;
            for (const ev of toJudge) {
              const verdict = await policy.onNavigationSettled(ev.url);
              if (!verdict.ok && verdict.violation !== undefined) {
                // 同站放宽（S1 四案终解）：Bun 的导航事件会把 iframe 加载泄漏进环
                // （lf-zt.douyin / same.eastmoney——真人浏览器同载不劫持顶层）。
                // 与回滚点同站（近似 eTLD+1：末两段一致）的「违规」一律静默忽略——
                // 不记违规、不回滚、不推进回滚点；跨站劫持照严判（S1 本意）
                if (sameRegistrableDomain(rec.lastAllowedUrl, ev.url)) {
                  continue;
                }
                const host = safeHost(ev.url) ?? "";
                if (host !== "" && !rec.policy.violatedHosts.includes(host)) {
                  rec.policy.violatedHosts.push(host);
                }
                try {
                  await engine.act({ kind: "navigate", url: rec.lastAllowedUrl });
                  rolledBack = true;
                } catch {
                  /* 回滚失败——记录违规即可 */
                }
              } else if (verdict.ok) {
                // 合法落定 → 回滚点推进（S2R P0-2：否则恢复永远回 create 起始页）。
                // 残余（低危，记录在案）：同站 iframe 泄漏条目也可能推进回滚点
                // （view.url 瞬时跟随 iframe → 主帧比对恒真，无法甄别）——回滚到
                // 同站 url 无安全影响；跨站从严不受影响。
                // about:blank 永不推进：建页初始落定会进环，若推进会把同站比对的
                // 参照变成空页 → 放宽全失效（douyin 复验实测）
                if (ev.url !== "about:blank") {
                  rec.lastAllowedUrl = ev.url;
                }
              }
            }
            if (ring.events.length > 0 || gap)
              rec.navEventSeq = Math.max(rec.navEventSeq, ring.latest);
          }

          // 现提取快照（索引类命令开始——S2 词面闸/索引查找/unchanged）
          const snap: Snapshot | null = await engine.currentSnapshot();

          /** run 选项：approvedSig=本动作已被人工批准（一次性放行，S2R P0-1）；
           * batchCtx=中段子步确认的续行上下文（写入 pending，§4b） */
          const run = async (
            action: BrowserAction,
            targetSnapshot: Snapshot | null,
            runOpts?: {
              approvedSig?: string;
              uploadBefore?: string[];
              batchCtx?: { steps: BrowserAction[]; executed: number; results: string[] };
            },
          ): Promise<ToolResult> => {
            const approved =
              runOpts?.approvedSig !== undefined && runOpts.approvedSig === sigOf(action);
            if (approved) approvedSigs.add(runOpts?.approvedSig ?? "");
            // 闸面（S1①/S2——与旧 executeTool 同序；批准放行动作跳闸）
            if (!approved && (action.kind === "navigate" || action.kind === "open_tab")) {
              const d = await policy.onNavigate(action.url);
              if (d.kind === "confirm") {
                const navHost = safeHost(action.url);
                writePending(dir, {
                  cid: d.cid,
                  reason: d.reason,
                  createdAt: Date.now(),
                  ...(navHost !== null ? { originHost: navHost, approveHost: navHost } : {}),
                  action: { ...action } as { kind: string },
                  ...(runOpts?.batchCtx !== undefined
                    ? { batchCtx: { ...runOpts.batchCtx, steps: runOpts.batchCtx.steps as never } }
                    : {}),
                });
                return {
                  ok: true,
                  cid: d.cid,
                  ...(d.reason !== "" ? { reason: d.reason } : {}),
                  text: `CONFIRMATION_REQUIRED: ${d.reason}`,
                };
              }
              if (d.kind === "block") {
                return { ok: false, code: "POLICY_BLOCKED", error: d.reason };
              }
            } else if (!approved) {
              // S2R P0-3：upload 路径闸（目录外 → 确认 + TOCTOU before-paths）
              if (action.kind === "upload") {
                const d = policy.checkUploadFiles(action.files);
                if (d.kind === "confirm") {
                  const before = action.files.map((f) => realpathSync(f));
                  writePending(dir, {
                    cid: d.cid,
                    reason: d.reason,
                    createdAt: Date.now(),
                    action: { ...action } as { kind: string },
                    uploadBefore: before,
                    ...(runOpts?.batchCtx !== undefined
                      ? {
                          batchCtx: { ...runOpts.batchCtx, steps: runOpts.batchCtx.steps as never },
                        }
                      : {}),
                  });
                  return {
                    ok: true,
                    cid: d.cid,
                    ...(d.reason !== "" ? { reason: d.reason } : {}),
                    text: `CONFIRMATION_REQUIRED: ${d.reason}`,
                  };
                }
                if (d.kind === "block") {
                  return { ok: false, code: "POLICY_BLOCKED", error: d.reason };
                }
              }
              const index = "index" in action ? (action as { index?: string }).index : undefined;
              // click_text：无索引——文本直接进 S2 词面闸（敏感词按钮按文本命中）
              const textTarget =
                action.kind === "click_text" ? { tag: "*", text: action.text } : undefined;
              const node =
                index !== undefined && targetSnapshot !== null
                  ? targetSnapshot.nodes.find((n) => n.id === index)
                  : undefined;
              const target =
                textTarget !== undefined
                  ? textTarget
                  : node !== undefined
                    ? {
                        tag: node.tag,
                        ...(node.text !== undefined ? { text: node.text } : {}),
                        ...(node.href !== undefined ? { href: node.href } : {}),
                      }
                    : undefined;
              const d = policy.onAction(action, target);
              if (d.kind === "confirm") {
                writePending(dir, {
                  cid: d.cid,
                  reason: d.reason,
                  createdAt: Date.now(),
                  action: { ...action } as { kind: string },
                  ...(runOpts?.batchCtx !== undefined
                    ? { batchCtx: { ...runOpts.batchCtx, steps: runOpts.batchCtx.steps as never } }
                    : {}),
                });
                return {
                  ok: true,
                  cid: d.cid,
                  ...(d.reason !== "" ? { reason: d.reason } : {}),
                  text: `CONFIRMATION_REQUIRED: ${d.reason}`,
                };
              }
              if (d.kind === "block") {
                return { ok: false, code: "POLICY_BLOCKED", error: d.reason };
              }
            } else if (
              approved &&
              action.kind === "upload" &&
              runOpts?.uploadBefore !== undefined
            ) {
              // 批准重放的 upload：TOCTOU 复核（§4b——realpath 前后比对）
              const now = action.files.map((f) => realpathSync(f));
              if (JSON.stringify(now) !== JSON.stringify(runOpts.uploadBefore)) {
                return {
                  ok: false,
                  code: "CONFIRMATION_DENIED",
                  error: "upload path changed during confirmation window",
                };
              }
            }
            // S2R P0-2：回滚点 = act 之前的页面 URL（不是落定后的违规目标）
            const preUrl = engine.activePage().url;
            const r = await engine.act(action, targetSnapshot);
            // redact 全工具面（B1 裁决：出域与盘面同一条路径——含 rendered，S2R P1-10）
            const text = policy.redact(r.text);
            const rendered = r.snapshot !== null ? policy.redact(renderSnapshot(r.snapshot)) : "";
            const unchanged =
              r.snapshot !== null && rec.lastRendered !== null && rendered === rec.lastRendered;
            // unchanged 时输出瘦身（agent 实测反馈：navigate/wait 连打把同一份 100+ 行
            // 快照原样回两遍）。判定仍用全文（rec.lastRendered 存全文），只有返回给
            // 调用方的 snapshot 截到状态头三行——方位感保留，体积砍 95%
            const outSnapshot =
              unchanged && rendered !== ""
                ? `${rendered.split("\n").slice(0, 3).join("\n")}\n[unchanged] same page — full snapshot omitted, reuse the previous one`
                : rendered;
            // 读取类动作附页面状态（agent 实测踩坑：页面被风控弹走后 extract_code 只剩
            // 空树，与「没数据」不可辨——白探几轮 DOM 才发现 URL 变了）
            const pageMark =
              action.kind === "look" ||
              action.kind === "extract_text" ||
              action.kind === "extract_code"
                ? { page: `${engine.activePage().url} · ${engine.activePage().title}` }
                : {};
            if (r.snapshot !== null) {
              rec.lastRendered = rendered;
              const activePage = engine.activePage() as unknown as { pageId?: number };
              if (activePage.pageId !== undefined) rec.activePageId = activePage.pageId; // S2R P1-6
              rec.currentUrl = engine.activePage().url || rec.currentUrl;
              rec.lastAllowedUrl = preUrl; // 回滚点=动作前位置（合法落定由 S1③ 消费者推进）
            }
            rec.budget.steps += 1;
            appendTrajectory(dir, {
              ts: Date.now(),
              step: rec.budget.steps,
              action,
              resultText: text.slice(0, 2000),
              url: rec.currentUrl,
            });
            return {
              ok: true,
              text,
              ...(outSnapshot !== "" ? { snapshot: outSnapshot } : {}),
              unchanged,
              ...pageMark,
              ...(r.image !== undefined ? { image: r.image } : {}),
              ...(r.intent !== undefined
                ? {
                    intent: {
                      kind: r.intent.kind,
                      ...(r.intent.href !== undefined ? { href: r.intent.href } : {}),
                    },
                  }
                : {}),
            };
          };

          /** batch 逐步执行器（§4b：确认挂起带全量续行上下文；confirm 批准后经
           * batchResume 从断点续行——approveSig 一次性放行被批准的子步） */
          const runBatch = async (
            steps: BrowserAction[],
            startAt: number,
            priorLines: string[],
            approvedSig?: string,
            uploadBefore?: string[],
          ): Promise<ToolResult> => {
            const lines = [...priorLines];
            let last: ToolResult = { ok: true };
            for (let i = startAt; i < steps.length; i += 1) {
              const step = steps[i] as BrowserAction;
              const isApprovedStep = approvedSig !== undefined && i === startAt;
              const sub = await run(step, snap, {
                ...(isApprovedStep
                  ? { approvedSig, ...(uploadBefore !== undefined ? { uploadBefore } : {}) }
                  : {}),
                batchCtx: { steps, executed: i, results: [...lines] },
              });
              if (sub.cid !== undefined) {
                // 确认挂起（ok:true + cid）——§4b：pending 已带续行上下文（run 写入）
                return {
                  ok: true,
                  cid: sub.cid,
                  ...(sub.reason !== undefined ? { reason: sub.reason } : {}),
                  text: `batch paused at step ${i + 1}/${steps.length}: ${sub.reason}\ncompleted:\n${lines.join("\n")}`,
                };
              }
              if (!sub.ok) {
                return {
                  ok: false,
                  ...(sub.code !== undefined ? { code: sub.code } : {}),
                  error: `batch stopped at step ${i + 1}/${steps.length}: ${sub.error ?? sub.code}\ncompleted:\n${lines.join("\n")}`,
                };
              }
              lines.push(`  ✓ [${i + 1}/${steps.length}] ${(sub.text ?? "").split("\n")[0]}`);
              last = sub;
            }
            return {
              ok: true,
              text: `batch ${steps.length} steps\n${lines.join("\n")}`,
              ...(last.snapshot !== undefined ? { snapshot: last.snapshot } : {}),
            };
          };

          let result: ToolResult;
          if (tool === "batch") {
            const built = buildAction("batch", params);
            if (built.kind !== "batch") throw new BWError("INVALID_TOOL_ARGS", "batch expected");
            result = await runBatch(built.steps, 0, []);
          } else if (tool === "batchResume") {
            // confirm 批准中段子步后的内部续行入口（params 由 confirm 构造）
            result = await runBatch(
              params.steps as BrowserAction[],
              Number(params.startAt ?? 0),
              (params.lines as string[] | undefined) ?? [],
              params.approvedSig as string | undefined,
              params.uploadBefore as string[] | undefined,
            );
          } else if (
            tool === "console" ||
            tool === "errors" ||
            tool === "cookies" ||
            tool === "cookies_set" ||
            tool === "cookies_clear" ||
            tool === "storage" ||
            tool === "storage_set" ||
            tool === "storage_clear" ||
            tool === "requests" ||
            tool === "cookies_all"
          ) {
            // inspect 家族（旧 INSPECT_TOOLS 语义）：chrome-only 闸 + 结果过 redact（B1 全工具面）
            const caps = driver.capabilities();
            if (
              (tool === "requests" || tool === "cookies_all") &&
              !caps.networkEvents &&
              !caps.httpOnlyCookies
            ) {
              result = {
                ok: false,
                code: "INVALID_TOOL_ARGS",
                error: `${tool} requires the chrome backend`,
              };
            } else {
              const kind = tool as
                | "console"
                | "errors"
                | "cookies"
                | "cookies_set"
                | "cookies_clear"
                | "storage"
                | "storage_set"
                | "storage_clear"
                | "requests"
                | "cookies_all";
              const raw = await engine.inspect(kind, {
                ...(params.key !== undefined ? { key: String(params.key) } : {}),
                ...(params.value !== undefined ? { value: String(params.value) } : {}),
              });
              result = { ok: true, text: policy.redact(raw) };
              rec.budget.steps += 1;
            }
          } else if (tool === "eval") {
            if (!rec.policy.allowEval) {
              result = {
                ok: false,
                code: "EVAL_DISABLED",
                error: "eval disabled (create --allow-eval)",
              };
            } else {
              const out = await engine.runExpression(String(params.expression ?? ""));
              result = { ok: true, text: policy.redact(out) };
            }
          } else if (tool === "tabs") {
            const pages = driver.pages();
            result = {
              ok: true,
              text: policy.redact(
                JSON.stringify(
                  pages.map((p, idx) => ({
                    index: idx,
                    url: (p as unknown as { url: string }).url,
                    title: (p as unknown as { title: string }).title,
                  })),
                ),
              ),
            };
          } else if (tool === "look") {
            const r = await run({ kind: "look" }, snap);
            result = r;
          } else {
            const action = buildAction(tool, params);
            result = await run(action, snap, {
              ...(replay?.approvedSig !== undefined ? { approvedSig: replay.approvedSig } : {}),
              ...(replay?.uploadBefore !== undefined ? { uploadBefore: replay.uploadBefore } : {}),
            });
          }
          writeRecord(root, rec);
          if (recovered && result.ok) {
            result.text =
              `${result.text ?? ""}\n[recovered] browser was dead; session recovered`.trim();
          }
          if (rolledBack && result.ok) {
            result.text =
              `${result.text ?? ""}\n[S1③] violation rolled back to ${rec.lastAllowedUrl}`.trim();
          }
          return result;
        } finally {
          release();
        }
      }
    },

    /** U5：从活会话捕获登录态快照（显式 save 才更新——不自动回写） */
    async captureProfile(id: string, name: string): Promise<{ path: string; cookies: number }> {
      readRecord(root, id); // NOT_FOUND 先于锁
      const dir = sessionDirOf(root, id);
      readRecord(root, id);
      const lock = acquireFlock(join(dir, "lock"));
      if (lock === null) throw new SessionBusyError(id);
      try {
        const rec = readRecord(root, id);
        const { driver, release } = await helperFactory(rec);
        try {
          const engine = createActionEngine(driver as Driver);
          await adoptActive(engine, driver, rec);
          const state = await readStorageState(
            engine.activePage(),
            (driver as Driver).capabilities(),
          );
          const path = saveProfileFile({
            schemaVersion: 1,
            name,
            createdAt: Date.now(),
            backend: state.backend,
            cookies: state.cookies,
            localStorage: state.localStorage,
          });
          return { path, cookies: state.cookies.length };
        } finally {
          release();
        }
      } finally {
        lock.release();
      }
    },

    /** 确认即执行（§4b：approve → 一次性放行执行；create 确认 → 置 active；
     * violatedHosts 迟到批准防护（S2R P1-5）） */
    async confirm(id: string, cid: string, approve: boolean): Promise<ToolResult> {
      readRecord(root, id); // NOT_FOUND 先于锁
      const dir = sessionDirOf(root, id);
      readRecord(root, id);
      const lock = acquireFlock(join(dir, "lock"));
      if (lock === null) throw new SessionBusyError(id);
      try {
        const r = confirmPending(dir, cid, approve);
        if ("error" in r) {
          return { ok: false, code: r.error.code, error: r.error.message };
        }
        const rec = r.rec;
        if (!approve) {
          if (rec.create === true) {
            destroySessionDir(dir, readRecord(root, id)); // §4c：deny → 杀组 + rm（S2R P1-8）
            return { ok: true, text: "create denied; session destroyed" };
          }
          if (rec.batchCtx !== undefined) {
            return {
              ok: false,
              code: "CONFIRMATION_DENIED",
              error: `batch stopped at step ${rec.batchCtx.executed + 1}/${rec.batchCtx.steps.length}: denied\ncompleted:\n${rec.batchCtx.results.join("\n")}`,
            };
          }
          return { ok: false, code: "CONFIRMATION_DENIED", error: "denied" };
        }
        const host = rec.approveHost;
        const sessionRec = readRecord(root, id);
        if (host !== undefined && host !== "") {
          // 迟到批准防护：挂起期间该域已违规 → 拒绝（旧 policies engine 语义）
          if (sessionRec.policy.violatedHosts.includes(host)) {
            return {
              ok: false,
              code: "CONFIRMATION_DENIED",
              error: `late approval rejected: ${host} violated while confirmation was pending`,
            };
          }
          if (!sessionRec.policy.allowedHosts.includes(host)) {
            sessionRec.policy.allowedHosts.push(host);
          }
        }
        writeRecord(root, sessionRec);
        if (rec.create === true && rec.action !== undefined) {
          // create 起始导航：执行导航置 active（§4c）
          const { driver, release } = await helperFactory(sessionRec);
          try {
            const engine = createActionEngine(driver as Driver);
            const page = await (driver as RemoteDriver).createPage({
              url: String(rec.action.url ?? "about:blank"),
            });
            sessionRec.activePageId = (page as unknown as { pageId: number }).pageId;
            engine.adopt(page);
            const snap = await engine.currentSnapshot();
            sessionRec.status = "active";
            sessionRec.currentUrl = String(rec.action.url ?? "about:blank");
            sessionRec.lastAllowedUrl = sessionRec.currentUrl;
            sessionRec.lastRendered = renderSnapshot(snap);
            writeRecord(root, sessionRec);
            return { ok: true, text: sessionRec.currentUrl };
          } finally {
            release();
          }
        }
        // 普通动作重放：批准签名一次性放行（S2R P0-1——同签名跳闸，否则死循环）
        if (rec.action !== undefined && rec.batchCtx === undefined) {
          const tool = String(rec.action.kind);
          const actionParams = { ...rec.action } as Record<string, unknown>;
          delete actionParams.kind;
          return await this.runLocked(id, tool, actionParams, {
            approvedSig: JSON.stringify(rec.action),
            ...(rec.uploadBefore !== undefined ? { uploadBefore: rec.uploadBefore } : {}),
          });
        }
        // batch 中段批准：续行余下子步（§4b——与一次跑完等价的汇总格式）
        if (rec.batchCtx !== undefined && rec.action !== undefined) {
          return await this.runLocked(id, "batchResume", {
            steps: rec.batchCtx.steps,
            startAt: rec.batchCtx.executed, // 被批准的子步（approvedSig 放行）从这里继续
            lines: rec.batchCtx.results,
            approvedSig: JSON.stringify(rec.action),
            ...(rec.uploadBefore !== undefined ? { uploadBefore: rec.uploadBefore } : {}),
          });
        }
        return { ok: true, text: "confirmed" };
      } finally {
        lock.release();
      }
    },
  };
}

/** 会话目录销毁（杀 helper 进程组 + rm——create deny/失败清场共用，S2R P1-8） */
function destroySessionDir(dir: string, rec: SessionRecord | undefined): void {
  killHelperGroup(rec?.helper.pid ?? 0); // 守卫：pid≤1 拒绝 + ps 命令核验
  if (rec?.driver.dataStore !== undefined) killChromeByDataDir(rec.driver.dataStore);
  rmSync(join(dir, "pending"), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** headed 映射用：常见 Chrome 安装位探测（与测试候选一致；找不到返回 null → create 报错） */
function detectChromeBinary(): string | null {
  const candidates = [
    process.env.BUN_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((p): p is string => p !== undefined);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 近似 eTLD+1：末两段一致视为同站（douyin.com ≈ lf-zt.douyin.com）。
 * 对 co.uk 类多级后缀会误判同站——S1 白名单已覆盖主域，残余风险可接受 */
function sameRegistrableDomain(a: string, b: string): boolean {
  const tail = (u: string): string => {
    try {
      return new URL(u).hostname.split(".").slice(-2).join(".");
    } catch {
      return u;
    }
  };
  const ta = tail(a);
  return ta !== "" && ta === tail(b);
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname || null; // hostname（无端口）——与 policy 白名单口径一致
  } catch {
    return null;
  }
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^127\./.test(host) || host === "::1" || host === "[::1]") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return false;
}

export { homedir, join, resolveBwHome, writeFileAtomic };
