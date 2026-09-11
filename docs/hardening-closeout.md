# 硬化收口报告（B12–B17）

> 日期：2026-09-12 · 方案 `05-hardening-plan.md` · 批次审查 review-B12…B17 + review-hardening-plan
> 起点：2026-09-11 全库差距核查（宣称空转 / CDP 缺位 / 高可用未建 / 评测未跑）

## 验收清单核销（05 §5 逐批）

### B12 token 效率（§3.1–3.4）
- [x] 渲染 diff 判定 unchanged（白名单废除；checkbox checked 进快照）；keep-2 只数全量快照——连续 unchanged 不失明（P0-1/P0-2 回归）
- [x] image keep-1 + `[screenshot removed]`；窗口估算 CJK 分档 + toolCall args；三阶段渐进裁剪（非快照 toolResult→快照 2→1→旧 assistant/user text part 截断）
- [x] strong 路由：terminate-after-batch + prompt("continue")（abort 不可靠实证）；三级装配（GLM_STRONG_MODEL/TaskRequest.model/opts）；升级后仍卡→failed；首个 done 定案
- [x] costUsd：BW_PRICES_JSON（CLI 认 .env）/opts 价目；按 model id 停用警告；TaskResult.cost
- [x] contextWindow 50/80 独立预警；errorMessage 终局 lastAssistantText 兜底

### B13 服务可用性（§3.5–3.6）
- [x] 生产档策略缺省（S4 生效）；allowPrivateNetwork 需 serve 级 BW_ALLOW_PRIVATE_NETWORK=1
- [x] 轨迹工厂 → serve 默认 ~/.bw/trajectories（任务+会话）；janitor 双目录（.jsonl 过滤 + downloads subdirs 一层展开）
- [x] /healthz（loopback 免 Bearer；不喂活 idle 时钟）；SIGTERM/SIGINT await 收尾；BW_DAEMON 空闲退出真接线
- [x] SESSION_LIMIT→429（不进 core 词表）；崩溃恢复（claim-at-entry 并发互斥 + 进程级限次 + 轨迹 __recovery + 单页化语义）
- [x] bw replay（控制字符剥离）；create 无 startUrl 走 about:blank；导航失败清场

### B14 CDP 轨道（§3.7）
- [x] CreateDriverOptions 全透传；webkit+UA fail fast；UA=about:blank 引导→覆写→首请求生效
- [x] Page += resize/reload/cdp/onCdpEvent；caps += httpOnlyCookies/networkEvents/webp/popups；ScreenshotFormat += webp
- [x] 下载：动作窗口内 setDownloadBehavior(allow)（探针实证 allowAndName=UUID 名）；requestId 精确网络回填；60s 超时监听器 finally 卸载；100MB/1GB/并发 1；目录差集定位；destroy 清目录
- [x] 上传：locateAndValidate + inputType/visible 复核（目的地偷换防线）+ performSearch 穿 shadow + realpath；路径闸 realpath 双向 + 审批后复检（TOCTOU）
- [x] reload 写重放闸（click submit + press Enter submit 置位）；__bwIdSeq Number 强制；requests URL query 敏感参数掩码
- [x] 工具按 caps 动态注册；HTTP/CLI 驱动选项透传（chromePath/dataDir/allowUploadDirs 走 BW_ALLOW_DRIVER_PATHS 门）；_blank 标注
- [x] go_back/go_forward 放弃（Bun 1.4.2 运行时未实现 back/forward——探针 p10/p11 登记）

### B15 CI（§3.8）
- [x] GitHub Actions 矩阵 macOS+Ubuntu × 四门 + 产物冒烟；bun 1.4.2 锁（packageManager + setup-bun）
- [x] scripts/stress.ts 压测出数（本机 webkit 3×4：12 ops 0 err p50=503ms）

### B16 评测（§3.9）
- [x] @bw/eval：MCP stdio client（error/超时/stop 语义）+ GLM 循环 + 5 任务集——装置 11 用例进默认门
- [x] 小规模真跑（5 任务×1 轮×双端）：done 5/5 vs 5/5 · steps 11 vs 14（-21%）· tokens 60,206 vs 104,802（**-42.6%**）
- [x] README/usage 宣称改实测口径（原「50 步约 8K」设计估算弃用）
- [x] 装置公平性 bug（answerHead 截断评级）修复+复跑，修正记录入报告

### B17 supervisor（§3.10）
- [x] N×bw serve（独立 dataDir/端口/token/轨迹）；退避 1s/2s/5s；exit 0 不重启；healthz 3 连败重启
- [x] state.json 0600 原子写 + lockfile O_EXCL；bw sup start|status|stop
- [x] 真 chrome 冒烟绿；实现期修 3 缺陷（review-B17）

## 假绿对抗抽查

- 豁免咬合：移除 supervisor 豁免 → coverage-gate FAIL（恢复后 PASS）✓
- 无 describe.skip/test.skip 裸跳过；18 处 skipIf 全为平台/浏览器存在性显式跳过（bun 输出 skip 计数）
- 被注释断言 0；B16 装置自揪出 answerHead 截断评级假绿并复跑修正

## 数字如实报告

| 项 | 值 |
|---|---|
| 提交数（B12-B17） | 9（含 2 chore） |
| 用例总数 | 506 pass / 1 skip（起点 395） |
| 覆盖率（coverage-gate） | 43 源文件（豁免 7）行 90.0% / 函数 92.0% |
| 对抗审查 | 方案 24 条 + B12 14 条 + B13 12 条 + B14 14 条 = 64 条全处置（0 驳回） |
| 真跑数字 | 见 docs/eval-report-B16.md（含口径披露与装置修正记录） |

## 遗留项（登记）

| 项 | 影响 | 计划 |
|---|---|---|
| 全量评测（20+ 任务×3 取中位） | 样本量小（5×1），不外推普适 | 后续独立跑（装置已就绪：`BW_REAL=1 bun scripts/eval-b16.ts --tasks 20 --runs 3`） |
| go_back/go_forward | Bun 1.4.2 运行时未实现 back/forward（types 谎报） | Bun 升级后跑探针回归（05 §6） |
| B14 真 chrome engine 级下载/上传 e2e + void 哨兵锚定 | fake 层已覆盖 31 用例；真 chrome 契约覆盖驱动层 | real 门扩展 |
| 会话预算 REST 面已加（budget 字段）但 SDK 文档未展开 | 低 | 04-usage 后续补 |
| dialogs 工具面 | 仅 caps 声明 | 独立裁决 |
