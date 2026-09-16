# browserwork

> **bw** — a browser for LLM agents, built on Bun.WebView

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

给 LLM 用的浏览器。一句话目标 → agent 自己看页面、做决策、跑完任务；或把浏览器工具按步交给任意外部 LLM。

```bash
bun i -g browserwork     # 或从源码：bun install && bun run build

bw run "总结 https://bun.com 首页三个要点"        # 自治模式（一句话，agent 自己跑完）
bw s create --url https://bun.com && bw s snap <id>  # 外部会话模式（REST/CLI 给任意 LLM 用）
```

## 为什么

对打 playwright-mcp（同一 GLM 驱动，真站 5 任务）——**token 少 43%、步数少 21%，完成率持平**：

| 指标 | bw | playwright-mcp |
|---|---|---|
| 完成/命中 | 5/5 · 5/5 | 5/5 · 5/5 |
| 总步数 | **11** | 14 |
| 总 tokens | **60,206** | 104,802 |

完整口径、原始数据与局限见 **[BENCHMARKS.md](BENCHMARKS.md)**（含复现命令）。

## 特性

- **零浏览器下载**（macOS）：驱动层是 Bun 内置 `Bun.WebView`——系统 WebKit；Linux 走 Chrome/CDP 后端（下载/上传/网络监听/httpOnly cookie 元数据/UA 覆写）
- **省 token 的感知层**：索引化 DOM 快照（`[n] link "Docs" -> url`）+ unchanged 标记 + 上下文渐进压缩 + 截图按需（只保最近 1 张在上下文内）
- **代码级数据提取**：`extract_code`——LLM 写纯函数跑在冻结 DOM 树副本上（Worker+vm 沙箱），一次调用返回结构化 JSON，读列表/表格不用逐行扫快照
- **安全内建**（S1–S6，代码级强制非建议）：origin 白名单三道闸、敏感词/提交确认门、URL/IP 封锁、secret 绑定 origin + 全链路脱敏、四维预算（步数/token/墙钟/费用）
- **生产可用性**：轨迹落盘可回放（`bw replay`）、浏览器崩溃自动恢复（会话级，文件会话 + 每会话 helper）、janitor 清理；无 daemon/端口/token（B22）
- **双模式**：自治 `bw run`（紧凑过程输出）+ 外部会话 `bw s`（CLI 直连文件会话，给 Claude Code/GPT/任意框架一步步驱动）；SDK 根包 `browserwork` 直接导出（进程内二次开发）；登录态快照 `bw auth`（storageState 模型）；批量 `bw run --jobs N --file tasks.jsonl`

## 快速开始

安装（需要 [Bun](https://bun.com) ≥ 1.4；macOS 用系统 WebKit 无需下载浏览器，Linux 需 Chrome）：

```bash
bun i -g browserwork     # 之后直接用 bw；临时执行用 bunx browserwork
```

或从源码：

```bash
bun install
bun run build        # → dist/cli/cli.js（单文件，含 pi coding agent 工具面）
export BW_API_KEY=xxx           # 自治模式需要——详见下方「LLM 配置」

bw run "打开 https://example.com 并报告页面标题"           # 过程：▸ [1/50] navigate … ↳ Example Domain
bw run "…" --verbose            # 每步打印快照头
bw run "…" --json               # 机器可读

bw s create --url https://example.com    # 外部会话模式（文件会话，无 daemon）
bw s snap <sessionId>                    # 索引化快照
bw s click <sessionId> 3                 # 动作后返回新快照
```

程序内集成走 SDK：`import { bw } from "browserwork"`（见[使用文档](docs/04-usage.md)）。

## LLM 配置

自治模式（`bw run`）需要 OpenAI 兼容的 API key。逐键优先级：进程 env → `./.env` → `~/.bw/.env`。

| 变量 | 用途 | 默认 |
|---|---|---|
| `BW_API_KEY` | API key（必填） | — |
| `BW_BASE_URL` | 任意 OpenAI 兼容端点 | GLM 官方（`https://open.bigmodel.cn/api/paas/v4`） |
| `BW_MODEL` | 模型 id | `glm-5.3-flash` |
| `BW_STRONG_MODEL` | 卡死升级用强模型（可选） | — |

```bash
# 任意 OpenAI 兼容服务商均可，例如 DeepSeek：
export BW_BASE_URL=https://api.deepseek.com/v1
export BW_MODEL=deepseek-chat
export BW_API_KEY=sk-...
```

或持久化：`echo 'BW_API_KEY=xxx' >> ~/.bw/.env`。费用计量默认关闭，需要时配 `BW_PRICES_JSON='{"deepseek-chat":{"input":0.27,"output":1.1}}'`（每 1M token 的 USD）。SDK 调用可不经环境变量，直接 `runTask(req, { apiKey: "..." })`。

## 架构

```
service ──→ agent ──→ policies ──→ core（类型/契约/错误分类法）
   │           │         │
   │           ↓         ↓
   │        actions ──→ perception（索引化 DOM 快照）
   │           │           │
   │           └────→ driver ──→ Bun.WebView（webkit | chrome/CDP）
   └──→ 轨迹/回放/janitor + 每会话 helper（unix socket）
```

monorepo（bun workspaces，`@bw/*`）：core → driver → perception → actions → policies → agent → service → eval。单向依赖，逐层可测。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/04-usage.md](docs/04-usage.md) | 使用文档（全命令/HTTP API/SDK/安全模型/env） |
| [BENCHMARKS.md](BENCHMARKS.md) | 对打基准（口径/数据/复现/局限） |
| [docs/01-baseline.md](docs/01-baseline.md) | 设计基线（目标/契约/安全基线 S1–S8/并发预算） |
| [docs/02-build-plan.md](docs/02-build-plan.md) | 施工图（批次/门禁/测试装置） |
| [docs/05-hardening-plan.md](docs/05-hardening-plan.md) | 硬化施工图 B12–B18 |
| [docs/hardening-closeout.md](docs/hardening-closeout.md) | B12–B17 收口验收（含数字） |
| [docs/probe-report.md](docs/probe-report.md) | Bun.WebView 行为探针实证（含上游限制登记） |

## 开发

```bash
bun run doors       # 四门：typecheck + lint(0-0) + build + test(含覆盖率门 ≥90 逐文件)
bun test            # 568 用例（真 webkit 集成在门内；chrome 契约在有 Chrome 时跑）
BW_REAL=1 bun scripts/eval-b16.ts    # 真站对打（消耗 GLM 额度）
bun scripts/stress.ts                # 并发压测
```

CI：GitHub Actions 双平台矩阵（macOS=webkit+chrome；Ubuntu=chrome）。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © Renxqoo
