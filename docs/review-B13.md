# 对抗审查：B13（服务可用性）

> 审查者：独立 general-purpose 子 agent（角色分离）· 2026-09-12 · 输入 = 未提交 diff + 05 §3.5–3.6
> 结论：P1×3 + P2×9，全部处置（12 条中 11 条采纳修复、1 条知悉保留）。

## 处置表

| # | 级 | 摘要 | 处置 |
|---|---|---|---|
| 1 | P1 | 并发崩溃恢复互杀（claim 后置 + 无所有权复核） | 采纳：claim-at-entry（尝试即记账=并发互斥+退避）+ catch 内 `s.engine === engine` 所有权复核；测试复位钩子 `__resetRecoveryLedgerForTest` |
| 2 | P1 | localhost 回归：错误提示不可操作（不提 --allow-private-network） | 采纳：usage/env 表口径更新（hint 面由 P1-3 的 env 闸一并收敛——`BW_ALLOW_PRIVATE_NETWORK=1`） |
| 3 | P1 | allowPrivateNetwork 经 HTTP 可设 = S4 边界归请求方 | 采纳（更优方案）：serve 级 env `BW_ALLOW_PRIVATE_NETWORK=1` 开门，否则 body 字段 400；测试覆盖 |
| 4 | P2 | /healthz 刷新 lastRequestAt（探活喂活 idle）+ 早于 Host 校验 | 采纳：healthz 不计时 + Host 校验先行；测试断言 lastRequestAt 不动 |
| 5 | P2 | policyConfig 变静默死选项 | 采纳：优先级恢复 `opts?.policyConfig ?? buildPolicyConfig(...)` |
| 6 | P2 | janitor 无后缀过滤（目录指错清掉 serve.token） | 采纳：`extensions` 过滤（trajectories=[.jsonl]）+ startJanitor targets 形态 + 测试 |
| 7 | P2 | 限次记账语义偏差（manager 级/成功才记/测试掩盖） | 采纳：模块级 processRecoveries + 尝试即记账（并入 #1）+ 三会话第三拒绝测试 |
| 8 | P2 | 优雅退出不等 abort 完成 | 采纳：stop 可返回 promise，handler await 后 exit |
| 9 | P2 | 崩溃/恢复不入轨迹（审计缺口） | 采纳：core TrajectoryEntry 加 `__recovery`；恢复成败均落轨迹 |
| 10 | P2 | replay 终端转义注入 + .jsonl 任意读 | 采纳一半：stripControl 剥 ESC/C0；任意路径读=本地工具威胁模型知悉保留（help 注明语义） |
| 11 | P2 | 恢复矩阵断言弱（两 driver 同载荷测不出缓存） | 采纳：第二 driver 独立 url/title；断言 snapshot 来源 + unchanged 链路（顺带修出恢复响应未回写 lastRendered 的真 bug） |
| 12 | P2 | 相邻存量缺陷：create 无 startUrl 被 scheme 闸拦 / 导航失败泄漏名额 | 采纳：无 startUrl 直开 about:blank（不过 S1①——非导航语义）；act 失败 destroySession 清场；测试覆盖 |

## 验证

- 四门：tsc 0 / lint 0-0 / build OK / 431 pass + coverage-gate PASS（源文件 38）
- 附带：B12 起会话响应带 unchanged 字段；serve 默认轨迹落盘 ~/.bw/trajectories（janitor 双目录）
