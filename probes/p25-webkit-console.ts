/**
 * p25：webkit 首屏 console 能力面探针（B25 遗留项——为什么 webkit 救不回首屏）。
 *
 * 实测结论（2026-09-26，Bun 1.4.2 macOS webkit 后端）：
 * - A. navigate 后不等事件立即 evaluate 装钩子：只能抓【装钩子之后】的消息
 *   （early-1 在装载前打印，永久丢失；late-1 可捕获）——onNavigated 在 load 后，
 *   没有任何「文档创建前」的回调可挂。
 * - B. onNavigated 触发时首屏脚本已跑完（typeof window.__firstRan === "number"）。
 * - C. WebView.cdp() 在 webkit 直接拒绝（requires backend: "chrome"）——
 *   无 Page.addScriptToEvaluateOnNewDocument 等价面。
 * - D. 构造器 html 项的 <script> 不执行（window.__ctorScriptRan undefined）。
 *
 * 推论：webkit 首屏 console 在 Bun.WebView 能力面内【无解】——不是 bw 不做，
 * 是平台没有钩子。能做的极限：导航后第一时间（extract/settle 之前）主动装钩子，
 * 把「首屏之后、首次 extract 之前」的消息救回来——这是 Fix C 已实现的
 * console/errors 动作先装后 drain 的语义边界。
 *
 * 附带发现：Bun 1.4.2 源码层解析 bug——顶层 await + 长字符串字面量组合会
 * SyntaxError（本文件用分段 evaluate 规避）；与 bw 无关，纯探针写作坑。
 */
const NAV =
  "data:text/html,<h1>t</h1><script>console.log('early-1'); setTimeout(function(){ console.log('late-1'); }, 300);</script>";

const w = new Bun.WebView({ width: 300, height: 300 });
await w.navigate(NAV);
await new Promise((r) => setTimeout(r, 60));
await w.evaluate(`window.__bwLog = []`);
await w.evaluate(
  `(function(){ var wrap = function(m){ var o = console[m].bind(console); console[m] = function(){ window.__bwLog.push(m + ":" + String(arguments[0])); o.apply(null, arguments); }; }; wrap("log"); wrap("warn"); })()`,
);
await new Promise((r) => setTimeout(r, 700));
const captured = await w.evaluate<string>(`JSON.stringify(window.__bwLog || [])`);
console.log("[p25] A 立即装钩子 captured:", captured, "（early-1 丢失 = 平台无文档创建前钩子）");
w.close();
process.exit(0);

export {}; // 顶层 await 需要 module 上下文（探针不入测试面）
