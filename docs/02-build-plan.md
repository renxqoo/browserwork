# 施工图（Browser Use on Bun.WebView）

> 状态：草稿 · 基线见 `01-baseline.md` · 单元契约见 `03-units.md`
> 每批次：实现 → 四门 → 对抗审查（独立子 agent）→ 逐条处置 → 提交（Conventional Commits，正文引用本文节号）

## 1. 四门定义（门禁集合，缺哪道补哪道，不许静默缺席）

| 门 | 命令 | 通过标准 |
|---|---|---|
| typecheck | `bunx tsc --noEmit`（项目 references） | 0 错误 |
| lint | `bunx biome check .` | **0 警告 0 错误** |
| build | `bun run build`（各包 `bun build --target=bun` 产物 + dts） | 退出码 0 |
| test | `bun test`（含覆盖率门） | 全绿 + 覆盖率达标 |

**覆盖率门**（B0 实测裁决，单轨）：Bun 1.4.2 的 bunfig `coverageThreshold` **不执行**（50% 覆盖配 90 阈值照样绿），且覆盖率只统计被 import 过的文件——未测文件隐形。自建真门 `scripts/coverage-gate.ts`：解析 lcov 强制**行/函数 ≥90（逐文件）**，并要求所有 `packages/*/src/**/*.ts` 出现在报告中，否则必须列入 `scripts/coverage-exemptions`（路径<TAB>理由，随批次清空，B8 收口必须为空）。Bun 的 lcov 无分支记录（BRDA），**分支覆盖不可测**——分支纪律由单元卡的边界双侧用例要求 + 对抗审查承担。只许补测试，禁止调阈值/加豁免换绿。

**门禁分层**：
- **默认门**（每次提交必须绿）：单元/契约测试 + 本地 fixture 站点的真 webview 集成测试（`http://127.0.0.1:<随机端口>`，无外网、无 LLM；测试用 `testPolicy` 测试档策略——fixture origin 预入白名单，S4 内网封锁对测试 origin 显式豁免，P1-14 处置）
- **平台矩阵**：macOS = 全量（webkit + chrome 双真 view）；Linux/CI = 单元/契约 + chrome 真 view（webkit 项显式标注 `skip-on-platform` 并计数上报，不算静默 skip）
- **real 门**（opt-in，`BW_REAL=1` + 真实 key 才跑）：真实外网站点 + 真实 LLM 的 e2e；不绿不阻塞提交，但 B8 收口前必须全绿一轮

## 2. 测试装置（一次性投入，后续复用）

1. **FakePage/FakeDriver**（`@bw/driver` 导出）：可编程替身——脚本化 `evaluate` 返回、navigate 状态机、可注入的 DOM 树快照；**click 必须模拟「选择器只查主文档、不穿 shadow/iframe」的真实语义**（防 P0-2 类缺陷在假驱动上测不出）；每用例 ephemeral storage（P1-12）；供 perception/actions/policies/agent 单元测试，零进程依赖
2. **fixture 站点**（`fixtures/` + 测试内 `Bun.serve` 起在随机端口）：静态页（链接/表单/输入/iframe/懒加载/shadow DOM/隐藏文本对抗样例/SPA 模拟）+ 两个可编程端点（`/api/*` JSON、`/redirect`）；页面内容文件化，测试断言与页面解耦
3. **真 webview 集成基座**（`@bw/testing`）：`withPage(fn)` 帮手——拉起 webkit view、跑用例、保证 close；测试间无共享可变状态，每用例新 view
4. **假 LLM**（`@bw/agent` 测试导出）：脚本化 provider——按剧本吐 toolCall/文本；agent 循环全部确定性可测，不依赖网络
5. **real 门装置**：`BW_REAL=1` 时用 `GLM_API_KEY` 真 LLM + 互联网 fixture 任务集

## 3. 批次划分（B0 → B8，每批独立提交可回滚）

| 批 | 内容 | 验收点 | 对抗审查 |
|---|---|---|---|
| **B0** | 基座：workspaces/tsconfig/biome/bunfig/四门可跑（含真实模块：core 错误分类法 + CLI 入口）+ 三件套文档 | 四门在含真实测试的骨架上通过（覆盖率门真实咬合，已做假绿抽查：豁免移除必红）；文档过对抗审查并处置完毕 | 审文档本身（大级规则，已完成 36 项处置见 `review-B0.md`） |
| **B1** | 探针 + de-risk 垂直切片：最小 driver 面（navigate/evaluate/click/screenshot）+ 最小感知（索引提取 v0）+ 脚本化旅程（fixture 站：打开→提取→点链接→断言新页） | 旅程集成测试绿；探针报告落档 `docs/probe-report.md`，探针清单：dialog 行为（含挂死风险）/window.open 归宿/**click(selector) 对 shadow DOM 元素的行为（P0-2）**/**重定向链 onNavigated 最终 URL（P0-1）**/evaluate 大结果上限/多 view 吞吐/SIGKILL 孤儿进程/data-bw-id×hydration/**chrome 后端 url:false 独立拉起验证（P1-11）**/evaluate 返回 undefined 归一 | 逐批审 |
| **B2** | driver 完整抽象：Driver/Page 接口、webkit+chrome 双后端（**chrome 默认 url:false**）、capabilities、tab 生命周期、FakePage、异常归一 | 双后端跑同一套接口契约测试（含 onNavigated 重定向终态断言） | 逐批审 |
| **B3** | perception 完整：索引树、shadow DOM/同源 iframe、**双轨坐标表**、隐藏过滤（不含视口外）、预算截断、domHash 复用、深度定位器 | 快照契约测试 + 对抗样例页（隐藏注入文本不进快照）+ 坐标换算（iframe 偏移） | 逐批审 |
| **B4** | actions：**每 page 互斥锁**、双轨索引桥、动作前校验（bw-id 主键）、导航意图解析、settle（上限照常继续）、动作集 | 表驱动动作矩阵 + **双轨分派矩阵** + 竞态（提取后 DOM 替换）+ submit 意图解析表 | 逐批审 |
| **B5** | policies：S1 三处挂钩决策、S2 含提交意图、S3 实际 origin、S4 归一化+DnsResolver、S5、S6 redact、预算、确认三态 | **越权矩阵**（注入样本 × 挂钩全维 × 绕过变体全表）+ 预算触顶矩阵 + secret 变体 redact | 逐批审（安全面） |
| **B6** | agent：pi 接入、工具动态注册、PendingConfirmation 状态机、done 协议、事件出域脱敏、transformContext 压缩、卡死检测+模型路由、预算计量、假 LLM | 假 LLM 全旅程矩阵（含确认门四路径/重定向回滚/done 后批次拦截）；上下文有界断言 | 逐批审 |
| **B7** | service：HTTP/SSE/确认/steer/轨迹存储脱敏 + CLI | SSE 事件序契约测试（终态恰好一次最后）；确认门超时=deny | 逐批审 |
| **B8** | 评测集 20-50 任务、对打 playwright-mcp、故障注入、并发压测、收口 | 四指标报告落档；验收清单核销；假绿抽查 | 审报告与抽查过程 |

**大级试运行（de-risk）**：B1 即切片批次——验证的是流程本身（方案歧义、装置可跑性、审查能不能抓到该抓的）。暴露问题先回改文档/规则再放量；切片代码即首个正式批次，后续在其上演进不推倒。

## 4. 评测口径（B8，先定口径后跑数）

- 任务集：20-50 个固定任务 = fixture 站（确定性断言）+ 公开真实站（搜索/表单/信息抽取，快照存档对比）
- 对照口径：本方与 playwright-mcp **由同一 GLM 模型驱动**——playwright-mcp 侧由评测装置内置的薄 MCP 客户端循环（GLM + MCP 工具调用）驱动，装置在 B8 前置准备中先行冒烟
- 指标：成功率 / 平均步数 / token 成本 / 墙钟时间
- 每任务 3 次取中位；失败样本归因分类（感知错/动作错/策略拦/LLM 错/站点变）
- 报告落 `docs/eval-report.md`，数字如实（包括输掉的项）

## 5. 过渡态与单轨纪律

- 允许的过渡：B1 最小 driver 与 B2 完整 driver 并存到 B2 收口；B6 前动作层以脚本 API 形式被测试消费
- 收口必须单轨：旧路径/别名/双轨字段在替代批次提交内删净；每个过渡在本文档登记，核销时划掉
- 过渡登记：(1) B1 感知提取 v0 → B3 完整版替换 [ ]；(2) B1 脚本旅程入口 → B6 agent 工具化 [ ]；(3) B1 `waitForNavigation` 最小等待（探针事实：click 后导航异步）→ B4 settle 取代 [ ]

## 6. 提交与汇报纪律

- Conventional Commits；正文引用 `02-build-plan.md` 节号与 `03-units.md` 单元卡号
- 每批收口报告：用例数、覆盖率数字、对抗审查问题数与处置（如实，不报「全绿」掩盖数字）
- 上下文受限时：提交可续状态进 git + 更新任务清单剩余项，不静默中断
