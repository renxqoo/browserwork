# browserwork

> **bw** — a browser for LLM agents, built on Bun.WebView

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

A browser for LLMs. One-line goal → the agent looks at pages itself, makes decisions, and finishes the task; or hand the browser tools step-by-step to any external LLM.

```bash
bun i -g browserwork      # or npm i -g browserwork; one-off without installing: bunx browserwork

bw run "Summarize the three key points of the https://bun.com homepage"  # autonomous mode (one sentence, agent runs it to the end)
bw s create --url https://bun.com && bw s snap <id>                     # external session mode (REST/CLI for any LLM)
```

## Why

Benchmarked against playwright-mcp (same GLM driver, 5 real-site tasks) — **43% fewer tokens, 21% fewer steps, same completion rate**:

| Metric | bw | playwright-mcp |
|---|---|---|
| Completed / hit | 5/5 · 5/5 | 5/5 · 5/5 |
| Total steps | **11** | 14 |
| Total tokens | **60,206** | 104,802 |

Full methodology, raw data and limitations in **[BENCHMARKS.md](BENCHMARKS.md)** (with reproduction commands).

## Features

- **Zero browser download** (macOS): the driver layer is Bun's built-in `Bun.WebView` — the system WebKit; Linux uses the Chrome/CDP backend (downloads/uploads/network interception/httpOnly cookie metadata/UA override)
- **Token-lean perception**: indexed DOM snapshots (`[n] link "Docs" -> url`) + unchanged markers + progressive context compression + on-demand screenshots (only the latest one kept in context)
- **Code-level data extraction**: `extract_code` — the LLM writes a pure function that runs on a frozen copy of the DOM tree (Worker + vm sandbox); one call returns structured JSON, so reading lists/tables doesn't mean scanning snapshots row by row
- **Security built in** (S1–S6, enforced in code, not advice): hard blocks (private network / URL / IP / egress-secret detection), interactive confirmation gates in `bw s` sessions (auto-approved in non-interactive `bw run`), secrets bound to origin + full-chain redaction, four-dimension budgets (steps/tokens/wall-clock/cost)
- **Production readiness**: trajectories persisted and replayable (`bw replay`), automatic recovery from browser crashes (per-session file sessions + one helper per session), janitor cleanup; no daemon/port/token (B22)
- **Dual mode**: autonomous `bw run` (compact progress output) + external sessions `bw s` (CLI drives file sessions directly, for Claude Code/GPT/any framework to drive step-by-step); SDK exported by the root package `browserwork` (in-process secondary development); login-state snapshots `bw auth` (storageState model); batch `bw run --jobs N --file tasks.jsonl`

## Quick Start

Install (requires [Bun](https://bun.com) ≥ 1.4; macOS uses the system WebKit, no browser download; Linux needs Chrome):

```bash
bun i -g browserwork        # global install (or npm i -g browserwork); then use bw directly
bunx browserwork s list     # one-off without installing — replace bw with bunx browserwork below
```

Or from source:

```bash
bun install
bun run build        # → dist/cli/cli.js (single file, includes the pi coding-agent toolset)
export BW_API_KEY=xxx           # required for autonomous mode — see LLM Configuration below

bw run "Open https://example.com and report the page title"  # progress: ▸ [1/50] navigate … ↳ Example Domain
bw run "…" --verbose            # print the snapshot header each step
bw run "…" --json               # machine-readable

bw s create --url https://example.com    # external session mode (file sessions, no daemon)
bw s snap <sessionId>                    # indexed snapshot
bw s click <sessionId> 3                 # returns a new snapshot after the action
```

In-process integration via the SDK: `import { bw } from "browserwork"` (see the [usage doc](docs/04-usage.md)).

## LLM Configuration

Autonomous mode (`bw run`) requires an OpenAI-compatible API key. Resolution order, per key: process env → `./.env` → `~/.bw/.env`.

| Variable | Purpose | Default |
|---|---|---|
| `BW_API_KEY` | API key (required) | — |
| `BW_BASE_URL` | Any OpenAI-compatible endpoint | GLM official (`https://open.bigmodel.cn/api/paas/v4`) |
| `BW_MODEL` | Model id | `glm-5.3-flash` |
| `BW_STRONG_MODEL` | Strong model for stuck-task escalation (optional) | — |

```bash
# Any OpenAI-compatible provider works, e.g. DeepSeek:
export BW_BASE_URL=https://api.deepseek.com/v1
export BW_MODEL=deepseek-chat
export BW_API_KEY=sk-...
```

Or persist it: `echo 'BW_API_KEY=xxx' >> ~/.bw/.env`. Cost metering is off by default; enable with `BW_PRICES_JSON='{"deepseek-chat":{"input":0.27,"output":1.1}}'` (USD per 1M tokens). SDK callers can pass `runTask(req, { apiKey: "..." })` instead of env vars.

## Architecture

```
service ──→ agent ──→ policies ──→ core (types / contracts / error taxonomy)
   │           │         │
   │           ↓         ↓
   │        actions ──→ perception (indexed DOM snapshots)
   │           │           │
   │           └────→ driver ──→ Bun.WebView (webkit | chrome/CDP)
   └──→ trajectory/replay/janitor + one helper per session (unix socket)
```

Monorepo (bun workspaces, `@bw/*`): core → driver → perception → actions → policies → agent → service → eval. One-way dependencies, each layer testable on its own.

## Docs

| Doc | Contents |
|---|---|
| [docs/04-usage.md](docs/04-usage.md) | Usage (all commands / HTTP API / SDK / security model / env) |
| [BENCHMARKS.md](BENCHMARKS.md) | Benchmarks (methodology / data / reproduction / limitations) |
| [docs/01-baseline.md](docs/01-baseline.md) | Design baseline (goals / contracts / security baseline S1–S8 / concurrency budgets) |
| [docs/02-build-plan.md](docs/02-build-plan.md) | Build plan (batches / gates / test fixtures) |
| [docs/05-hardening-plan.md](docs/05-hardening-plan.md) | Hardening plan B12–B18 |
| [docs/hardening-closeout.md](docs/hardening-closeout.md) | B12–B17 closeout acceptance (with numbers) |
| [docs/probe-report.md](docs/probe-report.md) | Bun.WebView behavior probes (upstream limitations logged) |

## Development

```bash
bun run doors       # four gates: typecheck + lint(0-0) + build + test (per-file coverage gate ≥90)
bun test            # 568 cases (real webkit integration inside the gate; chrome contracts run when Chrome exists)
BW_REAL=1 bun scripts/eval-b16.ts    # real-site benchmark (consumes GLM quota)
bun scripts/stress.ts                # concurrency stress test
```

CI: GitHub Actions two-platform matrix (macOS=webkit+chrome; Ubuntu=chrome). Contribution workflow in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Renxqoo
