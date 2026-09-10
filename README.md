# bun-webview / bw

生产级 Browser Use：基于 Bun.WebView 的浏览器自动化 agent。

```bash
bun install && bun run build
alias bw='bun dist/cli/cli.js'

bw run "总结 https://bun.com 首页三个要点"     # 自治模式（一句话，agent 自己跑完）
bw s create --url https://bun.com && bw s snap <id>   # 外部 agent 模式（工具级驱动）
```

- **双模式**：自治 agent（内部 GLM 循环）+ 外部会话工具（REST / CLI，给任意 LLM 用）
- **零依赖**：macOS 用系统 WebKit，无需下载浏览器
- **安全内建**：S1–S6（origin 白名单、敏感词确认门、IP 封锁、secret 脱敏、预算控制）
- **省 token**：索引化 DOM 快照 + 上下文压缩（50 步任务约 8K token）

文档：[使用文档](docs/04-usage.md) · [设计基线](docs/01-baseline.md) · [构建计划](docs/02-build-plan.md) · [单元契约](docs/03-units.md)

开发：`bun run typecheck && bun run lint && bun run test`（四门禁含覆盖率 ≥90%）
