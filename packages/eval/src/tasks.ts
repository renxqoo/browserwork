/**
 * 对打任务集（B16）：真实公开站点，目标可程序化校验（成功率=答案含期望锚点）。
 * 小规模真跑（用户裁决 3-5 任务）；全量 20+ 留后续。
 */

export interface EvalTask {
  id: string;
  goal: string;
  startUrl: string;
  /** 答案必须包含（小写化比对）的锚点——任一命中即成功 */
  expectAny: string[];
  /** 建议步数上限 */
  maxSteps: number;
}

export const SMALL_TASKS: EvalTask[] = [
  {
    id: "bun-docs-3points",
    goal: "打开起始页，总结该页面宣传的三个要点，用 done 给出答案（每个要点一行，包含关键词）。",
    startUrl: "https://bun.com",
    expectAny: ["fast", "bun", "javascript", "typescript", "runtime"],
    maxSteps: 12,
  },
  {
    id: "bun-github-stars",
    goal: "找到并报告 bun 仓库（oven-sh/bun）在 GitHub 上的 star 数量级（如 '90k+' 或具体数字），用 done 给出答案。",
    startUrl: "https://github.com/oven-sh/bun",
    expectAny: ["k", "star"],
    maxSteps: 12,
  },
  {
    id: "example-title",
    goal: "打开起始页，报告页面标题与第一段正文的主旨，用 done 给出答案。",
    startUrl: "https://example.com",
    expectAny: ["example", "domain"],
    maxSteps: 8,
  },
  {
    id: "bun-blog-nav",
    goal: "在起始页找到指向博客/文章的链接并点击进入，然后报告文章列表中最新一篇的标题，用 done 给出答案。",
    startUrl: "https://bun.com/blog",
    expectAny: ["bun", "release", "v1", "v2", "how"],
    maxSteps: 12,
  },
  {
    id: "docs-webview-api",
    goal: "在 Bun 文档里找到 WebView API 页面（可从起始页导航或改 URL），报告 WebView 支持哪两种后端引擎，用 done 给出答案。",
    startUrl: "https://bun.com/docs",
    expectAny: ["webkit", "chrome"],
    maxSteps: 15,
  },
];

export function grade(task: EvalTask, answer: string): boolean {
  const a = answer.toLowerCase();
  return task.expectAny.some((anchor) => a.includes(anchor));
}
