/**
 * B22 S4（U5/U11）：登录态快照——storageState 模型（对标 Playwright auth / Browserbase Contexts）。
 * save = 从活会话读 cookies+localStorage → ~/.bw/profiles/<name>.json（0600）；
 * inject = 新会话/任务启动时写入（chrome 经 CDP 可含 httpOnly；webkit 仅可见面——U11 文档标注）。
 * 不自动回写：显式 save 才更新（可复现可审计）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BWError, profilesRoot, readJsonIfPossible, writeFileAtomic } from "@bw/core";
import type { DriverCapabilities, Page } from "@bw/driver";

export interface ProfileCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface StorageStateProfile {
  schemaVersion: 1;
  name: string;
  createdAt: number;
  backend: "webkit" | "chrome";
  cookies: ProfileCookie[];
  /** localStorage per-origin（注入需先导航到对应 origin） */
  localStorage: Array<{ origin: string; entries: Record<string, string> }>;
}

const profilePath = (name: string): string => join(profilesRoot(), `${name}.json`);

/** 名字校验（防路径穿越：仅 [A-Za-z0-9._-]） */
export function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new BWError("INVALID_TOOL_ARGS", `profile name must match [A-Za-z0-9._-]{1,64}: ${name}`);
  }
}

/** 从活页面读取 storageState（chrome：CDP 全量含 httpOnly；webkit：document.cookie 可见面） */
export async function readStorageState(
  page: Page,
  caps: DriverCapabilities,
): Promise<
  Omit<StorageStateProfile, "schemaVersion" | "name" | "createdAt" | "backend"> & {
    backend: "webkit" | "chrome";
  }
> {
  const url = page.url;
  let cookies: ProfileCookie[] = [];
  if (caps.httpOnlyCookies) {
    // chrome：Network.getCookies 返回全量（含 httpOnly）——U11 确定契约
    const raw = await page.cdp<{ cookies: Array<Record<string, unknown>> }>("Network.getCookies", {
      urls: [url],
    });
    cookies = (raw.cookies ?? []).map((c) => ({
      name: String(c.name ?? ""),
      value: String(c.value ?? ""),
      domain: String(c.domain ?? ""),
      path: String(c.path ?? "/"),
      ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
      ...(c.httpOnly === true ? { httpOnly: true } : {}),
      ...(c.secure === true ? { secure: true } : {}),
    }));
  } else {
    // webkit：document.cookie（httpOnly 不可见——U11 诚实标注，快照只含可见面）
    const raw = await page.evaluate<string>("document.cookie");
    cookies = (raw ?? "")
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair !== "")
      .map((pair) => {
        const eq = pair.indexOf("=");
        const name = eq > 0 ? pair.slice(0, eq) : pair;
        const value = eq > 0 ? pair.slice(eq + 1) : "";
        return {
          name,
          value,
          domain: (() => {
            try {
              return new URL(url).hostname;
            } catch {
              return "";
            }
          })(),
          path: "/",
        };
      });
  }
  const ls = await page.evaluate<Array<{ origin: string; entries: Record<string, string> }>>(
    "(() => { try { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k) ?? ''; } return [{ origin: location.origin, entries: o }]; } catch { return []; } })()",
  );
  return { backend: caps.httpOnlyCookies ? "chrome" : "webkit", cookies, localStorage: ls ?? [] };
}

/** 向页面写入 storageState（须已导航到目标 origin；localStorage 按 origin 匹配注入） */
export async function writeStorageState(
  page: Page,
  caps: DriverCapabilities,
  state: Pick<StorageStateProfile, "cookies" | "localStorage">,
): Promise<void> {
  const url = page.url;
  if (caps.httpOnlyCookies && state.cookies.length > 0) {
    // chrome：Network.setCookies 可写 httpOnly
    await page.cdp("Network.setCookies", {
      cookies: state.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        ...(c.expires !== undefined ? { expires: c.expires } : {}),
        ...(c.httpOnly === true ? { httpOnly: true } : {}),
        ...(c.secure === true ? { secure: true } : {}),
      })),
    });
  } else {
    // webkit：document.cookie 逐条（httpOnly 写不进——可见面尽力而为）
    for (const c of state.cookies) {
      await page.evaluate(
        `document.cookie = ${JSON.stringify(`${c.name}=${c.value}; path=${c.path}`)}; (() => 1)()`,
      );
    }
  }
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  })();
  const mine = state.localStorage.find((l) => l.origin === origin);
  if (mine !== undefined && Object.keys(mine.entries).length > 0) {
    await page.evaluate(
      `(() => { ${Object.entries(mine.entries)
        .map(
          ([k, v]) =>
            `try { localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}); } catch {}`,
        )
        .join(" ")} return 1; })()`,
    );
  }
}

/** 落盘快照（0600） */
export function saveProfileFile(state: StorageStateProfile): string {
  assertProfileName(state.name);
  mkdirSync(profilesRoot(), { recursive: true });
  const path = profilePath(state.name);
  writeFileAtomic(path, JSON.stringify(state), 0o600);
  return path;
}

export function loadProfileFile(name: string): StorageStateProfile {
  assertProfileName(name);
  const p = readJsonIfPossible<StorageStateProfile>(profilePath(name));
  if (p === undefined) {
    throw new BWError("NOT_FOUND", `profile not found: ${name} (${profilePath(name)})`);
  }
  return p;
}

export function listProfiles(): Array<{
  name: string;
  createdAt: number;
  backend: string;
  cookies: number;
}> {
  const root = profilesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJsonIfPossible<StorageStateProfile>(join(root, f)))
    .filter((p): p is StorageStateProfile => p !== undefined)
    .map((p) => ({
      name: p.name,
      createdAt: p.createdAt,
      backend: p.backend,
      cookies: p.cookies.length,
    }));
}

export function deleteProfile(name: string): boolean {
  assertProfileName(name);
  const path = profilePath(name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
