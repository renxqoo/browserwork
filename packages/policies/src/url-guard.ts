/**
 * S4 URL 守卫（docs/01-baseline.md §7 S4，纯函数）：
 * 协议白名单、特殊主机名、IP 全记法解析（点分/十进制整数/十六进制/八进制/混合/
 * IPv6 含 ::ffff: 映射与 v4 结尾形式）、封锁段表。
 * 非字面主机名的 DNS 复查由 PolicyEngine 走注入的 DnsResolver（TOCTOU 残余
 * 风险文档化：按主机名缓存，会话内不重析）。
 */

export const BLOCKED_IPV4_RANGES: ReadonlyArray<{ base: number; bits: number }> = [
  { base: 0x00000000, bits: 8 }, // 0.0.0.0/8 "this network"
  { base: 0x0a000000, bits: 8 }, // 10.0.0.0/8
  { base: 0x64400000, bits: 10 }, // 100.64.0.0/10 CGNAT
  { base: 0x7f000000, bits: 8 }, // 127.0.0.0/8 loopback
  { base: 0xa9fe0000, bits: 16 }, // 169.254.0.0/16 link-local
  { base: 0xac100000, bits: 12 }, // 172.16.0.0/12
  { base: 0xc0a80000, bits: 16 }, // 192.168.0.0/16
  { base: 0xc6120000, bits: 15 }, // 198.18.0.0/15 benchmark
  { base: 0xe0000000, bits: 4 }, // 224.0.0.0/4 multicast
  { base: 0xf0000000, bits: 4 }, // 240.0.0.0/4 reserved
];

export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** inet_aton 全记法：1-4 段，每段十进制/0x 十六进制/0 八进制；返回 uint32 或 null */
export function parseIPv4(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let v: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      v = Number.parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      v = Number.parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      v = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isSafeInteger(v) || v > 0xffffffff) return null;
    values.push(v);
  }
  const n = values.length;
  // 非末段各占 1 字节
  for (let i = 0; i < n - 1; i++) {
    if ((values[i] as number) > 0xff) return null;
  }
  // inet_aton 语义：末段容纳余量（N 段 → 末段上限 256^(5-N)-1）
  const tail = values[n - 1] as number;
  if (tail >= 256 ** (5 - n)) return null;
  // 前段占据高位字节，末段为低位余量
  let result = tail;
  for (let i = 0; i < n - 1; i++) {
    result += (values[i] as number) * 256 ** (3 - i);
  }
  return result >>> 0;
}

function ipv4InRange(ip: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

export function isBlockedIPv4(ip: number): boolean {
  return BLOCKED_IPV4_RANGES.some((r) => ipv4InRange(ip, r.base, r.bits));
}

export interface ParsedHost {
  /** 字面 IP（v4 或 v6）——需要 DNS 复查时为 null */
  literalIp: string | null;
  isIPv6: boolean;
  hostname: string;
}

/** 主机名分类：特殊名 / IPv4 字面 / IPv6 字面 / 待 DNS 域名 */
export function classifyHost(hostname: string): ParsedHost {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(host);
  if (v4 !== null) return { literalIp: host, isIPv6: false, hostname: host };
  if (host.includes(":")) return { literalIp: host, isIPv6: true, hostname: host };
  return { literalIp: null, isIPv6: false, hostname: host };
}

const SPECIAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const SPECIAL_SUFFIXES = [".localhost", ".local", ".internal"];

/** 展开 IPv6 为 8 段（含 v4 结尾形式）；无法解析返回 null */
function expandIPv6(host: string): number[] | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(":")) return null;
  const halves = h.split("::");
  if (halves.length > 2) return null; // :: 至多一次
  const hasEllipsis = halves.length === 2;

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] ?? "";
      if (p === "") return null; // 空段（:: 展开之外不允许）
      if (p.includes(".")) {
        if (i !== parts.length - 1) return null; // 点分十进制只允许末段
        const v4 = parseIPv4(p);
        if (v4 === null) return null;
        out.push(((v4 >>> 16) & 0xffff) as number, (v4 & 0xffff) as number);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };

  const head = parseSide(halves[0] ?? "");
  if (head === null) return null;
  if (!hasEllipsis) {
    return head.length === 8 ? head : null;
  }
  const tail = parseSide(halves[1] ?? "");
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** IPv6 封锁判定：::, ::1, ULA fc00::/7, 链路本地 fe80::/10, v4 映射 ::ffff:0:0/96 递归 v4 检查 */
export function isBlockedIPv6(host: string): boolean {
  const segs = expandIPv6(host);
  if (segs === null) return false;
  const allZero = segs.every((s) => s === 0);
  if (allZero) return true; // ::
  if (segs.slice(0, 7).every((s) => s === 0) && segs[7] === 1) return true; // ::1
  const first = segs[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  // ::ffff:0:0/96（v4 映射）——URL 解析器会把点分形式规范成十六进制，两种都覆盖
  if (segs.slice(0, 5).every((s) => s === 0) && segs[5] === 0xffff) {
    const v4 = (((segs[6] ?? 0) << 16) | (segs[7] ?? 0)) >>> 0;
    return isBlockedIPv4(v4);
  }
  return false;
}

export interface UrlCheckViolation {
  ok: false;
  reason: string;
}

export interface UrlCheckOk {
  ok: true;
  /** 主机名需要 DNS 复查（非字面 IP 且非特殊名） */
  needsDns: boolean;
  hostname: string;
  origin: string;
}

export type UrlCheck = UrlCheckViolation | UrlCheckOk;

/** URL 静态检查（S4 前半 + 协议白名单）；不查 origin 白名单（S1 另做）。
 * allowPrivateNetwork = 测试档放宽（跳过内网/特殊主机封锁；协议白名单恒生效） */
export function checkUrl(url: string, opts?: { allowPrivateNetwork?: boolean }): UrlCheck {
  const relax = opts?.allowPrivateNetwork === true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${stripQueryLocal(url)}` };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme not allowed: ${parsed.protocol}` };
  }
  const rawHost = parsed.hostname.toLowerCase();
  // 空标签主机（.trusted.test / ..x / 首尾点之外的空洞）直接拒（B5 审查 P2-13）
  if (rawHost.startsWith(".") || rawHost.includes("..") || rawHost === ".") {
    return { ok: false, reason: `malformed hostname: ${stripQueryLocal(rawHost)}` };
  }
  const host = normalizeHost(rawHost);
  if (!relax && (SPECIAL_HOSTNAMES.has(host) || SPECIAL_SUFFIXES.some((s) => host.endsWith(s)))) {
    return { ok: false, reason: `local hostname blocked: ${host}` };
  }
  const cls = classifyHost(host);
  if (cls.literalIp !== null) {
    if (!relax) {
      if (!cls.isIPv6) {
        const v4 = parseIPv4(cls.literalIp);
        if (v4 !== null && isBlockedIPv4(v4)) {
          return { ok: false, reason: `private/reserved IP blocked: ${cls.literalIp}` };
        }
      } else if (isBlockedIPv6(cls.literalIp)) {
        return { ok: false, reason: `private/reserved IPv6 blocked: ${cls.literalIp}` };
      }
    }
    return { ok: true, needsDns: false, hostname: host, origin: parsed.origin };
  }
  return { ok: true, needsDns: !relax, hostname: host, origin: parsed.origin };
}

/** host 匹配白名单（S1）：精确或子域（example.com 匹配 a.example.com；禁止子串）。
 * 尾点规范化（trusted.test. == trusted.test，浏览器同站点语义）。 */
export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const h = normalizeHost(host);
  return allowedHosts.some((a) => {
    const al = normalizeHost(a);
    return h === al || h.endsWith(`.${al}`);
  });
}

/** 主机名规范化：小写 + 去尾点（FQDN 尾点是同站点） */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

function stripQueryLocal(url: string): string {
  return (url.split(/[?#]/)[0] ?? url).slice(0, 120);
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
