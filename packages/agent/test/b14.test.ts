/** B14：工具按能力注册矩阵 + upload 工具路径门（fake LLM 旅程） */
import { describe, expect, test } from "bun:test";
import type { DriverCapabilities } from "@bw/driver";
import { buildBrowserTools, type ToolContext } from "../src/tools.ts";

const WEBKIT_CAPS: DriverCapabilities = {
  cdp: false,
  upload: false,
  download: false,
  dialogEvents: false,
  userAgentOverride: false,
  pierceClick: false,
  httpOnlyCookies: false,
  networkEvents: false,
  webp: false,
  popups: false,
};
const CHROME_CAPS: DriverCapabilities = {
  ...WEBKIT_CAPS,
  cdp: true,
  upload: true,
  download: true,
  httpOnlyCookies: true,
  networkEvents: true,
  webp: true,
  popups: false, // 未实证——_blank 已标注
};

const stubCtx = (ctx: Partial<ToolContext> = {}): ToolContext => ({
  engine: { act: async () => ({ text: "", snapshot: null }) },
  policy: {
    onAction: () => ({ kind: "allow" }),
    onNavigate: async () => ({ kind: "allow" }),
    onNavigationIntent: async () => ({ kind: "allow" }),
    checkUploadFiles: () => ({ kind: "allow" }),
  } as unknown as ToolContext["policy"],
  hooks: {
    onEvent: () => {},
    awaitConfirmation: async () => true,
    onActionResult: () => {},
    beforeStep: () => {},
  },
  current: { snapshot: null, rendered: null },
  redact: (t: string) => t,
  ...ctx,
});

const names = (ctx: ToolContext, caps?: DriverCapabilities): string[] =>
  buildBrowserTools(ctx, caps).map((t) => t.name);

describe("B14 工具注册矩阵", () => {
  test("webkit：resize/reload 在；chrome-only 不在", () => {
    const got = names(stubCtx(), WEBKIT_CAPS);
    expect(got).toContain("resize");
    expect(got).toContain("reload");
    for (const n of ["download", "upload", "requests", "cookies_all"]) {
      expect(got).not.toContain(n);
    }
  });

  test("chrome：chrome-only 全注册；inspect 未注入则 requests/cookies_all 缺席", () => {
    const withoutInspect = names(stubCtx(), CHROME_CAPS);
    expect(withoutInspect).toContain("download");
    expect(withoutInspect).toContain("upload");
    expect(withoutInspect).not.toContain("requests"); // ctx.inspect 未接
    const withInspect = names(stubCtx({ inspect: async () => "[]" }), CHROME_CAPS);
    expect(withInspect).toContain("requests");
    expect(withInspect).toContain("cookies_all");
  });

  test("缺省 caps（未知驱动）：保守面——只有双端工具", () => {
    const got = names(stubCtx());
    expect(got).not.toContain("download");
    expect(got).toContain("resize");
  });
});

describe("B14 工具执行（覆盖 chrome-only 工具体）", () => {
  const tool = (name: string, ctx: ToolContext, caps: DriverCapabilities) =>
    buildBrowserTools(ctx, caps).find((t) => t.name === name) as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    };

  test("download/upload/requests/cookies_all execute 走引擎/inspect 通道", async () => {
    const acted: string[] = [];
    const ctx = stubCtx({
      engine: {
        act: async (action) => {
          acted.push(action.kind);
          return { text: `did ${action.kind}`, snapshot: null };
        },
      },
      inspect: async (kind) => `[${kind}]`,
    });
    const dl = tool("download", ctx, CHROME_CAPS);
    const r1 = await dl.execute("t1", { index: "5" });
    expect(r1.content[0]?.text).toContain("did download");

    // upload：路径门 allow（tmpdir 文件）→ 执行
    const { writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpFile = join(tmpdir(), "bw-agent-b14.txt");
    writeFileSync(tmpFile, "x");
    const up = tool("upload", ctx, CHROME_CAPS);
    const r2 = await up.execute("t2", { index: "6", files: [tmpFile] });
    expect(r2.content[0]?.text).toContain("did upload");

    // upload 空文件列表 → INVALID_TOOL_ARGS
    await expect(up.execute("t3", { index: "6", files: [] })).rejects.toThrow(/at least one file/);

    const req = tool("requests", ctx, CHROME_CAPS);
    const r3 = await req.execute("t4", {});
    expect(r3.content[0]?.text).toBe("[requests]");

    const ck = tool("cookies_all", ctx, CHROME_CAPS);
    const r4 = await ck.execute("t5", {});
    expect(r4.content[0]?.text).toBe("[cookies_all]");
    expect(acted).toEqual(["download", "upload"]);
  });
});
