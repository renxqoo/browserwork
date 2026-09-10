/** S4 URL 守卫纯函数表驱动（IP 全记法/封锁段/特殊名/协议/IPv6/匹配规则） */
import { describe, expect, test } from "bun:test";
import {
  checkUrl,
  classifyHost,
  hostAllowed,
  isBlockedIPv4,
  isBlockedIPv6,
  parseIPv4,
} from "../src/index.ts";

describe("parseIPv4 全记法表", () => {
  const table: Array<[string, number | null]> = [
    ["1.2.3.4", 0x01020304],
    ["127.0.0.1", 0x7f000001],
    ["2130706433", 0x7f000001], // 十进制整数
    ["0x7f.1", 0x7f000001], // 十六进制 + 短形
    ["0177.0.0.1", 0x7f000001], // 八进制
    ["127.1", 0x7f000001], // 短形点分
    ["0177.0.0.01", 0x7f000001], // 混合进制（末段八进制 01）
    ["0x7f000001", 0x7f000001],
    ["8.8.8.8", 0x08080808],
    ["example.com", null],
    ["1.2.3.4.5", null],
    ["1.2.3.999", null],
    ["", null],
    ["256.1.1.1", null],
  ];
  for (const [input, expected] of table) {
    test(`${input} → ${expected === null ? "null" : expected.toString(16)}`, () => {
      expect(parseIPv4(input)).toBe(expected);
    });
  }
});

describe("封锁段表（isBlockedIPv4）", () => {
  const blocked: string[] = [
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254", // 云元数据
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ];
  const allowed: string[] = [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "198.20.0.1",
    "9.9.9.9",
  ];
  for (const ip of blocked) {
    test(`封锁 ${ip}`, () => {
      const v = parseIPv4(ip);
      expect(v).not.toBeNull();
      expect(isBlockedIPv4(v as number)).toBe(true);
    });
  }
  for (const ip of allowed) {
    test(`放行 ${ip}`, () => {
      const v = parseIPv4(ip);
      expect(v).not.toBeNull();
      expect(isBlockedIPv4(v as number)).toBe(false);
    });
  }
});

describe("IPv6 封锁", () => {
  test(":: 与 ::1 封锁", () => {
    expect(isBlockedIPv6("::")).toBe(true);
    expect(isBlockedIPv6("::1")).toBe(true);
  });
  test("ULA fc00::/7 封锁", () => {
    expect(isBlockedIPv6("fc00::1")).toBe(true);
    expect(isBlockedIPv6("fd12:3456::1")).toBe(true);
  });
  test("链路本地 fe80::/10 封锁", () => {
    expect(isBlockedIPv6("fe80::1")).toBe(true);
    expect(isBlockedIPv6("febf::1")).toBe(true);
  });
  test("v4 映射递归封锁", () => {
    expect(isBlockedIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIPv6("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIPv6("::ffff:8.8.8.8")).toBe(false);
  });
  test("公网 IPv6 放行", () => {
    expect(isBlockedIPv6("2606:4700::1111")).toBe(false);
  });
});

describe("checkUrl（协议/特殊主机/IP/域名分类）", () => {
  const blocked: Array<[string, string]> = [
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,x", "scheme"],
    ["http://localhost/x", "local hostname"],
    ["http://api.localhost/x", "local hostname"],
    ["http://printer.local/x", "local hostname"],
    ["http://intranet.internal/x", "local hostname"],
    ["http://127.0.0.1/x", "private"],
    ["http://2130706433/x", "private"],
    ["http://0x7f.1/x", "private"],
    ["http://169.254.169.254/latest/meta-data", "private"],
    ["http://[::1]/x", "IPv6"],
    ["http://[fe80::1]/x", "IPv6"],
    ["http://[::ffff:10.0.0.1]/x", "IPv6"],
    ["not a url", "invalid"],
  ];
  for (const [url, why] of blocked) {
    test(`封锁 ${url}（${why}）`, async () => {
      const r = checkUrl(url);
      expect(r.ok).toBe(false);
    });
  }
  test("公网域名 → needsDns", () => {
    const r = checkUrl("https://example.com/a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.needsDns).toBe(true);
  });
  test("公网字面 IP → 不需 DNS", () => {
    const r = checkUrl("https://8.8.8.8/dns");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.needsDns).toBe(false);
  });
  test("classifyHost：IPv6 带方括号", () => {
    expect(classifyHost("[::1]").isIPv6).toBe(true);
  });
});

describe("hostAllowed（S1 匹配规则：精确/子域，禁止子串）", () => {
  const allowed = ["example.com"];
  test("精确匹配", () => {
    expect(hostAllowed("example.com", allowed)).toBe(true);
  });
  test("子域匹配", () => {
    expect(hostAllowed("a.example.com", allowed)).toBe(true);
    expect(hostAllowed("a.b.example.com", allowed)).toBe(true);
  });
  test("子串伪装不匹配", () => {
    expect(hostAllowed("example.com.evil.io", allowed)).toBe(false);
    expect(hostAllowed("notexample.com", allowed)).toBe(false);
    expect(hostAllowed("xexample.com", allowed)).toBe(false);
  });
  test("大小写不敏感", () => {
    expect(hostAllowed("WWW.Example.COM", ["example.com"])).toBe(true);
  });
});
