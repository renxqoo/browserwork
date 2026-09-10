# B1 对抗审查处置记录

> 审查者：独立子 agent（无实现上下文），指令「假设代码是错的」；非静态问题均以一次性探针在真 webkit 实证（审查者自跑后删除探针）。
> 结论：**18 条全部处置（修复 16 / 裁决改文档 2）**；四门复核全绿后提交。

## P1（契约破裂，全部修复）

| ID | 问题 | 处置 | 回归用例 |
|---|---|---|---|
| P1-1 密码框大小写绕过（S6 破裂） | `type="PASSWORD"` 明文进快照 | 提取脚本 type 统一 `toLowerCase()` | adversarial：PASSWORD 恒 `***` |
| P1-2 12K 硬预算被页面可控 title/url 击穿（20K title → 40K 输出） | 头部字段有界：title ≤200 / url ≤500，单行化；元素行换行归一防伪造快照行 | adversarial：超长 title + 换行注入 |
| P1-3 domHash 滚动敏感（below 参与指纹） | 指纹剔除 below（回到 U3 契约字段集） | adversarial：滚动前后 hash 相等 |
| P1-4 隐藏标题绕过全部不可见过滤直达 LLM | 可见性过滤对 headings 同样生效 | adversarial：display:none/hidden/2px 标题不入快照 |

## P2（全部处置）

| ID | 处置 |
|---|---|
| P2-1 click 选项丢失 | 修复：normalizeClickOpts 合并透传 |
| P2-2 driver.close 后 createPage 仍可用 | 修复：closed 标志 + 契约测试 |
| P2-3 navigate 错误一刀切 | 修复：`ERR_INVALID_STATE` → `DRIVER_ERROR`，其余 `NAVIGATION_FAILED` |
| P2-4 navigate timeoutMs 谎言 | 修复：Promise.race 超时抛 `TIMEOUT`（弃等语义文档化） |
| P2-5 truncated 字符串匹配误报 | 修复：renderPlan 结构化返回 truncated/renderedCount |
| P2-6 url 读取竞态 | 修复：url 改由页面内 `location.href` 与 nodes 同瞬取出 |
| P2-7 监听器无隔离 | 修复：逐 listener try/catch |
| P2-8 fixture 根路径 EISDIR 500 | 修复：statSync isFile 检查 → 404 + 测试 |
| P2-9 waitForNavigation 边缘 | 驳回不改：已登记为 B4 settle 前过渡态（02 §5） |
| P2-10 退订断言 no-op | 修复：精确断言（退订后零新事件） |
| P2-11 重定向终态无契约测试 | 修复：driver 契约测试（onNavigated == [最终URL]） |
| P2-12 并发 evaluate 契约漂移 | **裁决改文档**：串行化优于报错，U2 契约改为「互斥链排队，ERR_INVALID_STATE 不外泄」 |
| P2-13 below 标注不完整 | **裁决登记**：v0 below = 仅视口下方，完整坐标表归 B3（U3 已注记） |
| P2-14 裸 Error 逃逸 | 修复：形状校验抛 BWError(DRIVER_ERROR) |

## 审查流程结论（de-risk 元目标）

审查抓到了 4 条「测试套件恰好没测到的那一侧」的契约破裂——流程本身有效（方案歧义→实证→修复→回归闭环跑通），B2 起按本口径逐批审。
