# bw 全命令参考

统一输出：成功 `{"ok":true, ...}`；失败 `{"ok":false,"code":"...","error":"...","hint":"..."}`（exit 1）。

## 会话与页面

### create（`--help` 看全部）

```bash
bw s create --help          # 零副作用查看全部
bw s create [--url U] [--name N] [--profile P] [--backend webkit|chrome]
            [--data-dir D] [--chrome-path PATH] [--width W] [--height H]
            [--ua U] [--allow-eval] [--allow-private-network]
            [--debug-port N] [--headed] [--chrome-arg A]
            [--cdp-url URL] | [--electron PATH [--electron-arg A]…]
```
```json
{"ok":true,"sessionId":"sess-1fbd1489-3d34","result":"https://example.com/"}
```
起始域自动进白名单。`--profile` 注入登录态快照（见 SKILL 登录态节）；`--backend chrome` 解锁下载/上传/requests/cookies-all/整页截图。

### snap / extract / extract_code / look

```bash
bw s snap <id>      # {"ok":true,"snapshot":"# Page: ...\n[3] link \"...\""}
bw s extract <id>   # 全文 ≤4000 字；截断时末尾附 "[truncated at 4000/N chars]"
bw s extract_code <id> '(tree) => tree.children.map(n => n.text)'
bw s look <id> --out shot.png        # 视口截图
bw s look <id> --full --out full.png # 整页（仅 chrome；拍前自动等渲染稳定）
```
`look` 返回带 `page` 字段（截图瞬间的 `url · title`）——被风控弹走/跳转时先看它，判断截到的是不是目标页。
快照头部：`# Page: 标题`、`# URL:`、`# Scroll: 0/11360 (viewport 720)`——滚动位置看这里。
`below-viewport` / `↑above-viewport` 标记视口外元素（配合 scrollto）。
`target=_blank` 链接带 `↗new-tab` 标注。

extract_code 细节（树形状/上限/截断告警）见 advanced.md。

### attach 模式（Electron / 外部浏览器）

```bash
bw s create --electron ./node_modules/.bin/electron --electron-arg main.js  # spawn app + attach
bw s create --cdp-url http://127.0.0.1:9222                                 # 连已跑的调试口浏览器
```
收养对方窗口、全工具照用；`--cdp-url` 的 close 只断连（对方存活），`--electron` 的 app 随 close 收走。见 advanced.md。

### cdp（外部调试口）

```bash
bw s create --url https://myapp.dev --backend chrome --debug-port 0   # 0=随机端口
bw s cdp <id>   # → {"httpUrl":"http://127.0.0.1:5xxxx","browserWs":"ws://…",pages:[…]}
```
DevTools 打开 `httpUrl` 即可实时调试 bw 会话里的页面；puppeteer 用 `connect({browserWSEndpoint: browserWs})`。
默认不开（pipe-only 是默认安全态）；`--headed` 配合可开真窗口。
详细用法见 advanced.md 调试节。

### list / status / gc / close

```bash
bw s list          # [{"sessionId","name?","url","steps","alive","keep",...}]
bw s status <id>   # 单会话详情（状态机/URL/步数/后端）
bw s gc            # 清扫过期（30min 无活动）与僵尸会话 + 残留浏览器/helper 进程
bw s close <id>    # 关会话（幂等；连带杀净本会话全部浏览器进程）
```
无 `stop` 命令——没有服务可停（B22 起纯文件会话）。

## 交互

### click / clicktext / type / press

```bash
bw s click <id> 5                    # 按索引（快照里的 [N]）
bw s clicktext <id> 日K              # 按可见文本（SPA div-tab 兜底；文本可含空格）
bw s type <id> 3 "搜索词"
bw s press <id> Enter                # 单键；组合键 Control+a
```
- 索引点击走 selector 轨；shadow DOM / iframe 自动切换坐标轨
- clicktext：空白不敏感匹配（换行/多空格等价）；精确匹配优先 → 包含匹配取最小面积；屏外/被裁剪（carousel 旧屏、下拉裁剪区）与被遮罩盖住的候选自动出局，需要时会先滚入（含嵌套滚动容器）；多匹配时汇报 `clicked <div "日K"> (3 matches, clicked smallest/best)`；全候选被遮挡/出界时报 occluded/offscreen 理由；文本命中敏感词照样走确认门
- 密码框 value 在快照恒 `***`

### select / scroll / scrollto / wait / resize / reload

```bash
bw s select <id> 4 "b"                # 下拉选 value（不是显示文本）
bw s scroll <id> down 800             # down/up/left/right，默认 600px
bw s scrollto <id> 12                 # 滚到 [12] 可见
bw s wait <id> 3                      # 等待秒数（≤30）
bw s resize <id> 375 812              # 改视口（响应式断点/移动端布局验证）
bw s reload <id>                      # 重载当前页
```

### navigate / batch

```bash
bw s navigate <id> https://other.com  # 新域名触发确认门（返回 cid）
bw s batch <id> '[{"kind":"type","index":"3","text":"Alice"},{"kind":"type","index":"5","text":"123"},{"kind":"select","index":"7","value":"medium"}]'
```
batch：≤10 步一次往返；首错即停带进度（`batch stopped at step 2/3: ... completed: ✓ [1/3] ...`）；子步全闸面；只回末子步快照。填表单后单独点提交（提交过确认门）。

## 标签页

```bash
bw s opentab <id> https://docs.example.com   # 新标签页并切换
bw s tabs <id>        # [{"tab":0,"url":"...","title":"..."}]
bw s switchtab <id> 0
bw s closetab <id>    # 关当前；全关后需 opentab 重建
```
索引属于**当前活动标签页**；切页后先 snap。

## chrome 后端独占

```bash
bw s download <id> 5                 # 点下载链接存文件（60s；单文件≤100MB）
bw s upload <id> 5 /tmp/a.txt /tmp/b.txt   # 上传（目录外文件走确认门）
bw s requests <id>                   # 最近网络请求（找 API 端点）
bw s cookies-all <id>                # 全量 cookie 元数据（含 httpOnly；值掩码）
```

## 动作返回的形状

交互类动作成功返回自带新快照（索引的下一份权威来源）：

```json
{"ok":true,"tool":"click","result":"clicked [5] Docs",
 "snapshot":"# Page: Docs\n# URL: https://...\n[2] link ..."}
```

同页未变时动作结果带 `"unchanged":true` 且 snapshot 截到状态头三行 + `[unchanged]` 标记——复用上一份完整快照即可，不用重读。

`extract` / `extract_code` 结果带 `page` 字段（提取瞬间的 `url · title`）——**空结果先看它**：url 已变成校验/登录页 = 页面被弹走（不是没数据），对照 recovery.md 风控章节处置。

需要确认时：

```json
{"ok":true,"cid":"sc-8h2k1x9p","reason":"origin not in whitelist",
 "result":"CONFIRMATION_REQUIRED: origin not in whitelist"}
```
处理：`bw s confirm <id> sc-8h2k1x9p --yes`——**确认即执行**，返回里带执行结果。
