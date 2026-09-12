# 单元文档（Browser Use on Bun.WebView）

> 状态：定稿（v2，B0 对抗审查处置后；处置记录见 `review-B0.md`）
> 基线 `01-baseline.md` · 施工图 `02-build-plan.md`
> 每单元卡：职责 / 处理 / 不处理（归属）/ 契约 / 测试口径。契约是单一真相，实现漂移即 bug。

---

## U1 `@bw/core` — 类型与错误分类法（零业务逻辑、零运行时依赖）

**处理**：错误码封闭词表（基线 §4.3）与 `BWError`；`TaskRequest/TaskEvent/TaskResult/Budget/PolicyOverrides` 类型；`TaskEventKind` 导出常量（词表封闭承载）；`DriverCapabilities`、`Snapshot`、`BrowserAction` 判别联合；敏感词默认表；`TrajectorySink` 接口（agent 写、service 读，P1-16 处置）。
**不处理**：任何运行时行为；本地化文案。
**契约**：纯类型 + 常量 + `BWError`；无副作用。
**测试口径**：词表双向封闭（`TaskEventKind`/`ERROR_CODES` == 文档词表）；判别联合穷举。

## U2 `@bw/driver` — 浏览器驱动抽象

**处理**：`Driver`（createPage/close/capabilities/pages() 注册表）、`Page`（navigate/evaluate/click(selector|坐标)/type/press/scroll/scrollTo/resize/screenshot/goBack/goForward/reload/close + 只读 url/title/loading + onNavigated/onNavigationFailed 注册）；webkit / chrome 双实现；**chrome 默认 `url:false` 独立拉起**（基线 §5 铁律，Chrome 探测含 `BUN_CHROME_PATH`）；`FakePage/FakeDriver` 测试替身——click 命中表 = 可配置的主文档 DOM（作用域真实性由真 view 契约套件保证，B2 审查 P2-11 裁决），navigate/evaluate/close/事件/错误码语义与真驱动同形。
**不处理**：串行化互斥（U4 持锁，driver 只在单调用内护栏）；弹窗语义决策（探针后按能力声明上报）；stable 等待（U4）。
**契约要点**：
- `evaluate<T>(expr)`：表达式形式；结果 `undefined` 归一 `null`；**并发 evaluate 被互斥链串行化排队**，`ERR_INVALID_STATE` 不外泄（B1 审查 P2-12 裁决：串行化优于报错，文档随实现）
- `navigate(url, {timeoutMs})`：超时抛 `TIMEOUT`（弃等；底层导航由 B2 互斥队列收束）；导航在途二次导航等驱动态错误（`ERR_INVALID_STATE`）→ `DRIVER_ERROR`，非 `NAVIGATION_FAILED`（B1 审查 P2-3/P2-4 处置）
- click 双轨透传：selector 版透传 Bun actionable 等待与 timeout；坐标版原生点击；`timeoutMs/button/clickCount` 任意组合不丢失（P2-1）。异常归一：message 含 `actionable` → `ELEMENT_NOT_ACTIONABLE`，等待类超时 → `TIMEOUT`（基线 §4.3）
- 生命周期：close 幂等；**page 与 driver close 后一切方法（含 createPage）`DRIVER_ERROR`**（P2-2）；导航监听器彼此异常隔离（P2-7）；宿主死亡 → pending reject `DRIVER_ERROR("host process died")`
**测试口径**：接口契约套件同一套跑 webkit 真 view / chrome 真 view / FakePage（fixture 站）；navigate 失败矩阵；异常归一表驱动；close 后全方法矩阵；onNavigated 重定向链最终 URL 断言（探针同步）。

## U3 `@bw/perception` — 感知层

**处理**：提取脚本（页面内执行）：遍历 DOM + shadowRoot + 同源 iframe `contentDocument`（跨源 iframe 只输出占位 `[cross-origin iframe: url]`）；**不可见过滤 = display:none/visibility:hidden/opacity:0/字号<4px/同色/aria-hidden（不含视口外）**；可交互元素打 `data-bw-id` 并记录**视口坐标**（同源 iframe 内元素坐标含 frame 偏移换算）与 `belowViewport` 标注；`type=password` 的 value 永远 `***`；安装 guarded settle 观察者（`window.__bwSettle`，重注入先 disconnect）。`extractSnapshot(page)` → `Snapshot`（树、坐标表、滚动状态、domHash、截断标注、警告）；`renderSnapshot ≤ 12,000 字符（硬性）`；`locate(bwId)` 深度定位器脚本（穿 shadow/同源 iframe，返回元素+rect+document origin，跨源不可达）。
**不处理**：截图（U4）；跨源 iframe 内容（坐标兜底归 U4）；等待（U4）。
**契约要点**：
- 索引 = `data-bw-id`，全局唯一（每次提取重编）；**交互与校验的主键是 bw-id 属性本身**，tag/text 仅咨询性（P1-17 处置：页面重渲染移除旧节点 → 旧 bw-id 消失 → ELEMENT_NOT_FOUND → 自纠，而非误点同名孪生按钮）
- domHash = 树结构哈希（tag+role+可见文本前 64 字符+href origin+控件类型；**不含 class、不含 value、不含 below**——滚动不变性是 U3 显式契约）；复用条件 = domHash 且滚动位置且 url 未变（P0-3 处置）
- 页面可控内容（title/url/placeholder/text）单行化 + 钳长（title ≤200、url ≤500、text ≤80、placeholder ≤80、value ≤40；密码框任意大小写 type 恒 `***`）——头部有界是 12K 硬预算成立的前提，换行归一防伪造快照行（B1 审查 P1-1/P1-2 处置）
- `below` 语义 v0 = 仅「视口下方」（`rect.bottom > vh`）；上方外露与部分可见的完整坐标标注在 B3 坐标表实装（B1 审查 P2-13 登记为 B3 范围）
- 卡死检测口径（U6 消费）：同 (url, domHash) 连续出现且期间工具结果全为 no-op/错误（DOM 含时钟/广告文本导致 hash 恒变时不会误判为「有进展」，P2-14 处置为启发式并文档化）
**测试口径**：fixture 页矩阵（静态/表单/shadow DOM/同源 iframe/跨源 iframe/长列表/隐藏文本对抗/React 受控页/懒加载）；坐标换算断言（iframe 偏移）；预算截断两侧；domHash 稳定性（同页两次同、内容变则变、滚动不变）；对抗样例不进快照（越权矩阵项）；密码框恒 `***`；locate 穿透/跨源不可达。

## U4 `@bw/actions` — 动作层

**处理**：`executeAction(action, ctx)`；动作词表 `navigate/click/type/type_text_secret/press/scroll/scroll_to/select/extract_text/look/open_tab/switch_tab/close_tab/wait(含 until=networkIdle)/batch/resize/reload/download/upload/done`（B14 增 resize/reload/download/upload；B20 增 batch 与 networkIdle；go_back/go_forward 因 Bun 1.4.2 运行时未实现放弃——探针 p10/p11）；**每 page 互斥锁**（覆盖一切驱动调用 + settle 轮询 + 轨迹截图，基线 §6.1）；索引桥双轨：主文档 light DOM → selector 轨（点击前若 belowViewport 先 scrollTo）；shadow/iframe/跨源 → 坐标轨（先 locate 校验元素存在与 rect 一致，坐标点击）；**导航意图解析**（click/press 目标的 `a[href]`/formaction/form action + press Enter 且焦点在表单内 = 提交意图）交给 U5 前检；**动作前校验**（bw-id 深度定位 + rect 容差比对；type_secret 需目标文档 origin）；`select` 经 evaluate 原生 setter + change 事件合成（P2-4 处置；type 的 InsertText 天然兼容 React，不设 setValue helper）；settle（观察者静默 500ms 或 10s 上限照常继续，**超限不报错**）；复合步 `act(snapshot, action) → {result, nextSnapshot}`（锁内：校验→执行→settle→提取→轨迹截图）。
**不处理**：放行决策（U5 先拦）；LLM schema（U6）。（上传下载已随 B14 落地：download/upload 仅 chrome 后端，上传路径闸见 05 §3.7）
**契约要点**：错误一律 `throw BWError`；`look` 在「本页已输入 secret」期间默认拒绝（S6）；事件循环保活：等待期持有 pending evaluate（浏览器子进程不保活事件循环，P2-3 处置）。
**测试口径**：动作 × FakePage 表驱动（FakePage 模拟选择器作用域真实语义）；**双轨分派矩阵**（主文档/shadow/同源 iframe/跨源 → 各走哪轨）；竞态（提取后 DOM 替换 → ELEMENT_NOT_FOUND 非误点）；settle 两侧（永动页照常继续）；submit 意图解析表（a 按钮/submit 按钮/Enter in form/JS submit）；select 原生 setter 触发 change 断言；真 view 集成（fixture React 表单全旅程）；导航意图 href 解析表。

## U5 `@bw/policies` — 策略引擎（纯函数 + 注入依赖）

**处理**：`PolicyEngine`：`onNavigate(url)` / `onNavigationIntent(resolvedHref)`（S1②/S5）/ `onNavigationSettled(finalUrl)`（S1③，返回 `{ok} | {violation, rollback}`）/ `onAction(action, intent)`（S2，含提交意图）/ `resolveSecret(name, targetOrigin)`（S3）/ `budget.assert()` / `redact(text)`；S4 URL 归一化 + IP 全记法解析 + 封锁段表 + 注入 `DnsResolver`；敏感词表；origin 匹配（host 精确/子域，URL 解析）；cid 生成器注入（P2-8）；`GateDecision = {allow} | {block, reason} | {confirm, cid, reason}`。
**不处理**：确认计时器（U6 唯一拥有）；secret 存储（调用方给 `{source, ref}` + 注入 `SecretResolver`）；DNS（注入接口，Bun 实现在装配层）；预算计量采集（U6 采集，U5 只存数与断言）。
**契约要点**：核心字面检查纯同步；`onNavigate` 对非字面主机名走注入 resolver 的异步路径；预算只存数（consume 由 U6 调）+ assert 纯断言。
**测试口径**：**越权矩阵全维**：注入样本 × {显式 navigate / 链接点击意图 / 重定向终态 / 表单 GET 终态 / JS 跳转终态} × {file://、localhost、127 变体写法（十进制/十六进制/::ffff: 映射/0177.0.0.1）、172.16、169.254、公网域名解析到内网（resolver 替身）、新域、子域伪装 `example.com.evil.io`、query 带 token/邮箱/手机号/secret 子串}——每格断言三态与回滚决策；S3 矩阵（主文档/同源 iframe/跨源 iframe × 白名单/allowSecrets 有无）；S2 矩阵（敏感词按钮/submit/Enter 提交/普通点击）；secret 变体 redact（原文/base64/URL 编码）；预算各维度边界两侧；词表封闭。

## U6 `@bw/agent` — agent 组装（pi-agent-core 封装）

**处理**：`runTask`（SDK 契约 §4.1）；工具注册（U4 × capabilities，全 sequential）；**U4 互斥 + sequential 双保险**；钩子接线：`beforeToolCall` = U5 前检（navigate/意图/写闸/secret origin）+ 预算 assert——**confirm 不在钩子里挂起**：返回 `{block, reason:"confirmation_required:cid"}`，U6 状态机进入 PendingConfirmation（唯一计时器 120s，超时=deny），发事件、等 confirm()/超时；批准后注入合成用户消息「user approved: <action>」+ `continue()` 让 LLM 重发该动作（cid 已记批准 → 放行）（P1-10 处置）；`onNavigated → U5.onNavigationSettled` 违规 → 回滚 about:blank + 终止或确认；**done 终止协议**：done 一旦出现在批次，beforeToolCall 拦截同批后续工具（`task already concluded`）；done 执行后 U6 记录答案、发 `task_done`、调用 `agent.abort()` 收束——不依赖 pi 的「整批全 terminate」语义（P1-7 处置）；预算计量（订阅 message usage → consume；beforeToolCall + turn_end 双点 assert）；**事件出域脱敏**（S6：SSE/SDK 迭代器前统一 redact）；transformContext 压缩（基线 §6.8）；卡死检测（同 (url,domHash) 且无进展 N 步 → 换 strong 模型重试一次 → 仍卡 → `task_done(stuck_escalated 已告知)`)；steer/abort 接线（abort 在 PendingConfirmation 期间 = 取消等待 + 终止，P1-10）；`ScriptedLLM` 测试导出；GLM（OpenAI 兼容）+ Anthropic 兼容接入；TrajectorySink 默认文件实现（写 JSONL+截图+脱敏）。
**不处理**：事件传输（U7）；chrome 专属工具（按能力不注册）。
**契约要点**：pi 类型不外泄；`TaskEvent` 词表 == core 常量；`task_done` 恰好一次且最后；PendingConfirmation 期间 steer 入队不注入、abort 立即生效。
**测试口径**：假 LLM 旅程矩阵（完成/被拦转确认/确认批准重发/确认拒绝终止/确认超时=deny/预算各维度触顶/卡死升级/升级后成功/steer 打断/abort 包括挂起期/done 后同批工具被拦/重定向违规回滚/链接点击新域确认）；事件时序断言（终态恰好一次最后、confirmation_required 后必跟恢复或 CONFIRMATION_DENIED）；**压缩有界断言**：20 步剧本任务中 (a) 旧快照 toolResult 全部替换为单行 (b) 上下文估算 ≤ 系统提示+任务+2×快照+动作摘要总量（有界，非单调，P1-8 处置）；工具列表 == 能力过滤封闭断言；事件流经 redact（secret 变体不出现，逐字节）；real 门 GLM 冒烟（opt-in）。

## U7 `@bw/service` — HTTP 服务 + CLI + 轨迹读取

**处理**：§4.2 全端点（含 abort）；SSE（脱敏后有界队列，P2-9 策略）；轨迹读取/展示/`bw replay`；CLI（run/serve/replay）；Bearer 鉴权；并发限制（≤8，超出 429）；janitor（轨迹保留 7 天默认/磁盘上限）；确认超时配置注入 U6。
**不处理**：多租户数据隔离（进程边界模型，supervisor 约定文档化）；HTTPS 终结。
**测试口径**：SSE 事件序（终态恰好一次最后；慢客户端溢出断开+Last-Event-ID 重放）；abort 旅程；确认超时传递；鉴权越权矩阵（无/错 token × 全端点）；轨迹文件逐字节无 secret；429 并发上限两侧；CLI 冒烟。

## U8 `@bw/testing` — 测试装置（仅测试消费）

**处理**：`withPage`（真 webview 生命周期，**每用例 ephemeral view**——dataStore 隔离，P1-12 处置）；fixture server（随机端口）；`ScriptedLLM` 重导出；`testPolicy`（127.0.0.1 fixture origin 预入白名单的测试档策略，P1-14 处置）；断言帮手。
**不处理**：任何生产路径。
**测试口径**：装置自证——随机端口无串扰、失败必回收、用例间零共享可变状态。

---

## 依赖矩阵（运行时 import 白名单，lint 强制）

```
core      → (无运行时依赖；typebox 归 agent)
driver    → core
perception→ core, driver
actions   → core, driver, perception
policies  → core
agent     → core, driver, perception, actions, policies (+pi-agent-core/pi-ai/typebox)
service   → core, agent, policies（运行时调用 redact，非仅类型）
testing   → driver, agent（测试期：driver 契约测试可反向消费 testing，不入运行时图）
```

## 平台门禁矩阵（P1-14 处置）

| 平台 | 默认门内容 |
|---|---|
| macOS | 单元/契约 + webkit 真 view 集成 + chrome 真 view 契约 |
| Linux/CI | 单元/契约 + chrome 真 view 契约（webkit 不可用，跳过项显式标注 skip-on-platform 并计数，不算静默 skip） |
