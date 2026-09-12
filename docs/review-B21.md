# 对抗审查：B21（extract_code）

> 审查者：独立 general-purpose 子 agent（角色分离）· 2026-09-12 · 输入 = 未提交 diff + 05 §10；审查者实测复现 P0（构造链逃逸读 process.env）并跑通当时 14/14 测试
> 结论：**P0×1（实测安全逃逸）+ P1×2 + P2×5**，全部处置。审查期间自察另修 1 项（truncated 可见性，与 P1-2 同源，先于报告落地）。

## 处置表

| # | 级 | 摘要 | 处置 |
|---|---|---|---|
| 1 | P0 | vm 沙箱可逃逸：宿主 `tree/JSON/Math` 进 context → `X.constructor.constructor` 编译回 Worker realm（审查员实测：process/Bun/fetch 全可达、process.env 可读）；extract_code 默认开启（eval 尚需 opt-in）→ 提示注入一条短 payload 即读 GLM_API_KEY | 采纳：context **零宿主对象**——tree 以 `JSON.stringify` 字符串字面量内嵌脚本、目标 realm 内 `JSON.parse`；JSON/Math 用裸 context 自带 intrinsics。审查员验证过的修法。回归测试：三条构造链探针（tree/JSON/Math 出发）全返回 `"undefined"`。文档措辞降级为「realm 隔离（vm 非硬安全边界）」，不再声称「结构上不存在」 |
| 2 | P1 | truncated/nodeCount 算出即丢——>10000 节点页提取静默缺数据，`ok:true` 无信号 | 采纳（报告前已自察修复）：树截断时结果末尾附 `[warn] DOM tree truncated at 10000-node cap` 行；测试覆盖 |
| 3 | P1 | 会话轨迹落盘用未脱敏 `r.text`（HTTP 面已 redact，盘面裸奔；agent 模式 run.ts 是对的——extract_code 成唯一盘面泄漏工具） | 采纳：轨迹 `resultText` 改用脱敏后变量（HTTP 面=盘面同规则） |
| 4 | P2 | 密码源头掩码两个旁路：(a) `attrs` 平铺全量——服务端预填 `<input type=password value=明文>` 走 attrs.value 漏出；(b) `getAttribute("type")==="password"` 直比——`type=" password "`（枚举属性空白归一化）漏判，valueOf 发明文 | 采纳：判定改 IDL `el.type`（已归一化）；attrsOf 对密码 input 强制 `attrs.value="***"` |
| 5 | P2 | 结果截断静默返回无效 JSON（截在值中间无收尾）；环形引用返回 `"[object Object"` 假 ok；函数返回泄漏内部报错（`text.slice` 崩） | 采纳：超限**拒绝**（`result too large (N chars) — project to fewer fields`，可恢复语义）不裁断；stringify 抛错→`not JSON-serializable (circular?)`；返回 undefined→`(function/symbol?)`；删除 `String(result)` 兜底。测试三类覆盖 |
| 6 | P2 | extract_code 附全量快照：读操作白付 settle 等待 + 结果被压缩器当快照 keep-2 淘汰（工具存在的意义就是保这份数据）；extract_text 先例是 `snapshot:null` | 采纳：`snapshot:null`（提取不改 DOM，缓存快照仍有效）——agent 模式不再附 `[SNAPSHOT]` 标记，数据不进淘汰类 |
| 7 | P2 | `document.body===null`（解析中文档）→ 序列化器抛错 → 被 WebViewPage.evaluate 包装成 DRIVER_ERROR，LLM 看到 80 字符序列化器源码当「错误」 | 采纳：表达式内 `document.body && ser(...)` 空判——body 缺失返回占位空树（`{tag:"body"}`，与 serializeDomTree 兜底同形状）。evaluate 错误信息改进登记 B22 |
| 8 | P2 | 表单活态不可见：select 当前选中、checkbox/radio 的 checked 是活态属性不进 attrs——「提取当前表单状态」返回初始态，静默错 | 采纳：valueOf += select（`el.value`）；ser += checkbox/radio `checked` 布尔（同快照层 B12 裁决） |

## 审查确认无需处理

Worker 生命周期（finish 全路径清 timer、terminate().catch 挂接、settled 守卫覆盖 terminate/exit 竞态、不复用、无模块级全局——并发会话独立）；batch 嵌入（会话递归 executeTool 每子步 redact；agent runBatch 过 ctx.redact）；括号包裹不可被代码串破坏（单程序解析，语法错为结构化 ok:false）；nodeCount 精确；8KB 与 EVAL_MAX_RESULT 先例一致；SERIALIZE_TREE_EXPRESSION 纯页面 JS，webkit/chrome 同路径。

## 处置中补的测试

构造链逃逸×3 探针、环形/函数返回拒绝、超限拒绝（替换原「截断 8KB」用例——语义变了）、树截断告警行（自察项）。

## 关于 P0 的边界声明（文档同步降级）

vm 与 Node 同告诫：不是硬安全边界。修后剩余逃逸面属 JSC 引擎漏洞类（需利用 vm/解释器缺陷，而非一条构造链）。与 eval 的量级差：默认面零宿主引用可达 + 不在页面执行 + 代码≤4KB/3s/8KB。extract_code 保持默认开启（用户裁决：结构化提取唯一路径）——若未来威胁模型升级，可挂 eval 式 opt-in，接口已留（sessions buildAction 单点）。

## 验证

16/16（b21.test.ts）→ 四门（tsc / biome 0 error / build / 全量 546 tests）见提交前跑。
