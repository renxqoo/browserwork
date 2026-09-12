# 阶段 0 探针报告（B1，2026-09-10）

> 环境：macOS 26（darwin 25）/ Bun 1.4.2 / webkit 后端为主，chrome 后端 p9。
> 复跑：`bun probes/pN-*.ts`。RESULT 行为机器可读输出。

| # | 问题 | 实测结论 | 设计影响 |
|---|---|---|---|
| p1 | `alert()` 触发后 click/evaluate 会不会挂死 | **不会**。click 正常 resolve，后续 evaluate 正常，alert 被宿主自动处理（无事件可观测） | `dialogEvents:false` 定稿；**`dialogsUnsafe` 预案作废**（01 §5 原行删除）；dialog 语义 = 自动处理、不可观测 |
| p2 | `window.open` 的归宿 | **静默丢弃**：无新 view、无导航事件、当前页不变 | webkit 后端弹窗任务不支持（能力矩阵记 `popups:"dropped"`）；U3 提取脚本对 `target="_blank"` 链接加警告标注（B3） |
| p3 | evaluate 大结果上限 | **≥16MB 无压力**（16MB 字符串 253ms；1MB 3ms 疑似共享内存零拷贝） | 感知分块策略不需要（12K 预算远低于此） |
| p4 | webkit host 多 view 吞吐 | 4 view 并行 96ms vs 单 view 串行 194ms（**≈2× 并发度**，部分串行化） | §6.6「≤8 活跃任务」可行；吞吐上限实测在案，B8 压测复核 |
| p5 | 父进程 SIGKILL 后 host 孤儿 | **无孤儿**（2s/6s 后均为 0）——host 随管道关闭消亡 | 无需 supervisor 孤儿回收；崩溃清理只需处理进程内状态 |
| p6 | `data-bw-id` × 重渲染 | 重渲染后旧 id 消失（innerHTML 替换销毁属性）；**重新提取会重打 id 且工作正常** | P1-17 处置路径实证：元素被替换 → ELEMENT_NOT_FOUND → 重提取自纠 |
| p7 | `click(selector)` 穿 shadow DOM？ | **不穿**：`timeout waiting to be actionable`；**坐标轨命中**（shadow 内按钮点击成功） | `pierceClick:false` 定稿；P0-2 双轨设计实证成立 |
| p8 | 重定向链 onNavigated 上报 | **只报最终 URL**（单跳/三跳链都只见终点；中间 302 不可见）；事件发生时 title 可能为空 | S1③ 事后复检数据源成立且简单（单事件即终态）；复检只看 URL，title 用 `view.title` 另读 |
| p9 | chrome 后端 `url:false` 独立拉起 | 本机 Chrome 存在，navigate+evaluate 成功 | P1-11 铁律可实施；B2 契约测试双后端可行 |
| p10 | evaluate undefined 归一 | 单元测试覆盖：返回 `null`（driver 归一层） | 无额外影响 |
| p11 | GLM 真实端点（B6 前置，2026-09-10 补） | `open.bigmodel.cn/api/paas/v4/chat/completions` + `glm-5.3-flash`：文本 200、**tools 200 且正确返回 `click({"index":"3"})`**；注意：① `.env` 的 GLM_BASE_URL 是**完整端点**（已含 /chat/completions，勿再拼）② glm-5.3-flash 为推理模型，reasoning_tokens 计入 completion_tokens（max_tokens 过小会吃光推理预算导致空回复——实测 20 tokens 全被推理吃掉） | B6 可用 OpenAI 兼容接入；max_tokens/预算按推理模型留余量 |

## 附带平台事实（切片旅程中发现）

- **click 触发的导航是异步的**：click promise 在事件处理器结束后 resolve，`view.url` 要等导航完成才更新——U4 settle（B4）必须存在；B1 用 `waitForNavigation` 过渡（登记于 02 §5 过渡态）。
- 构造期 `url` 导航在途时再调 `navigate()` 同步抛错——driver 测试避免双导航；B2 的 navigate 互斥队列吸收。

## 能力矩阵定稿（webkit 列，01 §5 同步）

`cdp:false · upload:false · download:false · dialogEvents:false（自动处理）· userAgentOverride:false · pierceClick:false · popups:"dropped"`

## p10/p11（B14 前置：chrome 后端 CDP 面，2026-09-12）

| 探针 | 结论 |
|---|---|
| p10.cdpCommand | DOM.getDocument 直发 OK（先 navigate 建会话） |
| p10.cdpEvent | Network.requestWillBeSent 事件订阅 OK |
| p10.resize | resize(1024,768) 后 innerWidth/Height 即时生效 |
| p10.backOnNavigated | **`back()` 运行时不存在**（bun-types 1.4.2 声明了 back/forward 但未实现——在线文档的 goBack 同样不可用）→ B14 放弃历史导航动作，登记上游限制 |
| p10.uaOverride | Emulation.setUserAgentOverride 生效（navigator.userAgent 变更可见） |
| p11.runtimeMethods | reload= function / back=undefined / forward=undefined / resize=function |
| p11.querySelector | DOM.getDocument{depth:-1} + DOM.querySelector 命中（p10 失败是探针页无目标元素） |
| p11.objectIdObjectGroup | Runtime.evaluate 需 **objectGroup** 才返回 objectId（无 objectGroup 时剥离） |
| p11.performSearch | DOM.performSearch **穿 shadow DOM**（找到 shadow 内 data-bw-id）→ 上传主路径 |
| p11.downloadEvents | Browser.setDownloadBehavior(eventsEnabled) + Page.downloadWillBegin{suggestedFilename} OK；**行为契约实测：`allowAndName` 落盘为 UUID 名，`allow` 保留原名（冲突自动去重）——引擎采用 allow + 目录差集定位** |

## p14（B22 前置：文件会话 + helper 架构，2026-09-13）

| 探针 | 结论 |
|---|---|
| p14a 统一 helper | **15/15**。detached helper 持 WebView + unix socket RPC 双后端可行；**跨进程活 DOM 态连续**（进程 A 设输入值 → 全新进程 B 经同 socket 读回——替代不可行的 CDP re-attach）；chrome 走 `--remote-debugging-pipe` **全程无 TCP 端口**；`kill(-pid, SIGKILL)` 组清理带走 webkit host 与 chrome 子进程（residual=0）。附：Bun socket 的 data handler 必须在 connect/listen 选项里给，事后赋值不生效 |
| p14b dataStore 跨进程 | cookies（**含 httpOnly**）webkit/chrome 双后端**确定持久**——登录态底座成立。localStorage：webkit 持久 ✓；**chrome 落盘时机不定**（dwell 3s 无效；盘上 leveldb WAL 见值但读侧时序性 null）→ 设计裁决：**localStorage 持久按尽力而为**，profile 快照走 evaluate 读取 + 自管 JSON 不依赖它；helper 优雅退出前导航 away |
| p14c 单进程多视图 | **5/5**。webkit/chrome 同进程 2 视图并行 evaluate 互不干扰、真并行（800ms 并发 ≈ 单操作时延）；slot 语义确认（同视图并发第二 evaluate 同步抛）——SDK `Promise.all` 并发 run 的底座 |
| p14d flock | **4/4**。bun:ffi + libSystem.B.dylib：非阻塞互斥 ✓、释放后可得 ✓、**持锁进程 SIGKILL 后锁自动释放**（惰性回收安全性）✓。注意 macOS O_CREAT=0x200 |

**架构裁决依据（p14a + 审计 B2）**：Bun 文档明示 chrome 每视图 = Target.createTarget 新 tab、**无 re-attach 既有 tab 的 API**；且 Chrome 每 Bun 进程单例（同进程多会话共享一 Chrome 一 profile——违背 U7 隔离）。统一 helper 模型（每会话 1 个 detached helper + 1 条 unix socket；webkit 持 WKWebView、chrome 持 Bun.WebView+pipe Chrome）双后端同构解决两难。
