/** 真 view 生命周期帮手（docs/03-units.md U8）：每用例独立 page、失败必回收。 */
import type { Driver, Page, PageOptions } from "@bw/driver";

export async function withDriverPage<T>(
  driver: Driver,
  opts: PageOptions | undefined,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await driver.createPage(opts);
  try {
    return await fn(page);
  } finally {
    page.close();
  }
}

/**
 * B1 最小等待：click 触发的导航是异步的，view.url 要等导航完成才更新
 * （平台事实，见 docs/probe-report.md）。轮询至 url 变化且不在加载中；
 * 超时返回当前 url 不抛错（同页锚点等场景合法）。B4 的 settle 会取代它。
 */
export async function waitForNavigation(
  page: Pick<Page, "url" | "loading">,
  timeoutMs = 5000,
): Promise<string> {
  const start = page.url;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.url !== start && !page.loading) return page.url;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return page.url;
}
