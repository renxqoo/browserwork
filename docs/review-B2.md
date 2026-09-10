# B2 对抗审查处置记录

> 审查者：独立子 agent（无实现上下文），静态审查 + 6 个一次性探针真 webkit 实证（探针已删）。
> 结论：**12 条全部处置（修复 9 / 登记后批 2 / 改文档 1）**。

## P0（已修复 + 回归用例）

| ID | 问题 | 处置 |
|---|---|---|
| P0-1 | close/宿主死亡打断在途 navigate → 错分类 `NAVIGATION_FAILED`（实测复现：cause "WebView closed" / "host process killed by signal 9"）；崩溃快速终止链路（§6.6）被可自纠码打断 | 映射器补 `WebView closed`/`host process`/`killed by signal` → `DRIVER_ERROR`；契约真 view 套件加回归用例（slow 导航在途 close → 断言 DRIVER_ERROR） |

## P1（已修复）

| ID | 问题 | 处置 |
|---|---|---|
| P1-2 | FakeDriver.close 边遍历边 splice：N≥2 时漏关一半且被除名（实测 4 页漏 2） | 迭代副本 |
| P1-3 | FakeDriver.createPage 忽略 `opts.url`——真/fake 语义分叉；backends 的初始导航分支零覆盖 | fake 对齐（url → navigate 30s）；契约套件补 createPage({url}) 用例（三后端） |
| P1-4 | chrome 套件硬编码 macOS 路径 + 静默不注册——Linux CI 契约空转且门照绿 | describe.skipIf 显式跳过（bun 计数）+ BUN_CHROME_PATH/Linux 安装位候选 |

## P2（处置）

| ID | 处置 |
|---|---|
| P2-5 注释过度承诺（click 触发的导航不经 navChain） | **改注释收窄承诺**：队列只覆盖本包装层导航，click 自导航归 U4 settle（实测未复现撞错，降级成立） |
| P2-6 close 后全方法矩阵缩水 | 补全 8 方法矩阵 + driver.close 收尾（不再泄漏 view） |
| P2-7 navigate 互斥无直接断言 | 契约套件补并发 navigate×2 用例；ERR_INVALID_STATE 映射分支由探针实证 + P0-1 回归间接覆盖（fake 造不出该错误，登记为已知限制） |
| P2-8 FakePage.navigate 忽略 timeoutMs | 实现超时竞速（与真驱动同形）；fake 即时完成故超时分支仅 handler 慢时触发——文档化分叉 |
| P2-9 createPage({url}) 失败泄漏 view | 失败即 close+注销再 rethrow |
| P2-10 closed 抛错形态不一致（navigate 异步 vs 其余同步） | navigate 入口同步 #require |
| P2-11 FakePage 命中表 vs 规格「模拟主文档作用域」 | **裁决改文档**：U2 措辞改为「命中表 = 可配置的主文档 DOM」，作用域真实性由真 view 套件保证 |
| P2-12 createPage({url}) 无超时 | 默认 timeoutMs 30s |

## 已验证为正确（对抗未击穿）

navigate 互斥链无检查间隙、TIMEOUT 弃等槽位语义（含 timer 在导航真正开始后才计时）、超时分支无 unhandled rejection、Set 迭代删除安全、chrome url:false 铁律、监听器隔离、B1 处置项无回归。
