/**
 * 三后端契约套件注册：FakeDriver（全平台）/ webkit（darwin）/ chrome（已安装）。
 * 平台矩阵（03-units）：不可用项用 describe.skipIf 显式跳过（bun 输出 skip 计数），
 * 不静默降级；Chrome 探测覆盖 BUN_CHROME_PATH 与常见安装位（B2 审查 P1-4）。
 */
import { describe } from "bun:test";
import { existsSync } from "node:fs";
import { withFixtureServer } from "@bw/testing";
import { createWebViewDriver, FakeDriver, type FakePageOptions } from "../src/index.ts";
import { runPageContractSuite } from "./contract.ts";

const fakeOptions: FakePageOptions = {
  failUrls: ["fake://definitely-fails/"],
  evaluateHandler: (expr) => {
    if (expr === "1+1") return 2;
    if (expr === "2+2") return 4;
    if (expr.startsWith("throw")) throw new Error("page-side boom");
    return null;
  },
};

runPageContractSuite(
  "Fake",
  () =>
    new FakeDriver(
      {
        cdp: false,
        upload: false,
        download: false,
        dialogEvents: false,
        userAgentOverride: false,
        pierceClick: false,
      },
      fakeOptions,
    ),
  { real: false },
);

describe.skipIf(process.platform !== "darwin")("webkit 契约（fixture 站）", () => {
  runPageContractSuite("webkit", () => createWebViewDriver(), {
    real: true,
    withFixture: (fn) => withFixtureServer(fn),
  });
});

const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter((p): p is string => p !== undefined);

const chromeAvailable = CHROME_CANDIDATES.some((p) => existsSync(p));

describe.skipIf(!chromeAvailable)("chrome(url:false) 契约", () => {
  runPageContractSuite("chrome(url:false)", () => createWebViewDriver({ backend: "chrome" }), {
    real: true,
    withFixture: (fn) => withFixtureServer(fn),
  });
});
