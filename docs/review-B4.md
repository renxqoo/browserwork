# B4 对抗审查处置记录

> 审查者：独立子 agent（无实现上下文），静态 + 一次性探针真 WebKit 实证（探针已删）。
> 结论：**17 条全部处置（修复 13 / 部分采纳 2 / 登记后批 2）**；修复含 1 P0 + 4 P1。

## P0（修复 + 回归）

| ID | 问题 | 处置 |
|---|---|---|
| P0-1 坐标轨 below/above 元素：scrollIntoView 后用陈旧坐标 clickAt——WebKit 静默丢弃视口外坐标，动作**假成功**（实测：页面滚了、按钮没触发、引擎报 clicked） | 坐标轨改为「滚动 → **重新 locate** → 新视口坐标点击」；越界判定改用 locate 新鲜 rect（含横向，补齐 below/above 只算纵向的盲区）；type/type_text_secret 同路径修复 | regressions: deep-shadow below 元素点击真实命中 |

## P1（修复 + 回归）

| ID | 处置 |
|---|---|
| P1-2 表单内任意点击误报 submit 意图（input/checkbox 聚焦也报——B5 接线后每次输入都进确认门） | 意图判据改为「目标（或祖先）是 submitter 本身」：button[type=submit]、无 type 的 button（隐式 submit）、input[type=submit\|image]、带 formaction；`button form=` 跨表单归属修正（form 属性 → getElementById 优先） | regressions: 聚焦输入零意图、submit 按钮唯一意图 |
| P1-3 click 触发 JS 跳转后返回旧页快照（lastChange 是上次提取时刻 → settle 零等待放行；实测立即/延迟 400ms 两种都返回旧页） | settle 重设计：**最小观察窗**（settleQuietMs 从 settle 起算）+ **URL 基线**（动作前 URL；已变且不在加载 = 落地即返回）+ 观察者静默；click/press 以动作前 URL 为基线 | regressions: late-nav 立即/延迟两路径返回落地页快照 |
| P1-4 enter_submit 对 iframe/shadow 失明（实测 iframe 内 Enter 真提交、表达式返回 submit:false——S1②/S2 前检洞） | ENTER_SUBMIT 表达式改深度走查：activeElement 递归下钻同源 iframe/shadowRoot（深度≤5）；textarea 排除（反向误报） | regressions: iframe 内聚焦输入 + Enter → 意图可见 |
| P1-5 测试口径未兑现（fake 罐头 + journey 竞态好运气掩盖全部 P0/P1） | 补齐：reactish 受控输入 fixture（真 React 归 real 门，已注明）、select change 监听断言、below-shadow 命中、JS 跳转快照时效、iframe enter 意图、真 view scroll；测试全部链式使用最新快照（快照时效是本批最大测试教训） | regressions.test.ts 全套 |

## P2（处置）

P2-1 错误码：参数类（缺 snapshot/tab 越界/select 无效值）→ INVALID_TOOL_ARGS；「无活动页」保留 DRIVER_ERROR 但提示 open_tab 恢复（部分采纳） ✓ · P2-2 close_tab 改目标页锁内执行 ✓ · P2-3 S6 记忆改 origin+path 集合（query/hash 变化不换页；同 URL 双 tab 误拦属安全向，接受） ✓ · P2-4 fake createPage 失败回滚对齐真驱动 ✓ · P2-5 可输入判据补 isContentEditable（locate 返回 editable） ✓ · P2-6 select 无效值校验（options 命中才设置）→ INVALID_TOOL_ARGS ✓ · P2-7 intentSink 签名改可异步（B5 前检需等待 DNS）✓ · P2-9 locate 返回 visible（computed 复核），坐标轨点击前校验 ✓ · P2-11 new URL 兜底 try/catch ✓
登记后批：P2-8 轨迹截图钩子（B6 接线时以 onStep 钩子补，单元卡已注记）；P2-10 真 webkit scrollTo 超时 message 分类实证（B5 探针顺手补）

## 实现过程中自测发现

- Snapshot 缺 viewportW（坐标轨越界判定需要）——RawExtract/SnapshotScroll 补字段透传
- 快照时效规则在引擎契约中的地位升级：**每个 DOM 动作复合步重打 id，动作必须引用最新快照**（agent 循环与测试同规则；测试三次踩坑后成文）

## 已验证无问题

runExclusive 锁链模式、select 原生 setter + 双事件派发（change 实测触发）、core 判别联合、错误码词表与 §4.3 一致、依赖方向。
