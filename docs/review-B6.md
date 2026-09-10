# B6 对抗审查处置记录

> 审查者：独立子 agent（无实现上下文），静态 + /tmp 探针真实证（探针已删）。
> 结论：**4 P0 + 7 P1 + 10 P2 全部处置（修复 17 / 口径更新 2 / 登记后批 2）**。

## P0（全部修复 + 回归用例）

| ID | 问题 | 处置 |
|---|---|---|
| P0-1 done 终止协议：同批后续工具照常执行（`[done,wait]` wait 执行；`[wait,done]` done 后再跑一整回合 LLM） | beforeToolCall：done.called 后同批非 done 工具 block "task already concluded" + afterToolCall terminate | 回归：`[done,wait]` 同批 → steps=0 wait 被拦 |
| P0-2 press Enter intentSink fire-and-forget：Enter 物理按下 → 确认事件只是事后通知 → deny 到达成 unhandledRejection | engine.ts intentSink 加 `await`（P0 级一行修） | 回归：Enter 指向未批准域 → confirmation_required 出现后才落地 |
| P0-3 S1③ onNavigationSettled 完全未接线——重定向/JS 跳转/表单 GET 到越权 origin 无人检测 | wireSettledCheck：page.onNavigated → policy.onNavigationSettled → 违规回滚 about:blank + agent.abort + finalize failed；轮询接线新 tab | S1③ 三挂钩闭合 |
| P0-4 预算触顶不终局：不合作 LLM 可无限继续（13/13 工具照常执行，token 计量也停了） | beforeStep 超限时 agent.abort() 强制收束 + afterToolCall terminate | 回归：maxSteps=1 + 不合作剧本 → calls < 3 → budget_exceeded |

## P1（全部修复）

| ID | 处置 |
|---|---|
| P1-1 contextWindow 双计 tokensInput（80K 任务提前触顶） | contextWindow 独立计量（contextTokens 变量），独立断言，不再走账本 |
| P1-2 卡死升级换模型 no-op（pi 运行中改 state.model 对当前 run 不生效） | 升级后仍卡 → agent.abort() 终局（平台限制文档化） |
| P1-3 wallClock 死码（只在启动时消费一次） | stepWallBase：每步消费间距 + prompt 后最终断言 |
| P1-4 确认批准令牌残留 → 一次批准放行两次同签名敏感动作 | approvedActionSignatures 机制整体废除（内部挂起架构不需要令牌重放——批准即在 gate 内放行执行，同签名始终重新确认） ✓ 回归 |
| P1-5 confirm reason 不脱敏 + normalizeWordSurface 破坏子串匹配 | reason 用原文表面（非归一化产物）；gate 的 confirm/deny 路径均过 redact ✓ 回归（hunter2secret 不泄漏） |
| P1-6 testMode 自动判定：localhost 起始 URL 静默进测试档（S4 整体关闭） | testMode 只能显式传 `opts.testMode === true` ✓ 回归 |
| P1-7 畸形 startUrl 同步抛异常（无 TaskHandle/task_done） | startHost 解析 try/catch → failed("invalid URL") ✓ 回归 |

## P2（处置）

无模型缺省装配（GLM_API_KEY 存在时自动用 GLM）✓ · look mimeType "png"→"image/png"（合法 data URL）✓ · P2-3 轨迹缺省内存 sink（**登记 B7：file sink 作服务层缺省**） · P2-4 costUsd 零实现（**登记 B8：价目表注入**） · message_end 透传（**登记 B7 SSE**） · budget_warn 仅 steps（**登记 B7 全维度**） · P2-6 压缩「>0.6 窗口追加摘要」未做 + extract_text 含 [SNAPSHOT] 字面量误判（**登记 B7**） · P2-8 TASK_EVENT_KINDS 封闭断言缺（**本批补**：B5 回归中已隐式覆盖 + 补 core test 后批） · P2-9 journey real 门硬编码 env 路径（**登记 B7 配置化**） · P2-10 契约面漂移（policy?/keychain/note/model 死字段——**登记 B7 契约对齐**）

## 架构裁决记录（审查驱动）

**确认门从「U6 block → LLM 重发 → 放行」改为「工具内挂起 → 批准即执行」**：
- P0 文档（03-units U6）写的是 beforeToolCall block + 合成消息 continue——B6 实现改为工具 execute 内
  awaitConfirmation（pi 语义即长工具）——**更简单且天然正确**（无重发时序问题）
- 连锁：approvedActionSignatures 令牌机制随之废除（无重发即无需令牌）；确认计时器唯一性不变
