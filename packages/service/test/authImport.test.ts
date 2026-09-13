/** B22+：Chrome 登录态导入——解密往返/host 匹配/字段映射/落盘（合成数据，不碰真 Chrome） */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptCookieValue, deriveChromeKey } from "../src/authImport.ts";
import { loadProfileFile } from "../src/profiles.ts";

const HOME = mkdtempSync(join(tmpdir(), "bw-import-"));
process.env.BW_HOME = HOME;
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Chrome 同构加密：v10 前缀 + AES-128-CBC(IV=16 空格) + PKCS7 */
const encryptLikeChrome = (plain: string, password: string): Buffer => {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"); // Chromium 实测：SHA-1 非 SHA-256
  // macOS 明文 = 32B 指纹前缀 + 值
  const payload = Buffer.concat([Buffer.alloc(32, 7), Buffer.from(plain, "utf8")]);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "utf8"), body]);
};

describe("deriveChromeKey / decryptCookieValue", () => {
  test("PBKDF2 参数面（saltysalt/1003/16B/sha1）+ v10 往返（含 32B 指纹剥离）", () => {
    const key = deriveChromeKey("test-password");
    expect(key.length).toBe(16);
    const enc = encryptLikeChrome("session-token-值-中文", "test-password");
    expect(decryptCookieValue(enc, key)).toBe("session-token-值-中文");
  });

  test("错误密钥 → null；短 blob → null；坏前缀 → null（不炸）", () => {
    const enc = encryptLikeChrome("x", "right");
    expect(decryptCookieValue(enc, deriveChromeKey("wrong"))).toBeNull();
    expect(decryptCookieValue(new Uint8Array(5), deriveChromeKey("k"))).toBeNull();
    expect(
      decryptCookieValue(Buffer.from("zzz" + "a".repeat(20)), deriveChromeKey("k")),
    ).toBeNull();
  });
});

describe("importChromeCookies（sqlite fixture + Keychain 桩）", () => {
  test("host 精确/子域匹配、明文与加密值、字段映射、跳过解不开的、落盘 0600 JSON", async () => {
    const { importChromeCookies } = await import("../src/authImport.ts");

    // 造 Chrome 形状的 Cookies sqlite 到「Chrome 目录」
    const chromeDir = join(HOME, "Library/Application Support/Google/Chrome/Default");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(chromeDir, { recursive: true });
    const db = new Database(join(chromeDir, "Cookies"));
    db.run(`CREATE TABLE cookies (
      host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
      path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER)`);
    const ins = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const PW = "test-password";
    const enc = (s: string): Buffer => encryptLikeChrome(s, PW);
    ins.run("tillgate.io", "sid", "", enc("secret-sid"), "/", 13800000000000000, 1, 1);
    ins.run(".tillgate.io", "sub", "", enc("sub-val"), "/path", 0, 0, 0);
    ins.run("tillgate.io", "plain", "plain-val", new Uint8Array(0), "/", 0, 0, 0);
    ins.run("evil.io", "nope", "", enc("should-not-import"), "/", 0, 0, 0);
    db.close();

    const r = importChromeCookies({
      host: "tillgate.io",
      name: "tillgate",
      getPassword: () => PW, // DI 缝注入——绕开 Keychain（真 Keychain 面由 CLI 实测覆盖）
      browserRoot: join(HOME, "Library/Application Support/Google/Chrome"),
    });
    expect(r.cookies).toBe(3); // 精确 + 子域 + 明文；evil.io 不入
    expect(r.decrypted).toBe(2);
    expect(r.plaintext).toBe(1);

    const p = loadProfileFile("tillgate");
    expect(p.backend).toBe("chrome");
    const byName = new Map(p.cookies.map((c) => [c.name, c]));
    expect(byName.get("sid")).toMatchObject({
      value: "secret-sid",
      domain: "tillgate.io",
      path: "/",
      httpOnly: true,
      secure: true,
      expires: Math.floor((13800000000000000 - 11644473600000000) / 1_000_000),
    });
    expect(byName.get("sub")).toMatchObject({
      value: "sub-val",
      domain: "tillgate.io",
      path: "/path",
    });
    expect(byName.get("plain")).toMatchObject({ value: "plain-val" });

    // 无匹配 host → 诚实报错
    try {
      importChromeCookies({
        host: "nomatch.io",
        name: "x",
        getPassword: () => PW,
        browserRoot: join(HOME, "Library/Application Support/Google/Chrome"),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("no cookies for host");
    }
  });
});
