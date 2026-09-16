# 错误深度恢复、安全模型与风控对抗

## 错误码全表

| code | 含义 | 恢复路径 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 索引不在当前快照——DOM 变了或用了旧索引 | 重新 snap；刚做过动作就从动作返回的 snapshot 读新索引 |
| `ELEMENT_NOT_ACTIONABLE` | 元素存在但不可交互（隐藏/零尺寸/被遮盖） | `scrollto` 到该元素；仍不行看快照找替代入口 |
| `EVAL_ERROR` | 页面 JS 异常或语法错 | 看**真实异常消息**修表达式（多语句自动包 IIFE；CJK 用 `--file`） |
| `NOT_FOUND` | 会话不存在（已关/TTL 回收/ID 打错） | `bw s list` 核对；重建 |
| `SESSION_BUSY` | 同会话前一条命令还在执行（flock 串行） | 等待后重试，不要并发打同一会话 |
| `SESSION_LIMIT` | 并发会话触顶（默认 16） | `bw s list` + `close`/`gc` 腾位 |
| `BROWSER_DEAD` | 浏览器进程死（崩溃/被杀） | **直接重试**——下次命令自动恢复（重拉浏览器+导航回安全页） |
| `POLICY_BLOCKED` | 安全策略硬拦截 | file://、内网地址（除非 `--allow-private-network`）——换正常 URL，不要绕 |
| `CONFIRMATION_REQUIRED` | 等人工批准 | `confirm --yes/--no`（见下） |
| `CONFIRMATION_DENIED` | 批准被拒或 120s 超时 | 停止该动作；有用户许可可重试一次 |
| `EVAL_DISABLED` | 会话没开 eval | 重建：`create --url ... --allow-eval`（无法中途开） |
| `TIMEOUT` | 页面 JS 卡死 | `navigate` 重载；还不行 `close` 重建 |
| `INVALID_TOOL_ARGS` | 参数形状不对 | 看 error 里的 usage；通常是顺序/类型 |
| `DRIVER_ERROR` | 驱动层异常 | 看报文：带 "data-dir is held by a leftover Chrome process" → `bw s gc` 清残留后重试；其余 `bw s list`，会话没了就 create |
| `BUDGET_EXCEEDED` | 步数预算耗尽 | 会话已强制关闭——create 新的 |
| `AUTH_IMPORT_FAILED` | Chrome 导入失败 | 按 error 区分：Keychain 未授权（弹窗点允许）/ 无该域 cookie（先登录）/ 加密方案变（Chrome 升级） |

## 连续失败时的诊断顺序

1. `bw s snap <id>` —— 看页面**现在**长什么样（多数"失败"是页面已经变了）
2. 看 `# URL:` —— 确认没被重定向/没被风控弹走
3. `bw s tabs <id>` —— 确认操作的是活动标签页（click 可能开了新 tab）
4. 换索引重试一次；仍失败 → `close` 重建，别在死会话上循环

## 确认门细节

- **S1**：导航目标不在白名单（起始域 + 会话内批准过的域）。同源链接 302 跳未知域会被事后复检**自动回滚**（响应附 `[S1③] violation rolled back` 行）——页面弹回安全页，不是错误
- **S2**：元素文本命中敏感词（支付/删除/转账）——即使同源也要确认。**clicktext 的文本同样过 S2 闸**
- 批准语义：域级批准会话内有效；动作级批准一次性放行（approve 即执行并返回结果）
- batch 中段子步确认：批准后**自动续行余下步骤**（返回 batch 汇总格式）

## 风控对抗（症状触发——先确认适用，别自我设限）

**适用判定：本节只对「高对抗风控站点」适用**——判定信号是被弹症状（`# URL:` 变成 `.../correspond/...`/`verify`/`passport` 类校验页、截图白但快照正常、页面几秒后自动跳走）。**自己的网站、内网部署、绝大多数普通站点没有这层风控**——登录态下滚动/点击/截图是正常操作，全部工具照用，不要预防性地回避。

chrome 后端已内置三层环境指纹清理（2026-09-14 实证）：`--disable-blink-features=AutomationControlled`（webdriver 恒 false）+ `--user-agent` 覆写（Bun 强制 --headless 导致 UA 带 HeadlessChrome 的反制；版本动态对齐真机）+ 可选 `--headed`（真窗口真渲染）。实证范围：B站级高对抗站点以外的日常浏览未被本套配置弹过——但不要据此预设「多数站点没事」，按上面的症状判定走。

**弹跳机制（B 站 2026-09-14 矩阵实测，弹到 `.../correspond/1/...`；其他大厂风控同理参考）**：

| 场景 | 结果 |
|---|---|
| 匿名会话 + 截图/任意操作 | ✅ 干净 |
| **导入登录态（--profile）+ 纯被动读取**（snap/extract/extract_code/eval fetch，50s+） | ✅ 干净 |
| **导入登录态 + 主动动作**（scroll/click/look 截图，第一个动作就触发） | ❌ 秒弹 |

机制：风控计分 = 登录态抬高基线 × 交互异常信号。被动取数不触发；带登录态做「像人的操作」反而最危险。

**确认被弹后的对策（按需求选）**：
1. **只是要数据**：登录态会话改走数据面——`eval fetch`（登录 cookie 自动携带）——实测页面被弹走时 API 依然可用。canonical 形式（**跨子域必须 `credentials:'include'`**——fetch 默认 same-origin 策略不带跨域 cookie，报「未登录」多半是它）：
   ```js
   // bw s eval <id> --file api.js
   const r = await fetch('https://api.example.com/x/...', { credentials: 'include' });
   return await r.json();
   ```
2. **必须要截图**：开匿名会话（无 --profile）截——实测干净；或 `--backend webkit`（不走 CDP，指纹族不同）
3. **必须要登录态交互**：接受可能弹一次校验页；`navigate` 回目标页有时直接恢复；持久 `--data-dir` 连续使用养设备指纹（`auth import-chrome` 只搬 cookie 不搬 localStorage 指纹——同一 `--data-dir` 用几个会话后自洽）

## 会话与预算

- 每会话独立浏览器进程 + 独立策略引擎；30 分钟无活动自动回收（`keep` 豁免）
- 步数预算 1 万步/会话；超限强制关闭
- 并发默认 16 会话；满了 `list` + `close`

## 已知限制（别在这些方向浪费时间）

- 拖拽、录像、网络拦截配置：不支持
- webkit 后端无下载/上传/requests/cookies-all/整页截图（chrome 后端有）
- webkit 的 httpOnly cookie 读写均不可见（chrome 经 CDP 可）
- console 捕获从首次提取开始——加载早期的日志拿不到
- 跨源 iframe 只显示占位节点（chrome 后端的 requests 可看其网络流量）
