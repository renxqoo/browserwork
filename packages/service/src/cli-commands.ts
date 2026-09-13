/**
 * B22 S0：bw s 命令面纯映射层（CLI 名 → 工具规范名 + 位置参数 → JSON 参数 + usage 文案）。
 * 从 cli-session.ts 原样抽出（audit-service §4.4 规格的行为锚）——旧 HTTP 客户端与
 * S3 的 SessionStore 直连客户端共用；金测试锁定 drift。
 * S3 补齐：extract_code（code=join，可含空格）/ type-secret → type_text_secret。
 */
export const WIRE_NAMES: Record<string, string> = {
  scrollto: "scroll_to",
  clicktext: "click_text",
  "type-secret": "type_text_secret",
  "secret-type": "type_text_secret",
  opentab: "open_tab",
  switchtab: "switch_tab",
  closetab: "close_tab",
  extract: "extract_text",
  "cookies-set": "cookies_set",
  "cookies-clear": "cookies_clear",
  "storage-set": "storage_set",
  "storage-clear": "storage_clear",
  "cookies-all": "cookies_all",
};

export type MappedArgs = { params: Record<string, unknown>; hint: string } | { error: string };

export function mapToolArgs(tool: string, args: string[]): MappedArgs {
  switch (tool) {
    case "click":
    case "scroll_to":
      if (args.length < 1) return { error: `usage: bw s ${tool} <sessionId> <index>` };
      return { params: { index: args[0] }, hint: "" };
    case "type":
      if (args.length < 2) return { error: "usage: bw s type <sessionId> <index> <text>" };
      return { params: { index: args[0], text: args[1] }, hint: "" };
    case "navigate":
    case "open_tab":
      if (args.length < 1) return { error: `usage: bw s ${tool} <sessionId> <url>` };
      return { params: { url: args[0] }, hint: "" };
    case "press":
      if (args.length < 1) return { error: "usage: bw s press <sessionId> <key>" };
      return { params: { key: args[0] }, hint: "" };
    case "scroll":
      if (args.length < 1)
        return { error: "usage: bw s scroll <sessionId> <up|down|left|right> [amount]" };
      return {
        params: {
          direction: args[0],
          ...(args[1] !== undefined ? { amount: Number(args[1]) } : {}),
        },
        hint: "",
      };
    case "select":
      if (args.length < 2) return { error: "usage: bw s select <sessionId> <index> <value>" };
      return { params: { index: args[0], value: args[1] }, hint: "" };
    case "extract_text":
    case "look":
    case "close_tab":
    case "console":
    case "errors":
    case "tabs":
    case "cookies":
    case "cookies_all":
    case "requests":
    case "reload":
    case "storage_clear":
    case "cookies_clear": // S0 金测试发现的旧 CLI 潜伏 bug（B11 修 5 个漏配第 6 个：
      // 旧 switch 按原始名匹配，cookies-clear 无 case → 客户端直接 unknown；登记审计 B24
      return { params: {}, hint: "" };
    case "cookies_set":
    case "storage_set":
      if (args.length < 2) return { error: `usage: bw s ${tool} <sessionId> <key> <value>` };
      return { params: { key: args[0], value: args[1] }, hint: "" };
    case "storage":
      return { params: args.length >= 1 ? { key: args[0] } : {}, hint: "" };
    case "click_text":
      // 文本可含空格——整体 join；CLI 别名 clicktext
      if (args.length < 1) {
        return { error: "usage: bw s clicktext <sessionId> <text...>" };
      }
      return { params: { text: args.join(" ") }, hint: "" };
    case "eval":
      if (args.length < 1) {
        return { error: "usage: bw s eval <sessionId> <expression | --file path>" };
      }
      if (args[0] === "--file") {
        if (args[1] === undefined) return { error: "usage: bw s eval <sessionId> --file <path>" };
        return { params: { expressionFile: args[1] }, hint: "" };
      }
      return { params: { expression: args.join(" ") }, hint: "" };
    case "extract_code":
      // B21 文档超前、S3 补齐：code 表达式可含空格——整体 join
      if (args.length < 1) {
        return { error: "usage: bw s extract_code <sessionId> '<function expression>'" };
      }
      return { params: { code: args.join(" ") }, hint: "" };
    case "type_text_secret":
      if (args.length < 2) {
        return { error: "usage: bw s type-secret <sessionId> <index> <secretName>" };
      }
      return { params: { index: args[0], secretName: args[1] }, hint: "" };
    case "wait":
      if (args.length < 1) return { error: "usage: bw s wait <sessionId> <seconds> [networkIdle]" };
      return {
        params: {
          seconds: Number(args[0]),
          ...(args[1] === "networkIdle" ? { until: "networkIdle" } : {}),
        },
        hint: "",
      };
    case "resize":
      if (args.length < 2) return { error: "usage: bw s resize <sessionId> <width> <height>" };
      return { params: { width: Number(args[0]), height: Number(args[1]) }, hint: "" };
    case "download":
      if (args.length < 1) return { error: "usage: bw s download <sessionId> <index>" };
      return { params: { index: args[0] }, hint: "" };
    case "upload":
      if (args.length < 2)
        return { error: "usage: bw s upload <sessionId> <index> <file> [file...]" };
      return { params: { index: args[0], files: args.slice(1) }, hint: "" };
    case "batch":
      if (args.length < 1) return { error: "usage: bw s batch <sessionId> '<json steps array>'" };
      try {
        const steps = JSON.parse(args.join(" ")) as unknown;
        return { params: { steps }, hint: "" };
      } catch {
        return { error: "steps must be a JSON array of actions" };
      }
    case "switch_tab":
      if (args.length < 1) return { error: "usage: bw s switchtab <sessionId> <tabNumber>" };
      return { params: { tab: Number(args[0]) }, hint: "" };
    default:
      return { error: `unknown tool "${tool}" — run 'bw s --help' for list` };
  }
}

/** CLI 位置参数（去 sessionId）映射入口：wire 名归一 + 参数构造 */
export function mapCliCommand(
  cmd: string,
  argsAfterSession: string[],
): { tool: string; params: Record<string, unknown> } | { error: string } {
  const tool = WIRE_NAMES[cmd] ?? cmd;
  const mapped = mapToolArgs(tool, argsAfterSession);
  if ("error" in mapped) return { error: mapped.error };
  return { tool, params: mapped.params };
}
