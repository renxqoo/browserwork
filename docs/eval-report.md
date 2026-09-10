# B8 评测报告与收口验收

> 日期：2026-09-10 · 评测装置见 `packages/agent/test/eval.ts` · fixture 报告见 `eval-report-fixture.md`

## 四指标（fixture 站 · 假 LLM · 确定性默认门）

| 指标 | 值 |
|---|---|
| 任务数 | 23 |
| 成功率 | 91.3%（21/23——2 项为 budget/abort 预期失败场景） |
| 平均步数 | 1.2 |
| 总 token | 5,610（假 LLM 固定 usage——真 GLM 见 real 门） |
| 总墙钟 | 28s（≈1.2s/任务——含 settle 等待） |

## Real 门（GLM 真模型冒烟）

- 端点：`open.bigmodel.cn/api/paas/v4`（`.env` 的 `GLM_BASE_URL` 已含完整端点——需剥 `/chat/completions`）
- 模型：`glm-5.3-flash`（reasoning 模型——`thinkingLevel: "low"` 必须设，否则 400「该模型始终思考」）
- 结果：3 步完成「打开→点击链接→报标题」（15K tokens，含 reasoning tokens）
- 前置实证：探针 p11（tools 正确、reasoning 计入 completion）

## 对打 playwright-mcp

**本批未跑**——需要独立评测装置（薄 MCP 客户端 + 同一 GLM 驱动 playwright-mcp + 任务集交叉），属后续独立评测。

## 验收清单核销

### 外部契约逐条（01-baseline §4）

- [x] `runTask(req, opts) → TaskHandle`——`@bw/agent` 导出
- [x] `TaskHandle.events: AsyncIterable<TaskEvent>`——task_done 恰好一次且最后（342 测试覆盖）
- [x] `steer/confirm/abort/result`——终态后 steer/confirm 抛错、result 幂等（测试覆盖）
- [x] `TaskResult.status: done/failed/aborted/budget_exceeded`——全路径覆盖
- [x] `POST /tasks` → 202 · `GET /tasks/:id` · `GET /tasks/:id/events`（SSE）· `steer` · `abort` · `confirmations/:cid`（全端点测试覆盖）
- [x] SSE 脱敏（事件出域统一 redact）· 有界队列 1000（溢出合并 message_update）
- [x] Bearer 鉴权（无 token = 401 全拒；错 token = 401）
- [x] 确认门唯一计时器 120s（超时 = deny——测试覆盖）
- [x] 并发 ≤8（超出 429——测试覆盖）

### 边界/异常清单逐条

- [x] S4 全记法（十进制/十六进制/八进制/短形/IPv6 含 ::ffff: 映射/ULA/链路本地/尾点/空标签）——129 用例
- [x] S5 egress（24 位 token/JWT 点分隔/邮箱/手机号/secret 子串含 base64/base64url/hex/双重编码/大小写）——20+ 回归
- [x] S2 零宽字符/全角/分隔符不绕过——回归
- [x] S3 origin 伪造（userinfo@）不通过——实证
- [x] S6 redact 前缀碰撞不泄漏长者尾巴——回归
- [x] 预算 NaN/负数/Infinity 拒绝·contextWindow 独立计量·usage 副本——回归
- [x] 迟到批准防护（settled 判违规的主机不能洗白）——回归
- [x] 确认批准令牌废除（同签名动作始终重新确认）——回归
- [x] DOM 漂移→ELEMENT_NOT_FOUND（非误点同名孪生）——回归
- [x] 坐标轨滚动后重定位（陈旧坐标假成功）——回归
- [x] click 触发 JS 跳转后返回落地页快照（非旧页）——回归

### 并发/一致性预算逐条（01 §6）

- [x] 每 page 互斥锁（runExclusive）——实现
- [x] 快照 ≤12,000 字符（头部有界 + 页脚三级回退）——测试
- [x] settle 静默 500ms / 上限 10s 到点继续——测试
- [x] 多 view 并发度 ≈2×（探针 p4）——实测在案
- [x] 轨迹 JSONL + 内存替身——实现
- [x] transformContext 保留最近 2 快照（压缩有界）——测试

### 四门

- [x] typecheck（tsc --noEmit strict + exactOptionalPropertyTypes）
- [x] lint（biome 0 警告 0 错误）
- [x] build（bun build → dist/cli 5.12MB，`bw --version/--help` 通过）
- [x] test（342 用例全绿）+ coverage-gate PASS（行 95.9% / 函数 95.4%）

### 豁免清单

核心包（core/driver/perception/actions/policies/agent）**豁免为空**。
service 包 3 项部分豁免（min=70~75）——残余为 SSE 网络故障分支与 printEvent 事件分支，属基础设施级集成测试范畴。

### 假绿对抗抽查

- [x] 覆盖率门「咬合」验证：移除豁免必红（B0 实测）
- [x] 豁免失效检测：文件进 lcov 后豁免条目自动报错（coverage-gate 逻辑）
- [x] 断言弱于规格的测试已全部加强（B4-B6 各审查回归）

## 已知遗留项（登记）

| 项 | 影响 | 计划 |
|---|---|---|
| playwright-mcp 对打 | 无对比数据（「更好用」缺数字） | 独立评测装置（薄 MCP 客户端 + 同一 GLM） |
| costUsd 维度 | 从未消费（价目表未注入） | B8 后配置层 |
| MCP 服务器接口 | 未做 | 独立批次（薄适配层） |
| file sink 作服务缺省 | service 默认用内存 sink | B8 后 service 配置化 |
| 真实外网评测 | fixture 站确定性 ≠ 真实站点复杂度 | real 门扩展 |
| reactish 页真 React | 模拟受控组件（InsertText 面已验证） | real 门真 React 站 |
