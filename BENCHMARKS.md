# Benchmarks

对打基准的**规范文档**：口径、环境、任务集、原始数据、复现命令、局限。所有数字如实（含输掉的项）；装置修正历史一并保留。

- 原始运行日志：[docs/eval-report-B16.md](docs/eval-report-B16.md)（真站对打）· [docs/eval-report-fixture.md](docs/eval-report-fixture.md)（fixture 回归基线）
- 评测装置源码：`packages/eval`（MCP stdio client + agent 循环 + 任务集）· `scripts/eval-b16.ts`（双端跑批）

---

## 1. 对打口径（Methodology）

| 项 | 口径 |
|---|---|
| 被测 A | **bw**（本仓库）——`runTask`，产品自带系统提示词（被测系统的一部分） |
| 被测 B | **playwright-mcp**（`bunx @playwright/mcp@latest --headless`）——最小通用提示词（其生态惯例） |
| 驱动模型 | 同一 GLM `glm-5.3-flash`（open.bigmodel.cn，OpenAI 兼容端点），同一 API key |
| 步数预算 | 各自 maxSteps×2 上限（bw 侧另有任务级 maxSteps） |
| 浏览器 | bw=macOS 系统 WebKit；playwright-mcp=自带 headless Chromium |
| 判定 | **锚点命中**：完整答案（非截断）小写化后包含任务预定义关键词之一。宽松口径——衡量「完成并给出答案」，非精确断言 |
| 采集 | steps=工具调用次数；tokens=提供商 usage 累计（prompt+completion，GLM 侧含 reasoning tokens）；墙钟不比（bw 侧未计，见局限） |
| 轮次 | 每任务 1 轮（小规模真跑；用户裁决 2026-09-11），不取中位 |

**提示词不对称披露**：bw 用调优过的产品提示词，playwright-mcp 用通用提示词。这是「两个产品栈整体对比」而非「工具面孤立对比」——数字代表各自开箱即用的端到端表现。若需工具面孤立对比需另设装置（待办）。

## 2. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-09-12（复跑·完整答案评级版） |
| OS | macOS（Darwin 25.5.0，Apple Silicon） |
| Bun | 1.4.2 |
| Chrome（pwmcp 侧） | 系统安装版（bunx 拉起 headless） |
| GLM 端点 | `https://open.bigmodel.cn/api/paas/v4` |
| 任务数 | 5（对打基准口径，保持不变）× 1 轮 × 2 端；任务集现 7 任务（B20 增 httpbin 表单 + changelog，对打复跑沿用 5 任务口径） |

## 3. 任务集

| id | 目标 | 起始页 | 锚点（任一命中） |
|---|---|---|---|
| bun-docs-3points | 总结首页宣传的三个要点 | bun.com | fast/bun/javascript/typescript/runtime |
| bun-github-stars | 报告 oven-sh/bun star 数量级 | github.com/oven-sh/bun | k/star |
| example-title | 报告页面标题与首段主旨 | example.com | example/domain |
| bun-blog-nav | 进博客列表报最新一篇标题 | bun.com/blog | bun/release/v1/v2/how |
| docs-webview-api | 找 WebView API 页报两种后端引擎 | bun.com/docs | webkit/chrome |

任务定义源码：`packages/eval/src/tasks.ts`。

## 4. 原始数据（真站对打 · 5 任务 × 1 轮）

| task | side | done | 锚点 | steps | tokens in | tokens out |
|---|---|---|---|---|---|---|
| bun-docs-3points | bw | ✅ | ✅ | 2 | 10,124 | 856 |
| bun-docs-3points | pwmcp | ✅ | ✅ | 2 | 16,104 | 644 |
| bun-github-stars | bw | ✅ | ✅ | 1 | 4,422 | 175 |
| bun-github-stars | pwmcp | ✅ | ✅ | 2 | 15,485 | 184 |
| example-title | bw | ✅ | ✅ | 1 | 327 | 341 |
| example-title | pwmcp | ✅ | ✅ | 2 | 12,939 | 228 |
| bun-blog-nav | bw | ✅ | ✅ | 2 | 14,698 | 5,280 |
| bun-blog-nav | pwmcp | ✅ | ✅ | 4 | 31,945 | 819 |
| docs-webview-api | bw | ✅ | ✅ | 5 | 22,728 | 1,255 |
| docs-webview-api | pwmcp | ✅ | ✅ | 4 | 26,072 | 382 |

### 汇总

| 指标 | bw | playwright-mcp | 差 |
|---|---|---|---|
| 完成率 | 5/5 | 5/5 | 持平 |
| 锚点命中 | 5/5 | 5/5 | 持平 |
| 总步数 | **11** | 14 | **-21.4%** |
| 总 tokens（in+out） | **60,206** | 104,802 | **-42.6%** |

## 5. fixture 回归基线（确定性 · 假 LLM）

B8 评测集：23 任务 × fixture 站 × 脚本化 LLM——**不是 token 效率数据**（假 LLM 固定 usage），是行为回归基线（成功率/步数不随重构漂移）。

| 指标 | 值 |
|---|---|
| 成功率 | 91.3%（21/23；2 项为 budget/abort 预期失败场景） |
| 平均步数 | 1.2 |
| 总墙钟 | ~28s |

跑法：`bun test packages/agent/test/eval.test.ts`（默认门内）；`BW_WRITE_REPORT=1` 重写 `docs/eval-report-fixture.md`。

## 6. 并发压测（会话模式）

`bun scripts/stress.ts [--sessions N] [--ops M] [--backend webkit|chrome]`（不进门禁）。

本机参考（macOS arm64 · webkit · 3 会话 × 4 操作）：

| 指标 | 值 |
|---|---|
| ops | 12 |
| 错误 | 0 |
| p50 / p95 | 503ms / 552ms |
| 墙钟 | 2,393ms |

## 7. 复现（真站对打）

```bash
# 前置：BW_API_KEY（消耗真实额度；5 任务×2 端约 16 万 token）
export BW_API_KEY=xxx
BW_REAL=1 bun scripts/eval-b16.ts --tasks 5 --runs 1     # 生成 docs/eval-report-B16.md
BW_REAL=1 bun scripts/eval-b16.ts --tasks 20 --runs 3    # 全量口径（20+ 任务 × 3 轮取中位——待跑）
```

## 8. 局限（如实）

1. **样本量小**：5 任务 × 1 轮——差异方向明确（-43% token）但幅度不宜外推；全量口径待跑（命令见上）。
2. **锚点评级宽松**：关键词命中 ≠ 语义正确；全量评测应升级为程序化 DOM 断言。
3. **提示词不对称**：见 §1 披露——端到端产品对比，非工具面孤立对比。
4. **墙钟未比**：bw 侧事件流消费未计时；pwmcp 含串行模型等待。后续补双端墙钟。
5. **装置修正历史**：首跑评级误用答案前 100 字截断（pwmcp 一项误判未中）——已修为全文评级并复跑，本文档即复跑数据；首跑结果废弃，修正记录见 eval-report-B16.md 头部。

## 9. B20 batch 生效观察（2026-09-12 · 本方侧）

| task | status | 锚点 | steps | in | out | batch 使用 |
|---|---|---|---|---|---|---|
| example-title | done | ✅ | 2 | 8,388 | 407 | 0 |
| httpbin-form-fill | done | ✅ | 9 | 56,255 | 1,674 | 0 |

**第一轮（弱指引：一句 prompt 提示）**：glm-5.3-flash 未自发使用 batch（batchUses=0）——表单任务 9 步 56K input 为「未用 batch 基线」。

**第二轮（强指引：Rule 1 加粗+完整调用示例+反例边界，工具描述收窄）**：batchUses=3，表单任务 input 56,255→**49,900（-11%）**，两任务完成率不变；探索任务（example-title）batchUses 仍 0——指引未造成滥用。

结论：模型采用新工具模式靠「具体触发条件 + few-shot 示例 + 反例」三件套，一句提示不够。复现：`BW_REAL=1 bun scripts/eval-b20.ts`。
