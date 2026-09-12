# B22 迁移审计：sessions + driver（+ agent run 生命周期）

> 状态：审计产物（只读审计，未改任何源码）。输入：DESIGN.md 草稿。
> 四条标准：①正确性 ②契约符合 ③实现质量 ④依赖方向。
>
> **已审计文件**（全部通读，行号对应当前 HEAD f7c51f2）：
> - packages/service/src/sessions.ts（1084 行，全量）
> - packages/driver/src/backends.ts（155）、page.ts（464）、types.ts（128）、index.ts（19）
> - packages/driver/src/fake.ts（357）
> - packages/driver/test/：contract.ts（252）、contract.test.ts（67）、fake.test.ts（112）、webview.test.ts（258）、b14-chrome.test.ts（215）
> - packages/agent/src/run.ts（934，driver 生命周期相关段全量）
> - 佐证（接口契约核对）：node_modules/.bun/node_modules/bun-types/bun.d.ts:9186-9718（Bun.WebView 全量声明）、packages/policies/src/engine.ts、packages/actions/src/engine.ts、packages/service/src/server.ts、janitor.ts、shutdown.ts、packages/service/test/{sessions,b13,b14,b20}.test.ts
>
> 未读即未标：本清单未覆盖 server.ts 全量 / supervisor / daemon / cli-*（非本审计范围）。

---

## 1. 真 bug 清单 B#

| # | 位置 | 级别 | 复现条件 | 修复决策 |
| --- | --- | --- | --- | --- |
| B1 | sessions.ts:840-848, 996-1001, 1027-1036 | **中**（S6 脱敏面不一致） | 会话中先 type_text_secret（secret 值进 policy.redact 集），随后 console/errors/storage/extract_text 的结果文本**不经 redact** 直接进 HTTP 响应与盘面轨迹（eval 同）。仅 requests/cookies_all/extract_code 过 redact（845-848、999-1001）。注释 1032 声称「脱敏后文本…HTTP 面与盘面同规则」与实现不符——agent 面 run.ts:300 对**一切** onActionResult 文本 redact，会话面收窄。页面 console.log 回显/输入值镜像即可泄漏 | **随重构修**：SessionStore 落盘前统一过 redact（出域与盘面同一条路径），并补「console 回显 secret」回归用例 |
| B2 | sessions.ts:137-138, 641-651；backends.ts:75-90；bun.d.ts:9256-9258 | **中**（架构约束，非崩溃 bug） | 同一 bw 进程内：首个 chrome view 无 dataStore（缺省 ephemeral/temp）时，后续会话传入的 dataStore 被 Bun 静默忽略（单例首 view 生效）；firstChromeDataStore 守卫只覆盖「首个有 dataStore」的形态。且 Bun spawn 模式下**进程内所有 chrome 会话共享一个 Chrome 进程与一个 profile**——U7「每会话独立浏览器」在进程内 spawn 模式下不可能 | **B22 架构消除**：每会话自 spawn Chrome + `backend:{type:"chrome",url}` attach（见 §4）。旧守卫随 serve 删除一并删除 |
| B3 | sessions.ts:589-610 | 低-中 | 页面有 >2s 的长 JS（动画/忙循环）时任何驱动错误触发 isDriverDead：`page.evaluate("1")` 2s 超时即判死 → recoverSession 重建 driver、单页化、丢 tab 拓扑（假阳性恢复） | **挂账→B22 换探测**：attach 模式下用 CDP ws 连通性 / `http://127.0.0.1:<port>/json/version` 探测端点，不再 evaluate 探针 |
| B4 | sessions.ts:814-819；run.ts:451-465 | 低-中（S1③ 窗口） | open_tab/switch_tab 产生的新页在**下一次 executeTool** 才接 onNavigated 复检；其间页面 meta-refresh/JS 跳转到未批准域的事件已错过（监听器在事后才挂）。run.ts 是 200ms 轮询接线，同样有窗 | **随重构修**：driver/engine 暴露 onPageCreated（或 engine.act 内创建页后同步接线），消灭两处补丁式接线 |
| B5 | sessions.ts:315-318 与 339 | 低 | 确认门超时路径对同一 cid **第二次** emit confirmation_required（挂起时一次、超时又一次）；消费者无法区分「新确认」与「已过期」。且超时分支不调 `policy.resolveConfirmation`，策略侧 confirmations 记录滞留（直到 256 FIFO 逐出，policies engine.ts:277-281） | **随重构修**：pending/<cid>.json 惰性过期（120s）天然消除重复事件语义 |
| B6 | sessions.ts:737-743 | 低 | 调 closeAll() 后 manager 仍可用：cleaner 被永久 clearInterval，之后 create 的会话**永不被 TTL 回收**（只能显式 close） | **随重构修**：文件会话 TTL 改惰性判定（触接时比对 lastActiveAt），定时器整条消失 |
| B7 | sessions.ts:849, 860-880, 1040；buildPolicyConfig 468-473 | 低 | 预算盲区：eval/tabs 工具不 consume steps（allowEval 会话可无限 eval 不触顶）；`wallClockMs` 预算字段在会话模式**从不被任何路径消费**（死维度——只有 agent 模式 run.ts:340 消费） | **挂账**：SessionStore 预算字段重设计时裁决（建议：每命令 touch 消费 wallClock，或删字段） |
| B8 | sessions.ts:412-433, 925-964 | 低 | `batch {steps: []}` 通过校验 → 返回 ok "batch 0 steps"（snapshot ""/unchanged false）。agent 面 tools.ts:345-347 要求 ≥1 步——同一词汇表两套校验漂移的实证（见 D1） | **随重构修**（并入 D1 单一校验器） |
| B9 | sessions.ts:43-49；server.ts:426 | 低（契约谎言，非运行错） | `SessionConfirmationNeeded`（code "CONFIRMATION_REQUIRED" + cid）类型**从未被构造**；gate() 实际语义是阻塞等待 approve/deny/timeout。server.ts 426 的 202 分支是死代码 | **随重构修**：B22 文件会话本就要改为「非阻塞返回 cid」（DESIGN §1.3），类型即为该设计预留 |
| B10 | run.ts:451, 457-460 | 低 | settleWireTimer 无 unref：agent.prompt 永不结算时进程被 200ms interval 钉活；且以 `__bwSettledWired` 动态属性**戳改 driver 层 Page 对象**（对象若被冻结则静默失效→每 200ms 重复挂监听器） | **随重构修**（B4 的 onPageCreated 一并消灭轮询与戳改） |
| B11 | sessions.ts:811 vs 849/1040 | 低（可观测性） | info().steps 对**每次调用** +1（含失败调用、tabs、eval），预算 steps 只计 act/inspect 成功路径——两个「步数」语义分裂 | **挂账**：SessionStore 只留一个计数（建议按预算口径），文档写明 |
| B12 | page.ts:151-167（evaluate 无超时） | 低 | 页面 JS 死循环：evaluate 永久挂起 → 会话唯一兜底是 30min TTL；bw run 只能用户 abort。driver 层 evaluate/cdp 均无超时参数 | **挂账**：driver 契约加可选 timeoutMs（与 navigate 对齐），或引擎层统一 race |

未列入（核对过、判定为设计内行为）：recoverSession 失败后会话滞留至 TTL（claim-at-entry 退避语义，sessions.ts:516-521 已注释）；create 挂起确认期间占 maxSessions 名额（confirm() 需要会话已在 map）；events 环形 500 回放旧确认事件（confirm 未知 cid 返回 false，无害）。

---

## 2. 重复代码清单 D#

| # | 位置对 | 问题 | 提取计划 |
| --- | --- | --- | --- |
| D1 | sessions.ts:344-457（buildAction）↔ agent/src/tools.ts:280-420（TypeBox schema + mapper） | 同一工具词汇表两套「参数→BrowserAction」校验/映射，已发生漂移（B8）；新增工具要改两处+core 类型三处 | 提取到 **@bw/core**（或独立 `toolSchema` 模块）：单一 schema+builder，agent 注册工具面、session executeTool 共用。**B22 前置**——文件会话工具面必须与 SDK 单源 |
| D2 | sessions.ts:146-149（downloadsRoot）↔ run.ts:208-211 ↝ actions/engine.ts:396 ↝ supervisor.ts:200 | 下载根解析 4 处手写（env BW_DOWNLOADS_DIR ?? ~/.bw/downloads）；sessions 已导出函数但 agent/actions 无法反向依赖 service | 移入 **@bw/core**（唯一公共下游），三方 import；B22 下载根随 DESIGN §1.2 迁到 session 目录时单点改 |
| D3 | sessions.ts:263-289（wireSettledCheck，WeakSet 幂等，回滚 lastAllowedUrl）↔ run.ts:425-449（回滚 about:blank + 轮询戳改） | S1③ 接线双实现，回滚目标不一致；policies 的 `SettledVerdict.rollback` 标志（engine.ts:105-110）**两处都忽略**，策略层裁决形同虚设 | 提取共享 wiring 到 @bw/actions 或 policies（回调注入回滚目标），配合 B4 的 onPageCreated 事件 |
| D4 | contract.test.ts:50-57 ↔ b14-chrome.test.ts:12-19 | CHROME_CANDIDATES 探测表双份（env + 5 安装位） | 移到 @bw/testing（`chromeAvailable()`/`CHROME_CANDIDATES`） |
| D5 | sessions.ts:313-341（gate 的 pending map+timer）↔ run.ts:233-244（awaitConfirmation） | 确认门挂起骨架重复（会话版带事件、agent 版纯布尔，语义有差） | 低优先；文件化 pending/<cid>.json 后两处骨架都重写，不值得先提取 |
| D6 | page.ts:36-37, 97-167（#navChain/#evalChain）↔ fake.ts:50-51, 98-161 | 互斥链平行实现（替身刻意保真，但链逻辑本身可共享） | driver 内部私有 `serialize()` helper（不进公开面）；替身仅保留行为断言面 |
| D7 | contract.test.ts:27-39 / webview.test.ts:26-37 / fake.test.ts:88-100 | WEBKIT_CAPABILITIES 字面量在 3 个测试文件重复 | driver 导出 `WEBKIT_CAPABILITIES`/`CHROME_CAPABILITIES` 常量（index.ts 现只导出类型与工厂，backends.ts:11-35 常量未导出） |

**依赖方向结论（标准④）**：driver → 仅 @bw/core ✓；actions/perception/policies → core/driver ✓；service(sessions) → actions/core/driver/perception/policies ✓；agent → 同上 ✓。无环。两处越界：① driver/src/index.ts:3-4 把 FakeDriver/FakePage 从**生产入口**导出（测试替身进 SDK 公开面——B22 根包直接导出 browserwork 时会连带暴露，应移入 test 出口或子路径导出）；② run.ts:457-460 戳改 driver 层对象（见 B10）。另 actions/engine.ts:396 直读 env+homedir（配置策略散落，随 D2 收口）。

---

## 3. 契约缺口清单（记忆态 → 文件化落点）——SessionStore 设计直接输入

### 3.1 ManagedSession 字段（sessions.ts:74-103）

| 记忆态 | 现语义（行号） | 文件化落点建议 |
| --- | --- | --- |
| `id` | `sess-`+uuid 前 13（618） | session.json `id` |
| `driver`/`engine`/`makeDriver` | 活对象；makeDriver 闭包持 CreateDriverOptions（652-653） | session.json `driver` 段（backend/width/height/UA/chromePath）+ `endpoint` 段（chrome：ws url + user-data-dir；webkit：helper socket + pid）。makeDriver 变纯函数：endpoint 活→attach，死→重拉 |
| `policy.allowedHosts` 增量 | 批准累积（policies engine.ts:494 `allowed.add(host)`），**纯内存** | session.json `allowedHosts`——**必须持久**：重启后已批域不得重新确认（否则文件会话每次命令都弹确认） |
| `policy.confirmations`（cid→origin/action 记录，cap 256 FIFO，policies:277-281） | 挂起确认 + violatedHosts 迟到批准防护（497-499） | `pending/<cid>.json`（DESIGN §1.2）；violatedHosts → session.json `violatedHosts`（或接受触接重判：settled 复检会重新抓） |
| `policy.dnsCache` | 进程内 DNS 缓存（policies:211） | 不落盘（每命令进程重建；S4 重解析天然防 DNS 漂移窗口） |
| `policy.secretVariants`（redact 集） | resolveSecret 时动态注册（policies:218-240, 433） | **不落盘**（U4：每命令从 secrets 配置全量重解析；type_text_secret 命令内 resolve→redact→execute→落盘同进程完成）。注意 B1：重解析集必须覆盖所有出域/落盘文本，不只 extract_code |
| `policy.budget` #usage/#exceeded | 会话模式只消费 steps（849/1040）；tokens/cost 恒 0；wallClock 死维度（B7） | session.json `budget: { steps }`；其余维度先裁决再定字段 |
| `snapshot`（Snapshot 对象） | S2 target 查找（976-987）+ info url/title（291-300） | 不整体落盘（超 100KB 预算）；崩溃恢复=「导航回当前 URL+重提取」（DESIGN §1.3 已定）。S2 词面闸依赖快照——恢复后首个命令前必须先重提取，或该命令降级为无 target 闸 |
| `lastRendered` | unchanged 判定 + 渲染缓存（1002-1006） | session.json `lastRendered`（DESIGN §1.2 已列；计入 100KB 上限——大快照需截断策略） |
| `confirmations`（会话层 Map：resolver+timer，66-72/313-341） | 阻塞式确认门 | `pending/<cid>.json` + `bw s confirm` 取 flock 执行动作；120s 惰性过期（**语义变更**：现 HTTP 请求挂起等待→改为立即返回 cid，B9 类型即预留） |
| `createdAt`/`lastUsed` | TTL 判据（216） | session.json `createdAt`/`lastActiveAt`；**TTL 定时器→惰性判定**：每命令触接时 `now-lastActiveAt>ttl` → 回收；显式 `bw s gc` 扫目录 |
| `steps` | 见 B11 | session.json `steps`（按预算口径单一化） |
| `allowEval` | create 固化（666） | session.json `allowEval` |
| `lastAllowedUrl` | S1③ 回滚目标 + 崩溃恢复目标（667, 281, 569） | session.json `lastAllowedUrl`（或等价「当前批准 URL」） |
| `lastRecoveryAt` + 模块级 `processRecoveries`（133-136） | 会话级 5min≤1 + **进程级** 5min≤2（跨 manager 共享） | session.json 恢复记账（`recoveries: [ts]`）。**语义变更**：每命令一进程后进程级限次失义——建议改「会话级滑动窗 ≤N」；需设计裁决并写进 DESIGN |
| `trajectorySink` | create 时工厂解析（681-684；server.ts:116-120 落 `<dir>/<id>.jsonl`） | 路径推导：session 目录内 `trajectory.jsonl`（DESIGN §1.2 布局） |
| `name`/`kept` | B20 §9.5（772-790） | session.json `name`/`keep`；keep 时清 downloads 的语义保留（778-781） |
| `events[500]` + `eventWaiters`（100-101, 250-255, 751-770） | SSE 事件流缓冲（唯一消费面是 server.ts /events） | **无落点——需裁决**：U1 删 serve/SSE 后，外部 agent 的确认通知=命令同步返回 cid；任务事件=trajectory.jsonl。建议整条删除（迁移矩阵删 events()/SSE 用例） |
| `closed` | destroy 幂等（226） | 目录存在性 + lock 即事实源 |

### 3.2 Manager/模块级状态

| 记忆态 | 行号 | 落点 |
| --- | --- | --- |
| `sessions` Map | 209 | `~/.bw/session/` 目录枚举 |
| `maxSessions`（默认 16） | 130, 614 | create 时目录计数 + gc；上限语义保留（SDK 进程内则仍是内存计数） |
| TTL `cleaner` interval（60s，unref） | 212-223 | 删除（惰性判定替代，B6 随之消失） |
| `wiredPages` WeakSet | 262 | 不持久（每命令进程内重接线；onPageCreated 后天然消除） |
| `processRecoveries`（模块级） | 135-136 | 见上（语义重设计） |
| `firstChromeDataStore`（模块级） | 137-138 | **删除**——每会话独立 Chrome 后约束不复存在（B2） |
| 下载目录 `~/.bw/downloads/<id>` | 149 | 迁 `~/.bw/session/<id>/downloads`（DESIGN §1.2）；janitor.ts:27 `subdirs` 一层展开逻辑同步改锚点 |

### 3.3 三条「隐性契约」缺口（现实现隐含、DESIGN 未点名）

1. **create 时策略档快照**：policyMode/allowPrivateNetwork/allowUploadDirs 影响**后续每一次命令**的闸行为（620-651）。文件化后这些必须进 session.json（策略段），否则每命令重建 policy 时口径漂移。
2. **同一 cid 的策略侧与会话侧双账本**：policy.confirmations（含 origin host）+ session.confirmations（resolver）。confirm() 必须同时 resolve 两侧（797-798）。pending/<cid>.json 要合并两者：文件里存 `{reason, action, originHost?, createdAt}`，confirm 时先查 violatedHosts 再放行+加白名单。
3. **wallClock/tokens 预算维度**（B7）与 **events 流**（3.1 末行）是文件化后「自然消失还是显式保留」的两个显式裁决点，建议进 DESIGN §2.1。

---

## 4. Chrome 生命周期事实（p14a 探针与驱动层裁决输入）

以下全部为**当前代码 + Bun 类型声明**（bun.d.ts:9186-9718）可证事实，非推测：

1. **spawn 路径**：`backends.ts:76-90` 每个 chrome 页 = `new Bun.WebView({backend:{type:"chrome", url:false, path?, argv?, stdout?, stderr?}, dataStore?})`。**仓库内没有任何代码直接 spawn Chrome**（grep 无 Bun.spawn chrome / remote-debugging / DevToolsActivePort / closeAll / forceKill）。二进制定位：`opts.chromePath` → Bun 自身 auto-detect（标准安装位 + `BUN_CHROME_PATH`）。
2. **启动旗标**：Bun 缺省 `--remote-debugging-pipe --headless --no-first-run --no-default-browser-check --disable-gpu --user-data-dir=<temp>`；`argv` 追加在后（last-wins 覆盖）；`dataStore.directory` 覆写 `--user-data-dir`（bun.d.ts:9260-9261）。
3. **CDP 传输**：spawn 模式走 `--remote-debugging-pipe`（**stdio 管道，不是 TCP 端口也不是 ws**）。用户态拿不到任何 endpoint 字符串——CDP 只能经 `view.cdp()`/`view.addEventListener`（首次 navigate 建会话后可用，bun.d.ts:9556-9557）。**DESIGN §3「CDP 调试口是 Chrome 自身行为（127.0.0.1，随机端口）」对当前 spawn 路径不成立——今天根本没有 TCP 调试口**；该句只在 B22 改为自 spawn `--remote-debugging-port` 后才为真。
4. **进程单例**：bun.d.ts:9256-9258——Chrome **每 Bun 进程只 spawn 一次**，首个 `new Bun.WebView()` 的 path/argv/dataStore.directory 生效，后续 view 经 `Target.createTarget` 复用同一 Chrome。推论：同进程多 chrome 会话 = 一个 Chrome、一个 profile（sessions.ts:641-651 的守卫即此约束的补丁，见 B2）。
5. **bw 进程退出时**：
   - 正常退出：Bun 在进程退出时自动调 `WebView.closeAll()`（bun.d.ts:9444-9449，「Called automatically at process exit」）→ **force-kill Chrome 与 WKWebView host**。仓库自身无任何 kill/detach 逻辑（shutdown.ts 只 abort 任务+关会话，最终仍是 view.close()）。
   - `driver.close()`/`view.close()` 只释放该 view 的渲染进程（bun.d.ts:9703-9712）；**全 view 关闭后 Chrome 浏览器进程是否自退未在声明中承诺**（closeAll 注释「Call manually to reclaim browser resources early — subsequent calls respawn them」暗示不自退）——探针项。
   - SIGKILL/崩溃：at-exit 钩子不跑 → Chrome 成为孤儿（pipe 断裂）。Chrome 遇 `--remote-debugging-pipe` 对端关闭是否自退属 Chromium 行为，**未知——p14a 必测**。
   - 结论：**当前 Chrome 生命周期硬绑定 bw 进程**；「bw 崩溃浏览器活着」在现架构下不存在。
6. **连接既有浏览器的 API：存在**（bun.d.ts:9266-9286）——Backend 形态 `{type:"chrome", url: string}`：直接连既有 Chrome 的 DevTools WebSocket。URL 取自 profile 目录的 `DevToolsActivePort` 文件（`<port>\n<path>`，完整 url = `ws://127.0.0.1:<port><path>`）；与 `path`/`argv` **互斥**（连的是已运行的 Chrome，不再 spawn）。另有 `url: undefined`（缺省）auto-detect 形态（9288-9303：有 DevToolsActivePort 就连、失败回落 spawn）——backends.ts:77 的 `url:false` 铁律（P1-11，防自动连上用户日常 Chrome）是对的，**不可回退**。
7. **webkit**：Bun 内进程外 host（每 view 独立渲染进程；`closeAll` 同样杀 host，bun.d.ts:9442）。当前无任何 helper 架构——U8「每会话 detached helper」是**全新工程**（helper 持 WKWebView + unix socket 服务），非改造存量。
8. **p14a 探针清单**（裁决 chrome attach 路 A/B 的判据）：
   a. 自 spawn `chrome --headless --remote-debugging-port=0 --user-data-dir=~/.bw/session/<id>/chrome` → DevToolsActivePort 何时落盘、端口=0 语义是否可用；
   b. `{type:"chrome", url: wsUrl}` 连自 spawn 的 Chrome：多页（Target.createTarget）行为是否与 spawn 模式对齐（cdp()/事件/UA 覆写）；
   c. **同一 Bun 进程连多个不同 ws endpoint 是否可行**（单例条文是否也约束 connect 形态——决定 SDK 进程内多会话能否直接 attach，还是每会话仍需 helper/子进程）；
   d. attach 模式下 dataStore 选项是否被忽略（profile 属于启动方）；
   e. bw 进程 SIGKILL 后自 spawn Chrome 的存活/自退行为（pipe vs port 的差异）；
   f. `chrome://inspect` 开关的「每次新连接弹窗」是否只影响用户日常 Chrome（自 spawn 带港口当无此问题——需证）。

---

## 5. 行为规格清单（SessionManager 迁移等价性基线）

格式：方法 → 行为 → 既有测试用例名（迁移矩阵直接引用）。

| 方法 | 行为规格 | 测试锚点 |
| --- | --- | --- |
| `create(startUrl?, opts?)` | ①上限检查→`SessionLimitError`（614-616）②随机 id `sess-`+13（618）③建 policy（production 缺省：S4 生效、startUrl host 入白名单；`allowPrivateNetwork`/`allowEval`/`budget`/`allowUploadDirs`/driver 覆写合并 640-651）④makeDriver+engine+trajectorySink 解析（652-685）⑤startUrl 非空→S1① 前检+gate（可确认/可拒——**阻塞式**，会话先入 map 以便 confirm）⑥`open_tab` 至 startUrl 或 about:blank（about: 不过闸，689-701）⑦S1③ 接线起始页（707）⑧导航失败→清场不占名额（711-716） | sessions.test「生命周期」「会话列表与 maxSessions 限制」「会话 ID 随机」；b13「P2-12：create 无 startUrl 走 about:blank；导航失败清场不占名额」「P1-3：allowPrivateNetwork 经 HTTP 需 serve 级 env 开门」「production 缺省：内网/本地地址被 S4 拦…」 |
| `get(id)`/`list()` | SessionInfo（id/createdAt/lastUsed/url/title/steps/name?/kept?；url/title 取 snapshot 缓存，291-300） | sessions.test「生命周期」「会话列表」 |
| `close(id)` | deny 全部挂起确认→唤醒事件等待者→driver.close()→**rm 会话下载目录**（225-248）；未知 id 静默 | sessions.test「生命周期」（关闭后工具→DRIVER_ERROR） |
| `closeAll()` | 全量 destroy + 清 TTL 定时器（737-743，B6） | sessions.test「会话列表与 maxSessions 限制」 |
| `snapshot(id)` | `renderSnapshot(s.snapshot)`，无则 ""（745-749） | sessions.test「快照格式验证」「生命周期」 |
| `events(id)` | async 流；环形 500；closed 后终止；新订阅者回放缓冲 | sessions.test S1/S2 确认流（collectEvents 辅助）；**B22 裁决删除面** |
| `keep(id)` | kept=true + **rm 下载目录**；幂等；未知 false（772-783） | b20「keep/rename：置位与改名；未知名 false」 |
| `rename(id, name)` | 改名（server 侧 trim+80 截断）；未知 false | 同上 |
| `confirm(id, cid, approve)` | 先 policy.resolveConfirmation（含迟到批准/violatedHosts 防护）再 resolve 挂起 promise；未知 cid false（792-800） | sessions.test「S1 批准后执行」「S1 拒绝→CONFIRMATION_DENIED」「S2 敏感词按钮」 |
| `executeTool`：分发前置 | 未知会话/已关→DRIVER_ERROR；lastUsed/steps 计（803-811）；新页 S1③ 补接线（814-819） | sessions.test「错误处理：不存在的会话」 |
| ├ inspect 10 工具 | console/errors/cookies(_set/_clear)/storage(_set/_clear)/requests/cookies_all（INSPECT_TOOLS 192-203）；requests/cookies_all 需 chrome 能力否则 INVALID_TOOL_ARGS（826-839）；二者结果过 redact（845-848）；预算 consume+assert→超限销毁（849-856） | b14「webkit 会话：download/upload/requests/cookies_all → INVALID_TOOL_ARGS」；sessions.test「新工具：console/errors/cookies/storage/eval」 |
| ├ eval | 默认 EVAL_DISABLED；allowEval 才执行；参数校验；**无预算消费**（860-874，B7） | sessions.test「新工具…（默认禁用→opt-in）」 |
| ├ tabs | driver.pages() 只读清单 JSON（876-880） | sessions.test「tabs 清单…」 |
| ├ 参数构造 buildAction | 全工具参数校验→INVALID_TOOL_ARGS；batch ≤10、禁 done、禁嵌套（344-457；空 steps 缺口=B8） | sessions.test「错误处理」；b20「batch 参数校验」 |
| ├ chrome-only 动作闸 | download/upload 需能力（884-895） | b14 同上 |
| ├ upload TOCTOU | checkUploadFiles→gate（确认窗）→realpath 前后比对不一致→CONFIRMATION_DENIED（897-921） | b14「目录外文件 → CONFIRMATION_REQUIRED；批准后执行」 |
| ├ batch | 递归 executeTool；包装步不计步（926）；首错即停带进度（944-951）；只回末子步快照（956-963）；子步全闸面 | b20「batch 成功…」「batch 首错即停…×2」「batch 三步成功…」「P2-9 计步=子步数」「P2-12 批准后同域后续子步放行」「P1-3 嵌套 batch 三处拒绝」「batch 子步导航到未批准域→确认挂起→拒绝→终止」 |
| ├ S1①/S2 闸 | navigate/open_tab→onNavigate+gate（966-972）；其余→onAction(target=快照节点 tag/text/href)（974-991） | sessions.test S1/S2 系列；b20「P0-1：agent batch 子步 navigate 过 S1①」 |
| ├ 执行+响应 | engine.act；null 快照保留缓存；extract_code 过 redact（997-1001）；unchanged=rendered==lastRendered（1002-1006）；image/intent 透传 | sessions.test「工具矩阵」「静态页：第二个动作 unchanged=true」（b13） |
| ├ 轨迹 | 每动作 append（ts/step/action/resultText≤2000/url/domHash）（1026-1037）；恢复成败也入轨（533-546, 584） | b13「会话工厂：trajectoryDir → <id>.jsonl 每动作一行」 |
| ├ 预算 | consume steps→assert→超限**销毁会话**+BUDGET_EXCEEDED（1039-1051） | b13 限次相关；coverage |
| ├ 崩溃恢复 | catch DRIVER_ERROR→isDriverDead（2s 探针）→recoverSession：窗口限次（会话 1/5min+进程 2/5min）、claim-at-entry、挂起确认一律 deny、重建 driver+engine、open_tab lastAllowedUrl 单页化、lastRendered 失效、成功后返回「recovered」响应（516-610, 1054-1079） | b13「恢复成功：单页化+tabs reset+挂起确认被 deny」「限次：5 分钟窗内二次崩溃不再恢复」「恢复失败（回滚目标不可达）→销毁会话」「P2-11：恢复快照确来自新 driver…」「P1-1/P2-7：claim-at-entry+进程级限次」 |
| `downloadsRoot()`/`SessionLimitError`/`__resetRecoveryLedgerForTest`（模块导出） | 下载根单源 / 429 映射 / 测试重置（146-157, 141-143） | b13「SessionLimitError 直抛+HTTP 映射 429」 |

### 5.1 driver 契约（等价性第二基线，contract.ts 三后端套件）

`Page`：url/title/loading；navigate（互斥队列+timeoutMs=TIMEOUT 弃等、失败 NAVIGATION_FAILED、close 打断→DRIVER_ERROR）；evaluate（互斥链、undefined→null、异常包装 DRIVER_ERROR）；click/clickAt/scrollTo（actionable 语义→ELEMENT_NOT_ACTIONABLE/TIMEOUT）；type/press/scroll/resize/reload；screenshot（png magic）；cdp/onCdpEvent（webkit 抛 DRIVER_ERROR）；cdpPierceNodes?（chrome-only，≤30 节点+几何）；onNavigated（重定向只报终态 URL——S1③ 数据源）/onNavigationFailed；close 幂等+全方法矩阵抛。
`Driver`：createPage({url} 失败即关页不泄漏)/capabilities（chrome 与 webkit 的 10 项能力差——sessions 的 chrome-only 闸即以此判定）/pages 注册表随 page.close 收缩/close 后 createPage 抛。
契约套件形态：`runPageContractSuite` 同一断言跑 Fake/webkit/chrome（contract.test.ts 三注册 + skipIf 显式计数）——**迁移矩阵保留该形态**，新增 attach 形态后应注册第四行（chrome url:string attach）。

### 5.2 agent run 的 driver 生命周期（run.ts）

- 创建：`opts.driver ?? createWebViewDriver(normalizeDriverOptions(req.driver))`（186-189）；opts.driver 注入时**也被 finalize 关闭**（611-615）。
- 销毁：唯一出口 finalize()（终态事件后 driver.close()，U2 幂等）；abort/预算/违规/卡死升级全部汇入 finalize。
- S1③：settleWireTimer 200ms 轮询接线 + `__bwSettledWired` 戳改（450-465，B10）；违规回滚 about:blank + agent.abort（425-449）。
- B22 输入：`bw run` 进程内形态保留 driver 进程内创建/销毁即可；文件会话只影响 `bw s`/SDK sessions 面，run 的 TaskHandle/事件时序契约（终态恰好一次）不动。

---

## 附：最严重发现（供先行决策）

1. **B2+§4-4/5**：当前 Chrome 由 Bun 以 `url:false` spawn（pipe 传输、无端口、进程单例、退出即杀）——「attach 既有 Chrome」在 Bun 原生 API 上有路（`{type:"chrome",url}`），但**必须自 spawn Chrome（带 --remote-debugging-port + session 级 user-data-dir）**才能拿到可重连端点；且「同进程连多个 endpoint」未证实（p14a-c）。DESIGN §3 关于「CDP 调试口 127.0.0.1 随机端口」的前提需更正。
2. **B1**：会话面脱敏覆盖窄于 agent 面（console/errors/storage/extract_text/eval 未过 redact 即出域+落盘），注释与实现不符——SessionStore 落盘路径必须统一过 redact。
3. **§3 确认门双账本 + 事件流无落点**：pending 确认在 policy 与 session 各有一份内存 Map（含 violatedHosts 防护），阻塞式语义与 B22「非阻塞 cid + pending/<cid>.json」是**语义变更**而非平移；events()/环形缓冲在删 SSE 后无消费方，建议显式裁决删除并记入迁移矩阵。
