/** p3: evaluate 大结果上限——字符串本体跨 IPC/JSON 往返的尺寸与耗时 */
import { result, withTimeout } from "./helpers/kit.ts";

const view = new Bun.WebView();
await view.navigate("about:blank");

for (const size of [100_000, 1_000_000, 4_000_000, 16_000_000]) {
  const t0 = Date.now();
  let outcome: string;
  try {
    // 返回字符串本体（不是 length）——逼真实跨 IPC + JSON 往返
    const returned = await withTimeout(
      view.evaluate<string>(`"x".repeat(${size})`),
      30_000,
      `eval ${size}`,
    );
    outcome = returned.length === size ? `ok(${returned.length})` : `MISMATCH(${returned.length})`;
  } catch (e) {
    outcome = `ERR: ${e instanceof Error ? e.message.slice(0, 90) : String(e)}`;
  }
  result(`p3.transfer_${size}`, { ms: Date.now() - t0, outcome });
}
view.close();
