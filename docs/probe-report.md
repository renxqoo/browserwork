# 阶段 0 探针报告（B1，2026-09-10）

> 环境：macOS 26（darwin 25）/ Bun 1.4.2 / webkit 后端为主，chrome 后端 p9。
> 复跑：`bun probes/pN-*.ts`。RESULT 行为机器可读输出。

| # | 问题 | 实测结论 | 设计影响 |
|---|---|---|---|
| p1 | `alert()` 触发后 click/evaluate 会不会挂死 | **不会**。click 正常 resolve，后续 evaluate 正常，alert 被宿主自动处理（无事件可观测） | `dialogEvents:false` 定稿；**`dialogsUnsafe` 预案作废**（01 §5 原行删除）；dialog 语义 = 自动处理、不可观测 |
| p2 | `window.open` 的归宿 | **静默丢弃**：无新 view、无导航事件、当前页不变 | webkit 后端弹窗任务不支持（能力矩阵记 `popups:"dropped"`）；U3 提取脚本对 `target="_blank"` 链接加警告标注（B3） |
| p3 | evaluate 大结果上限 | **≥16MB 无压力**（16MB 字符串 253ms；1MB 3ms 疑似共享内存零拷贝） | 感知分块策略不需要（12K 预算远低于此） |
| p4 | webkit host 多 view 吞吐 | 4 view 并行 96ms vs 单 view 串行 194ms（**≈2× 并发度**，部分串行化） | §6.6「≤8 活跃任务」可行；吞吐上限实测在案，B8 压测复核 |
| p5 | 父进程 SIGKILL 后 host 孤儿 | **无孤儿**（2s/6s 后均为 0）——host 随管道关闭消亡 | 无需 supervisor 孤儿回收；崩溃清理只需处理进程内状态 |
| p6 | `data-bw-id` × 重渲染 | 重渲染后旧 id 消失（innerHTML 替换销毁属性）；**重新提取会重打 id 且工作正常** | P1-17 处置路径实证：元素被替换 → ELEMENT_NOT_FOUND → 重提取自纠 |
| p7 | `click(selector)` 穿 shadow DOM？ | **不穿**：`timeout waiting to be actionable`；**坐标轨命中**（shadow 内按钮点击成功） | `pierceClick:false` 定稿；P0-2 双轨设计实证成立 |
| p8 | 重定向链 onNavigated 上报 | **只报最终 URL**（单跳/三跳链都只见终点；中间 302 不可见）；事件发生时 title 可能为空 | S1③ 事后复检数据源成立且简单（单事件即终态）；复检只看 URL，title 用 `view.title` 另读 |
| p9 | chrome 后端 `url:false` 独立拉起 | 本机 Chrome 存在，navigate+evaluate 成功 | P1-11 铁律可实施；B2 契约测试双后端可行 |
| p10 | evaluate undefined 归一 | 单元测试覆盖：返回 `null`（driver 归一层） | 无额外影响 |

## 附带平台事实（切片旅程中发现）

- **click 触发的导航是异步的**：click promise 在事件处理器结束后 resolve，`view.url` 要等导航完成才更新——U4 settle（B4）必须存在；B1 用 `waitForNavigation` 过渡（登记于 02 §5 过渡态）。
- 构造期 `url` 导航在途时再调 `navigate()` 同步抛错——driver 测试避免双导航；B2 的 navigate 互斥队列吸收。

## 能力矩阵定稿（webkit 列，01 §5 同步）

`cdp:false · upload:false · download:false · dialogEvents:false（自动处理）· userAgentOverride:false · pierceClick:false · popups:"dropped"`
