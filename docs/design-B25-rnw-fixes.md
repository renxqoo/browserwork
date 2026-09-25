# RNW 实战四问题修复（B25）方案

> 状态：已核销（对抗审查 10 条处置完毕；四门全绿 + 真实 chrome 回归冒烟全过；
> 遗留三项后续裁决见下）
> 级别：中（跨 perception/actions/driver 三包；无外部契约新增，工具词表不变）

## 遗留项终裁（2026-09-26 二次追问后）

| 项 | 裁决 | 证据 |
| --- | --- | --- |
| webkit 首屏 console | **平台无能力面，非不为** | probes/p25-webkit-console.ts 实测：A) 导航后立即 evaluate 只能抓装载后的消息（early 丢、late 可救）；B) onNavigated 触发时首屏脚本已跑完；C) WebView.cdp() 在 webkit 直接拒绝（无 addScriptToEvaluateOnNewDocument 等价面）；D) 构造器 html 项的 script 不执行。四路全堵——Bun.WebView 没有文档创建前钩子 |
| resize 失败静默 | **已修**：stderr 告警 + 落定后回读校验，失配即报文点名（比静默错误尺寸更可行动） | 畸形尺寸实测报 `viewport mismatch after create: wanted …, got …`；正常路径 ±3px 容差不误伤 |
| 宿主侧日志 | **架构外，不纳入**：日志在宿主进程 stdout，与浏览器进程物理隔离；bw 是浏览器自动化层无进程面。可操作替代：宿主自重定向 `expo start > log 2>&1` + tail——上轮实战正是靠后台任务日志修复 | skill 文档已明示边界 |

## 对抗审查处置记录（独立会话，2026-09-26）

| # | 严重度 | 问题 | 处置 |
| --- | --- | --- | --- |
| 1 | P1 | 循环 scrollIntoView 顶走 best，末尾复核不重验 → 假成功 | **修**：两阶段——收集不滚，按分序滚入即验即停 |
| 2 | P1 | clipped 对 fixed 假阳性（body overflow-x:hidden 全站标配） | **修**：跳过 fixed/sticky + html/body；中心点判定（半裁剪可点） |
| 3 | P1 | 遮挡旅程测试断言空洞（穿透与否都过） | **修**：fixture 挂监听记 under-mask-penetrated，真断言 |
| 4 | P2 | resize 每次都发 + 失败静默 | **驳回主体**：chrome 构造器不落实任何尺寸（含默认），每次 resize 是让默认视口生效的唯一路径；方案口径「未传 pageOpts 不动」系笔误，修正。失败静默登记取舍（与 UA/泄漏注入同级尽力而为） |
| 5 | P2 | webkit 首屏仍丢，文档无限定宣称含首屏 | **修**：文档标注 chrome-only + webkit 补装语义 |
| 6 | P2 | 视口烘翅 1280×720 与小视口打架 | **修**：live window.innerWidth/Height；参数仅测试注入 |
| 7 | P2 | O(matches×ancestors) 重排链可超时 | **修**：随 #1（只滚选定候选一次）；clipped 仅对匹配元素调 |
| 8 | P2 | offscreen/occluded 计数互相顶掉 | **修**：双计数都报；reason 按多数 |
| 9 | P2 | 守卫路径脆弱；重言式测试无裁判力 | 守卫**驳回**（测试只在源码树跑，发布包不含 tests）；重言式**修**：改反例断言（无 .find 定位形态） |
| 10 | P3 | 读动作包装 console 扩大指纹面 | **修**：toString 伪装为 native code 形态 |

## 实施后的补充裁决（落档）

- **squeeze 归一取代 \\s→" " 折叠**（实测裁决）：源码换行在 innerText 里是渲染空格，
  用户文本无空格——折叠仍失配，删除全部空白才稳。
- **新增祖先裁剪判定**（场景泛化暴露）：元素可在视口内、但在 overflow:auto/hidden
  祖主裁剪区外（下拉/feed/侧栏）——rect 照常返回但不可见不可点。滚入判定含裁剪。
- **滚入改页内 scrollIntoView**：取代 engine 的 window.scroll+二次 re-locate 往返；
  一次定位表达式内完成，覆盖嵌套滚动容器。
- **fixture 泛化**：rnw-like.html → text-cases.html，八场景矩阵
 （React tab/嵌套 div/常规按钮/大容器包含/遮挡/内部滚动/图标按钮/叠屏）——
  通用网页点击能力，不绑定 RNW。

## 背景与实证

RNW（react-native-web）实战会话（sess-3fea42d7-1916，chrome 后端）暴露四个问题，
均已复现或代码定位：

1. **click_text 不可靠**（engine.ts:922-996）：
   - 归一化正则 `/s+/g` 是字母 s 不是 `\s`（同文件 908 行 extract_text 用对了）——
     RNW 嵌套 div 的 innerText 含换行/多空格时匹配直接失败；
   - 只判纵向出界（979-980），RNW stack/drawer navigator 的屏外副本
     （translateX 平移出屏，display/visibility/opacity 全过）参与最小面积竞选，
     被选中即坐标轨静默丢弃——「点了不跳路由」的机制；
   - 无遮挡复核（elementFromPoint），多屏常驻时覆盖副本可被选中；
   - 滚入后 re-locate（984）用文档序第一匹配，与主匹配的 best-smallest 规则不一致。
2. **chrome 后端 create --width/--height 不生效**：请求 390×844 实得 500×757；
   请求 900×600 实得 500×513（宽度恒 500，高度=请求−87 窗口外框）。
   helper 进程 argv 已带 --width/--height（链路没丢），是 Bun WebView chrome 后端
   构造器不落实尺寸、而 view.resize 落实（resize 后 390×844 精确生效）。
   webkit 后端实测正常（900×600 → viewport 600）。
3. **console 抓不全**：钩子装在 EXTRACT_EXPRESSION 尾部（script.ts:233-266），
   首次提取前（首屏渲染）的消息永久丢失——RNW 的 scrollEventThrottle 告警正属此类。
   `bw s console` 只 drain 不补装。
4. （问题 4「索引往返」B22 稳定 id 已缓解，不在本批次——登记遗留。）

## 契约

- 工具词表不变：`click_text` 参数/输出形态不变（`clicked <tag "text"> (N matches, …)`）；
- 错误形态沿用：ELEMENT_NOT_FOUND（含新理由「全被遮挡/全在视口外」）；
- 新增导出（内部包间契约）：
  - `@bw/perception`: `CLICK_TEXT_LOCATE_EXPRESSION(text, viewportW, viewportH)`
    （单源字符串生成器，engine 消费）；
  - `@bw/perception`: `INSTALL_LOG_HOOK_EXPRESSION`（幂等装 console/error 钩子，
    与 EXTRACT_EXPRESSION 内嵌段同源——内嵌段改为拼接本常量，单一真相）；
- `bw s console/errors`：读动作先补装钩子再 drain（对已导航页面救回后续消息）；
- chrome 后端 createPage：构造后补 `view.resize(w,h)` 使 create 期视口即生效
  （仅 chrome；webkit 构造器本就落实，不双轨）。

## 问题域

- 处理：空白归一 / 横向+纵向出界过滤 / 遮挡复核 / 统一 best-smallest（含滚动后
  re-locate）/ 空文本与纯空白文本拒绝 / chrome create 尺寸 / console 钩子前移
  （chrome init 注入 + console 动作预装）。
- 不处理：
  - 宿主侧日志（Metro/Expo 终端）——不在浏览器进程内，归宿主终端（skill 文档明示）；
  - iframe 内文本点击——click_text 主文档语义不变（快照 iframe 占位节点走坐标轨已有）；
  - `--electron/--cdp-url/--headed` 分支的 width/height 透传（attach 的窗口归外部 app）；
  - 索引重排的进一步优化（B22 稳定 id 已是正解；遗留登记）。

## 并发/一致性预算

- click_text 表达式仍单次 evaluate 往返（不增往返）；
- 遮挡复核在页面内完成（elementFromPoint 批量在同一表达式内），无新增 RPC；
- chrome resize 补一次 RPC（create 路径，一次性）；
- console 钩子：页面侧环形缓冲上限 200 条不变。

## 拆分

| 改动 | 位置 |
| --- | --- |
| CLICK_TEXT_LOCATE_EXPRESSION 单源 | packages/perception/src/script.ts（新导出） |
| engine click_text 消费单源表达式 + 出界/遮挡语义 | packages/actions/src/engine.ts |
| INSTALL_LOG_HOOK_EXPRESSION 抽出（EXTRACT 内嵌段改拼接） | packages/perception/src/script.ts |
| console/errors 动作先装后 drain | packages/actions/src/engine.ts:575-580 |
| chrome init 注入日志钩子 | packages/driver/src/backends.ts（chrome 分支，与 NO_CDP_LEAK_SCRIPT 同位） |
| chrome createPage resize | packages/driver/src/backends.ts |
| 新 fixture（RNW 风格嵌套 div/多屏常驻/遮挡/换行文本） | fixtures/rnw-like.html |
| skill 文档补「宿主日志自己盯」 | skills/bw/SKILL.md + references |

依赖方向不变：perception ← actions；driver 不依赖 perception（backends.ts 注入
脚本以字符串字面量内联，注明与 perception 同步——driver 不能 import perception，
否则环依赖）。

**关键裁决：日志钩子脚本的单一源放 @bw/perception，driver 注入的是它的复本。**
复本同步纪律：perception 侧导出 `INSTALL_LOG_HOOK_EXPRESSION`；driver 侧
`LOG_HOOK_DRIVER_COPY` 注释标明「与 @bw/perception INSTALL_LOG_HOOK_EXPRESSION
逐字节一致」；perception 侧加守卫测试（driver 复本 === perception 导出，从
backends.ts 正则抽取或以标记注释包裹），漂移即红。

## 实施顺序

1. **Fix A（click_text）**：表达式单源 + engine 消费 + fixture 旅程测试；
2. **Fix B（chrome 尺寸）**：backends resize + 真视图契约断言；
3. **Fix C（console 前移）**：常量抽出 + 动作预装 + chrome 注入 + 守卫测试；
4. 文档（skill/commands.md、本方案状态推进）。

每步独立提交、四门全绿。

## 裁决

- （默认裁决）遮挡复核用 elementFromPoint 中心点单采样：RNW 覆盖场景的实用解；
  多采样精度换往返复杂度，不做。
- （默认裁决）出界判定含横向（x<0 或 x+w>vw）与纵向；出界元素**不参与**匹配计数
  的「候选」但 matches 数照报（用户可见有多少命中）。
- （默认裁决）`click_text` 空文本/纯空白 → INVALID_TOOL_ARGS（而非页面内空转）。
- （默认裁决）Fix B 只补 chrome；webkit 已正确，不双轨（零兼容层）。
- 用户裁决：无（本方案为用户明确要求的「TDD 修复」的落地细化，方向已授权）。

## 测试口径（先于实现）

### A. click_text（单元：表达式字面 + FakeDriver 引擎级；集成：真 webkit fixture）

表达式级（直接断言生成的字符串）：
- [ ] 归一化用 `\s+`（字符串含 `\\s+`）——回归：字母 s 正则 bug；
- [ ] 出界判定含 x 轴（表达式含 `viewportW` 参与）；
- [ ] 遮挡复核在页面内（表达式含 elementFromPoint）；
- [ ] 文本经 JSON.stringify 注入（引号/换行安全）。

引擎级（FakeDriver）：
- [ ] found=false → ELEMENT_NOT_FOUND（回归不变量）；
- [ ] reason=occluded（全候选被遮挡）→ ELEMENT_NOT_FOUND 带 occluded 说明；
- [ ] reason=offscreen（全候选出界且不可滚入）→ ELEMENT_NOT_FOUND 带 offscreen 说明；
- [ ] 空文本 → INVALID_TOOL_ARGS；纯空白 → INVALID_TOOL_ARGS；
- [ ] 滚动后 re-locate 用同一表达式（同一单源，不再有第二套 .find 逻辑）；
- [ ] matches>1 时输出仍报 `(N matches, clicked smallest/best)`。

集成（真 webkit + rnw-like.html）：
- [ ] 嵌套 div 换行文本（`查看\n示例对话` 形态）命中叶子并触发 onclick；
- [ ] 多副本场景（同文本两处，一大一小）点小的（既有语义回归）；
- [ ] 平移出屏副本（translateX(-100%)）不抢匹配——点中可见者；
- [ ] 覆盖场景（透明遮罩盖住小元素）→ 点中大元素或报 occluded；
- [ ] 「深色」「返回」按钮文本点击 → onclick 计数 +1（RNW 语义最小复刻）。

边界/异常：
- [ ] want 含正则元字符（`(`、`*`）——includes 语义不受影响（无 RegExp 构造）；
- [ ] 超长文本（10k 字符）——表达式注入仍合法（JSON.stringify 承载）；
- [ ] 页面无 console（极端）——不相关但表达式不得抛；innerTT undefined 回退 direct text。

### B. chrome create 尺寸（真视图契约，skip-if 无 chrome）

- [ ] createPage({width:390,height:844,url}) 后 innerWidth/innerHeight 精确 390/844
  （±2px 容差——DPR 圆整）；回归：500×757；
- [ ] 未传 pageOpts 时不动（驱动级默认语义不变）；
- [ ] resize 之后 create 的第二个页不受影响。

### C. console 前移

单元（FakeDriver 引擎级）：
- [ ] console 动作先 evaluate(INSTALL_LOG_HOOK_EXPRESSION) 再 drain（顺序断言）；
- [ ] errors 动作同路径；
- [ ] 安装失败不阻断 drain（evaluate 抛 → 仍返回缓冲）。

守卫（防复本漂移）：
- [ ] backends.ts 的注入段与 perception 导出逐字节一致（抽取断言）。

集成（真 webkit）：
- [ ] 导航后**不 extract** 直接 console → 能看到页面加载期的 console.log
  （新 fixture 页加载即打日志）。

### D. 不新增 e2e 装置（fixture server 已有，旅程即 e2e 等价物）

## 验收清单

- [ ] 四门全绿（typecheck / lint 0-0 / build / test + coverage-gate ≥90）
- [ ] 上述测试口径逐条落地（实现前先红）
- [ ] 真实 chrome 复测：create 390×844 → viewport 390×844；RNW 会话场景
      click_text「深色」不再静默失败
- [ ] skill 文档补宿主日志边界说明
- [ ] 对抗审查（中级必做）问题清单清零
