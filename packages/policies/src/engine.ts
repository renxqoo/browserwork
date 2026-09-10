/**
 * 策略引擎（docs/03-units.md U5；01 §7 S1–S6）。
 * 纯决策核心 + 注入依赖（DNS/Secret/cid/词表/预算）；确认计时器归 U6。
 * 边界模型：意图前检（S1①②/S2/S3/S5）+ 结果后检（S1③ 回滚）——
 * webkit 无请求拦截，不承诺请求级阻断。
 */
import { type BrowserAction, BWError, type NavigationIntent } from "@bw/core";
import {
  checkUrl,
  hostAllowed,
  hostOf,
  isBlockedIPv4,
  isBlockedIPv6,
  originOf,
  parseIPv4,
} from "./url-guard.ts";

/** 默认敏感词表（S2；配置可覆盖/追加） */
export const DEFAULT_SENSITIVE_WORDS = [
  "支付",
  "付款",
  "购买",
  "下单",
  "结算",
  "删除",
  "移除",
  "发送",
  "转账",
  // 英文只保留领域词——泛化单词（send/delete/remove）会让每个普通按钮都进确认门，
  // 确认疲劳是安全负资产（B5 审查 P2）；需要更宽覆盖走配置追加
  "submit payment",
  "purchase",
  "checkout",
  "withdraw",
  "pay now",
] as const;

export type GateDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "confirm"; cid: string; reason: string };

export type BudgetDimension =
  | "steps"
  | "tokensInput"
  | "tokensOutput"
  | "wallClockMs"
  | "costUsd"
  | "contextWindow";

export interface BudgetLimits {
  maxSteps: number;
  maxTokensInput: number;
  maxTokensOutput: number;
  wallClockMs: number;
  costUsd?: number;
  contextWindow?: number;
}

export interface BudgetUsage {
  steps: number;
  tokensInput: number;
  tokensOutput: number;
  wallClockMs: number;
  costUsd: number;
}

export interface DnsResolver {
  /** 返回主机名解析到的全部 IP（字符串形式） */
  resolve(hostname: string): Promise<string[]>;
}

export interface SecretResolver {
  resolve(name: string): Promise<string>;
}

export interface PolicyConfig {
  /** 初始 origin 白名单（host；startUrl 域由装配层加入） */
  allowedHosts: string[];
  /** S3：允许输入 secret 的 origin（host；须同时在白名单内） */
  allowSecretsHosts?: string[];
  sensitiveWords?: readonly string[];
  /** 测试档放宽 S4 内网封锁（fixture 127.0.0.1）——默认 false */
  allowPrivateNetwork?: boolean;
  budget: BudgetLimits;
}

export interface PolicyDeps {
  dns: DnsResolver;
  secrets: SecretResolver;
  newCid: () => string;
}

export interface ActionTarget {
  text?: string;
  tag?: string;
  href?: string;
}

export interface SettledVerdict {
  ok: boolean;
  violation?: string;
  /** 违规时是否回滚（about:blank）——S1③ */
  rollback: boolean;
}

/** 预算账本（计量采集归 U6；本类只存数与断言） */
export class BudgetLedger {
  readonly limits: BudgetLimits;
  #usage: BudgetUsage = { steps: 0, tokensInput: 0, tokensOutput: 0, wallClockMs: 0, costUsd: 0 };
  #exceeded: BudgetDimension | null = null;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  get usage(): Readonly<BudgetUsage> {
    return { ...this.#usage }; // 副本——外部改写不透传（B5 审查 P2）
  }

  consume(dim: BudgetDimension, amount: number): void {
    if (this.#exceeded !== null) return;
    // 非法计量（NaN/负数/Infinity）一律忽略——防止 NaN 永久失效某维度（B5 审查 P2）
    if (!Number.isFinite(amount) || amount < 0) return;
    if (dim === "wallClockMs") this.#usage.wallClockMs += amount;
    else if (dim === "steps") this.#usage.steps += amount;
    else if (dim === "tokensInput") this.#usage.tokensInput += amount;
    else if (dim === "tokensOutput") this.#usage.tokensOutput += amount;
    else if (dim === "costUsd") this.#usage.costUsd += amount;
    else if (dim === "contextWindow") {
      // 上下文计量走 tokensInput 账户（contextWindow 限值在 assert 中比对）
      this.#usage.tokensInput += amount;
    }
  }

  /** 超限即锁存（一次性）；由 U6 在工具前后与 turn 末调用 */
  assert(): void {
    const u = this.#usage;
    const L = this.limits;
    const contextOver = L.contextWindow !== undefined && u.tokensInput > L.contextWindow;
    const over =
      u.steps > L.maxSteps ||
      u.tokensInput > L.maxTokensInput ||
      u.tokensOutput > L.maxTokensOutput ||
      u.wallClockMs > L.wallClockMs ||
      (L.costUsd !== undefined && u.costUsd > L.costUsd) ||
      contextOver;
    if (over && this.#exceeded === null) {
      this.#exceeded = contextOver
        ? "contextWindow"
        : u.steps > L.maxSteps
          ? "steps"
          : u.tokensInput > L.maxTokensInput
            ? "tokensInput"
            : u.tokensOutput > L.maxTokensOutput
              ? "tokensOutput"
              : u.wallClockMs > L.wallClockMs
                ? "wallClockMs"
                : "costUsd";
    }
    if (this.#exceeded !== null) {
      throw new BWError("BUDGET_EXCEEDED", `budget exceeded: ${this.#exceeded}`, {
        detail: { dimension: this.#exceeded, usage: this.#usage },
      });
    }
  }
}

export interface PolicyEngine {
  /** S1①：显式 navigate 前检（含 S4/S5） */
  onNavigate(url: string): Promise<GateDecision>;
  /** S1②/S5：链接/提交意图前检（click/press 解析出的目标） */
  onNavigationIntent(intent: NavigationIntent, action: BrowserAction): Promise<GateDecision>;
  /** S1③：onNavigated 最终 URL 事后复检（违规 → 回滚决策） */
  onNavigationSettled(finalUrl: string): Promise<SettledVerdict>;
  /** S2：写闸（敏感词/提交意图） */
  onAction(action: BrowserAction, target?: ActionTarget, intent?: NavigationIntent): GateDecision;
  /** S3：凭据解析（绑定 origin；解析值进 redact 集） */
  resolveSecret(name: string, targetOrigin: string): Promise<string>;
  /** S6：出域前统一脱敏（含变体） */
  redact(text: string): string;
  budget: BudgetLedger;
  /** U6 调用：确认决议（approve 应用载荷；deny 无副作用） */
  resolveConfirmation(cid: string, approve: boolean): void;
  /** 测试/审计用：当前白名单 */
  allowedHosts(): readonly string[];
}

interface ConfirmRecord {
  kind: "origin" | "action";
  host?: string;
  /** action 类：批准后重发匹配此签名时一次性放行（U6 契约 P1-10/P1-4） */
  actionSignature?: string;
  cid: string;
}

/** 动作签名：kind + 参数规范化（决定「同一动作」的批准语义） */
function actionSignatureOf(action: BrowserAction): string {
  const { kind } = action;
  const parts: string[] = [kind];
  if ("index" in action && action.index !== undefined) parts.push(action.index);
  if ("text" in action && action.text !== undefined) parts.push(action.text);
  if ("secretName" in action && action.secretName !== undefined) parts.push(action.secretName);
  if ("value" in action && action.value !== undefined) parts.push(action.value);
  if ("url" in action && action.url !== undefined) parts.push(action.url);
  if ("key" in action && action.key !== undefined) parts.push(action.key);
  return parts.join("|");
}

/** reason 里只保留 URL 的 origin+path（query/fragment 可能含 secret） */
function stripQuery(url: string): string {
  const cut = url.split(/[?#]/)[0] ?? url;
  return cut.slice(0, 120);
}

/** S2 词面归一化：NFC + 剥离零宽字符与分隔符（B5 审查 P1-5——页面内容不可信） */
const WORD_STRIP_RE = /[\s\u200b-\u200d\u2060\ufeff\u2028\u2029|\\/_+\x2d\u30fb\u2027\u00b7]/g;
function normalizeWordSurface(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(WORD_STRIP_RE, ""); // NFKC：全角折叠（B5 审查 P1-5）
}

export function createPolicyEngine(config: PolicyConfig, deps: PolicyDeps): PolicyEngine {
  const allowed = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
  const allowSecrets = new Set((config.allowSecretsHosts ?? []).map((h) => h.toLowerCase()));
  const words = config.sensitiveWords ?? DEFAULT_SENSITIVE_WORDS;
  const dnsCache = new Map<string, string[]>();
  const confirmations = new Map<string, ConfirmRecord>();
  const approvedActionSignatures = new Set<string>();
  /** S1③ 判过违规的主机：其挂起确认不再可批准（迟到批准防护，B5 审查 P2-7） */
  const violatedHosts = new Set<string>();
  /** S6 redact 集：secret 值及其变体 */
  const secretVariants: string[] = [];

  const registerSecretVariants = (value: string): void => {
    if (value.length < 4) return; // 太短的值误伤面大，不进子串替换
    const variants = new Set<string>([value]);
    try {
      const b64 = Buffer.from(value, "utf8").toString("base64");
      variants.add(b64);
      variants.add(b64.replaceAll("+", "-").replaceAll("/", "_")); // base64url（B5 审查 P1）
    } catch {}
    try {
      variants.add(encodeURIComponent(value));
    } catch {}
    if (value.length >= 6) {
      variants.add(
        Array.from(value as string, (ch) =>
          (ch as string).codePointAt(0)?.toString(16).padStart(2, "0"),
        ).join(""),
      ); // hex（B5 审查 P2）
    }
    for (const v of variants) secretVariants.push(v);
  };

  const dnsCheck = async (hostname: string): Promise<GateDecision | null> => {
    if (config.allowPrivateNetwork === true) return null;
    let ips = dnsCache.get(hostname);
    if (ips === undefined) {
      try {
        ips = await deps.dns.resolve(hostname);
        dnsCache.set(hostname, ips); // 仅缓存成功解析（失败不缓存——B5 审查 P2）
      } catch {
        ips = []; // 解析失败：无 IP 可查，按未命中处理（后续调用重查）
      }
    }
    for (const ip of ips) {
      const v4 = parseIPv4(ip);
      if (v4 !== null && isBlockedIPv4(v4)) {
        return { kind: "block", reason: `hostname ${hostname} resolves to private IP ${ip}` };
      }
      if (v4 === null && ip.includes(":") && isBlockedIPv6(ip)) {
        return { kind: "block", reason: `hostname ${hostname} resolves to blocked IPv6 ${ip}` };
      }
    }
    return null;
  };

  /**
   * S4 → S5 → S1（origin 三态）。S5 对一切导航 URL 无条件生效（B5 审查 P1-3：
   * 不能只挂在 allow 分支——confirm 场景用户必须看到外发风险，批准后重发同样受检）。
   * 一切带 URL 的动作（navigate / open_tab / 链接与提交意图）都必须过此检。
   */
  const guardUrl = async (url: string): Promise<GateDecision> => {
    const check = checkUrl(
      url,
      config.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {},
    );
    if (!check.ok) return { kind: "block", reason: check.reason };
    if (check.needsDns) {
      const dnsViolation = await dnsCheck(check.hostname);
      if (dnsViolation !== null) return dnsViolation;
    }
    const eg = egressViolation(url);
    if (eg !== null) return { kind: "block", reason: `egress blocked: ${eg}` };
    const host = check.hostname;
    if (hostAllowed(host, [...allowed])) return { kind: "allow" };
    const cid = deps.newCid();
    if (confirmations.size >= 256) {
      const oldest = confirmations.keys().next().value;
      if (oldest !== undefined) confirmations.delete(oldest);
    }
    const record: ConfirmRecord = { kind: "origin", host, cid };
    confirmations.set(cid, record);
    return {
      kind: "confirm",
      cid,
      reason: `navigation to new origin: ${host} (approves this host for any scheme/port)`,
    };
  };

  /** S5：外发敏感模式（query/fragment） */
  const egressViolation = (url: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    let surface = `${parsed.search} ${parsed.hash}`;
    try {
      surface += ` ${decodeURIComponent(surface)}`;
    } catch {
      surface += ` ${surface.replace(/%[0-9a-fA-F]{2}/g, (m) => String.fromCharCode(Number.parseInt(m.slice(1), 16)))}`;
    }
    if (surface.trim() === "") return null;
    // 阈值 24（01 §7 S5「≥24 位 token」）；点分隔形态（JWT 等）拆段后各段独立计长
    if (/[A-Za-z0-9_-]{24,}/.test(surface)) return "long token in query/fragment";
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(surface)) return "email in query/fragment";
    if (/(?:\+?86)?1[3-9]\d{9}/.test(surface)) return "phone number in query/fragment";
    const surfaceLower = surface.toLowerCase();
    for (const v of secretVariants) {
      if (v.length >= 4 && surfaceLower.includes(v.toLowerCase())) {
        return "known secret in query/fragment"; // 大小写不敏感（B5 审查 P2）
      }
    }
    return null;
  };

  return {
    budget: new BudgetLedger(config.budget),

    async onNavigate(url) {
      return guardUrl(url);
    },

    async onNavigationIntent(intent, _action) {
      if (intent.href === undefined) return { kind: "allow" };
      return guardUrl(intent.href);
    },

    async onNavigationSettled(finalUrl) {
      if (finalUrl === "about:blank") {
        return { ok: true, rollback: false }; // 自家回滚目标，不算违规（防回滚循环）
      }
      const check = checkUrl(
        finalUrl,
        config.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {},
      );
      if (!check.ok) return { ok: false, violation: check.reason, rollback: true };
      if (check.needsDns) {
        const dnsViolation = await dnsCheck(check.hostname);
        if (dnsViolation !== null && dnsViolation.kind === "block") {
          return { ok: false, violation: dnsViolation.reason, rollback: true };
        }
      }
      if (!hostAllowed(check.hostname, [...allowed])) {
        violatedHosts.add(check.hostname); // 迟到批准防护：记入违规集
        return {
          ok: false,
          violation: `settled on unapproved origin: ${check.hostname}`,
          rollback: true,
        };
      }
      return { ok: true, rollback: false };
    },

    onAction(action, target, intent) {
      const signature = actionSignatureOf(action);
      // 已批准的同签名动作：一次性放行后消费（U6「批准 → LLM 重发 → 放行」闭环）
      if (approvedActionSignatures.has(signature)) {
        approvedActionSignatures.delete(signature);
        return { kind: "allow" };
      }
      // 提交意图 → 写闸
      if (intent !== undefined && (intent.kind === "submit" || intent.kind === "enter_submit")) {
        const cid = deps.newCid();
        confirmations.set(cid, { kind: "action", cid, actionSignature: signature });
        return { kind: "confirm", cid, reason: "form submission" };
      }
      if (action.kind === "type_text_secret") {
        // origin 检查在 resolveSecret；这里只拦「同页已输过 secret 再输」无额外闸
        return { kind: "allow" };
      }
      // 归一化词面匹配（P1-5：零宽字符/分隔符不构成绕过）
      const surface = normalizeWordSurface(`${target?.text ?? ""} ${target?.href ?? ""}`);
      if (
        surface !== "" &&
        words.some((w) => {
          const nw = normalizeWordSurface(w);
          return nw !== "" && surface.includes(nw);
        })
      ) {
        const cid = deps.newCid();
        confirmations.set(cid, { kind: "action", cid, actionSignature: signature });
        return { kind: "confirm", cid, reason: `sensitive action: ${surface.slice(0, 60)}` };
      }
      return { kind: "allow" };
    },

    async resolveSecret(name, targetOrigin) {
      const originHost = hostOf(targetOrigin);
      if (originHost === "") {
        throw new BWError("POLICY_BLOCKED", "secret target origin invalid", {
          detail: { origin: targetOrigin },
        });
      }
      if (!hostAllowed(originHost, [...allowed])) {
        throw new BWError("POLICY_BLOCKED", `secret target origin not in allowlist: ${originHost}`);
      }
      if (!hostAllowed(originHost, [...allowSecrets])) {
        throw new BWError(
          "POLICY_BLOCKED",
          `secret not allowed on this origin (allowSecrets): ${originHost}`,
        );
      }
      let value: string;
      try {
        value = await deps.secrets.resolve(name);
      } catch (cause) {
        throw new BWError("SECRET_UNRESOLVED", `secret '${name}' unresolved`, { cause });
      }
      if (typeof value !== "string" || value === "") {
        throw new BWError("SECRET_UNRESOLVED", `secret '${name}' empty or invalid`);
      }
      registerSecretVariants(value);
      return value;
    },

    redact(text) {
      let out = text;
      // 长度降序：防前缀碰撞泄漏（A=alpha123、B=alpha12345 时先替换长者）
      const sorted = [...secretVariants].sort((a, b) => b.length - a.length);
      const forms = (v: string): string[] => {
        const list = [v];
        try {
          list.push(encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v)));
        } catch {
          /* 变体不可编码则跳过 */
        }
        return list;
      };
      for (const v of sorted) {
        for (const f of forms(v)) {
          if (out.includes(f)) out = out.split(f).join("***");
        }
      }
      // 大小写变体（原文形态，≥6 才做——过短误伤面大）：小写镜像定位后回替
      const lower = out.toLowerCase();
      for (const v of sorted) {
        if (v.length < 6) continue;
        const lv = v.toLowerCase();
        let idx = lower.indexOf(lv);
        while (idx !== -1) {
          out = `${out.slice(0, idx)}***${out.slice(idx + lv.length)}`;
          idx = lower.indexOf(lv, idx + 3);
        }
      }
      return out;
    },

    resolveConfirmation(cid, approve) {
      const record = confirmations.get(cid);
      if (record === undefined) return;
      confirmations.delete(cid);
      if (!approve) return;
      // 迟到批准防护：settled 已判违规的主机不许经挂起确认洗白（B5 审查 P2-7）
      if (record.kind === "origin" && record.host !== undefined) {
        if (violatedHosts.has(record.host)) return;
        allowed.add(record.host); // 会话级放行（host 粒度：任意 scheme/端口——确认文案已告知）
      }
      if (record.kind === "action" && record.actionSignature !== undefined) {
        approvedActionSignatures.add(record.actionSignature); // 一次性放行令牌
      }
    },

    allowedHosts: () => [...allowed],
  };
}

/**
 * 测试档（仅测试装配用，P1-14 处置）：fixture origin 预入白名单 + 内网放宽。
 * base 为**合并语义**（数组拼接）；allowPrivateNetwork 恒 true
 * （S4 对 fixture 127.0.0.1 必须放宽）——生产装配勿用本函数。
 */
export function testPolicyConfig(
  fixtureOrigins: string[],
  base?: Partial<PolicyConfig>,
): PolicyConfig {
  const fixtureHosts = fixtureOrigins.map((o) => hostOf(o));
  return {
    allowedHosts: [...(base?.allowedHosts ?? []), ...fixtureHosts],
    allowSecretsHosts: [...(base?.allowSecretsHosts ?? []), ...fixtureHosts],
    allowPrivateNetwork: true,
    ...(base?.sensitiveWords !== undefined ? { sensitiveWords: base.sensitiveWords } : {}),
    budget: base?.budget ?? {
      maxSteps: 100,
      maxTokensInput: 10_000_000,
      maxTokensOutput: 500_000,
      wallClockMs: 3_600_000,
    },
  };
}

export { hostOf, originOf };
