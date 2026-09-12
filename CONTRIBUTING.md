# Contributing

欢迎issue/PR。项目用「方案先行 + 四门验证 + 对抗审查」的开发流程（见下），PR 请顺着同样的纪律来。

## 开发环境

```bash
bun install          # Bun 1.4.2（packageManager 锁定；升级前先跑 probes/ 回归）
bun run doors        # 四门一条命令
```

- 平台：macOS 跑全量（webkit + chrome 双真视图）；Linux/CI 跑 chrome（webkit 用例 skipIf 显式跳过）
- 自治模式测试需要 `GLM_API_KEY`（真站评测 `BW_REAL=1` 是 opt-in，不进门禁）

## 四道门（每个 PR 必须全绿）

```bash
bun run typecheck    # tsc --noEmit，0 错误
bun run lint         # biome check，0 警告 0 错误（--write 可自动修）
bun run build        # bun build → dist/cli/cli.js
bun run test         # bun test + 覆盖率门（行/函数 ≥90 逐文件，见 scripts/coverage-gate.ts）
```

覆盖率纪律：**只许补测试，不许调阈值/加豁免换绿**。豁免清单在 `scripts/coverage-exemptions`（路径<TAB>理由<TAB>min=N），新增豁免会被审查挑战。

## 仓库结构

```
packages/
  core/        类型/契约/错误分类法（无依赖底座）
  driver/      Bun.WebView 双后端抽象 + Fake 替身 + 契约测试
  perception/  索引化 DOM 快照（提取脚本/渲染/深度定位）
  actions/     动作引擎（每 page 互斥/双轨分派/settle/下载/上传）
  policies/    S1–S6 策略引擎 + 预算账本（纯决策，注入依赖）
  agent/       pi-agent-core 封装：runTask/工具注册/压缩/GLM 装配
  service/     HTTP/SSE/CLI/daemon/supervisor/janitor/replay
  eval/        评测装置（MCP client + 对打 harness）
  testing/     测试装置（fixture server / withPage）
docs/          设计基线/施工图/审查记录/探针报告/收口报告
probes/        Bun.WebView 行为探针（升级 Bun 后回归用）
```

## 开发流程（中级以上改动）

1. **方案先行**：改契约/跨模块的 PR 附简短方案（契约形态/不处理清单/并发预算）——可放 PR 描述
2. **测试口径先行**：先想清楚「怎么算对」（词表封闭断言/表驱动矩阵/越权矩阵）
3. 小步提交（Conventional Commits，正文引用 docs/ 节号）
4. 安全面（policies/driver）与并发面（actions/sessions）的 PR 会被对抗式审查——假设代码有错地找漏洞

## 代码约定

- 错误一律 `throw BWError`（错误码词表在 `@bw/core`，封闭集合）
- Bun.WebView 行为不确定时：**先探针后接线**（`probes/` 加脚本，结论落 `docs/probe-report.md`）
- 禁 `git stash`/`reset --hard` 等不落盘操作；多任务并行用 worktree

## 报 issue

请附：版本（`bw --version`）、平台、复现命令、轨迹文件（`~/.bw/trajectories/<taskId>.jsonl`，secret 已脱敏）。
