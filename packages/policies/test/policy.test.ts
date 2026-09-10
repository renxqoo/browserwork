/** U5 越权矩阵：注入样本 × 挂钩全维 × 绕过变体；S2/S3/S5/S6/预算/确认 */
import { describe, expect, test } from "bun:test";
import { type BrowserAction, BWError, type NavigationIntent } from "@bw/core";
import {
  createPolicyEngine,
  type DnsResolver,
  type GateDecision,
  type PolicyConfig,
  type PolicyDeps,
  testPolicyConfig,
} from "../src/index.ts";

const BUDGET = { maxSteps: 10, maxTokensInput: 1000, maxTokensOutput: 100, wallClockMs: 60_000 };

function makeDns(map: Record<string, string[]> = {}): DnsResolver {
  return {
    async resolve(hostname) {
      const hit = map[hostname];
      if (hit !== undefined) return hit;
      throw new Error(`no dns record for ${hostname}`);
    },
  };
}

interface MakeOpts {
  dnsMap?: Record<string, string[]>;
  secrets?: Record<string, string>;
  config?: Partial<PolicyConfig>;
}

function makeEngine({ dnsMap = {}, secrets = {}, config }: MakeOpts = {}) {
  let cidSeq = 0;
  const deps: PolicyDeps = {
    dns: makeDns(dnsMap),
    secrets: {
      async resolve(name) {
        const v = secrets[name];
        if (v === undefined) throw new Error(`secret not found: ${name}`);
        return v;
      },
    },
    newCid: () => `cid-${++cidSeq}`,
  };
  const fullConfig: PolicyConfig = {
    allowedHosts: ["trusted.test"],
    allowSecretsHosts: ["login.trusted.test"],
    budget: BUDGET,
    ...config,
  };
  return createPolicyEngine(fullConfig, deps);
}

const clickAction: BrowserAction = { kind: "click", index: "1" };

describe("越权矩阵：S1/S4 三挂钩 × 绕过变体", () => {
  // 每格：[url, 期望 kind]——跑三个挂钩（navigate/intent/settled）
  const matrix: Array<[string, "allow" | "confirm" | "block"]> = [
    ["https://trusted.test/", "allow"],
    ["https://a.trusted.test/x", "allow"], // 子域
    ["https://other.test/", "confirm"], // 新域 → 确认门
    ["https://trusted.com/", "confirm"], // 近名不同域
    ["file:///etc/passwd", "block"],
    ["http://localhost/", "block"],
    ["http://127.0.0.1/", "block"],
    ["http://2130706433/", "block"],
    ["http://0x7f.1/", "block"],
    ["http://0177.0.0.1/", "block"],
    ["http://169.254.169.254/", "block"],
    ["http://172.16.0.1/", "block"],
    ["http://10.0.0.1/", "block"],
    ["http://[::1]/", "block"],
    ["http://[::ffff:127.0.0.1]/", "block"],
    ["http://[fc00::1]/", "block"],
  ];

  for (const [url, expected] of matrix) {
    const settledExpect = expected === "confirm" ? false : expected === "allow";
    test(`onNavigate ${url} → ${expected}`, async () => {
      const engine = makeEngine();
      const d = await engine.onNavigate(url);
      expect(d.kind).toBe(expected);
    });
    test(`onNavigationIntent(link ${url}) → ${expected}`, async () => {
      const engine = makeEngine();
      const intent: NavigationIntent = { kind: "link", href: url };
      const d = await engine.onNavigationIntent(intent, clickAction);
      expect(d.kind).toBe(expected);
    });
    test(`onNavigationSettled(${url}) → ok=${settledExpect}`, async () => {
      const engine = makeEngine();
      const v = await engine.onNavigationSettled(url);
      expect(v.ok).toBe(settledExpect);
      if (!v.ok) expect(v.rollback).toBe(true);
    });
  }

  test("公网域名解析到内网 → block（resolver 替身）", async () => {
    const engine = makeEngine({ dnsMap: { "public-looking.test": ["203.0.113.9", "10.1.2.3"] } });
    const d = await engine.onNavigate("https://public-looking.test/");
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toContain("private IP");
  });

  test("公网域名解析正常 → confirm（新域）/ allow（白名单域）", async () => {
    const engine = makeEngine({ dnsMap: { "trusted.test": ["93.184.216.34"] } });
    expect((await engine.onNavigate("https://trusted.test/")).kind).toBe("allow");
    expect((await engine.onNavigate("https://fresh.test/")).kind).toBe("confirm");
  });

  test("S5：query 带长 token/邮箱/手机号 → block", async () => {
    const engine = makeEngine();
    const bad = [
      "https://trusted.test/track?t=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc",
      "https://trusted.test/c?email=user%40example.com",
      "https://trusted.test/s?phone=13812345678",
    ];
    for (const url of bad) {
      const d = await engine.onNavigate(url);
      expect(d.kind).toBe("block");
      if (d.kind === "block") expect(d.reason).toContain("egress");
    }
    expect((await engine.onNavigate("https://trusted.test/ok?q=hello")).kind).toBe("allow");
  });

  test("确认流：新域 confirm → approve 后同域 allow（会话级）；deny 后仍 confirm", async () => {
    const engine = makeEngine();
    const d1 = (await engine.onNavigate("https://new.test/")) as GateDecision & { cid?: string };
    expect(d1.kind).toBe("confirm");
    engine.resolveConfirmation("cid-999", true); // 未知 cid 无副作用
    engine.resolveConfirmation(d1.cid ?? "", true);
    expect((await engine.onNavigate("https://new.test/x")).kind).toBe("allow");
    expect((await engine.onNavigate("https://new.test/")).kind).toBe("allow");

    const d2 = (await engine.onNavigate("https://denied.test/")) as GateDecision & { cid?: string };
    engine.resolveConfirmation(d2.cid ?? "", false);
    expect((await engine.onNavigate("https://denied.test/")).kind).toBe("confirm");
  });
});

describe("S3 矩阵：secret 绑定 origin", () => {
  test("allowSecrets 域 → 解析成功", async () => {
    const engine = makeEngine({ secrets: { pw: "hunter2-secret" } });
    const v = await engine.resolveSecret("pw", "https://login.trusted.test/");
    expect(v).toBe("hunter2-secret");
  });

  test("白名单内但非 allowSecrets 域 → POLICY_BLOCKED", async () => {
    const engine = makeEngine({ secrets: { pw: "x" } });
    await expect(engine.resolveSecret("pw", "https://trusted.test/")).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
    });
  });

  test("白名单外域（含子域伪装）→ POLICY_BLOCKED", async () => {
    const engine = makeEngine({ secrets: { pw: "x" } });
    await expect(engine.resolveSecret("pw", "https://evil.test/")).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
    });
    await expect(
      engine.resolveSecret("pw", "https://login.trusted.test.evil.io/"),
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  });

  test("解析器失败 → SECRET_UNRESOLVED；空值同", async () => {
    const engine = makeEngine({ secrets: {} });
    await expect(
      engine.resolveSecret("missing", "https://login.trusted.test/"),
    ).rejects.toMatchObject({ code: "SECRET_UNRESOLVED" });
    const engine2 = makeEngine({ secrets: { empty: "" } });
    await expect(
      engine2.resolveSecret("empty", "https://login.trusted.test/"),
    ).rejects.toMatchObject({ code: "SECRET_UNRESOLVED" });
  });
});

describe("S2 矩阵：写闸", () => {
  test("submit 意图 → confirm", () => {
    const engine = makeEngine();
    const d = engine.onAction(
      clickAction,
      { text: "Submit query" },
      {
        kind: "submit",
        href: "https://trusted.test/submitted",
        method: "get",
      },
    );
    expect(d.kind).toBe("confirm");
  });

  test("enter_submit 意图 → confirm", () => {
    const engine = makeEngine();
    const d = engine.onAction({ kind: "press", key: "Enter" }, undefined, { kind: "enter_submit" });
    expect(d.kind).toBe("confirm");
  });

  test("敏感词按钮/链接 → confirm（默认词表）", () => {
    const engine = makeEngine();
    for (const target of [
      { text: "删除订单" },
      { text: "立即支付" },
      { text: "Withdraw funds" },
      { href: "https://trusted.test/checkout?x=1", text: "" },
    ]) {
      const d = engine.onAction(clickAction, target);
      expect(d.kind).toBe("confirm");
    }
  });

  test("普通点击/输入 → allow", () => {
    const engine = makeEngine();
    expect(engine.onAction(clickAction, { text: "Next page" }).kind).toBe("allow");
    expect(
      engine.onAction({ kind: "type", index: "2", text: "hello" }, { text: "search" }).kind,
    ).toBe("allow");
  });

  test("自定义词表覆盖默认", () => {
    const engine = makeEngine({ config: { sensitiveWords: ["危险按钮"], budget: BUDGET } });
    expect(engine.onAction(clickAction, { text: "立即支付" }).kind).toBe("allow");
    expect(engine.onAction(clickAction, { text: "危险按钮" }).kind).toBe("confirm");
  });
});

describe("S6 redact 变体", () => {
  test("原文/base64/URL 编码全部替换", async () => {
    const engine = makeEngine({ secrets: { pw: "hunter2-secret" } });
    await engine.resolveSecret("pw", "https://login.trusted.test/");
    const text = [
      "password was hunter2-secret",
      "b64: aHVudGVyMi1zZWNyZXQ=",
      "url: hunter2-secret",
      "encoded: hunter2-secret",
    ].join(" | ");
    const out = engine.redact(text);
    expect(out).not.toContain("hunter2-secret");
    expect(out).not.toContain("aHVudGVyMi1zZWNyZXQ=");
    expect((out.match(/\*\*\*/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(out).toContain("password was");
  });

  test("未注册 secret 的文本原样通过", () => {
    const engine = makeEngine();
    expect(engine.redact("nothing to redact")).toBe("nothing to redact");
  });
});

describe("预算矩阵（边界两侧）", () => {
  test("各维度：等于上限通过、超出抛 BUDGET_EXCEEDED 并锁存", () => {
    const engine = makeEngine();
    const b = engine.budget;
    b.consume("steps", 10);
    b.assert(); // == 上限，通过
    b.consume("steps", 1);
    expect(() => b.assert()).toThrow();
    try {
      b.assert();
      expect.unreachable();
    } catch (e) {
      expect(BWError.is(e)).toBe(true);
      expect((e as BWError).code).toBe("BUDGET_EXCEEDED");
      expect((e as BWError).detail).toMatchObject({ dimension: "steps" });
    }
    // 锁存后 consume 无效、assert 恒抛
    b.consume("tokensInput", 5);
    expect(() => b.assert()).toThrow();
  });

  test("tokens/costUsd 维度", () => {
    const engine = makeEngine({ config: { budget: { ...BUDGET, costUsd: 1 } } });
    const b = engine.budget;
    b.consume("costUsd", 0.5);
    b.assert();
    b.consume("costUsd", 0.6);
    expect(() => b.assert()).toThrow();
  });
});

describe("测试档配置", () => {
  test("testPolicyConfig：fixture origin 预入白名单 + secrets 放行 + 内网放宽", async () => {
    const config = testPolicyConfig(["http://127.0.0.1:12345"]);
    const engine = createPolicyEngine(config, {
      dns: makeDns(),
      secrets: { resolve: async () => "fixture-secret" },
      newCid: () => "c1",
    });
    expect((await engine.onNavigate("http://127.0.0.1:12345/index.html")).kind).toBe("allow");
    expect(await engine.resolveSecret("pw", "http://127.0.0.1:12345/")).toBe("fixture-secret");
  });
});

describe("B5 审查回归", () => {
  test("S5 token 阈值边界：23 位放行、24 位拦截（规格 ≥24）", async () => {
    const engine = makeEngine();
    expect((await engine.onNavigate(`https://trusted.test/?t=${"a".repeat(23)}`)).kind).toBe(
      "allow",
    );
    expect((await engine.onNavigate(`https://trusted.test/?t=${"a".repeat(24)}`)).kind).toBe(
      "block",
    );
  });

  test("S5 点分隔 token（JWT 形态）不再绕过", async () => {
    const engine = makeEngine();
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"S".repeat(30)}`;
    expect((await engine.onNavigate(`https://trusted.test/?t=${jwt}`)).kind).toBe("block");
  });

  test("S5 短 secret（4-7 字符）也拦截", async () => {
    const engine = makeEngine({ secrets: { pin: "hunter2" } });
    await engine.resolveSecret("pin", "https://login.trusted.test/");
    const d = await engine.onNavigate("https://trusted.test/log?pw=hunter2");
    expect(d.kind).toBe("block");
  });

  test("S5 在 confirm 路径同样生效（新域 + token → block 而非 confirm）", async () => {
    const engine = makeEngine();
    const d = await engine.onNavigate(`https://evil.test/cb?t=${"a".repeat(36)}`);
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toContain("egress");
  });

  test("action 确认闭环：approve 后同签名动作一次性放行，再发再确认", () => {
    const engine = makeEngine();
    const action: BrowserAction = { kind: "click", index: "9" };
    const d1 = engine.onAction(action, { text: "立即支付" });
    expect(d1.kind).toBe("confirm");
    if (d1.kind === "confirm") {
      engine.resolveConfirmation(d1.cid, true);
    }
    expect(engine.onAction(action, { text: "立即支付" }).kind).toBe("allow"); // 批准 → 放行
    expect(engine.onAction(action, { text: "立即支付" }).kind).toBe("confirm"); // 一次性消费
  });

  test("S2 零宽字符/分隔符/大小写不构成绕过", () => {
    const engine = makeEngine();
    for (const text of ["支\u200b付", "支-付", "支 付", "Ｐｕｒｃｈａｓｅ", "CHECKOUT"]) {
      expect(engine.onAction(clickAction, { text }).kind).toBe("confirm");
    }
  });

  test("S6 双重编码 / base64url / hex / 大写 secret 全部替换", async () => {
    const secret = "p@ssw0rd+99";
    const engine = makeEngine({ secrets: { pw: secret } });
    await engine.resolveSecret("pw", "https://login.trusted.test/");
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const b64url = b64.replaceAll("+", "-").replaceAll("/", "_");
    const hex = Array.from(secret, (ch) => ch.codePointAt(0)?.toString(16).padStart(2, "0")).join(
      "",
    );
    const doubled = encodeURIComponent(encodeURIComponent(secret));
    for (const form of [b64, b64url, hex, doubled, secret.toUpperCase()]) {
      const out = engine.redact(`leak: ${form}`);
      expect(out.includes(form)).toBe(false);
      expect(out).toContain("leak:");
    }
  });

  test("redact 前缀碰撞不泄漏长者尾巴", async () => {
    const engine = makeEngine({ secrets: { a: "alpha123", b: "alpha12345" } });
    await engine.resolveSecret("a", "https://login.trusted.test/");
    await engine.resolveSecret("b", "https://login.trusted.test/");
    const out = engine.redact("key=alpha12345");
    expect(out).not.toContain("alpha12345");
    expect(out).not.toMatch(/45/);
  });

  test("预算：NaN/负数忽略；contextWindow 触发；usage 是副本", () => {
    const engine = makeEngine({
      config: {
        budget: {
          maxSteps: 100,
          maxTokensInput: 1_000_000,
          maxTokensOutput: 100,
          wallClockMs: 60_000,
          contextWindow: 500,
        },
      },
    });
    const b = engine.budget;
    b.consume("tokensInput", Number.NaN);
    b.consume("tokensInput", -100);
    b.consume("tokensInput", 501);
    expect(b.usage.tokensInput).toBe(501);
    const snapshot = b.usage;
    b.consume("tokensInput", 1);
    expect(snapshot.tokensInput).toBe(501); // 副本不透传
    expect(() => b.assert()).toThrow();
    try {
      b.assert();
      expect.unreachable();
    } catch (e) {
      expect((e as BWError).detail).toMatchObject({ dimension: "contextWindow" });
    }
  });

  test("settled about:blank = ok（自家回滚目标不触发循环）", async () => {
    const engine = makeEngine();
    const v = await engine.onNavigationSettled("about:blank");
    expect(v.ok).toBe(true);
    expect(v.rollback).toBe(false);
  });

  test("DNS 失败不缓存：解析恢复后立即生效", async () => {
    let ips: string[] | null = null; // null = SERVFAIL
    let calls = 0;
    const deps: PolicyDeps = {
      dns: {
        resolve: async () => {
          calls += 1;
          if (ips === null) throw new Error("SERVFAIL");
          return ips;
        },
      },
      secrets: { resolve: async () => "s" },
      newCid: () => "c",
    };
    const engine = createPolicyEngine({ allowedHosts: ["trusted.test"], budget: BUDGET }, deps);
    expect((await engine.onNavigate("https://trusted.test/")).kind).toBe("allow"); // 失败当未命中
    ips = ["10.0.0.9"]; // 现在解析到内网
    const d = await engine.onNavigate("https://trusted.test/x");
    expect(d.kind).toBe("block");
    expect(calls).toBe(2); // 失败未被缓存
  });

  test("尾点主机 = 同站点；空标签主机拒绝", async () => {
    const engine = makeEngine();
    expect((await engine.onNavigate("https://trusted.test./x")).kind).toBe("allow");
    const v = await engine.onNavigationSettled("https://.trusted.test/x");
    expect(v.ok).toBe(false);
  });

  test("迟到批准防护：settled 判违规的主机不能经挂起确认洗白", async () => {
    const engine = makeEngine();
    const d = (await engine.onNavigate("https://evil.test/")) as GateDecision & { cid?: string };
    expect(d.kind).toBe("confirm");
    const v = await engine.onNavigationSettled("https://evil.test/"); // 页面自行跳转 → 违规回滚
    expect(v.ok).toBe(false);
    engine.resolveConfirmation(d.cid ?? "", true); // 迟到批准
    expect((await engine.onNavigate("https://evil.test/")).kind).toBe("confirm"); // 未洗白
  });

  test("block reason 不携带 query（secret 不经 reason 出域）", async () => {
    const engine = makeEngine();
    const d = (await engine.onNavigate("https://trusted.test:99999/?pw=super-secret-token-9")) as
      | { kind: "block"; reason: string }
      | { kind: "confirm" };
    expect(d.kind === "block" || d.kind === "confirm").toBe(true);
    if (d.kind === "block") {
      expect(d.reason).not.toContain("super-secret-token-9");
    }
  });

  test("testPolicyConfig 合并语义：base.allowedHosts 保留", async () => {
    const { testPolicyConfig } = await import("../src/index.ts");
    const config = testPolicyConfig(["http://127.0.0.1:1"], {
      allowedHosts: ["extra.test"],
    });
    expect(config.allowedHosts).toContain("extra.test");
    expect(config.allowedHosts).toContain("127.0.0.1");
  });
});
