# B0 对抗审查处置记录

> 审查者：独立子 agent（无实现上下文），指令「假设文档是错的，找出会在哪里坏」
> 输入：三件套 v1 全文 + 平台事实清单（Bun.WebView / pi-agent-core 实测语义）
> 结论：**36 条全部处置（已修 36 / 驳回 0）**；文档重写为 v2 后定稿。无驳回理由：逐条核对平台事实与消费路径，未发现误报；成本最高的 P2-11（评测装置）也裁定接受。

## P0（返工级，全部已修）

| ID | 问题 | 处置 | 落点 |
|---|---|---|---|
| P0-1 | 安全边界只在显式 navigate 前检；链接点击/重定向/JS 跳转/表单 GET 全绕过 | S1 改三处挂钩：①navigate 前检 ②click/press 导航意图前检（U4 解析 a[href]/formaction/form action）③onNavigated 最终 URL 事后复检 + 违规回滚 about:blank；威胁模型改口为「意图前检+结果后检+回滚」，不再承诺请求级阻断 | 01 §1/§7 S1；03 U4/U5/U6；02 B1 探针（重定向终态） |
| P0-2 | shadow DOM/同源 iframe 元素「看得到点不到」：click(selector) 不穿 shadow/iframe，校验也够不着 | 交互改双轨：主文档 light DOM → selector 轨；shadow/iframe/跨源 → 坐标轨（提取记录视口坐标含 frame 偏移；深度定位器 locate(bwId) 做动作前校验）；FakePage 必须模拟真实选择器作用域；探针补 click(selector)×shadow 行为 | 01 §2/§5；03 U2/U3/U4 |
| P0-3 | 视口模型三处矛盾：过滤「视口外」元素 vs 截断标注「下方还有」 vs ACTIONABLE 承诺滚动重试互斥；domHash 复用与滚动死结 | 裁决：不可见过滤**不含视口位置**（防注入维度才管可见性）；视口外元素照常入快照标 belowViewport；点击前自动 scrollTo；domHash 复用条件 = hash+滚动位置+url 三者未变 | 01 §6.3/§7；03 U3/U4 |

## P1（实施中会炸，全部已修）

| ID | 处置摘要 | 落点 |
|---|---|---|
| P1-1 操作槽数与平台事实矛盾 | 承认 4-5 独立槽；U4 自持每 page 互斥锁覆盖一切驱动调用；轨迹截图在锁内拍 | 01 §6.1；03 U4 |
| P1-2 secret 泄入事件/快照/截图 | 脱敏链：密码框恒 ***；事件出域前统一 redact（含变体）；look 在已输入 secret 页默认拒绝 | 01 S6；03 U3/U6/U7 |
| P1-3 S4 绕过变体+DNS | 归一化+IP 全记法+完整段表（补 172.16/100.64/IPv6 ULA/映射）+注入 DnsResolver；TOCTOU 残余文档化 | 01 S4；03 U5 |
| P1-4 S2 绕过（Enter/JS 提交） | 提交意图解析（Enter in form、submit 类控件）过写闸；JS 自行提交残余：同域=已授权、跨域=S1③ 捕获，文档化 | 01 S2；03 U4 |
| P1-5 S3 绕过（白名单页内跨源 iframe） | secret 目标 origin 取实际文档（深度定位器）；跨源目标一律拒 | 01 S3；03 U4/U5 |
| P1-6 终态事件矛盾/词表不封闭 | task_done 唯一终态恰好一次最后（覆盖全部结束路径）；词表补 stuck_escalated/budget_warn；终态后调用语义与 failed 映射 | 01 §4.1；03 U1/U6 |
| P1-7 done 不可靠终止 | done 协议：批次内拦截后续工具 + 执行后 abort 收束；不依赖 pi「整批全 terminate」 | 03 U6 |
| P1-8 单调不涨断言不可能 | 改有界断言（旧快照全替换为单行 + 上下文 ≤ 上界）；压缩策略量化（K=2、窗口×0.6 触发、contextWindow 预算维度） | 01 §6.8；03 U6 |
| P1-9 预算计量无人认领/cost 无源 | 计量归 U6（usage 订阅→consume，双点 assert）；价目表注入（未知价停用 cost 维度）；wallClock 不含确认挂起+确认总上限 10min | 01 §6.4；03 U5/U6 |
| P1-10 确认门押注未证实能力 | 不在钩子挂起：block+cid → U6 PendingConfirmation 状态机（唯一计时器）→ 批准后合成用户消息+continue() 重发；abort 挂起期语义 | 01 §4.2；03 U6 |
| P1-11 chrome 自动连本机 Chrome/8tab 共享矛盾 | chrome 默认 url:false；服务器模式进程级隔离（一 Bun 一 Chrome），「8 tab」废除 | 01 §5/§6.6；03 U2；02 B1 探针 |
| P1-12 dataStore 任务隔离 | 默认 ephemeral per view；持久化=显式命名 profile；U8 每用例 ephemeral | 03 U2/U8 |
| P1-13 HTTP 缺 abort | 补 POST /tasks/:id/abort | 01 §4.2 |
| P1-14 默认门×S4×平台 | testPolicy 测试档（fixture origin 预入白名单）；平台门禁矩阵（Linux 跳过项显式计数） | 02 §1；03 U8 |
| P1-15 settle 上限饿死/观察者泄漏 | 上限到点照常继续（非错误）；guarded global 一次安装、重注入先 disconnect | 01 §6.5；03 U3/U4 |
| P1-16 轨迹归属反向依赖 | TrajectorySink 接口住 core，默认文件实现住 agent（SDK 单机也有轨迹）；矩阵修正 service→policies 运行时 | 01 §3；03 U1/U6/矩阵 |
| P1-17 同名孪生按钮误点 | 校验主键 = bw-id 属性（唯一），tag/text 降为咨询；元素被替换→旧 id 消失→NOT_FOUND→自纠 | 03 U3/U4 |
| P1-18 click 超时码映射缺失 | 异常归一表：message 含 actionable → ELEMENT_NOT_ACTIONABLE；否则 TIMEOUT | 01 §4.3；03 U2 |

## P2（文档瑕疵，全部已修）

P2-1 错误码补 SECRET_UNRESOLVED/INVALID_TOOL_ARGS/BUDGET_EXCEEDED(contextWindow)；evaluate undefined→null（01 §4.3、03 U2）· P2-2 host 崩溃快速终止不升模型（01 §6.6）· P2-3 等待期 pending evaluate 保活（03 U4）· P2-4 select 原生 setter+change；删 type 的 setValue helper（03 U4）· P2-5 host 精确/子域匹配禁子串（01 S1）· P2-6 B0 验收改「含真实模块的骨架」（02 B0）· P2-7 typebox 归 agent；testing 测试期消费不入运行时图（01 §8、03 矩阵）· P2-8 cid 生成器注入（03 U5）· P2-9 SSE 有界队列+溢出断开+重放（01 §4.2）· P2-10 统一 12,000 硬上限（01 §6.3）· P2-11 对照双方同 GLM+薄 MCP 客户端装置（01 §9、02 §4）· P2-12 dialogsUnsafe 能力+启发式确认门预案（01 §5）· P2-13 终态后调用语义+failed 映射（01 §4.1）· P2-14 domHash 去 class；卡死检测加无进展条件、启发式文档化（03 U3）· P2-15 并发限制归 U7+轨迹 janitor（01 §6.7、03 U7）

## 审查确认无误的部分（不再改动）

close 幂等/pending reject、evaluate 单飞与 IIFE 约定、type 不触发 keydown 的补偿、CDP 能力矩阵、webkit 无 CDP、GLM 走 OpenAI 兼容端点、pi 事件词表透传。
