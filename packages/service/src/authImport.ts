/**
 * B22+：`bw auth import-chrome --host <域名>`——从本机 Chrome 导入单站登录态。
 * 边界（ deliberate）：
 * - **单站范围**：只取 --host 匹配的 cookie（host_key 精确/子域），绝不整库搬——
 *   agent 工具不静默继承用户全部登录态（安全模型裁决，见 04-usage §2.5 讨论）
 * - **本机同用户**：Chrome cookie 由 Keychain「Chrome Safe Storage」密钥加密——
 *   解密需 Keychain 授权弹窗（用户点一次允许）；跨用户/跨机不适用
 * - **解密失败诚实报错**：Chrome 若换加密方案（Windows 已 App-Bound）——不猜
 * - 明文值（value 列非空）与加密值（encrypted_value）都读；cookie 值不打印 stdout
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BWError } from "@bw/core";
import {
  assertProfileName,
  type ProfileCookie,
  type StorageStateProfile,
  saveProfileFile,
} from "./profiles.ts";

export type SupportedBrowser = "chrome" | "chromium" | "edge" | "brave";

const BROWSER_DIRS: Record<SupportedBrowser, { mac: string; linux: string; keychain: string }> = {
  chrome: {
    mac: join(homedir(), "Library/Application Support/Google/Chrome"),
    linux: join(homedir(), ".config/google-chrome"),
    keychain: "Chrome Safe Storage",
  },
  chromium: {
    mac: join(homedir(), "Library/Application Support/Chromium"),
    linux: join(homedir(), ".config/chromium"),
    keychain: "Chromium Safe Storage",
  },
  edge: {
    mac: join(homedir(), "Library/Application Support/Microsoft Edge"),
    linux: join(homedir(), ".config/microsoft-edge"),
    keychain: "Microsoft Edge Safe Storage",
  },
  brave: {
    mac: join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser"),
    linux: join(homedir(), ".config/BraveSoftware/Brave-Browser"),
    keychain: "Brave Safe Storage",
  },
};

/** Chrome cookie 时间（1601 起 微秒）→ Unix 秒 */
const chromeEpochToUnix = (expiresUtc: number): number =>
  Math.floor((expiresUtc - 11644473600000000) / 1_000_000);

/** Keychain 取「<Browser> Safe Storage」密码（GUI 授权弹一次） */
export function readSafeStoragePassword(browser: SupportedBrowser): string {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-w", "-s", BROWSER_DIRS[browser].keychain],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0 || !r.stdout) {
    throw new BWError(
      "AUTH_IMPORT_FAILED",
      `cannot read "${BROWSER_DIRS[browser].keychain}" from Keychain (status ${r.status}). ` +
        `Approve the macOS prompt (Always Allow), or Chrome may be using a newer encryption scheme.`,
    );
  }
  return r.stdout.trim();
}

/**
 * PBKDF2(password, "saltysalt", 1003, 16B, **sha1**) → AES-128 密钥（Chromium os_crypt 实测：
 * sha256 派生 BAD_DECRYPT——文档传抄常见错误；真实方案是 SHA-1/1003）
 */
export function deriveChromeKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** v10/v11 + AES-128-CBC(IV=16 空格) 解密单个 cookie 值；失败返回 null（不炸整批） */
export function decryptCookieValue(encryptedValue: Uint8Array, key: Buffer): string | null {
  const buf = Buffer.from(encryptedValue);
  if (buf.length < 19) return null; // 3B 版本前缀 + 至少 16B 密文
  const prefix = buf.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    decipher.setAutoPadding(true);
    const plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    // macOS Chrome v10 明文 = 32B SHA256 指纹前缀 + 真值（实测 JWT cookie 可见）——剥前缀
    const body = plain.subarray(32);
    return body.length > 0 ? body.toString("utf8") : plain.toString("utf8");
  } catch {
    return null;
  }
}

export interface ImportOptions {
  host: string;
  name?: string;
  browser?: SupportedBrowser;
  chromeProfile?: string;
  /** 测试缝：密钥口令注入（缺省走 Keychain） */
  getPassword?: () => string;
  /** 测试缝：浏览器配置根（缺省真实 home——fixture 库注入用） */
  browserRoot?: string;
}

export interface ImportResult {
  path: string;
  cookies: number;
  decrypted: number;
  plaintext: number;
  undecryptable: number;
}

/** 主入口：拷库（Chrome 运行中 WAL 兼容）→ sqlite 读 → 解密 → profile 落盘（0600） */
export function importChromeCookies(opts: ImportOptions): ImportResult {
  const browser = opts.browser ?? "chrome";
  const profileDir = opts.chromeProfile ?? "Default";
  const dirs = BROWSER_DIRS[browser];
  const base =
    opts.browserRoot !== undefined
      ? join(opts.browserRoot, profileDir)
      : join(dirs.mac, profileDir);
  const cookiesPath = join(base, "Cookies");
  if (!existsSync(cookiesPath)) {
    throw new BWError(
      "AUTH_IMPORT_FAILED",
      `cookies db not found: ${cookiesPath} (is ${browser} installed? try --browser/--chrome-profile)`,
    );
  }

  // 拷贝读（Chrome 运行时锁库；连 -wal/-shm 一起拷保事务完整）
  const tmp = mkdtempSync(join(homedir(), ".bw", "import-"));
  const tmpDb = join(tmp, "Cookies");
  const cookies: ProfileCookie[] = [];
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = `${cookiesPath}${suffix}`;
      if (existsSync(src)) {
        // copyFileSync（同步）——Bun.write 异步：曾致拷库未完成即开库 → 0 行（实测踩坑）
        copyFileSync(src, join(tmp, `Cookies${suffix}`));
      }
    }
    const password =
      opts.getPassword !== undefined ? opts.getPassword() : readSafeStoragePassword(browser);
    const key = deriveChromeKey(password);
    // 读写打开（我们拥有的临时副本）：Chrome 运行时 cookie 多在 -wal 未 checkpoint——
    // readonly 连接不回放 WAL 会看到旧状态（实测 0 行假象）；读写打开自动恢复
    const db = new Database(tmpDb);
    // 单站匹配：精确 host 或 .host 子域（.example.com 覆盖 a.example.com）
    const host = opts.host;
    const rows = db
      .query(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly
         FROM cookies
         WHERE host_key = ? OR host_key = '.' || ? OR host_key LIKE '%.' || ?`,
      )
      .all(host, host, host) as Array<{
      host_key: string;
      name: string;
      value: string | null;
      encrypted_value: Uint8Array | null;
      path: string;
      expires_utc: number;
      is_secure: number;
      is_httponly: number;
    }>;
    db.close();

    let decrypted = 0;
    let plaintext = 0;
    let undecryptable = 0;
    for (const row of rows) {
      let value: string | null = null;
      if (row.value !== null && row.value !== "") {
        value = row.value;
        plaintext++;
      } else if (row.encrypted_value !== null && row.encrypted_value.length > 0) {
        value = decryptCookieValue(row.encrypted_value, key);
        if (value !== null) decrypted++;
        else undecryptable++;
      }
      if (value === null) continue; // 解不开的跳过（不炸批——其余 cookie 仍可用）
      cookies.push({
        name: row.name,
        value,
        domain: row.host_key, // 保留原始形态（.example.com = 域 cookie；IP = 精确）——
        // 剥点会让注入层丢失「子域共享」语义（实测：B 站 SESSDATA host_key=.bilibili.com）
        path: row.path || "/",
        ...(row.expires_utc > 0 ? { expires: chromeEpochToUnix(row.expires_utc) } : {}),
        ...(row.is_secure === 1 ? { secure: true } : {}),
        ...(row.is_httponly === 1 ? { httpOnly: true } : {}),
      });
    }
    if (cookies.length === 0) {
      const detail =
        rows.length > 0
          ? `${rows.length} cookies found but none decryptable (Chrome encryption scheme changed?)`
          : `no cookies for host "${host}" (login in ${browser} first, then retry)`;
      throw new BWError("AUTH_IMPORT_FAILED", detail);
    }
    // 过期清洗：会话 cookie（expires 缺）照存——注入按会话 cookie 语义
    const name = opts.name ?? host.replace(/[^A-Za-z0-9.-]/g, "-");
    assertProfileName(name);
    const profile: StorageStateProfile = {
      schemaVersion: 1,
      name,
      createdAt: Date.now(),
      backend: "chrome",
      cookies,
      localStorage: [], // Chrome localStorage（LEVeldb）不进本次范围——cookie 面已覆盖绝大多数登录态
    };
    const path = saveProfileFile(profile);
    return { path, cookies: cookies.length, decrypted, plaintext, undecryptable };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
