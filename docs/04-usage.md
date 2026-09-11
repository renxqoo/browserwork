# Browser Use (bw) 使用文档

基于 Bun.WebView 的浏览器自动化 agent。两种使用方式：

- **自治模式**（`bw run`）：一句话目标，内部 GLM 自己看页面、做决策、跑完任务
- **外部 agent 模式**（`bw s`）：把浏览器工具暴露给任意外部 LLM（Claude Code / GPT / 自研框架），一步一步驱动

两者共用同一套感知层（索引化 DOM 快照）、动作引擎和安全基线（S1–S6）。

---

## 0. 安装与构建

```bash
bun install
bun run build        # → dist/cli/cli.js（约 5MB，单文件）
```

平台支持：macOS 用系统 WebKit（零浏览器下载）；Linux 走 Chrome 后端。

快速自检：

```bash
bun dist/cli/cli.js --version
bun dist/cli/cli.js --help
```

下文以 `bw` 代指 `bun dist/cli/cli.js`（可 `alias bw='bun /path/to/dist/cli/cli.js'`）。

---

## 1. 自治模式：bw run

一句话给目标，agent 自己循环「快照 → 决策 → 动作」直到完成，全程事件流输出。

**前置**：需要 GLM 凭据（三处任选，优先级从高到低）：

1. 进程环境变量：`GLM_API_KEY` / `GLM_BASE_URL` / `GLM_MODEL`
2. 当前目录 `.env`
3. `~/.bw/.env`

```bash
export GLM_API_KEY=xxx
export GLM_MODEL=glm-5.3-flash    # 推理模型；内部自动 thinkingLevel=low

bw run "打开 https://bun.com 并总结首页三个要点"
bw run "搜索 Bun 的 GitHub 星数" --url https://github.com
bw run "..." --json               # 机器可读输出（任务事件流）
```

特点：

- 上下文自动压缩（老快照折叠成一行），50 步任务约 8K token
- 预算控制：步数/token/时长三重上限，超限强制终止
- 安全事件（确认、违规回滚）实时打印，secret 永不回显

---

## 2. 外部 agent 模式：bw s

### 2.1 零配置启动

`bw s` 第一次使用时**自动拉起后台服务**（daemon），无需手动 `bw serve`：

- 服务只绑 `127.0.0.1`，鉴权 token 自动生成，经环境变量传给子进程（`ps` 不可见）
- 状态文件在 `~/.bw/`（`serve.pid` / `serve.token`，权限 0600）
- 全部会话关闭后 60s 无操作自动退出

```bash
bw s stop          # 手动停掉后台服务
```

### 2.2 一个完整工作流

```bash
# ① 创建会话（快照索引从真实页面生成）
$ bw s create --url https://bun.com
{"ok":true,"sessionId":"sess-1fbd1489-3d34","result":"https://bun.com/"}

# ② 看快照——每个可交互元素一个 [N] 索引
$ bw s snap sess-1fbd1489-3d34
{"ok":true,"sessionId":"...","snapshot":"# Page: Bun — ...\n[3] link \"Docs\"\n[4] button \"Get Started\"..."}

# ③ 点 [3]、输入、按键……全部动作后返回新快照
$ bw s click sess-1fbd1489-3d34 3
{"ok":true,"tool":"click","result":"clicked [3] Docs","snapshot":"# Page: ..."}

# ④ 读取结果
$ bw s extract sess-1fbd1489-3d34
$ bw s look sess-1fbd1489-3d34 --out shot.png

# ⑤ 关闭
$ bw s close sess-1fbd1489-3d34
```

**索引规则**：动作后页面重新提取，索引号会变——每次动作的返回里已带新快照；隔了几个动作再操作，先 `snap`。

### 2.3 命令总表

| 会话/页面 | |
|---|---|
| `create [--url U] [--allow-eval]` | 建会话；`--allow-eval` 显式开启 eval |
| `list` | 活跃会话清单 |
| `snap <id>` | 当前快照 |
| `extract <id>` | 页面正文文本（≤4000 字） |
| `look <id> [--out F]` | 截图（默认存 /tmp） |
| `close <id>` | 关会话 |
| `stop` | 停后台服务 |

| 交互 | |
|---|---|
| `click <id> <index>` | 点击（shadow DOM / iframe 自动走坐标轨） |
| `type <id> <index> <text>` | 输入文本 |
| `press <id> <key>` | 按键（`Enter` / `Tab` / `Control+a`…） |
| `select <id> <index> <value>` | 下拉选择 |
| `scroll <id> <up\|down\|left\|right> [px]` | 滚动 |
| `scrollto <id> <index>` | 滚到某元素 |
| `wait <id> <seconds>` | 等待 |
| `navigate <id> <url>` | 导航（过安全闸） |

| 标签页 | |
|---|---|
| `opentab <id> <url>` | 新标签页 |
| `tabs <id>` | 标签页清单（索引+URL+标题） |
| `switchtab <id> <n>` | 切换 |
| `closetab <id>` | 关当前标签页 |

| 调试/状态 | |
|---|---|
| `console <id>` | 增量读取页面 console 消息 |
| `errors <id>` | 页面错误（onerror / unhandledrejection） |
| `cookies <id>` | 读 cookie（httpOnly 不可见） |
| `cookies-set <id> <name> <value>` | 写 cookie（path=/, SameSite=Lax） |
| `cookies-clear <id>` | 清可见 cookie |
| `storage <id> [key]` | localStorage 全量/单键 |
| `storage-set <id> <key> <value>` | 写 |
| `storage-clear <id>` | 清 |
| `eval <id> <js表达式>` | 受控求值（见 2.5） |

### 2.4 统一输出格式

成功：`{"ok":true, ...}`；失败：`{"ok":false, "code":"...", "error":"...", "hint":"下一步建议", "sessionId":...}`（exit 1）。

常见错误码：

| code | 含义 | hint 要点 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 索引失效（DOM 变了） | 重新 `snap` |
| `ELEMENT_NOT_ACTIONABLE` | 元素隐藏/不可交互 | 先 `scrollto` |
| `POLICY_BLOCKED` | 安全策略拦截 | 检查 origin 白名单 |
| `CONFIRMATION_REQUIRED` | 需要人工确认 | 见 2.6 |
| `CONFIRMATION_DENIED` | 确认被拒/超时 | |
| `EVAL_DISABLED` | 会话未开 eval | `create --allow-eval` |
| `TIMEOUT` | 页面 JS 卡死 | 重新 navigate 或 close |
| `INVALID_TOOL_ARGS` | 参数不对 | `bw s --help` |
| `DRIVER_ERROR` | 驱动层错误 | 会话可能已过期，`bw s list` |

### 2.5 eval 的边界

默认禁用。`create --allow-eval` 显式开启后：

```bash
$ bw s create --url https://example.com --allow-eval
$ bw s eval <id> "document.title"
{"ok":true,"result":"\"Example Domain\""}
```

- 在页面互斥锁内执行，10s 超时，结果截断 8K
- 超时后页面 JS 线程可能卡死——navigate 或 close 恢复
- 仍然是任意代码执行面：只在你信任目标页面时开启

### 2.6 确认门（人工审批）

导航到白名单外域名、点击敏感词按钮（支付/删除等）时，工具不执行，返回确认请求：

```bash
$ bw s navigate <id> https://other-site.com
{"ok":true,"cid":"sc-8h2k1x9p","reason":"origin not in whitelist","result":"CONFIRMATION_REQUIRED: ..."}

$ bw s confirm <id> sc-8h2k1x9p --yes    # 或 --no
```

默认 120s 不处理 = 拒绝。

---

## 3. HTTP API（外部框架直连）

不想 shell 出 CLI 的框架可以直接走 REST。与 CLI 同一服务。

**鉴权**：所有请求 `Authorization: Bearer <token>`。`bw serve` 不带 `--token` 时自动生成并打印/落盘（`~/.bw/serve.token`）。

**约束**：POST 请求体必须 `content-type: application/json` 且 ≤1MB（415/413）；服务只绑 127.0.0.1。

### 自治任务

```
POST /tasks              {"goal":"...", "startUrl":"..."}     → 202 {"id"}
GET  /tasks/:id                                            → 200 {"status":"running|finished","result"?}
GET  /tasks/:id/events    (SSE，事件流：message_update/tool_execution_*/task_done...)
POST /tasks/:id/steer     {"text":"补充指示"}
POST /tasks/:id/abort     {"reason":"..."}
POST /tasks/:id/confirmations/:cid  {"approve":true}
```

### 外部会话

```
POST   /sessions                        {"startUrl":"...", "allowEval":false}  → 201 {"id","url",...}
GET    /sessions                        → 会话列表
GET    /sessions/:id                    → 会话信息
DELETE /sessions/:id                    → 关闭
GET    /sessions/:id/snapshot           → {"snapshot":"# Page: ..."}
GET    /sessions/:id/events             (SSE)
POST   /sessions/:id/tools/<name>       参数同 CLI（{"index":"5"} 等）
POST   /sessions/:id/confirmations/:cid {"approve":true}
```

工具名用规范形式：`scroll_to` / `open_tab` / `switch_tab` / `close_tab` / `extract_text` / `cookies_set` / `storage_set` 等。需要确认时返回 **202** + `cid`。

### curl 示例

```bash
TOKEN=$(cat ~/.bw/serve.token)
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"startUrl":"https://bun.com"}' http://127.0.0.1:3456/sessions
```

---

## 4. SDK（进程内，无 HTTP）

在自有 Bun 程序里直接驱动（浏览器生命周期 = 宿主进程）：

```ts
import { createSessionManager } from "@bw/service";
import { runTask } from "@bw/agent";

// 外部会话式（自己写循环）
const mgr = createSessionManager({ maxSessions: 4 });
const s = await mgr.create("https://bun.com");
const r = await mgr.executeTool(s.id, "click", { index: "3" });
if (r.ok) console.log(r.snapshot);
mgr.close(s.id);

// 自治式
const handle = runTask({ goal: "总结这个页面", startUrl: "https://bun.com" });
for await (const e of handle.events) console.log(e.type);
console.log(await handle.result());
```

---

## 5. 安全模型（S1–S6 速览）

| 规则 | 内容 | 触发表现 |
|---|---|---|
| S1 | origin 白名单：起始域自动放行，其余导航三道闸（前检/意图/落定复检） | `CONFIRMATION_REQUIRED`；同源 302 跳未知域自动回滚 |
| S2 | 敏感词闸（NFKC 归一防混淆）：支付/删除类按钮 | 确认门 |
| S3 | secret 与 origin 绑定 | 未配置时 `type_text_secret` 拒绝 |
| S4 | URL 硬拦截：file://、裸 IP（IPv4 全记法/IPv6/ULA） | `POLICY_BLOCKED` |
| S5 | 出域扫描（链接/表单目标） | 拦截或确认 |
| S6 | secret 脱敏 + 输过 secret 的页面禁截图 | 输出打码；`look` 拒绝 |

服务面（B11 加固）：Bearer 强制（无 token 自动生成，永不裸奔）· Host 白名单防 DNS rebinding · content-type 强制 JSON 防 CSRF · body 1MB 上限 · 响应 `nosniff`/`no-store` · token 不落 argv/文件 0600。

---

## 6. 环境变量

| 变量 | 作用 |
|---|---|
| `BW_SERVER_URL` | 指定远程 bw serve 地址（跳过本地 daemon；空串视为未设置） |
| `BW_TOKEN` | 手动 serve/远程连接时的 Bearer token |
| `BW_HOME` | 状态目录（默认 `~/.bw`；测试隔离用） |
| `GLM_API_KEY` / `GLM_BASE_URL` / `GLM_MODEL` | 自治模式 LLM 凭据 |
| `GLM_STRONG_MODEL` | 卡死升级用强模型 id（B12：连续 3 步页面同态时切换续跑） |
| `BW_PRICES_JSON` | 价目表 `{"模型id":{"input":USD,"output":USD}}`（每 1M token；CLI 也认 .env）；配了才有 `cost` 计量 |

> 注意：serve 进程的 env 里有 `GLM_API_KEY` 时，`POST /tasks` 会自动装配模型——上下文窗口治理（0.5×窗口压缩、50%/80% 预警、contextWindow 硬预算）随之生效，长任务可能以 `budget_exceeded(contextWindow)` 提前终局（B12 起的行为）。

手动起服务（一般不需要）：

```bash
bw serve --port 3456            # 自动生成 token 并落盘
bw serve --token my-token       # 显式指定（注意：会出现在 shell 历史里）
```

---

## 7. 已知限制

- 网络拦截 / CDP 直连 / 录像 / 拖拽：Bun.WebView API 未暴露，暂不支持（文件上传在 Chrome 后端可后续加）
- httpOnly cookie 读写不可见（WebKit 限制）
- console 捕获自首次提取起——页面加载早期的消息拿不到
- Linux 平台安全闸、坐标轨等以 Chrome 后端探针为准，部分行为与 WebKit 有差异
