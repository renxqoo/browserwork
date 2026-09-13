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
bw run "..." --verbose            # 过程中打印每步快照头 15 行
bw run "..." --max-steps 20       # 步数上限（默认 50）
```

执行过程（紧凑双行）：每个工具显示 `▸ [n/max] 工具 参数`、`✓ 结果首行 (耗时)`、
`↳ 页面标题 · N 元素`（与上一步相同页标注「页面未变」）；确认门如实提示
「120s 后自动拒绝；起始域可用 --url 预授权」（CLI 不交互——脚本场景语义）。
轨迹默认落盘 `~/.bw/trajectories/<taskId>.jsonl`，跑完可 `bw replay <taskId>` 回看。

特点：

- 上下文自动压缩（老快照折叠成一行 + unchanged 标记跳过重读）——真站对打实测 token 比 playwright-mcp 少 43%（docs/eval-report-B16.md）
- 预算控制：步数/token/时长三重上限，超限强制终止
- 安全事件（确认、违规回滚）实时打印，secret 永不回显

---

## 2. 外部 agent 模式：bw s

### 2.1 零配置——没有服务

`bw s` **没有任何后台服务/daemon**（B22 起删除）：每条命令是独立进程，直连
`~/.bw/session/<id>/` 里的文件会话；每会话一个轻量 helper 进程持有浏览器
（unix socket，无端口无 token，`bw s close` 或 TTL 过期即退）。

```bash
bw s list          # 看当前会话（~/.bw/session/ 扫描）
bw s gc            # 清扫过期/僵尸会话
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
| `create [--url U] [--name 任务名] [--allow-eval] [--allow-private-network]` | 建会话（--name 3-6 词任务名）；`--allow-eval` 显式开启 eval；`--allow-private-network` 放行本地/内网地址——需 serve 进程 `BW_ALLOW_PRIVATE_NETWORK=1` 开门（生产档 S4 默认封锁） |
| `list` | 活跃会话清单 |
| `snap <id>` | 当前快照 |
| `extract <id>` | 页面正文文本（≤4000 字） |
| `extract_code <id> '<js>'` | 写纯函数提取结构化数据：`(tree) => …` 在冻结 DOM 树副本上沙箱执行（Worker+vm；代码≤4KB / 3s / 结果≤8KB；密码恒 `***`）。树形状见 04 附录 extract_code |
| `look <id> [--out F]` | 截图（默认存 /tmp） |
| `close <id>` | 关会话 |
| `status <id>` / `gc` | 会话状态 / 清扫 |

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
| `batch <id> '<json>'` | 类型化动作序列（≤10 步；首错即停带进度；仅末步附快照） |
| `keep <id>` | 标记保留（TTL 不回收，显式 close 才销毁） |
| `rename <id> <name>` | 会话改名（任务记账） |
| `resize <id> <w> <h>` | 视口尺寸（快照坐标刷新） |
| `reload <id>` | 重新加载（POST 落点过确认门） |
| `download <id> <index>` | 点下载链接存文件（仅 chrome；单文件≤100MB） |
| `upload <id> <index> <file>…` | 上传文件（仅 chrome；目录外走确认门） |
| `requests <id>` | 最近网络请求（仅 chrome） |
| `cookies-all <id>` | 全量 cookie 元数据，值掩码（仅 chrome） |

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

`create` 另收：`--backend <webkit\|chrome>`、`--data-dir <dir>`（登录态持久化；chrome 为进程级首会话生效）、`--chrome-path`、`--width/--height`、`--ua`。`bw run` 同名 flag 一致。

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

### 2.5b extract_code 的树形状

`extract_code` 的入参是纯函数表达式，`tree` 为冻结的 body 副本（不碰活页面）：

```js
(tree) => tree.children
  .filter(n => n.tag === "li")
  .map(n => ({ id: n.attrs?.["data-id"], text: n.text }))
```

节点形状：`{ tag, attrs?, text?, value?, checked?, children? }`——`text` 只含直属文本（子元素文本在子节点里，拼列表请用递归或按需下钻）；`value` 是 input/textarea/**select** 当前值（密码恒 `***`，源头掩码——含 value 属性面）；`checked` 是 checkbox/radio 勾选态；shadow root 已穿透、同源 iframe 已下钻、跨域 iframe 为 `{tag:"iframe", attrs:{src}}` 占位。上限：节点 10000 / 文本 200 字 / 属性值 500 字；树超节点上限被裁时结果末尾附 `[warn] DOM tree truncated` 行（数据可能不完整，据此换策略或分块提取）；**结果 JSON >8KB 直接拒绝**（不是截断——截断的 JSON 解析不了），收窄投影后重试。

### 2.6 确认门（人工审批）

导航到白名单外域名、点击敏感词按钮（支付/删除等）时，工具不执行，返回确认请求：

```bash
$ bw s navigate <id> https://other-site.com
{"ok":true,"cid":"sc-8h2k1x9p","reason":"origin not in whitelist","result":"CONFIRMATION_REQUIRED: ..."}

$ bw s confirm <id> sc-8h2k1x9p --yes    # 或 --no
```

默认 120s 不处理 = 拒绝。

---

## 3. SDK（进程内二次开发——原 HTTP API 已删除）

B22 起无 HTTP 面（U1 用户裁决）。框架/程序内集成走根包直接导出的 SDK：

```ts
import { bw } from "browserwork";

const s = await bw.sessions.create({ url: "https://bun.com" });
const snap = await bw.sessions.snapshot(s.id);
const r = await bw.sessions.executeTool(s.id, "click", { index: "3" });
await bw.sessions.close(s.id);

const task = bw.run({ goal: "总结 bun.com 首页三点", startUrl: "https://bun.com" });
for await (const ev of task.events) {}
const result = await task.result();

await bw.sessions.captureProfile(s.id, "github");   // 登录态快照（显式 save）
```

- `TaskHandle.events` 为单消费者流（多订阅互抢）
- 会话文件布局属公开契约（`~/.bw/session/<id>/`——DESIGN §1.2）

---

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
| `BW_ALLOW_PRIVATE_NETWORK` | `=1` 时才接受 create 的 allowPrivateNetwork（本地/内网 S4 放行的总闸） |
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
