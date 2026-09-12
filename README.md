# bw — a browser for LLM agents, built on Bun.WebView

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 社区项目，与 Oven（Bun 官方）无关联 · community project, not affiliated with Oven

给 LLM 用的浏览器。一句话目标 → agent 自己看页面、做决策、跑完任务；或把浏览器工具按步交给任意外部 LLM。

```bash
bun install && bun run build
alias bw='bun dist/cli/cli.js'

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
- **安全内建**（S1–S6，代码级强制非建议）：origin 白名单三道闸、敏感词/提交确认门、URL/IP 封锁、secret 绑定 origin + 全链路脱敏、四维预算（步数/token/墙钟/费用）
- **生产可用性**：轨迹落盘可回放（`bw replay`）、崩溃自动恢复（会话级）、`/healthz`、优雅退出、多实例 supervisor（`bw sup`）、janitor 清理
- **双模式**：自治 `bw run`（紧凑过程输出）+ 外部会话 `bw s`（REST/CLI，给 Claude Code/GPT/任意框架一步步驱动）

## 快速开始

```bash
bun install
bun run build        # → dist/cli/cli.js（单文件 ~2.5MB）
export GLM_API_KEY=xxx          # 自治模式需要（默认 glm-5.3-flash）

bw run "打开 https://example.com 并报告页面标题"           # 过程：▸ [1/50] navigate … ↳ Example Domain
bw run "…" --verbose            # 每步打印快照头
bw run "…" --json               # 机器可读

bw s create --url https://example.com    # 外部会话模式（自动拉起后台服务）
bw s snap <sessionId>                    # 索引化快照
bw s click <sessionId> 3                 # 动作后返回新快照
```

外部 LLM 框架可直连 REST（Bearer + `POST /sessions/:id/tools/<name>`），见[使用文档](docs/04-usage.md)。

## 架构

```
service ──→ agent ──→ policies ──→ core（类型/契约/错误分类法）
   │           │         │
   │           ↓         ↓
   │        actions ──→ perception（索引化 DOM 快照）
   │           │           │
   │           └────→ driver ──→ Bun.WebView（webkit | chrome/CDP）
   └──→ 轨迹/回放/janitor/supervisor
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
bun test            # 514 用例（真 webkit 集成在门内；chrome 契约在有 Chrome 时跑）
BW_REAL=1 bun scripts/eval-b16.ts    # 真站对打（消耗 GLM 额度）
bun scripts/stress.ts                # 并发压测
```

CI：GitHub Actions 双平台矩阵（macOS=webkit+chrome；Ubuntu=chrome）。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © wangrenren
