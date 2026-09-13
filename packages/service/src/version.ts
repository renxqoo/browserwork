import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 版本从根 package.json 派生（治理缺口：手工双写曾漂移——audit §4.5-32）。
 * 读文件而非 import：路径跨 bun build 产物形态稳定 */
const pkgPath = join(import.meta.dir, "..", "..", "package.json");
let v = "0.0.0";
try {
  v = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
} catch {
  try {
    // 构建产物形态：dist/cli/cli.js 内联——退回 package.json 同级查找
    v =
      (
        JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
          version?: string;
        }
      ).version ?? "0.0.0";
  } catch {
    /* 保持 0.0.0 */
  }
}
export const VERSION: string = v;
