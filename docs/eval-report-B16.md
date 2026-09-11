# B16 小规模真跑（2026-09-11 · glm-5.3-flash · 任务×5 轮×1）

> 口径披露：本方用产品自带系统提示词（被测系统的一部分）；playwright-mcp 侧用最小通用提示词（其生态惯例）。同一模型（glm-5.3-flash）、各自步数预算。锚点命中 = **完整答案**含任务期望关键词（宽松——衡量"完成并给出答案"，非精确断言）。
>
> 装置修正记录：首跑评级误用答案前 100 字截断（pwmcp 的 webview 任务答对但关键词在截断外，误判未中）——已修为全文评级并复跑，上表为复跑结果。任务×5 · 轮×1（用户裁决小规模；全量 20+ 任务×3 取中位留后续）。pwmcp 每任务独立 spawn（bunx 冷启动已含在墙钟外——token/steps 指标不受影响）。

| task | side | done | 锚点命中 | steps | in | out | error |
|---|---|---|---|---|---|---|---|
| bun-docs-3points | bw | ✅ | ✅ | 2 | 10124 | 856 |  |
| bun-docs-3points | pwmcp | ✅ | ✅ | 2 | 16104 | 644 |  |
| bun-github-stars | bw | ✅ | ✅ | 1 | 4422 | 175 |  |
| bun-github-stars | pwmcp | ✅ | ✅ | 2 | 15485 | 184 |  |
| example-title | bw | ✅ | ✅ | 1 | 327 | 341 |  |
| example-title | pwmcp | ✅ | ✅ | 2 | 12939 | 228 |  |
| bun-blog-nav | bw | ✅ | ✅ | 2 | 14698 | 5280 |  |
| bun-blog-nav | pwmcp | ✅ | ✅ | 4 | 31945 | 819 |  |
| docs-webview-api | bw | ✅ | ✅ | 5 | 22728 | 1255 |  |
| docs-webview-api | pwmcp | ✅ | ✅ | 4 | 26072 | 382 |  |

**bw**：done 5/5 · 锚点 5/5 · 总 steps 11 · tokens in/out 52299/7907

**pwmcp**：done 5/5 · 锚点 5/5 · 总 steps 14 · tokens in/out 102545/2257

## 答案摘录

- **bun-docs-3points/bw**: Bun 官网首页（bun.com）宣传的三个要点：

1. 快速（Fast）：Bun 是一个快速的 JavaScript 运行时 & 工具包，运行时替代 Node.js，可直接运行 JavaScrip
- **bun-docs-3points/pwmcp**: done
- 一体化工具箱（All-in-one）：Bun 是快速的 JavaScript/TypeScript 运行时（runtime，基于 JavaScriptCore，替代 Node.js），并
- **bun-github-stars/bw**: oven-sh/bun 仓库在 GitHub 上的 star 数约为 95.9k（即接近 10 万，数量级为 90k+，具体显示为 "Star 95.9k"）。
- **bun-github-stars/pwmcp**: done — oven-sh/bun 在 GitHub 上的 star 数量级为 **90k+**（页面显示精确数字：**95,944** stars，即约 95.9k）。
- **example-title/bw**: 起始页（example.com）已打开。页面标题为 "Example Domain"。第一段正文的主旨：该域名专门用于各类文档和示例场景，使用它无需事先获得许可；但应避免将其用于实际的运营/生产用途。
- **example-title/pwmcp**: done

- **页面标题**：Example Domain
- **第一段正文主旨**：该域名（example.com）专门用于文档和示例演示，使用时无需获得许可，但不应用于实际运营用途。

（原
- **bun-blog-nav/bw**: 从起始页通过导航栏的 Blog 链接进入博客后，文章列表中最新一篇（页面标记为 LATEST）的标题是：**Bun v1.4.2**（发布于 2026 年 9 月 5 日，Release 类文章；其下
- **bun-blog-nav/pwmcp**: 我已从起始页 https://bun.com/blog 找到博客链接并点击进入了文章列表中标记为 "Latest"（最新）的文章。

文章列表中最新的文章信息：
- **标题：Bun v1.4.2**
- **docs-webview-api/bw**: Bun 文档的 WebView API 页面（https://bun.com/docs/runtime/webview，Runtime › Process & System › WebView）说明 
- **docs-webview-api/pwmcp**: done

已找到 Bun 文档的 WebView API 页面（https://bun.com/docs/runtime/webview）。在 "Backends" 一节明确说明：**`Bun.We

