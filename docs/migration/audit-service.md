# B22 迁移前审计——service 包（旧服务形态）

> 范围：`packages/service/src/{server,daemon,supervisor,shutdown,janitor,replay,index,version,cli,cli-run,cli-session}.ts`
> + 对应测试（作为行为规格清单）。`sessions.ts` 不在逐文件清单内，但因 server.ts 的
> 行为依赖其语义，相关交叉发现已标注（sessions.ts 自身的深度审计另行安排）。
>
> **方法论与诚实声明**：本审计为**静态阅读**（全部 11 个源文件 + 9 个测试文件逐行读完，
> 并交叉核对了 `@bw/agent` run.ts、`@bw/core` task.ts 的 TaskHandle/events/steer 实现）。
> 未执行任何测试或运行时复现。标注「测试已覆盖」= 存在测试用例锚定该行为；
> 标注「静态阅读」= 仅代码推理，未实测。行号以当前 main（f7c51f2）为准。
> 按四标准审：①正确性 ②契约符合 ③实现质量 ④依赖方向。

---

## 一、真 bug 清单（B#）

级别：`数据丢失 / 安全 / 一般`。处置：`随删除核销`（该文件随 serve/daemon/sup 整体删除，
bug 不再可达，但教训进第三节）/ `随迁移修` / `本波修` / `挂账`。

| # | 位置 | 级别 | 复现条件（静态/测试） | 修复决策建议 |
| --- | --- | --- | --- | --- |
| B1 | server.ts:72,174-179 | 一般 | 长驻 serve 每 POST /tasks 一次 `tasks.set`，完成后**永不删除**——ManagedTask+result 常驻内存，无界增长（含 aborted 任务）。静态阅读 | **随删除核销**（SDK run 无注册表）。教训：新形态不得有无界任务登记 |
| B2 | server.ts:161-173 | 一般 | `active >= maxConcurrent` 检查与 `active += 1` 之间隔 `await readJsonBody`——并发 POST /tasks 可超限（check-then-act 竞态）。静态阅读 | **随删除核销**。--jobs 池上限（DESIGN §3）天然无此竞态 |
| B3 | server.ts:377-379 + sessions.ts:745-748 | 一般（契约） | GET `/sessions/:id` 未知 id → 404，但 GET `/sessions/:id/snapshot` 未知 id → **200 `{snapshot:""}`**（sessions.snapshot 对缺失返回空串，server 无条件 200）。CLI 端 `bw s snap <bad-id>` → `{"ok":true,"snapshot":""}` exit 0——静默成功。静态阅读 | **随迁移修**：文件会话 snap 必须对未知 id 返回 `NOT_FOUND` exit 1（写入行为规格 #24） |
| B4 | server.ts:358-361 | 一般（契约） | DELETE `/sessions/:id` 未知 id → 200 `{ok:true}`（close 为 void，无法区分）。与 GET 404 不一致。静态阅读 | **随迁移修（规格决策）**：close 建议保持幂等成功（rm -rf 语义），但 GET/snap 必须区分存在性——在 MIGRATION 中定死 |
| B5 | server.ts:190-230 + agent/run.ts:221-227,739-747 | 一般 | `TaskHandle.events` 是**单消费者破坏性队列**（`eventQueue.shift()`）：同一 task 两个并发 SSE 订阅（或断线重连的第二个流）会互相抢事件——每个事件只到达其中一个订阅者。HTTP 层把它当广播流暴露。静态阅读（已核对 agent 实现） | **随删除核销**（HTTP），**但 SDK 继承同一 TaskHandle**：DESIGN §1.1 `TaskHandle{events}` 未注明单消费者约束——SDK 文档必须写明或加广播（进第三节缺口 G2） |
| B6 | server.ts:197-222 | 一般 | /tasks/:id/events 的写循环只在 `task_done` 或异常时 close writer；若 events 生成器耗尽而无 task_done（已被前一订阅者消费干的终态任务、上游契约破坏），SSE **挂起永不关闭**（sessions 侧 381-399 无此问题——总是 close，两处不对称）。静态阅读 | **随删除核销** |
| B7 | server.ts:99-114 | 一般 | body 上限：content-length 头可缺/可谎报；兜底用 `raw.length`（UTF-16 码元）——多字节 JSON 实际字节可达限值 ~3-4 倍。DoS 界限近似。静态阅读 | **随删除核销**（无 HTTP 面后无此攻击面） |
| B8 | server.ts:149 | 一般 | `lastRequestAt` 对**任何**非 healthz 请求刷新（含 401 未授权请求）——loopback 上未授权轮询可让 daemon 永不空闲退出。静态阅读 | **随删除核销**（daemon 无） |
| B9 | daemon.ts:53-63,119-124 | 一般 | `isServerRunning` 把**任何** HTTP 应答者当 bw serve（`res.status !== 0` 恒真）。陈旧 PID 文件 + 端口被无关服务复用 → 误收养：后续全部 401、PID 文件永不清理、报错误导。2.5 步已改 probeAuthorized，第 2 步仍是弱探测。静态阅读 | **随删除核销**。教训（进 G12）：文件会话复活前必须**验证身份**（schemaVersion/端点探测），不得信任「文件存在」 |
| B10 | daemon.ts:107-171 | 一般 | 两个并发 `bw s`（无运行服务）：都过 readPidFile→undefined、都 spawn 固定端口 3456——败者 child EADDRINUSE 死亡 → 调用方等满 5s 抛 `failed to start`（而服务其实正在起来）。自启动无锁竞态。静态阅读 | **随删除核销**。DESIGN §1.3 flock 快速失败已正确替代此场景 |
| B11 | daemon.ts:147-156 | 一般 | spawn 的 child 只挂 `exit` 无 `error` 监听：`bun` 不在 PATH / 二进制部署形态下 spawn 失败发 `error` 事件——无监听则进程**崩溃**（未捕获异常）而非干净报错。静态阅读 | **随删除核销** |
| B12 | daemon.ts:174-195 | 一般 | `bw s stop` + BW_SERVER_URL 指向活着的远程 → stopServer 返回 false → CLI 打印 `no server running`——误导（实际是无法停止远程）。静态阅读 | **随删除核销** |
| B13 | supervisor.ts:226-239 | 一般 | `superviseRestart` kill 旧 child 前不置 `old.stopping = true`：旧 child 若以**信号**退出（启动窗内被杀、硬崩），其 exit 回调按 index 找到的是**新替换实例** → 给健康新实例排一次退避重启（杀掉重拉）。另：exit-监控重启与 health-探测重启可对同一 index 并发各跑一次 superviseRestart → 双 spawn/孤儿 child。静态阅读（B17 测试只覆盖非并发路径） | **随删除核销** |
| B14 | supervisor.ts:279-283,319-321,375-393 | **高**（sup 面） | `bw sup stop` 只杀 state.json 里的**实例** pid 并清锁——supervisor 本体 pid **从未持久化**，常驻 supervisor 进程不被停止：其内存实例表仍在，health 探测 3×10s 失败后 `superviseRestart` **无条件 respawn**——`bw sup stop` 后 ~30s 所有实例在原端口复活。stop 不是 stop。静态阅读（b17 stop 测试只断言 kill 调用与锁清理，未观测复活） | **随删除核销**。教训：任何「停」命令必须先停管理者本体（pid 落盘）再停被管者 |
| B15 | supervisor.ts:375-391 | 安全（低概率） | `bw sup stop` 对 state.json 里的陈旧 pid 直接 SIGTERM，**无身份校验**——supervisor 长驻后 pid 复用可误杀无关进程。静态阅读 | **随删除核销** |
| B16 | cli-session.ts:210-216 | 一般 | `bw s --help` / `bw s`（无参）在打印帮助**之前**先 `ensureServer()`——**打印帮助会拉起后台守护进程**（首次调用慢 + 意外副作用）。静态阅读 | **随迁移修**（自然消解：daemon 删除后 help 路径必须零副作用——写入规格 #28/#32） |
| B17 | cli-run.ts:23-25 vs cli.ts:151-153,206-207 vs sessions.ts:146-148 | 一般（体验为数据丢失） | **BW_HOME 解析三分叉**：daemon/supervisor/replay/serve-trajectory 尊重 BW_HOME；`runTrajectoryDir()`（bw run 轨迹）与 `downloadsRoot()`（会话下载）**忽略 BW_HOME**。设 BW_HOME 后：`bw run` 轨迹写真实 HOME，`bw replay` 在 BW_HOME 找 → **找不到刚跑完的轨迹**；downloads 同理散落。静态阅读（security.test.ts 只对 daemon 设 BW_HOME） | **随迁移修（必修）**：统一 `resolveBwHome()` 单一解析器（D5）——DESIGN §1.2 `~/.bw/session/<id>` 布局是公开契约，不能三处各写一套 |
| B18 | cli.ts:60-104 | 一般 | parseArgs **静默吞未知 flag**：`--max-step`（拼错）被忽略 → 默认 50 步静默生效；未知 flag 的值甚至可被当作 goal 捕获（若 goal 未设）。隐藏默认 + 吞错。静态阅读 | **随迁移修**：新 CLI 参数面统一「未知 flag → 报错 exit 2」 |
| B19 | cli.ts:70-71,88-91 | 一般 | `--port/--width/--height/--max-steps` 直接 `Number()` 无校验：`--port abc` → NaN 一路传到 Bun.serve/driver，未定义崩溃而非干净 usage 错。静态阅读 | **随迁移修**（并入新参数解析） |
| B20 | shutdown.ts:23-31 | 一般 | `stop()` 抛错被吞后仍 `exit(0)`——优雅关闭失败与成功同退出码；错误静默（注释自认「尽力而为」但至少应非零退出或 stderr）。静态阅读 | **随迁移修**：信号路径退出码应反映任务结果（进规格 G4/bw run 信号语义） |
| B21 | server.ts:440-444 + cli.ts:179-183 | 数据丢失（轻） | stop() 对每个任务 `void handle.abort(...)` **不等待** finalize（轨迹终态写入是异步的）即 closeAll+exit——SIGTERM 时运行中任务的轨迹**缺终态行**，违反「终态事件最后且恰好一次」的收敛语义。静态阅读 | **随删除核销**。**教训直接进 G4**：bw run 的 Ctrl+C 必须等 abort→finalize 落盘再退出 |
| B22 | janitor.ts:88-100,117-127 + cli.ts:169-173 | 一般 | 容量策略按**每个目录**独立计量：downloads 根 `subdirs:true` 时每个会话子目录各得 512MB 预算，**总量无界**（直到年龄策略触发）；且 keep 会话（TTL 豁免可长活）目录内 >7 天的下载文件会被**在活跃会话脚下删掉**。静态阅读 | **随迁移修**：janitor 保留（DESIGN §2.1 gc）——改按根聚合计量 + 活跃会话目录豁免（可从 lock 存在性判断） |
| B24 | cli-session.ts mapToolArgs（旧 switch 原始名匹配） | 一般（潜伏，S0 金测试实证） | `bw s cookies-clear` 客户端报 unknown tool——旧 switch 覆盖了 raw `cookies-all` 却漏 raw `cookies-clear`（B11 wire 修复的漏网第 6 个）；help 文档有此命令 → 意图明确是支持 | **随迁移修**（已在 S0 映射层修复：cli-commands.ts cookies_clear case + 金测试锚） |
| B23 | packages/service/package.json + sessions.ts:11-14 | 一般（④依赖方向） | 包声明只列 `core/agent/policies`，但 sessions.ts 实际 import `@bw/actions`、`@bw/driver`、`@bw/perception`——**未声明依赖**靠 workspace 提升侥幸工作；包边界失真。静态阅读 | **随迁移修**：包重组（SDK 根包导出）时补齐或重排依赖 |

**测试已覆盖（非 bug，锚定事实）**：鉴权矩阵/401/202/409/429、healthz loopback-only、
P2-4 healthz 不喂空闲时钟、415/413/400、SSE task_done 恰好一次且最后、
`authToken` 缺省自动生成永不裸奔、token 不落 argv、PID/token 0600、
端口占用不误收养（B9 的 2.5 步修补有测试）、sup 退避矩阵/锁/幂等 stopAll、
崩溃恢复矩阵（claim-at-entry/进程级限次/恢复失败销毁）、janitor 年龄/容量/后缀过滤、
replay 控制字符剥离、S1③ 302 违规回滚、batch 全闸面。

---

## 二、重复代码清单（D#）

| # | 位置对 | 问题 | 提取计划 | 目标归属 |
| --- | --- | --- | --- | --- |
| D1 | cli.ts:60-104（parseArgs）↔ cli-session.ts:273-275（flagValue）↔ supervisor.ts:338-341（flag） | 三套手写 flag 解析，行为各异（吞未知 flag / 无类型校验 / 无复用） | 提取共享 mini flag parser：类型化取值 + 数值校验 + **未知 flag 报错**（修 B18/B19） | 新 CLI 参数层（cli/args.ts）；bw run 与 bw s 共用 |
| D2 | daemon.ts:35-44（writePidFile）↔ daemon.ts:84-93（persistServeToken）↔ supervisor.ts:156-168（writeState tmp+rename） | 0600 安全写两处重复；且与原子写**分叉**——PID 文件是直接 writeFileSync（并发读可读到撕裂 JSON，触发 B9 的 unlink 分支误删好文件） | 提取 `writeSecureFileAtomic(path, data)`：0600 + tmp+rename 单实现 | 新 fs 基础模块；**session.json 原子写（DESIGN §1.2）用同一函数** |
| D3 | daemon.ts:53-63（isServerRunning）↔ daemon.ts:66-76（probeAuthorized） | 同一 fetch 探测两个变体、弱/强判定散落 | 合并为 `probe(url, token?) → status` | 随 daemon 删除核销；文件会话「端点死探测」复用同型（返回状态而非布尔） |
| D4 | server.ts:190-230（tasks SSE）↔ server.ts:381-407（sessions SSE） | TransformStream+writer+encoder+sseFormat 循环重复，且背压策略**不一致**（tasks 有 MAX_QUEUE 丢 message_update；sessions 无丢弃、依赖 500 条 buffer + writer 背压） | 曾可提 `sseResponse(iterable)` 工厂 | 随 HTTP 删除核销；SDK 侧只需记住 events 单消费者约束（B5） |
| D5 | cli.ts:151-153 ↔ cli.ts:206-207 ↔ cli-run.ts:23-25 ↔ sessions.ts:146-148（downloadsRoot） | `BW_HOME ?? HOME ?? /tmp` 家目录 + `.bw/trajectories`/`downloads` 拼接四处各写，BW_HOME 语义不一致（= B17） | 提取 `resolveBwHome()` / `trajectoryDir()` / `downloadsRoot()` 单一来源 | 新 fs 布局模块；**迁移必修**（~/.bw/session 布局是公开契约） |
| D6 | cli.ts:129-141（run driverOptions）↔ cli-session.ts:289-300（create body）↔ server.ts:328-335（/sessions driver 映射） | 「CLI/HTTP 参数 → CreateDriverOptions」三处映射重复（ua→userAgent 等键名转换散落） | 提取 `driverOptionsFrom(args)` 纯函数 | CLI/SDK 参数层；迁移后 bw run 与 bw s create 共用 |

---

## 三、契约缺口清单（被删面 → 新归属 → 缺口判断）

新归属依据 DESIGN §2.1 / §1.3 / §1.1。判断「缺口=是」= 迁移必须补对应物或补文档承诺。

| # | 旧行为（file:line） | 新归属（DESIGN） | 缺口判断 |
| --- | --- | --- | --- |
| G1 | 确认门：工具 202 `{code:CONFIRMATION_REQUIRED,cid,reason}`（server.ts:426）；`bw s confirm <id> <cid> --yes`（cli-session.ts:363-374）；120s 超时=deny（sessions.ts:315-319） | §1.3 pending/<cid>.json + `bw s confirm` + 惰性 120s 过期；§2.1 executeTool+确认门 | **否**——已覆盖。注意点：旧 SSE 事件流也能发现 cid，新形态 cid 由工具同步响应携带即可（CLI 场景足够） |
| G2 | 自治任务中途改向 `POST /tasks/:id/steer`（server.ts:237-249；TaskHandle.steer 存在，core/task.ts:117） | §1.1 `bw.run(...) → TaskHandle{ events, result, abort }`——**漏列 steer** | **是（文档缺口）**：SDK TaskHandle 应含 `steer`（与 confirm 同理——run 任务内的确认门消费方式也需写明）。另须注明 events 单消费者（B5） |
| G3 | healthz 匿名探活 + version/uptime/sessions/activeTasks（server.ts:133-148） | 无服务面；「下次命令探测端点死」（§1.3）；`bw --version` | **否**——故意删除（U1）。metrics 面无对应物是裁决结果，不需要补 |
| G4 | 优雅退出：SIGTERM/SIGINT → 停收 → abort 任务 → 关会话 → 清 PID → exit；二次信号强退（shutdown.ts + cli.ts:174-183）——但见 B21 轨迹截断缺陷 | serve 删除后**无主**；DESIGN §1.3「终态事件最后且恰好一次」隐含但未写信号路径 | **是（行为缺口）**：`bw run` 当前**无任何信号处理**（cli-run.ts 无 handler，Ctrl+C 裸杀 → 轨迹可能缺终态，与 B21 同病）。迁移必须给 bw run 装等价语义：SIGINT → handle.abort → **等 finalize/轨迹落盘** → 按结果定退出码；二次信号强退。SDK 侧 abort 已有 |
| G5 | /tasks 异步跑：202+id、GET 状态轮询（不阻塞，server.ts:231-236）、SSE、并发上限 429（161-162） | §1.1 `bw.run → TaskHandle`；§3 --jobs N（默认上限 8） | **否**——覆盖。B1/B2 的教训不迁移（无注册表；池上限无竞态） |
| G6 | 会话 TTL 30min 惰性清理 + keep 豁免 + close/destroy 清下载目录（sessions.ts:212-221,772-783） | §2.1 gc（惰性+显式）+ keep + close；§1.2 目录自包含（rm -rf 即销毁） | **否**——覆盖。注意 keep 时清下载目录的语义要在新 keep 规格中保留或显式变更 |
| G7 | 会话事件流 GET /sessions/:id/events：500 条 buffer、多订阅者、close 即终（server.ts:381-407 + sessions.ts:751-770） | 外部 agent 模式 CLI 同步调用；无对应物 | **否**——判断不需要：外部 agent 用 console/errors 等 inspect 工具轮询即可；自治模式 SDK run 的 events 已覆盖 |
| G8 | daemon 自动拉起 / 空闲 60s 退出 / PID+token 0600 / BW_SERVER_URL 远程复用（daemon.ts 全文） | 文件会话无服务（U1/U2） | **否**——删除。**但迁移需补「遗留清扫」**：~/.bw/{serve.pid, serve.token, sup/, trajectories(旧), downloads(旧)} 的处置（至少 MIGRATION 写明：旧 token 文件建议提示用户删除，避免 0600 明文 token 永留盘） |
| G9 | supervisor：N 实例、退避重启 1/2/5s 封顶 30s、healthz 3 失败重启、O_EXCL 锁（supervisor.ts） | U9 明确不做（--jobs 覆盖并发） | **否**——用户裁决 |
| G10 | HTTP 安全面：Bearer 常数时间比对、Host 白名单、content-type 强制、413、nosniff/no-store（server.ts:46-114） | 无网络面后无攻击面（§3：CDP 口是 Chrome 自身行为） | **否**。安全承诺转为：profiles/secrets 0600（§1.2）——审计确认旧实现的 0600 习惯（D2）应延续到新 fs 模块 |
| G11 | maxSessions=16 → SessionLimitError → HTTP 429（sessions.ts:130,152-157；server.ts:339-341） | DESIGN **未写**每机/每用户会话数上限（§3 只写 --jobs 8） | **是（小，规格决策）**：文件会话形态下 16 上限是否保留（磁盘/进程资源约束）——建议保留软上限或显式决策「无上限+gc」并写进 MIGRATION |
| G12 | daemon 误收养防护（端口占用+token 验证才收养，daemon.ts:126-141） | 文件会话复活：端点死探测→标记→恢复（§1.3） | **否（已覆盖）但带教训**：session.json 的复用必须**验证内容**（schemaVersion + 端点活性），不得信任文件存在性（B9 教训） |
| G13 | DELETE 幂等 200 vs GET 404 的存在性区分（server.ts:354-361——见 B3/B4） | §2.1 close/status | **是（规格缺口）**：新 CLI 必须区分：未知 id 的 snap/get → NOT_FOUND exit 1；close 幂等成功。写入行为规格 |
| G14 | healthz 不喂空闲时钟、未授权请求喂时钟的边界（server.ts:131-149，B8） | 无 daemon | **否** |

---

## 四、行为规格清单（迁移后必须等价的基线，供 MIGRATION 引用）

> 来源：静态阅读 cli.ts / cli-run.ts / cli-session.ts / replay.ts / janitor.ts；
> 标 ✅ 的有测试锚定（b18/b13/coverage/security 等），其余为代码即规格（**注意：
> cli-session.ts 全文件零测试覆盖**——迁移时这些规格必须先有测试再动刀）。

### 4.1 bw run（cli.ts + cli-run.ts）

1. ✅ 缺 goal → stderr `bw run requires a goal: bw run "do something"`，exit 2。
2. flags：`--url/-u`、`--json`、`--verbose`、`--max-steps N`、`--backend <webkit|chrome>`、
   `--data-dir`、`--chrome-path`、`--width`、`--height`、`--ua`（→ driver.userAgent）；
   后六项仅在显式给出时组装 driver 对象；goal = 首个非 `--` 开头参数。
3. key 解析：进程 env `GLM_API_KEY` 优先；否则 `.env` 与 `~/.bw/.env`
   （后者覆盖前者）；`GLM_BASE_URL/GLM_MODEL/GLM_STRONG_MODEL` 仅当 key 未在进程 env
   时从 envFiles 兜底；全无 → stderr `GLM_API_KEY not found (env, .env, or ~/.bw/.env)`，exit 2。✅（cli.test.ts）
4. `BW_PRICES_JSON`：进程 env 缺省时从 envFiles 提升（价目表也认 .env）。✅（coverage）
5. startUrl 以 `http://127.0.0.1` 开头 → 自动 testMode。
6. 轨迹**总是**落盘：`BW_TRAJECTORY_DIR ?? ~/.bw/trajectories/<taskId>.jsonl`（含 --json 模式）。✅（b18）
   ⚠ B17：BW_HOME 不一致——迁移时随 D5 统一。
7. 非 json 过程渲染（✅ b18 全套断言）：
   - tool_execution_start → `\n▸ [n/max] tool k=v k=v`；n 由渲染器自增（非引擎步数）；
     max = `--max-steps` 或 50；>60 字符的 `text` 参数整段省略；值截 60 字符加 `…`。
   - tool_execution_end → `  ✓ <resultText 前 100 字符> (<x.x>s)`（无结果 `  ✓ ok`）；
     随后 `    ↳ <title 截 60|url 回退> · N 元素`（与前页 title+url+elements 全等追加
     `（页面未变）`）；verbose 时 snapshotHead 每行加 `    │ ` 前缀（仅 verbose）。
   - confirmation_required → `\n⚠ 确认门 [<cid>]: <reason>` + 固定第二行
     `  （CLI 不交互，120s 后自动拒绝；起始域可用 --url 预授权）`（用户裁决 2026-09-12 保持非交互）。✅
   - budget_warn → `\n⚠ 预算: <dimension> <usedPct>%`；
     stuck_escalated → `\n⚠ 卡死 — 模型升级 <from> → <to>`；
     message_update → 裸 `process.stdout.write`（流式文本）。
8. 终局两行：`\n── result: <status> — <answer?>` 与
   `   steps=<N> · tokens <in>/<out> · <wall>s · trajectory=<path>`；
   tokens ≥1000 → `3.1K` 形态。✅（b18 fmtTokens）
9. `--json`：仅一行 TaskResult JSON，无过程输出。
10. 退出码：`status==="done"` → 0；否则 1；缺 key/缺 goal → 2。✅
11. 事件消费终止于 task_done（不等生成器耗尽）。
12. ⚠ G4：当前**无信号处理**——迁移需新增 Ctrl+C 语义（abort→落轨迹→按结果退出）。

### 4.2 bw replay（replay.ts + cli.ts）

13. `bw replay <taskId|file>`：目标以 `.jsonl` 结尾按路径；否则 `<baseDir>/<id>.jsonl`；
    baseDir = `BW_TRAJECTORY_DIR ?? (BW_HOME|HOME|/tmp)/.bw/trajectories`。
14. 缺文件 → stderr `trajectory not found: <绝对路径>`，exit 1；缺参数 → usage，exit 2。✅（b13）
15. 行格式：`#<step> <action.kind> <url> domHash=<hash> | <resultText 首行截 120>`；
    action 无 kind → JSON 前 40 字符；解析失败行 → `# (unparseable line) <前 60 字符>`；
    空行跳过；输出剥离 ESC/C0 控制字符（保留 \t\n）——终端注入面。✅（b13 P2-10）
16. 成功逐行 stdout，exit 0。✅

### 4.3 janitor（janitor.ts；serve 内建 → 迁移后为 gc 的基础）

17. sweepDir 单目录：先年龄（mtime > retentionDays，默认 7 天）后容量
    （总量 > maxTotalBytes，默认 512MB，按最旧删到达标）；`extensions` 后缀过滤
    （trajectories 用 `.jsonl`——防误删同目录 serve.token 类文件 ✅ b13 P2-6）；
    目录缺失 no-throw 返回 `{deleted:0,bytesFreed:0}` ✅；单文件 unlink 失败跳过不中断；
    返回 `{deleted, bytesFreed}`。
18. startJanitor：**启动即扫** + 周期扫（默认 1h，intervalMs 可调）✅；timer unref；
    返回停止函数。
19. serve 装配形态：`[{dir: trajectories, extensions:[".jsonl"]}, {dir: downloadsRoot, subdirs:true}]`
    ——下载根一层子目录展开清扫 ✅（b14）。⚠ B22：子目录各自预算 + 活跃会话误删需迁移时修正。

### 4.4 bw s（cli-session.ts——迁移后直连文件会话，输出契约不变）

20. **输出统一单行 JSON**：成功 `{ok:true,...}` exit 0；失败
    `{ok:false, code, error, hint?, sessionId?}` exit 1；连接错误也是 stdout 的 JSON
    （`console.error` 仅 help 外的 create 缺 goal 等少数路径——本文件实际全走 out/fail）。
21. 命令面（39 个）：create/list/snap/extract/look/click/type/navigate/press/scroll/
    scrollto/select/wait/batch/keep/rename/opentab/switchtab/closetab/tabs/console/
    errors/cookies/cookies-set/cookies-clear/cookies-all/storage/storage-set/
    storage-clear/eval/resize/reload/download/upload/requests/confirm/close/stop
    （+ `--help`/无参=help，exit 0）。
22. wire 名映射（CLI 名 → 工具规范名）：scrollto→scroll_to、opentab→open_tab、
    switchtab→switch_tab、closetab→close_tab、extract→extract_text、
    cookies-set→cookies_set、cookies-clear→cookies_clear、storage-set→storage_set、
    storage-clear→storage_clear、cookies-all→cookies_all（B11 修复回归点）。
23. 参数映射细节：eval 表达式 `args.join(" ")`（可含空格）；wait 第二参字面量
    `networkIdle` → `until`；scroll 第二参数值化；resize 宽高数值化；
    upload 多文件 `args.slice(1)`；batch 参数整体 join 后 JSON.parse（失败 →
    INVALID_ARGS `steps must be a JSON array of actions`）；storage 可选 key；
    press 单 key；缺参各命令有专属 usage 文案（INVALID_ARGS）。
24. create flags：`--url/--allow-eval/--allow-private-network/--name/--backend/
    --data-dir/--chrome-path/--width/--height/--ua`；成功 →
    `{ok:true, sessionId, result:<startUrl>}`（无 url 则省 result）。
    ⚠ 旧链路：`--allow-private-network` 需 serve 级 env BW_ALLOW_PRIVATE_NETWORK=1、
    路径类需 BW_ALLOW_DRIVER_PATHS=1（server.ts:296-314）——**S4 门的新家在 SDK 初始化 +
    create 参数（DESIGN §2.1）**，CLI 参数面保留、门语义保留、env 名去留需 MIGRATION 裁决。
25. 确认流：工具返回确认门 → `{ok:true, sessionId, tool, cid, reason,
    result:"CONFIRMATION_REQUIRED: <reason>"}` **exit 0**（不是错误）；
    `bw s confirm <id> <cid> --yes|-y`（不给即 deny）→ `{ok:true, sessionId, cid}`；
    缺 cid → MISSING_CID。
26. 错误码目录（含 hint 文案，迁移后逐字保留或显式改写）：
    - SERVER_NOT_RUNNING（fetch 错误消息含 `ConnectionRefused`/`Unable to connect`；
      hint: `run 'bw s stop' then retry (daemon will auto-start), or start manually: bw serve`）
      ——**随服务面删除，此码退役**，新形态的错误码按文件会话重定义。
    - MISSING_SESSION（hint `run 'bw s create' first`）、INVALID_ARGS（含各 usage 文案）、
      NOT_FOUND、CREATE_FAILED、LIST_FAILED、KEEP_FAILED、RENAME_FAILED、CLOSE_FAILED、
      MISSING_CID、CONFIRM_FAILED、LOOK_FAILED、TOOL_FAILED；
    - 服务端透传码 + hint：ELEMENT_NOT_FOUND（`run 'bw s snap <id>' ...`）、
      ELEMENT_NOT_ACTIONABLE（scrollto 建议）、POLICY_BLOCKED、CONFIRMATION_DENIED、
      INVALID_TOOL_ARGS（`check argument order`）、DRIVER_ERROR（`session may have expired
      — run 'bw s list'`）、EVAL_DISABLED（`re-create ... --allow-eval`）、TIMEOUT。
    - look 专属：POLICY_BLOCKED 时 hint `secret was typed on this page — screenshot blocked`。
27. look：`--out <file>` 缺省 `/tmp/bw-shot-<epochMs>.png`；base64 写盘 →
    `{ok:true, sessionId, path}`；无 image → `result:"screenshot taken (no image data)"`。
28. keep → `{ok:true, sessionId, result:"session kept (TTL exempt)"}`；
    rename → `result:"renamed to <name>"`（缺名 → INVALID_ARGS usage）；
    rename 名服务端截 80 字符（server.ts:374）。
29. close → `{ok:true, sessionId}`；list → `{ok:true, sessions:[...]}`；
    snap → `{ok:true, sessionId, snapshot}`（⚠ B3：未知 id 旧链路返回 ok+空串——
    迁移规格改为 NOT_FOUND）。
30. stop → `{ok:true, result:"server stopped"|"no server running"}`——**命令随 daemon
    退役**；help 文本中 "Server auto-starts on first use..." 段与 Env 段（BW_SERVER_URL/
    BW_TOKEN）随服务面删除（B16：help 路径必须零副作用）。
31. 其他 fetch 异常（非连接拒绝）原样重抛（未捕获 → 非零退出）。

### 4.5 bw 顶层（cli.ts）

32. `bw --version|-v` → `0.0.1`（version.ts 与 package.json 目前手工同步，版本治理缺机制）exit 0；
    `bw --help|-h`/无命令 → help 文本 exit 0；未知命令 → stderr
    `unknown command: <cmd>` exit 2。✅（coverage）
33. help 文本结构：Usage 块逐命令一行——serve/sup 行删除后同步收缩；
    `bw s` 行改为文件会话语义。
34. 退出码约定全表：0 成功（含 CONFIRMATION_REQUIRED 的 202 语义）；1 工具/任务失败
    （bw run 非 done / bw s fail）；2 用法错误（缺 goal/缺参数/未知命令/未知子命令）。

---

## 五、测试文件清单（行为规格锚点，迁移时随语义搬运）

| 文件 | 锚定的行为（摘要） | 迁移处置 |
| --- | --- | --- |
| cli.test.ts | 鉴权矩阵 401/400、POST /tasks 202+轮询 finished、404、无 token 全拒、SSE task_done 恰一且最后、steer/abort/confirm 终态语义 409/200、429、400 无效 JSON、GET running 不等待、SSE 断连不炸、runCliTask 缺 key exit 2 | HTTP 面测试随删除核销；runCliTask 缺 key 规格保留 |
| sessions.test.ts | 会话生命周期/工具矩阵/S1/S1③/S2/S4/确认门批准与拒绝/并发 3 会话隔离/错误处理/快照格式/maxSessions/ID 随机/tabs/extract 不清缓存/eval 门/console/errors/cookies/storage；HTTP 端点 201→snapshot→tools→DELETE→404、确认流 202→confirm→200 | 语义全部进新 SDK/文件会话测试（ fixtures 与断言可搬） |
| b13.test.ts | 生产档 S4/429/healthz（loopback 200·非 loopback 404）/轨迹工厂落盘/janitor 年龄+容量+后缀过滤/replay 渲染+缺失+控制字符/空闲退出/信号处理（0/1/卸载）/崩溃恢复三态/unchanged/pidFileCleanup/isServeIdle/startJanitor/replay CLI 退出码/P1-3 env 门/P2-4 healthz 时钟 | janitor/replay/信号/崩溃恢复/unchanged 规格保留搬运；healthz/空闲退出核销 |
| b14.test.ts | chrome-only 工具闸（webkit 拒 download/upload/requests/cookies_all）、upload 目录外确认门+批准执行、webkit+UA fail fast | 全部保留（会话语义不变） |
| b17.test.ts | sup 全矩阵：start N/state.json 0600/退避 1s→2s/exit0 不重启/stopAll 幂等+锁/O_EXCL 双锁/instances 越界/restart/probeInstance 三态/readState 损坏容错/runSupCommand 退出码（0/1/2）/dwell | **整体核销**（U9）；B14 复活 bug 证明测试未覆盖「stop 后不复活」——核销即可，无需补 |
| b18.test.ts | 渲染器纯函数全套（formatToolStart/End/PageState/fmtTokens/printEvent 确认门文案与 verbose）/事件透传 args·ms·pageState·snapshotHead/轨迹工厂路径 | **全部保留**（bw run 输出规格的锚点） |
| b20.test.ts | 引擎拒 batch 旁路/networkIdle 双端/agent batch 计步=子步+末快照+首错即停/会话 batch 同语义/参数校验（无 steps/含 done/>10/嵌套）/keep·rename/batch 内导航确认挂起/P0-0 子步 S1①/loc 渲染 | 全部保留（会话+agent 语义不变） |
| security.test.ts | tokenMatches/isAllowedHost 矩阵/serveSpawnArgs 无 token/0600/损坏 PID 清除/isServerRunning/ensureServer 三态/stopServer | 核销（HTTP+daemon 面）；0600 习惯延续到 profiles/secrets（G10） |
| coverage.test.ts | steer 运行中 200/缺 text 400/stop 幂等/未知子路径 404/printEvent 分支/json 模式/.env 读取/parseArgs/main 退出码/serve 分支冒烟 | HTTP 部分核销；cli-run/parseArgs/退出码部分保留（并入新 CLI 测试） |

**关键空窗**：cli-session.ts（449 行，外部 agent 全命令面）**零测试**——本审计第四节 4.4
即其唯一规格来源。迁移动刀前必须先为 4.4 各条补测试（金主：输出 JSON 形态、错误码目录、
wire 名映射、确认流 exit 0）。

---

## 六、依赖方向备注（④）

- `index.ts` barrel 导出 daemon/server/supervisor 符号（含 `IDLE_EXIT_MS`）——迁移时
  barrel 须整体重排为 SDK 面（sessions/create 等），不得残留已删模块再导出。
- `supervisor.ts:131` 默认 `cliPath="dist/cli/cli.js"`——服务包依赖**自身构建产物**，
  源码运行即坏（5s 超时后才报错）。随删除核销，但教训：新形态不得默认引用构建产物路径。
- `@bw/service` 未声明 `@bw/actions/@bw/driver/@bw/perception`（B23）。
- server.ts 同时承载自治任务与会话两个产品面 + stats/空闲策略组装——机制层尚干净
  （空闲谓词 isServeIdle 在 daemon.ts、组装在 cli.ts），迁移后该「组装」职责落 SDK 入口。
- 未发现循环依赖；cli.ts 对重模块全部懒 import（好实践，保留）。
