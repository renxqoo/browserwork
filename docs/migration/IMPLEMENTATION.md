# B22 施工图（IMPLEMENTATION）

> 状态：定稿待审（审计证据：[audit-service.md](audit-service.md) / [audit-sessions-driver.md](audit-sessions-driver.md)；探针：docs/probe-report.md §p14）
> 顺序纪律：S0→S6 为**内部质量门序列**（每门四门绿 + 独立 revert），非产品分期（用户裁决 U6）——中间不出可用半成品，最终一次交付全量。

## 1. 审计结论引用

- service 面：B1-B23 / D1-D6 / G1-G14 / 行为规格 34 条（§四）/ 测试锚点处置（§五）
- sessions+driver 面：B1-B12 / D1-D7 / 记忆态落点表（§3）/ chrome 生命周期事实（§4）/ SessionManager 行为规格（§5）
- 探针：p14a 统一 helper 15/15 · p14b cookies 确定持久 · p14c 多视图并发 5/5 · p14d flock 4/4

## 2. 逐模块裁决表（旧文件）

| 旧文件 | 裁决 | 审计状态 | 动作 |
| --- | --- | --- | --- |
| service/src/server.ts | **不移植** | 已审计（B1/B2/B5/B6/B7/B21） | 删除；语义分流见 G1-G14 |
| service/src/daemon.ts | **不移植** | 已审计（B8-B12） | 删除；`~/.bw/serve.pid`/`serve.token` 遗留清扫进 S3 |
| service/src/supervisor.ts | **不移植** | 已审计（B13/B14/B15；G9 用户裁决） | 删除；B14 教训（停命令先停本体）无新对应物——无管理者进程 |
| service/src/shutdown.ts | **不移植**（serve 专用） | 已审计（B20） | 删除；bw run 信号语义新写（G4，cli-run 内） |
| service/src/sessions.ts | **重构** | 已审计（B1/B2/B5/B6/B8/B9/B11；§3 落点表全量） | 拆为 SessionStore（文件会话）+ 命令执行器（闸面/工具面语义按 §5 规格平移）；记忆态按 §3 落点表逐项归位。**旧文件删除归 S3 门**（grep 零残留清单含 sessions.ts） |
| service/src/cli.ts | **重构** | 已审计（B18/B19/D1/D6） | 删 serve/sup 分支；参数层换共享 parser（未知 flag exit 2）；+bw auth/gc 子命令 |
| service/src/cli-run.ts | **复制+微修** | 已审计（G4/B17/D6） | +信号处理（abort→等 finalize→按结果退出码）；driverOptionsFrom 共享；BW_HOME 统一 |
| service/src/cli-session.ts | **重写** | 已审计（B3/B16 + 错误码目录 §4.4-26；**全文件零测试**） | HTTP 客户端 → SessionStore 直连；§4.4 规格逐条等价（例外已裁决：B3 snap→NOT_FOUND、§4.4-25 确认流按 MIGRATION-core §4b 新语义直接写金测试——旧 202 分支是死码无从锚定） |
| service/src/janitor.ts | **复制+微修** | 已审计（B22） | 根聚合计量 + 活跃会话（lock 存在）豁免；锚点迁 session 目录；运行形态改搭车+显式 gc |
| service/src/replay.ts | **复制** | 已审计（B17） | 仅 BW_HOME 路径统一 |
| service/src/index.ts | **重写** | 已审计（§六 barrel 残留） | SDK barrel：`bw`（sessions/run/profiles）；根包 browserwork re-export |
| driver/src/backends.ts | **重构** | 已审计（§4 生命周期事实） | +helper 形态：`connectHelper(socket)` 返回 Page/Driver 远程代理；spawn 形态保留给 bw run 进程内用 |
| driver/src/page.ts | **复制+微修** | 已审计（B12/D6） | evaluate/cdp 可选 timeoutMs（引擎层 race 兜底亦可，二选一在 S1 定）；私有 serialize 提取 |
| driver/src/fake.ts | **复制** | 已审计（D6/D7） | 契约面不动；capabilities 常量改从 driver 导入（D7） |
| driver/src/index.ts | **复制+微修** | 已审计（依赖方向①） | FakeDriver/FakePage 移出生产入口 → `@bw/driver/testing` 子路径导出（S5 根包导出时不泄漏测试替身）；capabilities 常量转正导出（D7） |
| driver/test/contract.ts | **复制+微修** | 已审计（§5.1） | 契约套件保留三后端注册 + **新增 helper 远程代理第四行**（D4 探测表单源化） |
| agent/src/run.ts | **复制+微修** | 已审计（B4/B10/D3/D5） | onPageCreated 事件消灭 200ms 轮询与 `__bwSettledWired` 戳改；S1③ 共享 wiring（D3）；其余不动（§5.2：TaskHandle/事件时序契约不动） |
| agent/src/tools.ts + sessions buildAction | **重构** | 已审计（D1/B8） | 工具 schema 单源化到 @bw/core（`toolRegistry`）：TypeBox schema + 参数 builder + 校验，agent 注册与 SessionStore 共用 |
| packages/service/package.json | **复制+微修** | 已审计（B23） | 补齐 @bw/actions/@bw/driver/@bw/perception 声明；根包 browserwork 增加 SDK 导出面 |

**新建模块**（无旧对应物，全部登记进 §4 测试计划）：

| 新模块 | 职责（一动词一文件） |
| --- | --- |
| packages/core/src/toolRegistry.ts | 工具词汇表单源（schema+builder+校验）——D1 |
| packages/core/src/fsx.ts | resolveBwHome / writeSecureFileAtomic(0600+tmp+rename)——D2/D5 |
| packages/core/src/flock.ts | flock 非阻塞互斥（bun:ffi，p14d） |
| packages/driver/src/helper.ts | helper 进程端：持 WebView + unix socket RPC 服务 + 事件上行（onNavigated/CDP events 推送）+ 优雅退出（导航 away + close + exit） |
| packages/driver/src/helperClient.ts | RPC 客户端：socket 连接 + 请求/响应 + 事件订阅 → Page/Driver 远程代理实现 |
| packages/driver/src/helperSpawn.ts | detached spawn（独立进程组）+ 就绪等待 + 组清理（kill(-pid)）+ 活性探测 |
| packages/service/src/store.ts | SessionStore：session.json schema/原子写/flock 串行/惰性 TTL/僵尸清扫/恢复记账 |
| packages/service/src/executor.ts | 命令执行器：buildAction(单源)→闸面→engine→redact（全工具面，B1）→轨迹→预算→确认门 pending 文件 |
| packages/service/src/confirmations.ts | pending/<cid>.json 生命周期（写入/确认执行/120s 惰性过期/violatedHosts 合并账本——审计 §3.3-2） |
| packages/service/src/profiles.ts | storageState 快照 save（chrome CDP 全量 cookie / webkit 可见面 + localStorage）/ inject / list / delete |
| packages/service/src/secrets.ts | 无状态重解析：每命令从 env/~/.bw/.env 全量重建脱敏集（U4） |
| packages/service/src/batch.ts | --jobs N 批量执行器：**每任务一个子进程**（chrome 单例隔离，DESIGN §3）；tasks.jsonl 行 schema 见 MIGRATION-cli §4b；失败汇总不中断 |
| packages/service/src/sdk.ts | `bw` SDK 对象装配（sessions/run/profiles；S4 env 门在初始化读取） |

## 3. 审计裁决记录（挂账与缺口的显式裁决）

| 来源 | 裁决 |
| --- | --- |
| 审计-B7/B11（预算维度分裂） | session.json `budget:{steps}` 单维度；wallClock/tokens/cost 只属 agent 任务面（bw run），会话面不落字段 |
| 审计-B3（driver-dead 假阳性） | helper 模式下活性探测 = socket 连通性（天然消灭 evaluate 探针） |
| 审计-§3.1 末（events 流） | **删除**（G7）：无 SSE 消费方；确认 cid 由工具同步响应携带 |
| 审计-G11（maxSessions） | 保留软上限 16（可配 `BW_MAX_SESSIONS`）；超限 `SESSION_LIMIT`。**计数+建目录在 `~/.bw/session/.create.lock` 全局 flock 内**——否则重演旧 check-then-act 竞态（audit-service B2 类） |
| gc 分类法（P1-7 处置） | 会话四态：**live**（socket connect 通）→ 不动；**idle-live**（live 且 lastActiveAt>TTL 30min 且非 keep）→ 回收（kill 进程组 + rm 目录）；**browser-dead**（socket 断、目录在）→ 标记，下次命令恢复；**孤儿**（helper 进程在、会话目录已不存在）→ kill(-pgid) 清扫。janitor 豁免 = live（不是「有 lock」——lock 只在命令期间存在，P1-7 纠偏）；下载清理只针对非 live 会话 |
| 审计-G13/B3/B4（存在性） | get/snap/status 未知 id → `NOT_FOUND` exit 1；close 幂等成功（rm -rf 语义） |
| 审计-§3.3-1（策略档快照） | session.json `policy` 段：mode/allowEval/allowPrivateNetwork/allowUploadDirs/allowedHosts/violatedHosts——每命令重建 policy 必须以此为准 |
| 审计-§3.1（恢复限次） | 会话级滑动窗（5min 内 ≤1，`recoveries:[ts]` 落盘）；进程级限次随常驻进程消亡删除 |
| 审计-G2/B5（TaskHandle） | SDK 面 `TaskHandle{events, result, abort, steer}`；文档写明 events 单消费者约束 |
| 审计-G4/B21（信号语义） | bw run：SIGINT/SIGTERM → handle.abort() → **等 finalize（轨迹终态落盘）** → 按结果退出码；二次信号立即强退 130 |
| 审计-B18/B19/D1（参数层） | 共享 parser：未知 flag → exit 2；数值 flag 校验（NaN → usage 错误） |
| 审计-G8（serve 遗留） | 首次运行检测 `~/.bw/serve.pid`/`serve.token` → stderr 提示删除（不自动删用户文件）；sup 数据目录同 |
| 审计-B22（janitor） | 聚合计量（跨子目录总量 512MB 默认）+ 有 lock 的会话目录豁免 |
| 审计-B1（redact 面） | executor 出域与落盘同一条 redact 路径（全工具面）；回归用例：console 回显 secret |
| helper 生命周期 | 粘性（无 idle 自杀）；活性 = socket connect + pid kill-0；死 → 会话标 `browser-dead` → 下次命令恢复（重拉 helper + dataStore 沿用 + 导航 lastAllowedUrl） |
| S4 env 名 | `BW_ALLOW_PRIVATE_NETWORK` 保留（SDK 初始化读取，语义不变）；`BW_ALLOW_DRIVER_PATHS` 同 |
| 错误码目录 | 新增 `SESSION_BUSY`/`SESSION_LIMIT`/`BROWSER_DEAD`（可恢复）；退役 `SERVER_NOT_RUNNING`；其余透传码与 hint 逐字保留（audit §4.4-26） |

## 4. 测试计划

- **旧测试 = 规格**（audit-service §五已逐文件处置）：保留面（sessions 语义 / b14 工具闸 / b18 渲染 / b20 batch）**断言原样搬运**；核销面（HTTP/daemon/sup）显式列出删除理由；**cli-session.ts 零测试空窗**——S0 先按 audit §4.4 34 条补金测试（输出 JSON 形态/错误码目录/wire 名映射/确认流 exit 0/未知 id NOT_FOUND）再动刀。
- **每个真 bug 一个回归用例**：随迁移修的 B1（redact 全面）、B3（NOT_FOUND）、B5（确认不重复 emit→文件化语义）、B6（TTL 惰性）、B8（空 batch 拒绝，toolRegistry 单源测试）、B16（help 零副作用）、B17（BW_HOME 一致）、B18/B19（参数层）、B20（退出码）、B22（janitor 聚合）、B23（依赖声明=build 验证）、B4/B10（onPageCreated 后 S1③ 无窗）、审计-B2（每会话独立浏览器=集成断言）。
- **必测清单**：契约级——helper RPC 第四行契约套件、toolRegistry 词表封闭性（core/actions 两处 action 联合穷举）、session.json schemaVersion 演进拒绝；边界——flock 竞态/SIGKILL 锁自释放/僵尸清扫/机器重启模拟（socket 文件在 pid 死）/100KB 落盘上限/确认 120s 惰性过期/批量失败汇总；表驱动——错误码目录、CLI 参数矩阵。
- 覆盖率门 ≥90% 沿用；只许补测试不许放水。

## 5. 实施顺序（质量门序列）

| 门 | 内容 | 验收点 |
| --- | --- | --- |
| S0 前置 | toolRegistry 单源（D1）；fsx/flock（D2/D5/D7）；cli-session 金测试补齐（按 audit §4.4 直写**新行为**预期——§4.4-25 确认流与 B3 snap 是死码/缺陷，无从对旧实现锚定，按 MIGRATION-core §4b/§4c 新语义写）；BW_HOME 三分叉修复（B17 随 fsx 落地） | 四门绿；新旧工具面校验漂移用例（空 batch）过 |
| S1 helper 层 | helper.ts/helperClient/helperSpawn + RPC 协议 + 事件上行；contract 套件第四行 | 契约套件 4/4 后端绿；p14a 断言搬进 driver 测试 |
| S2 会话核心 | store/executor/confirmations/secrets（无状态）；记忆态按落点表归位；redact 全面对齐（B1）；确认门按 MIGRATION-core §4b/§4c；S1③/快照按 §4d | sessions.test 语义断言在新 Store 上绿（「原样」类逐字等价；「改写」类引用 MIGRATION-core §1 裁决节号）；B1 回归用例绿 |
| S3 CLI+删除 | cli-session 重写直连；cli.ts 删 serve/sup + auth/gc；cli-run 信号（G4）；janitor/batch 改造；serve/sup/daemon/shutdown/server 删净 + 遗留清扫提示；b17/security/HTTP 测试核销 | audit §4.4 34 条规格逐条等价（例外：B3/§4.4-25 已裁决改写）；旧文件 grep 零残留（server/daemon/supervisor/shutdown/**sessions.ts**/server 相关测试） |
| S4 profiles+jobs | profiles save/inject（chrome CDP / webkit 可见面——U11 标注）；--jobs 批量执行器 | 登录态注入 e2e；并发 3 会话隔离断言（p14c 语义） |
| S5 SDK+文档 | sdk.ts 装配 + 根包 browserwork 导出（Fake 出口隔离见 driver/index 行）；04-usage/README/skill/eval 脚本迁移；BENCHMARKS 口径核对；版本治理（version.ts 由 package.json 派生，消灭手工同步 audit §4.5-32）；**run 任务下载迁 ~/.bw/tasks/<id>/downloads**（actions/engine.ts:396 缺省经 fsx，D2 收口；janitor 加锚点） | SDK 冒烟（bun -e import 即用）；文档与代码零偏差抽查 |
| S6 e2e+核销 | 隔离装置（临时 BW_HOME）+ 双形态进程冒烟（源码/构建产物）+ 对抗审查（行为等价第二裁判）+ 假绿抽查 + 验收清单 | 收口核销十项全过（skill §10） |

每门结束：四门 + 本门对抗审查（独立 subagent：diff + 旧实现片段 + 规格基线）+ 独立提交可 revert；实现中发现文档有误 → 同一提交先改文档。
