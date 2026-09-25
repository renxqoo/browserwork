---
name: bw
description: 用 bw CLI 驱动真实浏览器完成网页任务——打开页面、按索引点击/输入、按文本点击 SPA 元素、结构化数据提取（extract_code）、整页截图、登录态复用（import-chrome/profile）、多标签页、读 console。任何需要操作真实网站的任务都用本 skill：查资料、填表单、提交搜索、截图、验证部署效果、抓取需要 JS 渲染的页面、用登录态访问内部系统。即使用户只说"打开这个网站看看""帮我看看这个页面上有什么"，也用本 skill。不要用 curl 抓需要渲染或交互的页面——那拿到的是空壳 HTML。
---

# bw：命令行驱动真实浏览器

## 心智模型（决定成败的 5 件事）

1. **会话是文件，不是服务**。`bw s create` 建会话（一个独立浏览器进程 + `~/.bw/session/<id>/` 目录）；每条 `bw s` 命令是独立进程直连那个浏览器。没有 daemon、没有端口、没有 token——不要问服务在不在，也不存在 `bw serve`。
2. **索引每次动作后重排**。快照里 `[3] link "Docs"` 的 `3` 只在那一份快照里有效。动作返回**自带新快照**——直接用它，省一次 snap；隔了别的操作再操作，先 `snap`。
3. **拿数据优先 extract_code**。`(tree) => …` 一次调用返回结构化 JSON（列表/表格/商品）——对比逐屏滚动+extract 的多轮读取，省的是**轮次**（一次往返 vs N 次滚动+读），token 上整体对打实测约 1.7 倍优势（B16 eval）。这是本工具对 agent 的最大价值点。它是默认起点不是限制：结果超 8KB 被拒时收窄投影重试，要按视觉顺序通读（长文/攻略）时滚动+extract 照样是正路。
4. **snap 是文本不是图**。要截图用 `look`（chrome 后端可 `--full` 整页），要页面全文用 `extract`（≤4000 字，超限附截断标记）。snap 给的是状态头 + `# Headings:`（h1-h3 原文）+ 可交互元素索引。
5. **输出统一 JSON**。失败必有 `code` + `hint`——按 hint 走，不要换着参数瞎试。

## CLI 入口

已发布 npm——两种用法（下文 `bw` 均指安装后的命令）：

```bash
bun i -g browserwork        # 全局安装（或 npm i -g browserwork），之后直接用 bw
bunx browserwork s list     # 免安装一次性执行——下文的 bw 替换为 bunx browserwork 即可
```

## 任务→工具决策表（先看这里再动手）

| 你要做的事 | 用什么 | 为什么 |
|---|---|---|
| 拿页面上的结构化数据（列表/表格/价格/评论） | `extract_code <id> '(tree) => …'` | 一次往返拿全（滚动+extract 要 N 轮）；冻结树沙箱，密码恒 `***` |
| 看页面标题/大纲 | `snap` | `# Headings:` 行就是答案 |
| 拿页面全文 | `extract` | ≤4000 字；数据密集页会截断（末尾有标记）——改用 extract_code |
| 点击 React/Vue SPA 的 div 元素（无 onclick/role） | `clicktext <id> <文本>` | 坐标轨命中事件委托；多匹配点最精确的 |
| 填多个字段的表单 | `batch <id> '<json>'` | 一次往返 ≤10 步；返回带进度和末快照 |
| 截长图 | `look <id> --full`（需 chrome 后端） | 整页一拍，省 scroll+look 轮次 |
| 带登录态访问 | `create --profile <name>` | 见下方「登录态」 |
| 排查页面白屏/报错/行为异常 | `errors` + `console` + `requests`（chrome） | 页面 JS 异常、应用日志、网络请求一次看全；自站调试同理 |
| 人眼看页面 / DevTools / 外部工具并连调试 | `create --debug-port 0 [--headed]` → `bw s cdp <id>` | 真窗口 + 外部调试口（DevTools 打开 httpUrl / puppeteer.connect）；见 advanced.md |
| 测 Electron app（UI 层）/ 驱动外部浏览器 | `create --electron <bin> [--electron-arg …]` 或 `--cdp-url http://…:port` | 收养对方窗口、全工具照用；close 只断连（--electron 的 app 除外）；见 advanced.md |
| 页面里跑 JS（computed style/调页面函数/自站接口联调） | `eval`（需 `create --allow-eval`） | 多语句自动包 IIFE；CJK 表达式用 `eval --file x.js` |

## 核心循环

```bash
# 1. 建会话——返回 sessionId，后续所有命令都要带
bw s create --url https://example.com
# {"ok":true,"sessionId":"sess-1fbd1489-3d34","result":"https://example.com/"}

# 2. 拿快照——每个可交互元素一行 [N] 标记
bw s snap sess-1fbd1489-3d34
# {"ok":true,"snapshot":"# Page: Example Domain\n# URL: ...\n[2] link \"More information...\""}

# 3. 按索引操作——返回自带新快照（下一次操作的索引从这里读！）
bw s click sess-1fbd1489-3d34 2

# 4. 拿数据 / 拿图：
bw s extract_code sess-xxx '(tree) => tree.children.filter(n => n.tag === "a").map(n => n.text)'
bw s look sess-xxx --out p.png

# 5. 用完关掉——每会话占一个浏览器进程，不关会拖满并发上限
bw s close sess-xxx
```

## 高频命令速查

| 命令 | 用途 |
|---|---|
| `create [--url U] [--profile P] [--backend webkit\|chrome] [--allow-eval]` | 建会话（`--help` 看全部 flag） |
| `snap <id>` / `extract <id>` / `look <id> [--out F] [--full]` | 快照 / 全文 / 截图 |
| `extract_code <id> '<纯函数>'` | 结构化数据（沙箱；结果 ≤8KB） |
| `click <id> <index>` / `clicktext <id> <文本…>` / `type <id> <index> <text>` | 点击 / 按文本点 / 输入 |
| `press <id> <key>` / `select <id> <index> <value>` | 按键（Enter/Control+a）/ 下拉 |
| `scroll <id> <down\|up> [px]` / `scrollto <id> <index>` | 滚动 / 滚到元素 |
| `navigate <id> <url>` / `batch <id> '<json>'` | 跳转 / 批量动作序列 |
| `tabs <id>` / `opentab <id> <url>` / `switchtab <id> <n>` / `closetab <id>` | 标签页 |
| `wait <id> <seconds>` / `console <id>` / `errors <id>` | 等待 / 增量读 console / 页面报错 |

**console 的边界**：`console`/`errors` 只抓页面进程内的消息。**chrome 后端含首屏**（钩子在文档创建时注入）；**webkit 后端首条消息需先触发过任意 extract/evaluate**（无 init 注入面——B25 已知取舍）。**宿主进程日志（Metro/Expo/webpack dev server 终端、Node 服务 stdout）不在此面**——那些日志归宿主终端，bw 看不到；排查构建/热更新/HMR 问题要自己去盯宿主输出。

| `list` / `status <id>` / `gc` / `close <id>` | 会话管理 |

**chrome 后端独占**：`download` / `upload` / `requests`（网络请求）/ `cookies-all`（含 httpOnly 元数据）/ `look --full`。webkit 后端（macOS 系统 WebKit）无这几项——但零安装、启动快，作为 chrome 被风控弹走时的备选指纹族。

## 登录态（一次建立，终身复用）

```bash
# 从本机 Chrome 导入单站 cookie（Keychain 弹一次授权，点「始终允许」）
bw auth import-chrome --host example.com --as mysite
bw s create --url https://example.com/ --backend chrome --profile mysite   # 登录态开局
```

或从已登录的 bw 会话捕获：`bw auth save <sessionId> --as mysite`。`bw auth list / delete` 管理。
单站范围（只搬该域 cookie）——有意设计：agent 工具不静默继承全部登录态。

## 确认门（安全机制，不是错误）

导航到白名单外域名、点击含支付/删除类敏感词的按钮时，返回 `CONFIRMATION_REQUIRED` + `cid` + `reason`。**确认即执行**（approve 后动作真的跑并返回结果）。把 reason 告诉用户，用户同意才 `--yes`；默认 120 秒不处理等于拒绝。不要未经用户同意就批准。

## 出错恢复速查

| code | 原因 | 动作 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 索引失效（最常见，不是 bug） | 重新 `snap`，用新索引重试 |
| `ELEMENT_NOT_ACTIONABLE` | 元素隐藏/不可交互 | 先 `scrollto` |
| `EVAL_ERROR` | 页面 JS 异常/SyntaxError | 看**真实异常消息**修表达式（多语句已自动包 IIFE） |
| `NOT_FOUND` | 会话不存在 | `bw s list`，重建 |
| `SESSION_BUSY` | 同会话并发（前一条命令还在跑） | 等一下重试 |
| `CONFIRMATION_DENIED` | 确认被拒/超时 | 问用户，别硬闯 |
| `POLICY_BLOCKED` | 安全策略 | 换正常 URL |
| `TIMEOUT` / `DRIVER_ERROR` | 页面卡死 / 会话没了 | navigate 重来 / `list` 后重建 |
| `BROWSER_DEAD` | 浏览器进程死 | 直接重试（自动恢复），无需重建 |

**截图白但快照正常** → 先 `snap` 看 `# URL:` 是否被风控弹到校验页（见 references/recovery.md 的反检测章节）。
连续失败两次以上：先 `snap` 看页面现状，再决定。

## 按需深入（references/）

平时不用读。只在对应场景打开：

- **全命令参数细节 / batch 语法 / 返回 JSON 形状** → `references/commands.md`
- **连续报错 / 安全规则边界 / 风控对抗 / 预算** → `references/recovery.md`
- **eval 细节 / extract_code 树形状 / cookie/storage / cdp 调试 / bw run 自治** → `references/advanced.md`
