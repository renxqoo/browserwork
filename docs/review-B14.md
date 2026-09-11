# 对抗审查：B14（驱动透传 + CDP 轨道）

> 审查者：独立 general-purpose 子 agent（角色分离）· 2026-09-12 · 输入 = 未提交 diff + 05 §3.7 + 探针 p10/p11；审查者跑了三个决定性实证（cdp void 返回值 / 缺失下载目录 / UA 首请求时序）
> 结论：P0×1 + P1×5 + P2×8，全部处置；两处任务假设被实证证伪（记录在案）。

## 处置表

| # | 级 | 摘要 | 处置 |
|---|---|---|---|
| 1 | P0 | 上传目的地可被页面偷换（attr 搬迁/__bwIdSeq 毒化/performSearch 命中隐藏 input）——文件外泄原语 | 采纳：upload 复用 locateAndValidate（漂移+可见性）+ LocateResult.inputType 复核 file；script.ts __bwIdSeq Number 强制；偷换/隐藏/非 file 三回归测试 |
| 2 | P1 | enter_submit 不置 lastNavWasPost——POST 写重放闸缺口 | 采纳：press Enter submit 分支置位（method!=="get"）；enter_submit→reload 回归测试 |
| 3 | P1 | UA 覆写时序实证证伪：带 url 路径先导航后覆写——首请求带真 UA；e2e 假绿 | 采纳：统一 about:blank→覆写→目标导航（含带 url 路径）；覆写失败抛 DRIVER_ERROR（撤「静默降级」）；契约用例断言 navigator.userAgent |
| 4 | P1 | POST /sessions 暴露 chromePath/dataDir——持 token 方 spawn 任意可执行文件 | 采纳：`BW_ALLOW_DRIVER_PATHS=1` serve 级 env 门（含 allowUploadDirs——同路径面），默认 400 |
| 5 | P1 | 上传 TOCTOU：审批窗分钟级 + engine 不 realpath | 采纳：sessions 审批后 realpath 前后比对（不重跑 checkUploadFiles——那会生成新 cid 变二次确认）；engine performUpload 传 realpath 解析路径 |
| 6 | P1 | 下载清理链失效：destroy/S1③ 不清目录 + janitor 看不见子目录 + agent 模式共享 default 目录 | 采纳：destroySession rm 会话下载目录；janitor targets `subdirs:true` 一层展开；runTask per-task downloadsDir；下载根统一 `downloadsRoot()`（BW_DOWNLOADS_DIR 单源） |
| 7 | P2 | 下载 60s 超时后 CDP 监听器永久泄漏 | 采纳：done promise `.finally` 卸载 + timer 清理 |
| 8 | P2 | 落盘选择 `size===0` 短路：0 字节文件混作首选标记 | 采纳：`path === ""` 判首 + 独立 newest mtime；0 字节照常参与 |
| 9 | P2 | 网络回填「最新未定条目」乱序张冠李戴 + 死代码 | 采纳：requestId 精确匹配（requestWillBeSent 存 id）；删死代码；乱序回归测试 |
| 10 | P2 | requests URL query 凭据明文进上下文（agent redact 不识 URL token；sessions inspect 不过 redact） | 采纳：engine 入缓冲前 maskUrl（敏感 key 名单值掩码）；sessions requests/cookies_all inspect 过 policy.redact；掩码回归测试 |
| 11 | P2 | chrome dataStore 不符静默改写用户选项（spec 要求警告不改行为） | 采纳：撤改写，console.warn 如实告知实际生效目录 |
| 12 | P2 | 规格面缺口：allowUploadDirs/budget 未上 HTTP、popups cap 缺、BW_DOWNLOADS_DIR 三处分叉 | 采纳：body 补两字段（env 门后）；popups cap 补（webkit/chrome 均 false 未实证）；下载根单源解析 |
| 13 | P2 | netWired 先置位后 enable：瞬态失败永久沉默；open_tab/switch_tab 不接线 | 采纳：enable 成功才标记；两条 tab 路径锁内接线 |
| 14 | P2 | e2e 缺口：下载用例绕开 engine、上传无真 chrome 链路、void 返回值哨兵无锚定 | 部分采纳：fake 层补 engine 驱动的下载/上传/守卫/预算/catch 分支 31 用例；真 chrome engine e2e + void 哨兵锚定登记遗留（B16 real 门顺带） |

## 实证证伪记录（审查者）

- `Browser.setDownloadBehavior`/`Network.enable` 在真 chrome 返回 `{}`（非 undefined）——`enable !== undefined` 哨兵当前成立
- 下载目录不存在时 Chrome 自动创建（无需预建）
- p10 首探针 cdp 挂死为探针自身 bug（每步无超时护栏）；p11 修正后全通

## 验证

- 四门：tsc 0 / lint 0-0 / build OK / 473 pass + coverage-gate PASS（engine.ts 函数 92.2%）
- chrome 真视图契约：resize/cdp/webp/reload/UA/下载 e2e（本机 Chrome 全绿）
