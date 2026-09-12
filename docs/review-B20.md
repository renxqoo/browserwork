# 对抗审查：B20（吸收 ego）

> 审查者：独立 general-purpose 子 agent（角色分离）· 2026-09-12 · 输入 = 未提交 diff + 05 §9；审查者跑通 B20 测试（16/16）并做对抗复现（已删）
> 结论：**P0×1（已实证安全绕过）+ P1×4 + P2×8 + P3×2**，全部处置。

## 处置表

| # | 级 | 摘要 | 处置 |
|---|---|---|---|
| 1 | P0 | agent batch 子步 navigate/open_tab 完全绕过 S1① 导航前检（审查者复现：evil.test 无确认直达+内容入上下文） | 采纳：onNavigate+gate 移入 runAction（单动作与 batch 共用同一闸面）；回归测试 |
| 2 | P1 | crossOrigin click 跳过 intentSink——跨帧提交零确认 | 采纳：crossOrigin 分支在坐标点击前构造意图（submit 类强制确认/link 上报）；外视口明确报错 |
| 3 | P1 | 嵌套 batch 未拒（步数乘法+钩子旁路+引擎快照缺陷） | 采纳：三处校验拒绝嵌套（agent preGate/sessions buildAction/engine）；engine batch 分支删除（P3-14 一并） |
| 4 | P1 | eval-b20 batchUses 恒 0（batch 不落轨迹——结构性死指标） | 采纳：onBatchComplete 钩子→run.ts 追加轨迹 llm/batch 条目；eval-b20 改数该条目 |
| 5 | P1 | CDP 并入轨只实证 same-site 跨域（127.x:不同端口）；真 OOPIF 未证 | 采纳：登记待实测（B16 real 门顺带——不动 chrome 代码）。types.ts 注释维持「跨域 iframe」表述，复测后如降级再改 |
| 6 | P2 | networkIdle 空/缺缓冲永不静默（白等满 cap） | 采纳：空/缺=已静默立即返回 |
| 7 | P2 | cdpPierceNodes.frameUrl 恒空串+嵌套 iframe 不下钻 | 采纳：frameUrl 随节点携带；walkFrame 帧内递归 |
| 8 | P2 | 每步提取都付全树 getDocument+30 次 quads | 采纳：shim 报无跨域 iframe 时跳过 CDP 轨（raw.warnings 门） |
| 9 | P2 | 会话 batch 双重计步（外层+子步） | 采纳：外层退 1，与 agent 对齐（子步各计）；测试 3=3 |
| 10 | P2 | keep 使下载目录无限期留盘 | 采纳：keep 时即清下载目录 |
| 11 | P2 | prompt Rule 1「one action per step」否定 batch；CLI wait 无 networkIdle | 采纳：Rule 1 改写；wait 命令加 [networkIdle] 位参 |
| 12 | P2 | batch「批准→续行」路径零测试 | 采纳：简化为「批准后同域后续子步放行」（事件 buffer 读 cid 方案实证后写入；原始 race 轮询在 SDK 层不可达，文档化） |
| 13 | P3 | loc= 偏差：a 不用 #id；转义不完整 | 采纳：a 也用 #id；属性值 encodeURIComponent（模板字面量内 regex 转义踩坑两次后改用） |
| 14 | P3 | engine batch 与 agent/session 三份循环重复 | 采纳：engine 分支删除（顶层拦截后不可达），防御性拒绝保留 |

## 处置中发现并修复的次生缺陷

- regex 转义在模板字面量（EXTRACT_EXPRESSION）内两次踩坑（`\]` 在模板内变形）→ 最终用 `encodeURIComponent` 根治——41 感知测试全绿
- crossOrigin click 初版自审发现未接线坐标轨 → 修复

## 验证

- 四门：tsc 0 / lint 0-0 / build OK / 530 pass + coverage PASS
- chrome 真视图：cdpPierceNodes 返回跨域按钮几何 ✓；快照 ⟂cross-frame + loc= ✓
- 真跑（§9.6）：batch 工具可用但 glm-5.3-flash 未自发使用（batchUses=0，修复指标后复测口径）——如实落档 BENCHMARKS §9
