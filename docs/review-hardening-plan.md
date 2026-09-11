# 对抗审查：05-hardening-plan.md（定稿前）

> 审查者：独立 general-purpose 子 agent（角色分离，未参与起草）· 2026-09-11
> 输入：05 草稿 + 01/03 契约 + 全库代码核对
> 结论：24 条（P0×4 · P1×13 · P2×7），全部处置——22 采纳（含 4 条改道实现）、2 条以更优方案替代。最危险三类：(a) unchanged 标记致模型失明；(b) 会话模式生产默认 test 档策略上叠加高危能力；(c) B13/B17 生命周期互斥。

## 处置表

| # | 级 | 摘要 | 处置 |
|---|---|---|---|
| 1 | P0 | unchanged 标记参与 keep-2 挤出最后全量快照 | 采纳：keep-2 只数全量快照（带 `# Page:` 头），标记不占位（05 §3.1 重写） |
| 2 | P0 | 值变更豁免白名单漏 checkbox/JS toggle | 采纳并改道：白名单废除 → 渲染文本逐字符 diff 判定（05 §3.1） |
| 3 | P0 | 会话模式生产默认 = testPolicyConfig（S4 全开） | 采纳：B13 首项 `policyMode` 缺省 production（05 §3.5 新增） |
| 4 | P0 | cookies_all 无闸凭据外泄面 | 采纳并加强：值永不出域（只回元数据+掩码），opt-in 都不开（05 §0/§3.7） |
| 5 | P1 | supervisor 与 idle-exit/janitor 互斥 | 采纳：sup 子进程不设 BW_DAEMON；exit 0 不重启；per-instance trajectory-dir（05 §3.10） |
| 6 | P1 | 历史导航可重放写操作；onNavigated 实证缺 | 采纳：lastNavWasPost 时 reload/go_forward 过 S2 门；B14 探针（05 §3.7） |
| 7 | P1 | S1③ 窗口期内下载已启用 | 采纳：setDownloadBehavior 仅动作窗口内启用；回滚/销毁清目录（05 §3.7） |
| 8 | P1 | 下载无预算/文件名穿越 | 采纳：并发/单文件/累计上限 + sanitize + janitor 兜底（05 §3.7/§4） |
| 9 | P1 | 上传路径闸 symlink/CWD/不可配 | 采纳：默认仅 tmpdir + realpath 双向 + allowUploadDirs 入请求面（05 §3.7） |
| 10 | P1 | resize 后缓存坐标失效 | 采纳：resize 复合步强制重提取（05 §3.7） |
| 11 | P1 | download 若独立分支绕过 S1②/S5 | 采纳：复用 click 复合步，仅追加下载等待（05 §3.7） |
| 12 | P1 | 崩溃恢复状态语义未定义 | 采纳：单页化明示 + 挂起确认 deny + 进程级限次 + 01 回改 carve-out（05 §3.6/§7） |
| 13 | P1 | chars/token=3 对 CJK 方向性错误 | 采纳：CJK 分档 1.5/4 + image 2000 token 直计 + 阈值降 0.5（05 §3.2） |
| 14 | P1 | chrome 真视图 macOS CI 不可达 × 覆盖率门 | 采纳：FakeDriver-CDP 模拟为主覆盖来源；真视图 skip-if（05 §3.7/§3.8） |
| 15 | P1 | 联动面遗漏（buildAction/命令表/prompt/PolicyConfig/03 回改） | 采纳：批次表加「联动文件」列 + §7 回改清单（05 §5/§7） |
| 16 | P1 | SESSION_LIMIT 污染 core 错误分类法 | 采纳：服务层 SessionLimitError → 429；core 不动（05 §2.1） |
| 17 | P1 | strong 续跑缺状态迁移清单 | 采纳：迁移表逐项断言 + 引用既有实证（05 §3.3） |
| 18 | P2 | healthz 非 loopback 匿名访问 | 采纳：非 loopback 返回 404（05 §2.5） |
| 19 | P2 | UA 施加时点不一致 + 措辞 | 采纳：about:blank 建会话→覆写→再导航；措辞改受控测试能力（05 §3.7） |
| 20 | P2 | 网络监听 url 无上界 | 采纳：≤500 字符 + truncated 标记（05 §2.3/§4） |
| 21 | P2 | supervisor state.json 竞态 | 采纳：原子写 + lockfile + 轮询周期入预算（05 §3.10/§4） |
| 22 | P2 | B16 第三套 LLM 客户端 + 提示词不对等 | 采纳：复用 pi-ai；提示词差异落档披露（05 §3.9） |
| 23 | P2 | assistant 压缩破坏消息结构 | 采纳：仅截 text part + 结构断言（05 §3.2） |
| 24 | P2 | 「词表追加均为加法」不实 | 采纳：改为显式同步扩项清单（05 §2.2/§6） |

无驳回项。
