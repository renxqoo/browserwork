# B11 安全加固 + 功能补齐（对齐 agent-browser 对比差距）

日期：2026-09-11 · 触发：与 vercel-labs/agent-browser 对比后的差距修复（用户指示「尤其是安全问题」）。

## 一、安全审计（11 项发现 → 全部处置）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| P0-1 | 高 | `bw serve` 无 `--token` → checkAuth 全拒，服务不可用，诱发用户把 token 写进 argv | createServer 缺省自动生成 token（永不无鉴权运行）并暴露 `server.token`；CLI 落盘 `~/.bw/serve.token`（0600） |
| P0-2 | 高 | daemon 把 token 放 argv → `ps aux` 全机可见 | token 改走 env `BW_TOKEN`；`serveSpawnArgs()` 导出供测试断言不含 token |
| P0-3 | 高 | **会话模式没接 S1③**：同源链接经 302/meta-refresh/JS 跳到未批准域不拦（agent 模式有回滚，外部会话模式没有）——策略绕过 | sessions.ts `wireSettledCheck`：每 page `onNavigated → onNavigationSettled`，违规 → 回滚 `lastAllowedUrl` + `NAVIGATION VIOLATION` 事件；集成测试验证 302 场景 |
| P0-4 | 中 | PID 文件默认 644 且含 token | 写入后显式 `chmod 0600`（serve.token 同） |
| P0-5 | 中 | 无 Host 校验 → DNS rebinding 面 | `isAllowedHost`：loopback 绑定只认 `127.0.0.1/localhost/[::1]`（±端口）；显式 `--host` 放行（运维自觉） |
| P1-6 | 中 | `req.json()` 不校验 content-type → text/plain 表单可构造 JSON（CSRF 面；Bearer 已缓解，纵深防御） | `readJsonBody`：非 `application/json` → 415 |
| P1-7 | 中 | 无 body 上限 → 本地内存 DoS | content-length / 文本长度 > 1MB → 413 |
| P1-8 | 低 | 会话 ID `sess-<时间戳>-<序号>` 可预测 | `sess-<uuid 前 13 位>` |
| P1-9 | 低 | token `===` 比较非常数时间 | sha256 + `timingSafeEqual` |
| P1-10 | 低 | 响应缺 nosniff/no-store（快照含页面内容可进 HTTP 缓存） | 所有 JSON/SSE 响应加 `x-content-type-options: nosniff` + `cache-control: no-store` |
| P1-11 | 低 | 不存在会话 GET /events 返回 200 空 SSE | 先查会话存在 → 404 |

附带修复：daemon 路径惰性解析（`BW_HOME` 测试覆写生效，测试不再污染真实 `~/.bw`）；手动 serve 探测区分「活着」（401）与「可用」（200）；ensureServer 支持复用手动 serve；HEAD 上既有的 7 处 lint 违规清零。

## 二、功能补齐（低成本高价值子集）

| 新工具 | 说明 | 安全边界 |
|---|---|---|
| `bw s console` | 页面 console 消息（提取时幂等安装环形缓冲 200 条，光标式增量读取） | 只读；页面可伪造 `__bwLogHooked` 阻断安装（与 settle 观察者同级风险，仅影响可用性不影响安全） |
| `bw s errors` | window.onerror / unhandledrejection（level=error 过滤） | 同上 |
| `bw s cookies` / `cookies-set` / `cookies-clear` | document.cookie 读/写/清 | httpOnly cookie 天然不可见（WebKit 限制，已文档化）；写仅 path=/ SameSite=Lax |
| `bw s storage` / `storage-set` / `storage-clear` | localStorage 读/写/清 | 键值经 JSON 转义安全内嵌表达式 |
| `bw s eval` | 受控 JS 求值：锁内 + 10s 超时 + 8K 截断 | **默认禁用**（EVAL_DISABLED）；`bw s create --allow-eval` 显式 opt-in；超时后页面 JS 线程可能卡死 → 提示 navigate/close 恢复 |

不实现项（Bun.WebView API 限制，登记为已知差距）：网络拦截（无请求钩子）、CDP 直连（webkit 无 CDP）、录像、拖拽、文件上传（chrome 后端可后续加）、设备模拟、React 分析。

## 三、实现落点

- `packages/service/src/server.ts` — 鉴权/Host/content-type/body/headers/SSE 404
- `packages/service/src/daemon.ts` — env token / 0600 / serveSpawnArgs / 惰性路径 / probeAuthorized
- `packages/service/src/sessions.ts` — S1③ 接线 / 随机 ID / allowEval / inspect 工具分发
- `packages/actions/src/engine.ts` — `inspect()` / `runExpression()`（与 act 同一 per-page 互斥锁）
- `packages/perception/src/script.ts` — console/error 捕获安装 + `DRAIN_LOGS_EXPRESSION`
- `packages/service/src/cli-session.ts` — 9 个新子命令 + EVAL_DISABLED/TIMEOUT 提示

## 四、测试与门禁

新增：`service/test/security.test.ts`（17）、`actions/test/inspect.test.ts`（8）、sessions 集成 4 项（S1③ 回滚 / 新工具矩阵 / ID 随机 / tabs+快照缓存）。
四门禁：typecheck ✓ · lint ✓（97 文件 0 违规，含 HEAD 既有 7 处清零）· test 384/0 ✓ · coverage ✓（daemon.ts 部分豁免 min=55：真实 spawn/空闲退出归 E2E）。

## 五、真机冒烟追加修复（dist 构建 + 自动 daemon + bun.com 实站）

| 问题 | 处置 |
|---|---|
| **存量 bug：5 个 CLI 命令在 HTTP 层全断** —— CLI 发 `scrollto/opentab/switchtab/closetab/extract`，服务端 buildAction 只认 `scroll_to/open_tab/switch_tab/close_tab/extract_text`（此前 E2E 级联失败根源之一） | `WIRE_NAMES` 规范名映射；连字符命令（cookies-set 等）同映射 |
| extract_text 把会话缓存快照清成 null → 后续 scroll_to 报 requires a snapshot | 快照只在 `r.snapshot !== null` 时覆盖（look/wait 同理） |
| `tabs` 在文档注释承诺但从未实现 | 服务端 tabs 工具（driver.pages() 只读清单）+ CLI 子命令 |
| 端口被陌生 token 的 bw serve 占用 → spawn 超时 5s 且误收养（后续全 401） | spawn 前 `isServerRunning` 预检 → 占用即明确报错（token mismatch 提示）；等待环改 probeAuthorized + 子进程退出快败 |
| `BW_SERVER_URL=`（空串）被当作已设置 | trim 后空串视为未设置（stopServer 同） |
| daemon 路径模块加载时固化 → 测试污染真实 ~/.bw | `pidDir()` 惰性解析（BW_HOME 可覆写），已清理污染文件 |

冒烟结论（bun.com 实站，全部通过）：create --allow-eval → eval 读 title → storage/cookies 读写 → console 捕获真实 Script error → extract（wire 修复）→ snap/scrollto/look（299KB 截图）/tabs/list/close/stop；`ps` 中无 token 泄漏。
