# 进阶：eval / extract_code / cookies / storage / bw run

## eval —— 在页面里跑 JS

**默认禁用**（任意代码执行面——只对可信站点开）。建会话时显式开启：

```bash
bw s create --url https://example.com --allow-eval
bw s eval <id> "document.title"
# {"ok":true,"tool":"eval","result":"\"Example Domain\""}
```

要点：

- **多语句自动包 IIFE**——`a.click(); b.className` 直接可用；只有真语法错才报错
- 语法错/页面异常返回 `EVAL_ERROR` + **真实异常消息**（`SyntaxError: Unexpected identifier...`）——按消息修，不是驱动故障
- **CJK / 引号表达式用文件**：`bw s eval <id> --file /tmp/expr.js`——shell 引号搅局免疫（表达式走文件内容，不经 shell 解析）
- 结果 JSON 化返回，≤8000 字符；10 秒超时；超时后页面 JS 线程可能卡死 → `navigate` 或 `close`
- 适合：computed style、调页面函数、fetch API 验证登录态（`fetch('/api/nav').then(r=>r.json())`）
- 安全边界：页面能做的它都能做（含发请求）——别在碰过 secret 的页面用

## extract_code —— 结构化数据提取（首选取数方式）

冻结 DOM 树副本 + 沙箱（Worker+vm realm 隔离，无 fetch/process），一次调用返回 JSON：

```bash
# 商品列表：一次调用拿全部
bw s extract_code <id> '(tree) => {
  const walk = (n, out) => { if (!n) return out;
    if (n.tag === "li" && n.attrs?.["data-id"]) out.push({ id: n.attrs["data-id"], text: n.text });
    (n.children || []).forEach(c => walk(c, out)); return out; };
  return walk(tree, []);
}'
```

树形状：`{ tag, attrs?, text?, value?, checked?, children? }`
- `text` 只含**直属文本**（子元素文本在子节点——拼列表用递归或下钻）：
  `const textOf = (n) => (n.text ?? "") + (n.children || []).map(textOf).join("")`
- **图标链接 text 为空**（logo/GitHub/Discord 这类）——可读名在属性里：
  `n.text || n.attrs?.["aria-label"] || n.attrs?.title` 回退
- `value` 是 input/textarea/**select** 当前值；密码恒 `***`（源头掩码）
- href 按 DOM 原样返回（相对路径不补全 origin）——需要绝对地址时前端拼或对照 snap
- shadow root 已穿透、同源 iframe 已下钻、跨域 iframe 占位

上限：节点 10000 / 文本 200 字 / 属性 500 字；代码 ≤4KB / 3s；**结果 JSON >8KB 直接拒绝**（收窄投影重试）；树截断附 `[warn] DOM tree truncated` 行。

## 调试：console / errors

```bash
bw s console <id>    # 增量返回 [{"t":...,"level":"log","text":"..."}]——每次只给新消息
bw s errors <id>     # 只给 error 级（含 window.onerror / unhandledrejection）
```
排查「点了没反应」：click → `errors` 看 JS 异常 → `console` 看应用日志。
已知限制：捕获从首次提取开始——页面加载早期的日志拿不到。

## cookies / storage

```bash
bw s cookies <id>                      # "a=1; b=2"（httpOnly 不可见）
bw s cookies-all <id>                  # 含 httpOnly 元数据（值掩码；仅 chrome）
bw s cookies-set <id> name value       # path=/, SameSite=Lax
bw s cookies-clear <id>
bw s storage <id> [key]                # 全量 JSON 或单键
bw s storage-set <id> key value
bw s storage-clear <id>
```

## 登录态管理（bw auth）

```bash
bw auth import-chrome --host example.com --as mysite   # 本机 Chrome 单站导入
                                                       # Keychain 弹一次「始终允许」
bw auth save <sessionId> --as mysite    # 从已登录 bw 会话捕获
bw auth list                            # [{"name","createdAt","backend","cookies"}]
bw auth delete mysite
```
注入：`bw s create --url … --backend chrome --profile mysite`（chrome 经 CDP 含 httpOnly；webkit 仅可见面）。支持 `--browser chrome|chromium|edge|brave`、`--chrome-profile`（多用户）。
不自动回写——会话内新登录不更新快照，显式 save 才更新（可复现可审计）。

## 自治模式（bw run）

不需要分步控制时，让内置 agent 跑完：

```bash
bw run "打开 https://bun.com 总结首页三个要点" --url https://bun.com
bw run "…" --profile mysite --json     # 带登录态 + 机器可读
bw run --jobs 4 --file tasks.jsonl     # 批量（每任务一子进程；行含 goal/startUrl/name）
```
需要 GLM 凭据（env / `.env` / `~/.bw/.env`）。分步可控场景仍用 `bw s`。

## attach 模式：Electron app / 外部浏览器

bw 默认自己 spawn 浏览器；attach 模式反向——**连别人家的浏览器**（任何带 CDP 调试口的 Chromium 系进程）：

```bash
# A) Electron 测试（UI 层完整）——bw spawn app + attach；close 连带收走 app
#    注意：传**真二进制**（dist/Electron.app/Contents/MacOS/Electron）——
#    node_modules/.bin/electron 是 node 脚本，helper 环境跑不了
bw s create --electron node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
            --electron-arg . --allow-eval
# （Chrome 当 app 调试 launcher 时需 --electron-arg --user-data-dir=<独立目录>——
#   裸启动会单例让位给你的日常 Chrome；真 Electron app 无此问题）

# B) 连已在跑的外部浏览器（对方须带 --remote-debugging-port 启动）
bw s create --cdp-url http://127.0.0.1:9222 --allow-eval
```

attach 会话语义：
- 建会话**收养**对方现有窗口（不新开 tab；后续 `opentab` 才开新 target）
- 全部工具照用（snap/extract_code/click/eval/look/requests——引擎零改动）
- **close 只断连**——外部浏览器/Electron app 不受影响（`--cdp-url` 语义）；
  `--electron` 的 app 是 bw 拉的，随 close 收走
- 主进程（ipcMain/原生 API）CDP 够不到——UI 层以外的测试仍需 Playwright 的注入方案

## 调试：bw s cdp / --headed

```bash
# 建可调试会话（--debug-port 0 = 随机端口；默认不开——CDP 管道是默认安全态）
bw s create --url http://localhost:3000 --backend chrome --debug-port 0 [--headed]
bw s cdp <id>
# {"httpUrl":"http://127.0.0.1:53161","browserWs":"ws://127.0.0.1:53161/devtools/browser/…",
#  "pages":[{"url":"…","title":"…","ws":"ws://…/devtools/page/…"}]}
```

- **Chrome DevTools**：浏览器打开 `httpUrl`，选 target 即实时调试（Elements/Network/Console 全可用）
- **puppeteer**：`puppeteer.connect({ browserWSEndpoint: browserWs })` —— 与 bw 命令并行操作同一浏览器（bw 的索引快照不感知外部改动，混用时先 `snap` 再动）
- 调试口只绑 127.0.0.1；会话 close 即随浏览器关闭
- `--headed`：真窗口（内部自动走 launch 模式：spawn 真 Chrome 二进制 + attach——Bun 强制 `--headless` 无法用 `--headless=false` 反转，实测定论）。测自站视觉效果/需要手动登录/风控对抗时用；close 连带收走窗口
- `--chrome-arg A`：chrome 启动旗标透传（可重复）——代理 `--chrome-arg --proxy-server=http://127.0.0.1:7890`、窗口尺寸等

## 环境变量

| 变量 | 用途 |
|---|---|
| `BW_HOME` | 状态目录（默认 `~/.bw`；测试隔离用） |
| `BW_POLICY_MODE=test` | 测试档（放宽 S4 内网封锁——访问本地 fixture 服务用） |
| `BW_MAX_SESSIONS` / `BW_MAX_JOBS` | 并发上限（默认 16 / 8） |
| `BUN_CHROME_PATH` | chrome 可执行文件路径（缺省自动探测常见安装位；UA 版本对齐也用它） |
| `GLM_API_KEY` / `GLM_MODEL` | `bw run` 用（本 skill 分步场景一般不需要） |
