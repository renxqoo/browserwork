# 迁移文档：会话存储与命令执行（核心单元）

> 状态：定稿待审
> 迁移单元：外部 agent 模式的「会话生命周期 + 命令执行」垂直行为（create→executeTool→confirm→close/gc 全旅程）
> 旧实现：packages/service/src/sessions.ts（1084 行，内存 SessionManager + HTTP 内嵌）+ server.ts 会话路由（455 行，删除面）
> 目标位置：packages/service/src/{store,executor,confirmations,secrets}.ts + packages/driver/src/helper*.ts
> 关联：[DESIGN.md](DESIGN.md) §1.2/§1.3 · [IMPLEMENTATION.md](IMPLEMENTATION.md) S1/S2 · [audit-sessions-driver.md](audit-sessions-driver.md)

## 1. 行为规格基线（audit-sessions-driver §5 全表 = 判定标准）

旧测试清单（→ 用例数 → 测什么）：

| 文件 | 用例 | 测什么 |
| --- | --- | --- |
| sessions.test.ts | ~40 | 生命周期/工具矩阵/S1①③/S2/S4/确认门批拒/3 会话并发隔离/错误处理/maxSessions/ID 随机/tabs/eval 门/console/errors/cookies/storage/unchanged |
| b13.test.ts | ~30 | 生产档 S4/429/轨迹工厂/janitor/replay/信号/崩溃恢复三态/限次/unchanged/空闲退出/healthz |
| b14.test.ts | ~12 | chrome-only 工具闸（webkit 拒 download/upload/requests/cookies_all）/upload 目录外确认门/webkit UA fail-fast |
| b20.test.ts | ~15 | batch 全语义（计步/首错停/嵌套拒/子步闸面/导航确认）/keep/rename/loc 渲染 |
| driver 契约 | 3+1 行 | Page/Driver 契约套件（Fake/webkit/chrome + 新 helper 第四行） |

显式删除的用例（机制已裁决移除 ≠ 功能缺失）：
- `events()/SSE` 相关（server.ts /events + sessions.events 环形缓冲）——裁决出处：IMPLEMENTATION §3（events 流删除，G7）
- healthz/空闲退出/daemon 拉起（b13 部分 + security.test 大部）——U1 删除面

显式**改写**的用例（行为变更已裁决，断言按新语义重写——非原样平移）：
- 确认流形态：202+SSE → 同步 cid 返回（B9；CLI exit 0 保留）。受影响：sessions.test 确认流
  HTTP 形态、b20「batch 子步导航确认挂起→拒绝→终止」（新语义见 §4b 批量续行）、
  upload TOCTOU（before-paths 入 pending 记录，跨进程比对）
- S1③ 违规检测：即时 → 下次触接（DESIGN §1.3 跨命令模型）。受影响：b13「S1③ 302
  违规回滚」——改写为「违规跳转后下一条命令触接检测→回滚→响应附 rolled back 行」
- create 起始导航确认：旧阻塞等待（会话先入 map）→ 新建目录+helper 后返回 cid，
  确认执行导航，拒绝/超时销毁目录（状态机见 §4c）

## 2. 审计结论引用

audit-sessions-driver：B1（redact 面）B2（Chrome 单例）B5（确认重复 emit）B6（TTL）B8（空 batch）B9（202 死码）B11（步数分裂）§3 落点表（20 项记忆态逐项）§3.3（三条隐性契约）§5 规格表。

## 3. 逐模块裁决

见 [IMPLEMENTATION.md](IMPLEMENTATION.md) §2（sessions.ts→重构：store/executor/confirmations/secrets；backends→+helper 三件）。

## 4. API 对照表

| 旧签名（SessionManager） | 新签名（SessionStore/SDK） | 变化理由 |
| --- | --- | --- |
| `createSessionManager({policyMode, driverFactory, …})` | `createSessionStore({ bwHome, maxSessions?, helperFactory? })` | 无进程内注册表——目录即事实源；**helperFactory 是测试缝**：缺省 = 真实 spawnHelper，测试注入进程内 stub RPC（同协议 Bun.listen unix socket，或函数直调适配器）——全部 store 测试走此缝不碰真实浏览器 |
| （新） | `store.create` 参数**不含 budget**（会话面单维 steps，见 DESIGN §2.1） | 审计 B7/B11 裁决 |
| `mgr.create(startUrl?, opts?)` | `store.create({ url?, name?, backend?, profile?, allowEval?, allowPrivateNetwork?, width/height/ua/chromePath/dataDir? })` | 参数平铺（DESIGN §1.1）；阻塞式起始导航确认 → **同步返回 cid**（状态机 §4c） |
| `mgr.executeTool(id, tool, params)` | `store.executeTool(id, tool, params)` / SDK `bw.sessions.executeTool(…)` | 同形；内部：flock → policy 重建（session.json policy 段+secrets 重解析）→ 闸 → helper RPC → redact → 落盘 |
| `mgr.snapshot(id)`（缺失返回 ""） | `store.snapshot(id)`（缺失 → throw NOT_FOUND） | B3/G13 存在性裁决 |
| `mgr.confirm(id, cid, approve)` | `store.confirm(id, cid, approve)`（取 flock 执行 pending 动作并返回结果） | 确认即执行（原为唤醒挂起 promise） |
| `mgr.close/closeAll/keep/rename/get/list` | 同名（close 幂等；list=目录扫描+活性探测） | 语义平移；closeAll → `gc({closeAll:true})` 兼留（SDK 进程形态） |
| `mgr.events(id)` | **删除** | G7 |
| `createWebViewDriver(opts)`（spawn 形态） | 保留（bw run 进程内用）+ `spawnHelper(sessionDir, driverOpts)`/`connectHelper(socket)` | 双形态：run=进程内；sessions=helper |

## 4b. 确认门语义（pending/<cid>.json 完整规格——P0-1 处置）

记录 schema（单一真相，confirmations.ts 实现）：

```json
{
  "cid": "sc-…", "reason": "origin not in whitelist", "createdAt": 1730000000000,
  "originHost": "other-site.com",
  "action": { "kind": "navigate", "url": "…" },
  "batchCtx": { "steps": […], "executed": 2, "results": ["✓ [1/3] …", "✓ [2/3] …"] },
  "uploadBefore": ["/real/path/a.txt"]
}
```

- **普通动作**：`action` 必有；confirm(approve) → 取 flock → 重过闸（allowedHosts 已含
  批准域）→ 执行 → 返回 `{ok:true, sessionId, cid, result:<工具结果>, snapshot?}`——
  **superset**：旧 `{ok,sessionId,cid}` 键全保留，新增 result/snapshot（行为变更登记：
  旧确认只回执不执行）
- **batch 中段子步**：`batchCtx` 必有（steps 全量 + 已执行进度）；approve → 续行余下
  子步（返回 batch 汇总格式，与一次跑完等价）；deny/超时 → 返回
  `batch stopped at step i/n: CONFIRMATION_DENIED` + completed 进度（旧 b20 语义保持）
- **upload TOCTOU**：`uploadBefore` 存 gate 前 realpath 列表；confirm 时重新 realpath
  比对，不一致 → CONFIRMATION_DENIED（旧同进程保护跨进程化）
- **过期**：120s 惰性（任何触接该会话的命令顺带清扫过期 pending → deny 语义记账
  violatedHosts 不动、返回过期错误码）
- **violatedHosts 合并账本**：pending 写入时查 policy.violatedHosts（迟到批准防护），
  confirm 时 policy.resolveConfirmation 同步落 session.json——单一账本

## 4c. create 状态机（P0-1 处置）

```
create(url?) → mkdir 会话目录（经 ~/.bw/session/.create.lock 全局锁内计数+建目录，防 maxSessions 竞态）
→ spawn helper → session.json {status:"pending-create"} → S1① 前检
   ├─ 免确认 → 执行导航 → status:"active" → 返回 {ok:true, sessionId, result:url}
   ├─ 需确认 → pending/<cid>.json{action:navigate, create:true} → 返回
   │     {ok:true, sessionId, cid, reason, result:"CONFIRMATION_REQUIRED: …"}（exit 0）
   │     ├─ confirm --yes → 导航 → active → {ok:true, sessionId, cid, result:url}
   │     └─ deny/120s 超时 → kill helper 进程组 + rm 会话目录 → 不占 maxSessions 名额
   └─ 导航失败 → 清场（同旧语义：不占名额）
```

## 4d. S1③/快照（P0-2/P0-3 处置）

见 DESIGN §1.3「S1③ 违规检测（跨命令模型）」「快照获取规则」——helper 记导航事件环
（url+ts，容量 100，无判定）；executor 每命令消费 navEventSeq 后的事件做违规判定；
索引类命令开始现提取快照。受影响断言改写见 §1「显式改写」。

## 5. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
| --- | --- | --- |
| sessions.test 生命周期/工具矩阵/S1/S2/确认/并发隔离/错误处理 | packages/service/test/store.test.ts | **改写**：helperFactory 注入进程内 stub RPC（§4 测试缝）；非确认类断言原样；确认流/S1③ 断言按 §1「显式改写」新语义 |
| sessions.test HTTP 端点（201/snapshot/tools/DELETE/404） | 删除 | server.ts 删除面；CLI 等价由 cli-session 金测试接 |
| b13 生产档 S4/轨迹/unchanged/崩溃恢复三态/限次 | store.test.ts | 改写（恢复=socket 死模拟；限次=会话级滑动窗；S1③=下次触接模型 §4d） |
| b13 janitor/replay/信号 | janitor.test / cli-run.test | 移植（B22 聚合计量新用例） |
| b14 chrome-only 闸/upload TOCTOU | store.test.ts | 移植（能力判定来自 helper 元数据） |
| b20 batch/keep/rename | store.test.ts（+toolRegistry.test 单源校验） | 移植 + 空batch 拒绝（B8 回归）；**batch 子步确认 3 用例按 §4b 续行语义改写** |
| driver contract 3 行 | contract.test.ts 4 行 | +helper 远程代理注册（D4 单源探测） |
| security.test daemon 面 | 删除；0600 断言迁 fsx.test | 核销+移植 |
| **新增** | store.test：session.json schemaVersion 拒读/100KB 上限/flock SESSION_BUSY/SIGKILL 锁自释放/机器重启清扫/pending 120s 惰性过期/B1 redact 全工具面回归/B2 每会话独立浏览器集成断言 | 新模块必测清单 |

## 6. 回滚方案

每门（S0-S6）独立提交可 revert；session.json 无 schema 迁移动作（新目录 ~/.bw/session/ 全新命名空间，旧 ~/.bw/downloads 不动——首次运行提示清扫但不自动删）；回滚无数据动作。

## 7. 验收

- 四门 + 覆盖率 ≥90%；sessions.test 语义断言 100% 有新家（矩阵逐条勾；「原样」与
  「改写」分类与 §1 一致——改写项引用本文件裁决节号）
- 对抗审查（独立会话）：假设新 store/executor 与旧 sessions.ts 行为不一致，diff 对照 §5 规格表找偏差
- 行为对照清单：audit-sessions-driver §5 十方法逐项勾
- e2e：跨进程旅程（CLI create→click→确认→close；杀 helper→恢复）+ 隔离 BW_HOME + 双形态冒烟

## 8. 实施记录

（每门收口追加）
