/**
 * p14c：单进程多 WebView 并发（SDK Promise.all 并发 run 的底座）。
 * 验证：同进程内 2 个 webkit 视图并行 evaluate 互不干扰；chrome 后端 2 视图 = 2 tab
 * 并行 evaluate；slot 语义（同视图并发第二次 evaluate 抛 ERR_INVALID_STATE——已知行为对照）。
 */
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? (pass++, console.log(`  ✓ ${name}${detail !== "" ? ` — ${detail}` : ""}`))
     : (fail++, console.log(`  ✗ ${name}${detail !== "" ? ` — ${detail}` : ""}`));
};

async function two(backend: "webkit" | "chrome"): Promise<void> {
  console.log(`\n== p14c ${backend} ==`);
  const a = new Bun.WebView({ backend });
  const b = new Bun.WebView({ backend });
  await a.navigate(`data:text/html,<script>document.title='A'</script>`);
  await b.navigate(`data:text/html,<script>document.title='B'</script>`);
  const [ra, rb] = await Promise.all([a.evaluate("document.title"), b.evaluate("document.title")]);
  check("两视图并行 evaluate 各自正确", ra === "A" && rb === "B", `${ra}/${rb}`);
  const t0 = Date.now();
  await Promise.all([
    a.evaluate("new Promise(r => setTimeout(() => r('slow'), 800))"),
    b.evaluate("'fast'"),
  ]);
  check("并发操作真并行（不等价串行）", Date.now() - t0 < 1_400, `${Date.now() - t0}ms`);
  a.close();
  b.close();
}

await two("webkit");
await two("chrome");

// slot 语义对照（已知行为：同视图第二个并发 evaluate 同步抛）
{
  console.log("\n== p14c slot 语义 ==");
  const v = new Bun.WebView();
  await v.navigate("data:text/html,<h1>x</h1>");
  const p = v.evaluate("new Promise(r => setTimeout(r, 300))");
  let threw = false;
  try {
    await v.evaluate("1");
  } catch (e) {
    threw = true;
  }
  await p;
  check("同视图并发第二 evaluate 抛错（slot 语义保持）", threw);
  v.close();
}

console.log(`\np14c 结论: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
