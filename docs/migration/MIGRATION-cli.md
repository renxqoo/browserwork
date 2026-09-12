# 迁移文档：CLI 面 + 登录态/secret/批量 + 删除面

> 状态：定稿待审
> 迁移单元：CLI 两种模式的用户可见行为（bw s 39 命令 / bw run 过程输出与退出码 / bw auth·gc 新面）+ serve/sup/daemon 删除与职责安家
> 旧实现：cli-session.ts（449 行）/ cli-run.ts（230）/ cli.ts（222）/ server.ts+daemon.ts+supervisor.ts+shutdown.ts（1122，删除面）
> 目标位置：packages/service/src/{cli-session,cli-run,cli,janitor,batch,profiles}.ts + sdk.ts
> 关联：[DESIGN.md](DESIGN.md) §1.1 · [IMPLEMENTATION.md](IMPLEMENTATION.md) S3-S5 · [audit-service.md](audit-service.md)

## 1. 行为规格基线

**audit-service §四 34 条 = 判定标准**（bw run 12 / replay 4 / janitor 3 / bw s 21 / 顶层 3）。其中：
- bw s 面（§4.4，**旧实现零测试**）——S0 先补金测试再动刀（输出 JSON 形态/错误码目录/wire 名映射/确认流 exit 0/参数映射细节 23 条）
- bw run 面（§4.1）——b18 渲染器全套已有锚点，断言零漂移；新增信号语义（G4）与 `--profile/--jobs` 新 flag

显式删除（裁决出处标注）：`bw s stop`（U1）；`SERVER_NOT_RUNNING` 错误码（服务面）；help 中 Server auto-starts 段与 BW_SERVER_URL/BW_TOKEN 段（B16）；serve/sup 顶层命令（U1/U9）。
显式变更：`bw s snap <未知id>` ok+空串 → NOT_FOUND exit 1（B3/G13）；`bw s confirm` 回执 `{ok,sessionId,cid}` → **增 result/snapshot**（确认即执行，MIGRATION-core §4b——旧 §4.4-25 的 202 流是死码，无从等价，直接按新语义立规格）；`--allow-private-network` 的 serve 级 env 门 → SDK 初始化门（语义不变，形态变）；命令数 38（旧文 39 含 stop）。

## 4b. tasks.jsonl 行 schema（--jobs 公开契约）

```jsonl
{"goal":"查 bun.com 最新版本","startUrl":"https://bun.com","name":"bun-version","profile":"github","backend":"webkit"}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| goal | 是 | 任务目标（同 bw run 第一参） |
| startUrl / name / profile / backend / maxSteps | 否 | 同 bw run 同名 flag；name 用于汇总行与失败定位 |

非法行（缺 goal/JSON 解析失败）→ 记为该行任务失败（错误=行号+原因），批次继续；汇总逐行 `name|status|steps|tokens` + 失败清单；任一失败 exit 1（全成 exit 0）。

## 2. 审计结论引用

audit-service：B3/B4（存在性）B16（help 副作用）B17（BW_HOME）B18/B19（参数）B20（退出码）B22（janitor）B23（依赖）；D1（参数层）D2（安全写）D5（BW_HOME）D6（driverOptions）；G1-G14 缺口分流。

## 3. 逐模块裁决

见 [IMPLEMENTATION.md](IMPLEMENTATION.md) §2（cli-session 重写 / cli-run 复制+微修 / cli 重构 / janitor 复制+微修 / server·daemon·supervisor·shutdown 不移植）。

## 4. API 对照表（用户可见面）

| 旧 CLI | 新 CLI | 变化理由 |
| --- | --- | --- |
| `bw s <39 命令>`（HTTP→daemon） | 同命令面直连 SessionStore | 输出契约逐字等价（§4.4-20 单行 JSON/错误码与 hint 目录）；wire 名映射保留 |
| `bw s stop` | 删除（retire 文案：`no daemon in this version — sessions live in ~/.bw/session/`） | U1 |
| `bw serve / bw sup …` | 删除 | U1/U9 |
| `bw s create --allow-private-network` | 保留 flag；门在 SDK init（BW_ALLOW_PRIVATE_NETWORK） | S4 安家 |
| （无） | `bw s status <id>`：浏览器活性 + 状态机（live/browser-dead/pending 数）| DESIGN §2.1 |
| （无） | `bw s gc`：惰性回收显式入口（过期/僵尸/孤儿进程组清扫） | DESIGN §2.1 |
| （无） | `bw auth save <id> --as <n>` / `bw auth list` / `bw auth delete <n>` | U5 |
| （无） | `bw run --profile <n>` / `bw run --jobs N --file tasks.jsonl`（行 schema §4b；**每任务一个子进程**；汇总：per-task status/steps/tokens + 失败清单 exit 1） | U7 并发 + chrome 单例隔离（DESIGN §3） |
| `bw run`（无信号处理） | SIGINT/SIGTERM → abort → 等 finalize → 按结果退出码；二次信号 130 | G4/B21 |
| `bw s create/… --data-dir` | 保留（session 级 dataStore，U11 语义） | — |

## 5. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
| --- | --- | --- |
| cli.test.ts HTTP 面（鉴权/SSE/steer/429…） | 删除 | server.ts 删除面 |
| cli.test.ts runCliTask 缺 key exit 2 | cli-run.test | 移植 |
| b18.test.ts 渲染器全套 | b18.test（不动）+ cli-run.test 信号用例 | 保留 + 新增（abort→finalize→退出码；二次信号） |
| b13.test janitor/replay/信号/P1-3 env 门 | janitor.test/replay.test/cli-run.test | 移植（B22 聚合计量+活跃豁免新用例） |
| b17.test（sup 全矩阵） | 删除 | U9 核销 |
| security.test daemon 面 | 删除；0600/原子写断言 → fsx.test | 核销+移植 |
| coverage.test serve 冒烟/HTTP 部分 | 删除；parseArgs/退出码部分 → cli.test（新 parser：未知 flag exit 2/NaN 校验 B18/B19） | 核销+改写 |
| **新增** | cli-session.test（S0 金测试：§4.4 规格直写**新行为**预期——含 §4b 确认即执行/B3 NOT_FOUND）；profiles.test（save/inject/list/delete + U11 webkit 标注）；batch.test（--jobs 子进程并发/非法行容错/失败汇总/上限 8） | 零测试空窗补齐 + 新面 |

## 6. 回滚方案

每门独立提交；删除面（server/daemon/supervisor/shutdown + 对应测试）单独一笔提交，revert 即恢复旧形态；`~/.bw/serve.*` 遗留只提示不自动删（回滚零数据动作）。

## 7. 验收

- 四门 + 覆盖率 ≥90%；§4.4 34 条逐条勾（B3 一条例外改 NOT_FOUND，已裁决）
- 对抗审查：CLI diff 对照 §四规格找偏差（含 help 文本/退出码/hint 文案逐字）
- e2e：双形态（源码 bun packages/… 与 dist 构建产物）进程冒烟——`bw s create→click→close` 全链 + `bw run` 短任务 + Ctrl+C 落轨迹终态
- 文档：04-usage/README/skill（.claude/skills/bw）/eval 脚本与实现零偏差抽查

## 8. 实施记录

（每门收口追加）

## 9. S0 实施记录（2026-09-13）

交付：toolRegistry 单源（@bw/core；agent 16 mapper 委托 + sessions buildAction 委托，
B8 空 batch 拒绝落地，25 用例）· fsx（BW_HOME 单源——B17 修复：cli-run/cli/replay/
downloadsRoot 四点归一；0600 原子写+撕裂防护用例）· flock（node-fd + ffi-flock(int,int)
最小面——ffi 指针编组 open 在 bun test 下不稳定，S0 实测改道；SIGKILL 自释放用例）·
cli-commands 纯映射层抽出 + 13 金测试（wire 名/参数映射/usage 逐字锚）。

发现并修复：**B24**（`bw s cookies-clear` 客户端 unknown——旧 switch 按原始名匹配漏
第 6 个 wire 名；金测试首跑即抓到，已修 + 锚定）。

门禁：tsc ✓ biome 0 error ✓ build ✓ 579 tests 0 fail（1 skip 沿袭）。
 ffi 勾稽：p14d 探针的 ffi-open+closeSync 组合在 bun test 环境不稳定——生产探针
 结论不变（跨进程互斥/自释放），flock.ts 采用 node:fs fd + 纯整数 ffi flock。

