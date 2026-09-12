# B22 设计基线（DESIGN）

> 状态：**定稿待审**（p14 探针 4/4 落定 + 双审计完成；待三件套齐后统一过独立文档审查）
> 迁移主题：会话与执行架构——HTTP 服务守护 → SDK + 文件会话 + 浏览器自持有
> 方法论：repo-migration-e2e-v2；本文定稿后少改，实现推翻设计时同一提交先改本文。

## 0. 北极星（用户裁决 2026-09-13）

做一个**优秀全能、高可用、高性能的、agent 使用的浏览器工具**。

- **全能**：SDK 全 API 面二次开发 + 上层 CLI 两模式（外部 agent / 内置 agent）
- **高可用**：bw 进程崩溃零损失（浏览器活着、状态在盘）；每会话独立故障域；无单点
- **高性能**：无 daemon 跳数；命令热路径 ~100ms 量级；快照注入 KB 级

## 1. 外部契约

### 1.1 形态总览【用户裁决：serve 整体删除；SDK 根包直接导出】

```
CLI（bw）
 ├─ bw run "goal" [--profile P] [--jobs N --file tasks.jsonl]   内置 agent 模式（进程内）
 ├─ bw s <cmd> …                                                 外部 agent 模式（文件会话直连）
 ├─ bw auth save <会话id> --as <name> / bw auth list / delete    登录态快照
 └─ bw replay <id>                                               轨迹回放
SDK（根包 browserwork 直接导出）
 ├─ bw.sessions.create({ url, name, backend, profile, … }) → Session
 ├─ bw.sessions.executeTool(id, tool, params) → ToolResult
 ├─ bw.sessions.list/close/rename/keep/gc …
 ├─ bw.profiles.save/list/delete
 └─ bw.run({ goal, startUrl, profile }) → TaskHandle{ events, result, abort, steer }
                                    （events 单消费者流——多订阅互抢，SDK 文档明示）
```

- 无 HTTP、无 TCP 端口、无 token；每会话 1 个 helper 进程（双后端同构，unix socket 0600，U10）
- 原 serve/REST/SSE/sup **全部删除**，无兼容层、无旧路径别名【用户裁决：直接删除，不留双轨】

### 1.2 文件系统契约（对外可见的布局，属公开契约的一部分）

```
~/.bw/
 ├─ session/<id>/                # 每会话自包含；rm -rf 即销毁
 │   ├─ session.json             # schemaVersion + 元数据（原子写 tmp+rename）
 │   ├─ lock                     # flock 串行同会话命令
 │   ├─ trajectory.jsonl         # 轨迹（现状延续）
 │   ├─ pending/<cid>.json       # 确认门队列（120s 惰性过期）
 │   └─ downloads/               # 每会话下载
 ├─ profiles/<name>.json         # 登录态快照（cookies+localStorage，0600）
 ├─ secrets                      # secret 声明 JSON（0600）：{ "<name>": {"source":"env","ref":"VAR"} | {"source":"literal","value":"…"} }
 │                               #   与策略层 SecretsConfig 同形；唯一明文来源（U4）
 ├─ tasks/<taskId>/downloads/    # bw run 任务下载（原 ~/.bw/downloads/<taskId> 迁此）
 └─ trajectories/                # bw run 任务轨迹（现状延续）
```

- session.json 字段：schemaVersion、id、name、backend、createdAt/lastActiveAt、
  keep、当前 URL、**lastAllowedUrl**（S1③ 回滚/恢复导航目标——与「当前 URL」不同义：
  违规跳转后当前 URL 是违规页）、快照缓存（lastRendered）、
  **navEventSeq**（已消费的 helper 导航事件序号——S1③ 跨命令检测用）、
  策略状态（mode/allowEval/allowPrivateNetwork/allowUploadDirs/allowedHosts/
  violatedHosts/budget.steps/recoveries[] 时间戳）、
  helper 端点（socket 路径 + pid + 进程组 id）、dataStore 目录、下载字节累计。
- **secret 明文永不在 session 目录落盘**【用户裁决：secret 无状态重解析】

### 1.3 行为契约

- **同会话并发**：flock 串行；第二持有者快速失败 `SESSION_BUSY`（不排队）。
- **跨会话并发**：零协调并行（各自浏览器进程 + 各自目录）。
- **确认门**：动作被闸 → 写 `pending/<cid>.json` 返回 cid；`bw s confirm <id> <cid> --yes`
  取锁执行并返回结果；120s 未确认 = 惰性拒绝（下次触接过期）。
- **浏览器崩溃/机器重启**：下次命令探测端点死 → 标记 → 恢复（重拉浏览器 + 导航回
  lastAllowedUrl；登录态视 backend/dataDir 尽力保留）。
- **S1③ 违规检测（跨命令模型）**：helper 常驻并记录导航事件环（url+ts，容量 100，
  不做判定——策略不进 driver 层）；每次命令触接时，executor 取 `navEventSeq` 之后
  的事件逐条对照 allowedHosts——违规即回滚导航 lastAllowedUrl + 记 violatedHosts +
  响应附 `[S1③] rolled back` 行。与旧常驻形态的差：**检测从即时退化为下次触接**
  （窗口=相邻命令间隔），行为变更显式登记迁移矩阵。
- **快照获取规则**：每条索引类命令开始时**现提取**一次 Snapshot（经 helper evaluate，
  与引擎页锁同量级 ~10-30ms）——S2 词面闸/索引查找/unchanged 判定全部用此快照；
  lastRendered 落盘做 unchanged 字符串比对（语义保持）；extract_text/look/wait 仍
  返回 null 快照（不刷 lastRendered，语义保持）。
- **事件时序**（bw run / SDK run）：终态事件保证最后且恰好一次；事件词表封闭（现状延续）。

### 1.4 消费方

1. **SDK 二次开发者**：进程内 import { bw } from "browserwork"——API 稳定性一级承诺
2. **外部 agent（Claude Code / 自研框架）**：shell 出 CLI 命令逐步驱动（bw skill 形态）
3. **内置 agent**：bw run 进程内 GLM 循环（现状延续）

## 2. 内部问题域

### 2.1 处理（逐动词）

- 会话：create / list / close / rename / keep / status / gc（惰性回收 + 显式清扫）
- 执行：executeTool（全工具面，含 batch / extract_code）+ 确认门（非阻塞：
  动作+完整上下文写入 `pending/<cid>.json` 同步返回 cid；120s 惰性过期；确认即执行）
- 会话事件流（events/SSE 环形缓冲）：**删除**（无消费方；确认 cid 由工具同步响应携带）
- 会话预算：**单维度 steps**（wallClock/tokens/cost 只属任务面）；恢复限次：会话级
  滑动窗 5min ≤1（进程级限次随常驻进程消亡）
- 浏览器生命周期：统一 helper（每会话 1 进程持 WebView；启动/就绪/健康探测/组清理/崩溃恢复）
- 登录态：profiles save / inject（storageState 快照模型）
- secret：按名解析 + origin 绑定 + 全链路脱敏（每命令从配置全量重建脱敏集合）
- 任务：run（进程内 agent 循环）/ 并发（多会话、多 run、--jobs 批量执行器）
- 持久化：轨迹落盘 + 回放；janitor（搭车式 + 显式 gc）
- 安全：S1–S6 全闸面（含 S4 内网门重新安家到 SDK 初始化 + create 参数）

### 2.2 明确不处理（每项写归属）

- **任务队列的跨机调度/分布式**：不处理——本地工具；归属将来的独立编排层（SDK 之上）
- **REST/SSE 远程消费**：不处理——已删除【用户裁决】；需要远程的消费方在 SDK 之上自建服务
- **共享浏览器的多会话复用**（一 Chrome 多 tab 供多会话）：不处理——每会话独立浏览器
  【用户裁决默认】；隔离是安全模型的一部分（S1 白名单每会话独立）
- **任务内登录回写 profile**：不处理自动回写——显式 `bw auth save` 才更新快照（可复现可审计）
- **NFS/网络盘上的会话目录**：不处理——本地盘假设（flock 语义）
- **MCP 协议**：不处理【用户裁决 2026-09-11 沿袭】——CLI/SDK 已够

## 3. 并发与性能预算（违反 = 缺陷）

- 命令热路径：CLI 进程 spawn + session.json 读 + attach（helper unix socket，双后端同构）
  + 动作 + 写回 ≤ 300ms（不含页面自身渲染等待）；attach 本身 ≤ 50ms
  （§0 的「~100ms 量级」是热路径理想值，此处 ≤300ms 是预算硬约束——违反即缺陷）
- session.json：单次原子写 ≤ 100KB（快照缓存计入；超限即缺陷）
- flock：同会话命令串行；锁等待不排队（立即失败）；锁必须带超时自动释放（进程死锁兜底：lockfile 内写 pid+时间戳，过期可夺锁）
- 无 TCP 监听于工具路径（chrome 走 pipe、helper 走 unix socket）——bw 全程零端口【用户裁决 U1 引申】
- 出域文本脱敏全工具面对齐（审计 B1：旧会话面仅 requests/cookies_all/extract_code 过 redact，console/errors/storage/extract_text/eval 裸奔——新实现以 agent 面全量 redact 为准）
- 每会话独立进程：一个会话崩溃不得影响其他会话（进程级隔离验证）
- 批量执行器 --jobs N：**每任务一个子进程**（bun cli.js run …），并发闸只管进程数——chrome 进程级单例（审计 B2）下这是每任务独立浏览器/profile 的唯一隔离形态；单机默认上限 8（可配 BW_MAX_JOBS）；失败汇总不中断批次
- SDK 单进程并发 run：webkit 后端 Promise.all 各持 driver（p14c 实证）；**chrome 后端每任务经专属 helper**（进程级单例约束，否则多任务共享一 Chrome 一 profile 违背 U7）；上限受内存约束

## 4. 关键技术分叉（已由 p14 探针 + 审计裁决定稿）

| 分叉 | 裁决 | 依据 |
| --- | --- | --- |
| 浏览器持有模型 | **统一 helper**：每会话 1 个 detached helper 进程 + 1 条 unix socket（0600）；webkit 持 WKWebView、chrome 持 Bun.WebView（Chrome 由 Bun 经 `--remote-debugging-pipe` spawn，**无 TCP 端口**）。双后端同构 | p14a 15/15（跨进程活 DOM 连续实证）；Bun API 无 re-attach 既有 tab 能力（每视图=createTarget 新 tab）+ Chrome 每 Bun 进程单例（审计 B2：同进程多会话共享一 Chrome 一 profile，违背 U7）——「bw 无常驻 + Chrome 自持有」不可行，helper 是唯一同时满足隔离与连续性的解 |
| 登录态持久 | **cookies（含 httpOnly）= 确定持久契约**（dataStore 跨进程实证）；localStorage 按尽力而为（chrome 落盘时机不定，p14b）——profile 快照走 evaluate 读取 + 自管 JSON，不依赖 dataStore flush | p14b |
| 同会话互斥 | **flock（bun:ffi + libSystem.B.dylib）**：非阻塞互斥 + SIGKILL 自动释放 | p14d 4/4 |
| helper 清理 | helper 以独立进程组 spawn（detached）；close = `kill(-pid, SIGKILL)` 整组带走（webkit host / chrome 子进程，p14a 实证 residual=0） | p14a |

探针副产品（实现注意）：Bun socket 的 data handler 必须在 connect/listen 选项里给（事后赋值不生效）；evaluate 表达式须为表达式（IIFE），语句序列是语法错；macOS O_CREAT=0x200。

## 5. 用户裁决总账（全部落档，实现不得偏离）

| # | 裁决 | 日期 |
| --- | --- | --- |
| U1 | serve/sup/daemon/HTTP API 全部删除，不留兼容层 | 2026-09-13 |
| U2 | 产品 = SDK（根包 browserwork 直接导出）+ CLI 两模式 | 2026-09-13 |
| U3 | 会话状态文件化（~/.bw/session/<id>/；目录式优先于 sqlite） | 2026-09-13 |
| U4 | secret 无状态重解析：配置是唯一明文来源，会话不产生新明文落盘 | 2026-09-13 |
| U5 | 登录态 = storageState 快照注入（对标 Playwright auth / Browserbase Contexts） | 2026-09-13 |
| U6 | 一步到位：单里程碑全量交付，无分期、无 TODO 代码、无 feature flag | 2026-09-13 |
| U7 | 每会话独立浏览器（不共享多 tab）；多会话/并发任务必须支持 | 2026-09-13 |
| U8 | macOS webkit 例外：每会话 helper 进程（unix socket，无端口无 token） | 2026-09-13 |
| U9 | worker 池/队列不在本期（--jobs 批量执行器已覆盖并发需求） | 2026-09-13 |
| U10 | 统一 helper 模型（探针裁决）：每会话 1 helper 进程，双后端同构；「Linux 零常驻」放弃（Bun 无 re-attach + 进程级 Chrome 单例使然），隔离与连续性优先 | 2026-09-13 |
| U11 | localStorage 持久 = 尽力而为（chrome 时机不定）；cookies 含 httpOnly = 确定契约；profile 快照不依赖 dataStore flush | 2026-09-13 |

> U6 与 skill「分阶段实施」的调和：阶段 = 内部质量门（四门 + 对抗审查 + 可独立
> revert 的提交序列），不是产品分期；中间不出可用的半成品状态。
