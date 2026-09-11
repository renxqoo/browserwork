# 硬化施工图（B12–B17）

> 状态：定稿（对抗审查处置后；处置记录见 `review-hardening-plan.md`）
> 基线见 `01-baseline.md`（本文件是其增补；对 01 的修改点在 §7 显式列出回改，其余不覆盖）
> 工作流：feature-dev-v2 大级（借件）· 每批：实现 → 四门 → 对抗审查（独立子 agent）→ 逐条处置 → 提交
> 背景：2026-09-11 全库差距核查发现「宣称与实现脱节 / CDP 轨道缺位 / 高可用未建 / 目标未获证明」四类缺口，本文件定义补齐方案。

## 0. 目标与非目标

**目标**：把已有宣称还成实物 + 补战略能力 + 建最小高可用 + 拿到评测数字。具体：

1. token 效率宣称全部接线（domHash 复用、截图压缩、窗口主动裁剪、strong 路由、costUsd 计量）
2. 服务可用性最小集（**生产档策略修正**、轨迹落盘/清理、健康检查、优雅退出、空闲退出真接线、崩溃恢复、会话限额语义）
3. 驱动构造选项全透传 + chrome 后端 CDP 轨道落地（cookie 元数据、下载、上传、网络监听、UA、resize、历史导航）
4. CI 平台矩阵 + Bun 版本锁 + 压测脚本
5. 评测装置（playwright-mcp 对打 + 真站 token 曲线）+ 小规模真跑落档
6. 最小 supervisor（进程级隔离）

**非目标（写清归属）**：

- **MCP 服务器接口不做**（用户裁决 2026-09-11：CLI/HTTP 入口已够用）——基线 §1 非目标项维持
- 反爬对抗/隐身（指纹伪装、验证码）维持非目标——UA 覆写是**受控测试能力**（非隐身手段；能力矩阵既有项），locale/timezone 覆写不做
- 网络请求**拦截/改写**不做（webkit 不可达；chrome 侧只做**监听**——requests 工具）
- **httpOnly cookie 值永不出域**（审查 P4 处置）：cookies_all 只回元数据（name/domain/path/flags），值掩码；全值导出连 opt-in 都不开，留待独立安全裁决
- 多租户**路由/计量/配额**不做——supervisor 只管进程生命周期，租户路由归宿主（文档化）
- agent 模式（bw run）的 host 崩溃**自动重试**不做——维持基线 §6.6 P2-2 裁决（fail fast = failed(DRIVER_ERROR)）；恢复只做会话模式（§7 回改 01 写明 carve-out）
- dialog 处理不做（webkit 不可观测；chrome 仅声明 dialogEvents，本批不消费）
- 自定义快照预算/渲染格式参数化不做（12K 单一口径维持）

## 1. 用户裁决（2026-09-11）

| # | 裁决 | 影响 |
|---|---|---|
| 1 | MCP 不实现 | B16 评测装置的「对打客户端」是评测自用的薄 MCP **client**，不是 server——不违背裁决 |
| 2 | 最小 supervisor 要做 | B17：spawn N × bw serve（独立 dataDir/端口/token）+ 监控重启；约数百行 |
| 3 | 评测装置 + 小规模真跑 | B16 真跑 3-5 任务 + 对打装置出数（几十万 token 内）；全量 20+ 任务对打留待后续 |

## 2. 外部契约变更（增量，词表封闭纪律不变）

### 2.1 错误码

- core `ERROR_CODES` **不动**（审查 P16：SESSION_LIMIT 是传输层语义，不进 LLM 错误分类法）。服务包内新增 `SessionLimitError`（普通 Error 子类），server 映射 429；顺带修 sessions.ts:326 现存误用 DRIVER_ERROR 表达触顶的 bug。
- chrome-only 工具在 webkit 会话被调 → 既有 `INVALID_TOOL_ARGS`（message 注明 requires chrome backend）。

### 2.2 BrowserAction 词表（core/actions.ts）

追加：`{kind:"resize"; width:number; height:number}` · `{kind:"go_back"}` · `{kind:"go_forward"}` · `{kind:"reload"}` · `{kind:"download"; index:string}` · `{kind:"upload"; index:string; files:string[]}`。全部走既有 beforeStep 预算/轨迹钩子。同步扩项清单（审查 P24）：`BROWSER_ACTION_KINDS` 封闭断言、engine `never` 穷举、actions 表驱动矩阵、driver 契约套件、sessions `buildAction` 表、cli-session 命令表、U4/U6 单元卡（§7 回改 03）。

### 2.3 InspectKind 词表（actions）

追加：`requests`（chrome 网络监听环形缓冲读取，最近 N 条；url 截断 500 字符标 truncated——审查 P20）· `cookies_all`（chrome CDP cookie **元数据**，值掩码；见 §3.7）。

### 2.4 Driver/Page 契约（driver/types.ts）

- `Page` 追加：`resize(w,h)` · `goBack()` · `goForward()` · `reload()` · `cdp(method, params): Promise<unknown>`（webkit 实现抛 DRIVER_ERROR）· `onCdpEvent(method, listener): () => void`
- `DriverCapabilities` 追加：`httpOnlyCookies` · `networkEvents` · `webp` · `popups`（默认全 false，chrome 按实测置位）
- `ScreenshotFormat` 追加 `"webp"`
- `CreateDriverOptions` 追加：`width/height`（默认 1280×720）· `dataStore?: string`（目录；webkit=每 view 同目录持久化，chrome=进程级首 view 生效，后续实例 dataDir 不符时发警告事件）· `chromePath?` · `argv?: string[]` · `stdout/stderr?: "inherit"|"ignore"` · `userAgent?: string`（仅 chrome；webkit 传入即抛——fail fast）

### 2.5 会话/任务请求面

- `POST /sessions` body 追加：`backend` · `dataDir` · `chromePath` · `width/height` · `userAgent` · `allowUploadDirs`（审查 P9）· `budget {maxSteps?, wallClockMs?}`；`bw s create` 对应 flag 同名
- `TaskRequest` 追加 `driver?: {backend?; dataDir?; width?; height?; chromePath?; userAgent?}`（runTask 在未注入 opts.driver 时消费）
- `TaskRequest.model`（既有字段）开始被消费：未注入 opts.models 时按 id（+env 端点）装配 fast/strong
- `bw run` 追加 flag：`--backend` `--data-dir` `--chrome-path` `--width` `--height`；env 追加 `GLM_STRONG_MODEL`、`BW_PRICES_JSON`
- `bw serve` 追加 flag：`--trajectory-dir`（默认 `~/.bw/trajectories`）
- 新 CLI：`bw replay <taskId|file>` · `bw sup start|status|stop`（B17）
- `GET /healthz`：仅 loopback 绑定时免 Bearer（非 loopback 返回 404——审查 P18）；返回 `{ok, version, uptimeMs, sessions, activeTasks}`
- `SessionToolResponse` 追加 `unchanged: boolean`（渲染文本未变标记；snapshot 照常全量返回，外部 agent 自行取舍）
- `TaskResult` 追加 `cost?: {usd: number}`（价目表已配时）

## 3. 设计要点与「不处理」边界

### 3.1 domHash 快照复用（B12）——审查 P0-1/P0-2 处置后

- **判定 = 渲染文本 diff，非白名单**：动作后新快照 `renderSnapshot(next)` 与上一次返回给 LLM 的渲染文本**逐字符相等** → unchanged 标记；任何 value/checked/滚动/标题变化都会改变渲染文本，天然覆盖 checkbox/JS toggle/输入回显（白名单法废除）。
- **agent 模式**：unchanged → 工具结果文本 = 动作行 + `[SNAPSHOT]\n(page unchanged since last step — render identical)`。**标记不计入 keep-2 计数**——keep-2 只数全量快照 toolResult（含 SNAPSHOT_MARKER 且带 `# Page:` 头），连续 N 步 unchanged 时最后一张全量快照永远在保留窗内。
- **会话模式**：响应加 `unchanged` 字段，快照文本照常返回（渲染缓存复用）。
- **不处理**：不做「跳过提取」（无页面外事件源；安全上不可信）。

### 3.2 截图与窗口治理（B12）——审查 P13/P23 处置后

- `compactSnapshots`：含 image content 的 toolResult 只保**最近 1 张**，更早的 image 项替换为文本 `[screenshot removed]`（文字描述保留）。
- 窗口估算（修正方向）：text 按内容 CJK 占比分档——CJK>30% 用 1.5 chars/token，否则 4 chars/token；image 按 **2000 token/张** 直计（不折 chars）；toolCall arguments 计入估算。估算和 > 0.5×contextWindow 时依次压缩：非快照 toolResult → 单行摘要；全量快照 2→1；旧 assistant/user **仅 text part** 首行截断（toolCall part 原样，结构不变断言入测试）。事后 contextWindow 断言保留为兜底而非主防线。已知取舍：阶段 2（快照 2→1）后 unchanged 标记链的锚点快照可能不在窗内（极端窗口压力；摘要行含页首行可部分还原）。
- `budget_warn` 补 contextWindow 维度（50%/80% 两档）。

### 3.3 strong 模型路由（B12）——审查 P17 处置后

- 装配：`GLM_STRONG_MODEL` env / `TaskRequest.model.strong` / `RunTaskOptions.models.strong` 三级。
- 机制（已实证，pi-agent-core 0.73.1 源码 + run.ts:219 既有结论）：loop config 在 run 启动时捕获 state.model，运行中赋值对当轮无效 → **abort + `agent.prompt("continue")`**（每次 prompt 重建 config，读到新 state.model）。
- 跨 Agent 边界状态迁移清单（逐项断言入测试）：`done.called` **不重置**（终局守卫持续）；`settledViolation` 定时器接线不变；预算账本/wallClock 同一实例连续（不经 Agent）；PendingConfirmation 不受影响（升级只发生在 onActionResult——工具完成后，此时无挂起确认）；stuckRing 清空重计。
- 升级后仍卡（新 ring 3 步同态）→ finalize failed("stuck after model escalation")。

### 3.4 costUsd（B12）

- `RunTaskOptions.prices?: Record<modelId, {input:number; output:number}>`（每 1M token USD）；缺省读 env `BW_PRICES_JSON`。
- message_end 后 `consume("costUsd", (in*pin+out*pout)/1e6)`；价目缺失且预算含 costUsd → 一次性 `budget_warn {dimension:"costUsd", usedPct:0}`（reason 说明停用）。
- **不硬编码任何模型价格**（价目波动，宁缺毋错）。

### 3.5 会话模式生产档策略（B13 首项——审查 P0-3 处置）

- 现状 bug：serve 生产路径 `sessions.ts` 缺省用 `testPolicyConfig`（allowPrivateNetwork:true）——S4 全开。
- 修复：`SessionManagerOptions.policyMode?: "production" | "test"`，**缺省 production**（S4 生效、内网封锁、确认门全开）；测试用例显式 `policyMode:"test"`。HTTP 层不暴露 policyMode（生产服务不可降档）。

### 3.6 服务生命周期（B13）——审查 P5/P12 处置后

- 轨迹：`RunTaskOptions.trajectory` / `SessionManagerOptions.trajectory` 扩为 `TrajectorySink | ((taskId) => TrajectorySink)` 工厂；serve 默认 `~/.bw/trajectories/<id>.jsonl`（`config.trajectoryDir` 死字段激活）。
- janitor：启动 + 每小时；**两个目录**——trajectories（`*.jsonl`，mtime>7 天删；总量>512MB 按最旧删）与 downloads（同策略）；单目录 O(n) 不递归。
- `bw replay`：只读打印（step/action/url/domHash/结果首行）。
- 空闲退出：`setupIdleExit(isIdle, {idleMs=60s, onExit})` 重签名；`BW_DAEMON=1` 时接线（死变量转正）。isIdle = 无会话 ∧ 无活动任务 ∧ 距最近 HTTP 请求 > idleMs。**supervisor 子进程不设 BW_DAEMON**（§3.10）。
- SIGTERM/SIGINT：serve 分支注册（server.stop + 轨迹 flush + PID 清理 + exit 0；二次信号强退）；createServer 本体不注册。
- 会话触顶：`SessionLimitError` → 429（§2.1）。
- **崩溃恢复（会话模式）**：executeTool 捕获 DRIVER_ERROR → 锁外探测（page.evaluate("1") 2s 超时）→ 死亡则重建 driver+engine、navigate(lastAllowedUrl)、重提取。**语义边界（文档化）**：恢复 = 单页化（tab 拓扑重置，响应 text 报告 "tabs reset to single page"）；挂起确认一律 deny；限次 = 会话级 5 分钟窗 ≤1 + **进程级** 5 分钟窗 ≤2；无 dataDir 登录态丢失如实注明；恢复失败 → 销毁会话 + DRIVER_ERROR。01 §6.6 回改写 carve-out（§7）。

### 3.7 CDP 轨道（B14）——审查 P4/P6/P7/P8/P9/P10/P11/P19 处置后

- **cookie 元数据**：`cookies_all`（chrome）= `Network.getCookies {urls:[page.url]}` → name/domain/path/expires/httpOnly/secure，**值一律 `***`**。redact 依赖为零（值不出域）。cookies 写/清仍走 document.cookie 语义（httpOnly 属性写不出，文档化）。
- **下载**：动作 = click 复合步复用（审查 P11：locate → intentSink → S2/S5 闸 → executeClick 全走 click 路径，仅追加下载等待）；`Browser.setDownloadBehavior(allow, downloadPath=~/.bw/downloads/<sessionId>, eventsEnabled)` **仅在该动作窗口内启用**，settle/超时后即恢复 default（审查 P7：S1③ 窗口期违规页不可触发下载）；`Page.downloadWillBegin/downloadProgress` 等待 completed；60s 超时 TIMEOUT。预算（审查 P8）：并发 ≤1/会话；单文件 >100MB 完成后删除并报错；会话累计 >1GB 拒绝新下载；文件名 sanitize（basename + `[A-Za-z0-9._-]` 白名单 + 冲突 `-1` 改名）；会话销毁/S1③ 违规回滚清空该会话 downloads 目录；janitor 兜底清理。
- **上传**：`Runtime.evaluate(returnByValue:false)` 拿 objectId → `DOM.setFileInputFiles`；**路径闸**：默认仅 `os.tmpdir()`；`allowUploadDirs` 可配（POST /sessions 面）；**realpath 双向解析**后前缀比较（防 symlink——macOS /var↔/private/var 同理）；越界 → S2 确认门；文件不存在 → INVALID_TOOL_ARGS。越权矩阵含 symlink 用例。
- **网络监听**：会话建立（chrome）时 `Network.enable` + requestWillBeSent/responseReceived/loadingFailed → 环形缓冲 200 条 `{url≤500字符, method, status?, type, ts, truncated}`；`requests` 工具读取。只监听不拦截。
- **UA**：仅 chrome；施加时点 = createPage 后先 navigate `about:blank`（建立 CDP 会话）→ `Emulation.setUserAgentOverride` → 再 navigate 目标（首个真实请求即带覆写 UA——审查 P19）。措辞：受控测试能力，非隐身手段。
- **resize**：复合步强制重提取返回新快照（审查 P10：缓存坐标全失效）。
- **历史导航**：go_back/go_forward/reload 包装 + 动作。引擎维护 `lastNavWasPost`（submit/enter_submit 意图置位，link/navigate 清位）；**reload/go_forward 在 lastNavWasPost 时过 S2 确认门**（防写重放——审查 P6）；go_back 由 S1③ 兜底。B14 探针实证 goBack/reload 后 onNavigated 触发（文档虽载明，chrome bfcache 行为须实证），不触发 → capability 降 false 并登记。
- **工具按 capabilities 动态注册**：`download/upload/requests/cookies_all`（chrome-only）；`resize/back/forward/reload`（双端）；webkit 不注册 chrome-only 工具。FakeDriver 扩展可编程 `cdp()` + CDP 事件注入（审查 P14：覆盖主来源），chrome 真视图用例 skip-if-无-chrome（本地/Ubuntu CI 有 chrome）。
- chrome dataStore 进程级限制：同进程第二个 chrome 会话 dataDir 不生效 → 运行时警告事件（不改行为；B17 supervisor 进程隔离是正解，文档化）。
- `_blank` 标注：提取脚本给 target=_blank link 打 `↗new-tab`；warnings 加计数提示。

### 3.8 CI 与版本锁（B15）

- `package.json` 加 `"packageManager": "bun@1.4.2"`；CI 同版本。
- workflow：matrix [macos-latest, ubuntu-latest] ×（setup-bun → install → `bun run doors`）；Ubuntu `BUN_CHROME_PATH=/usr/bin/google-chrome`（runner 预装）；macOS webkit 套件覆盖 page.ts，chrome 套件 skip-if-缺；webkit 项 Linux 按既有 skipIf 跳过。
- 压测：`scripts/stress.ts`——fixture 站 + N 并发会话 × M 操作，p50/p95/错误数；手动/CI 可选（不进门禁）。

### 3.9 评测装置（B16）——审查 P22 处置后

- 新包 `@bw/eval`：薄 MCP stdio client（initialize/tools/list/tools/call）+ **复用 pi-ai 基建**驱动 GLM（不自建第三套 LLM 客户端）+ 任务集 + 指标聚合（markdown 报告）。
- 对打：同一 GLM 同一预算；提示词口径落档披露——本方用产品自带 prompt（被测系统的一部分），playwright-mcp 侧用同任务文本的最小通用提示词；报告明示该差异（数字诚实性）。
- 默认门：假 LLM/假 MCP server 单测；real 门（`BW_REAL=1`）：真站 3-5 任务双跑 + 每步 token 曲线 → `docs/eval-report-B16.md`；README 宣称按实测改写。

### 3.10 最小 supervisor（B17）——审查 P5/P21 处置后

- `packages/service/src/supervisor.ts`：配置 {instances≥1≤16, portBase, dataRoot, bunBin, cliPath}；spawn `bun cli.js serve --port <base+i> --backend chrome --data-dir <dataRoot/i/profile> --trajectory-dir <dataRoot/i/trajectories>`，env 独立 BW_TOKEN（0600 落 `~/.bw/sup/<i>.token`）；**不设 BW_DAEMON**（禁用 idle-exit）。
- 监控：退出码非 0 或信号 → 指数退避重启（1s/2s/5s 封顶 30s）；**exit 0 = 预期停止，不重启**；/healthz 每 10s 轮询、连续 3 失败 → kill+重启；SIGTERM/SIGINT → 全停。
- 状态：`~/.bw/sup/state.json` **tmp+rename 原子写**；`bw sup start` 持 lockfile（O_EXCL）防并发双 spawn；`bw sup status` 打印实例表。
- **不处理**：请求路由/负载均衡/租户计量——宿主按端口自选（文档化）。

## 4. 并发/一致性预算（硬约束）

| # | 约束 |
|---|---|
| 1 | 空闲退出定时器 1 个/进程（10s 周期）；janitor 1 个（1h 周期，trajectories+downloads 两目录）；均 unref |
| 2 | 网络监听环形缓冲 200 条/会话，url≤500 字符（截断标 truncated）；console 缓冲维持 200 条 |
| 3 | 崩溃恢复：会话级 5 分钟窗 ≤1，进程级 5 分钟窗 ≤2；探测超时 2s |
| 4 | 截图上下文占用：任意时刻 ≤1 张；估算 image=2000 token/张 |
| 5 | unchanged 标记行 ≤120 chars；摘要单行 ≤120 chars |
| 6 | supervisor：实例 ≤16；退避封顶 30s；healthz 轮询 10s；状态文件原子写 + lockfile |
| 7 | replay/janitor 只扫单层 `*.jsonl` / downloads 文件，O(n) 不递归 |
| 8 | 下载：并发 ≤1/会话；单文件 ≤100MB（超限删除+报错）；会话累计 ≤1GB |
| 9 | 429/SESSION_LIMIT 判定 O(1)（Map.size）；上传路径 realpath 解析每文件 ≤1 次 |

## 5. 批次与验收（含联动文件清单——审查 P15）

| 批 | 内容 | 联动文件 | 验收点 | 审查 |
|---|---|---|---|---|
| **B12** | §3.1–3.4 | agent/{tools,run,prompt,llm,trajectory}.ts · core/task.ts · service/cli-run.ts | 渲染 diff 判定 + keep-2 只数全量（连续 unchanged 不失明）；压缩有界（image≤1）；strong abort+continue 状态迁移逐项断言；prices 注入 cost 消费 | 必审 |
| **B13** | §3.5–3.6 | service/{sessions,server,daemon,cli,cli-session}.ts · agent/{run,trajectory}.ts | 生产档策略矩阵（内网封锁在 serve 默认档生效）；文件轨迹 e2e；janitor 双目录×双策略；恢复矩阵（探针×成败×限次×tab 重置×挂起确认 deny）；healthz/信号/空闲退出 | 必审 |
| **B14** | §2.2–2.4、§3.7 | driver/{types,backends,page,fake}.ts · actions/engine.ts · perception/script.ts · policies（allowUploadDirs）· agent/{tools,prompt}.ts · service/{sessions,cli-session}.ts · core/actions.ts | FakeDriver-CDP 模拟为主覆盖 + chrome 真视图（skip-if）；下载/上传/cookies_all/requests/UA/resize/历史导航矩阵；上传路径越权矩阵（含 symlink）；webkit 降级矩阵；S1③ 回滚清 downloads | 必审 |
| **B15** | §3.8 | .github/workflows · package.json · scripts/stress.ts | 双平台 workflow 绿；版本锁生效；stress 出数 | 合并审 |
| **B16** | §3.9 | 新包 @bw/eval · scripts · docs/eval-report-B16.md · README/04-usage 宣称修正 | 假装置单测绿；真跑 3-5 双端出数落档（提示词差异披露）；宣称与实测一致 | 必审 |
| **B17** | §3.10 | service/supervisor.ts · cli.ts | 假 spawn 注入（退避/exit0 不重启/health 重启/全停/lockfile）；真 1 实例冒烟 | 必审 |

每批四门（typecheck/lint 0-0/build/test 含覆盖率 ≥90 逐文件）；测试口径先行的纪律沿用 02 §1/§2。

## 6. 风险与回滚

- Bun.WebView 实验性 API（resize/cdp/CDP 事件/goBack+onNavigated 在 chrome 的实际行为）——B14 先探针后接线，探针失败项降 capability=false 并登记（不阻塞其余项）。
- 每批独立提交可回滚；**词表追加 ≠ 免检**（审查 P24）：封闭断言、never 穷举、契约套件、表驱动矩阵每批同步扩项，遗漏即门禁红。
- 既有结论引用：run.ts:219「运行中换模型不生效」+ 本轮 pi 源码实证（createLoopConfig 启动时捕获）。

## 7. 对 01/03 的显式回改清单（实现批次内完成）

| 文档 | 回改点 |
|---|---|
| 01 §6.6 | 会话模式崩溃恢复 carve-out（P2-2 fail-fast 仅指 agent 模式；会话模式恢复语义见 05 §3.6） |
| 01 §6.8 | keep-2 语义细化：只数全量快照；unchanged 标记不占位（05 §3.1） |
| 01 §4.3 | 不动（SESSION_LIMIT 不进 core——05 §2.1 反向澄清） |
| 03 U4/U5/U6/U7 | 新动作 kind 表、onAction upload 路径闸、工具按能力注册、CLI/replay/sup 命令面 |
