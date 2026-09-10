/** p4: webkit host 多 view 吞吐——4 view 并行 vs 单 view 串行（共享 host 是否串行化） */
import { result } from "./helpers/kit.ts";

async function bench(views: number, perView: number): Promise<number> {
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: views }, async () => {
      const v = new Bun.WebView();
      await v.navigate("about:blank");
      for (let i = 0; i < perView; i++) {
        await v.evaluate("1+1");
      }
      v.close();
    }),
  );
  return Date.now() - t0;
}

const serial = await bench(1, 40);
const parallel = await bench(4, 10);
result("p4.serialMs_1view_40evals", serial);
result("p4.parallelMs_4view_10evals_each", parallel);
result("p4.ratio_parallel_over_serial", Number((parallel / serial).toFixed(2)));
