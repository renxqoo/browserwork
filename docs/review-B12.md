# 对抗审查：B12（token 效率接线）

> 审查者：独立 general-purpose 子 agent（角色分离）· 2026-09-12 · 输入 = 未提交 diff + 05 §3.1–3.4 + pi-agent-core 0.73.1 源码
> 结论：无 P0；P1×4（两处击穿 §3.1/§3.2 核心承诺）+ P2×10，全部处置。
> 攻击后**不成立**的点（记录供回溯）：三阶段索引错位；S1③ 回滚后 unchanged 误报（渲染含 `# URL:` 行必不同）；render-equal 坐标漂移不一致窗口；terminate-after-batch 留悬挂 toolCall。

## 处置表

| # | 级 | 摘要 | 处置 |
|---|---|---|---|
| 1 | P1 | checked 不进提取/渲染——checkbox 勾选被误报 unchanged（§3.1 承诺落空） | 采纳：script.ts 提取 checkbox/radio `checked`、renderNode 渲染 `[checked]`、SnapNode.checked（不入 domHash）；勾选变化测试 |
| 2 | P1 | 阶段 1 `startsWith("[")` 前缀守卫 = 永久免疫洞（正文以 "[" 开头的 extract_text 4000 字不压） | 采纳：改长度阈值 `>200`（设计上单行 ≤120 天然豁免，无启发式） |
| 3 | P1 | user 消息（goal/steer）无裁剪阶段——第二有界性破口 | 采纳：阶段 3 扩到旧 user string content（>200 截断，最近 2 条不动） |
| 4 | P1 | 测试假绿：stuckRing 清零/steps、keep-2 计数、done×升级同批均未按规格断言 | 采纳：steps===6 精确断言；keep-2 改 `toBe(1)` + 6 连 unchanged；补 done 同批与跳变预警用例 |
| 5 | P2 | toolCall arguments 每轮上 wire 不计估算 | 采纳：itemsOf 附 argsJson 长度 |
| 6 | P2 | 全量快照×image 同 toolResult 的 else-if 互斥（latent） | 采纳：imageIdx 独立收集 |
| 7 | P2 | serve env 有 key 时窗口治理静默激活（行为变化未声明） | 采纳：04-usage 环境表加注 |
| 8 | P2 | BW_PRICES_JSON 不读 .env | 采纳：cli-run .env 补读（loadEnvFile 正则本就匹配） |
| 9 | P2 | pi every() 批语义：批中段升级整批不收束 → 多一轮旧模型；done 重复调用覆写答案 | 采纳+加固：afterToolCall 判据改全局旗标 done.called；**首个 done 定案**（重复不覆写）；测试固化 |
| 10 | P2 | 升级后 message.model 变 id → 价目键失配静默停计 | 采纳：costWarnedModels 按 id 逐个一次性告警 |
| 11 | P2 | 续跑 provider 失败丢升级前产出 | 采纳：errorMessage 分支 lastAssistantText 兜底（status 仍 failed 如实） |
| 12 | P2 | .gitignore `.claude/` 全忽略 → 项目 skill 永不入库 | 知悉保留：仓库无 remote/团队共享需求，skill 属本地工作流；如需共享改 `.claude/*` + `!.claude/skills/` 并配 biome files.ignore（登记，不改） |
| 13 | P2 | contextWindow 50/80 else-if：跳变直上 80% 漏发 50 / 回落补发倒挂 | 采纳：两档独立 if |
| 14 | P2 | 阶段 2 后 unchanged 标记链失去锚点 | 采纳为已知取舍：05 §3.2 注记（极端窗口压力下方发生；摘要含页首行） |

## 验证

- 四门：typecheck 0 / lint 0-0 / build OK / test 47（agent 包）+ 全量 398+ / coverage-gate PASS（run.ts 94.4% 行 92.9% 函数）
- 附带修复：sessions.test S1③ 存量 flaky（外网 example.com+DNS+回滚竞态三重不确定 → 本地第二 origin + wait 重提取断言，4 连跑稳定）
