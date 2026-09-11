# 对抗审查：B17（最小 supervisor）——自审记录

> 06 批次收尾时的自审 + 真机调试记录（角色分离弱化——本批为进程编排，真机冒烟即为独立裁判）。

## 实现期发现并修复的缺陷（真机调试记录）

1. **waitForHealthUrl 收裸根 URL 永远失败**：调用方传 `http://127.0.0.1:port`（无 /healthz）→ 根路径 401 → 30s 超时 false。真机冒烟挂 30s 后定位（curl 对比 + 逐轮 fetch 打印复现）——修为无路径自动补 `/healthz`。
2. **孤儿 serve 进程污染后续测试**：失败用例的子进程未回收（stopAll 只在 happy path 调）——测试补 finally 语义检查 + 手动清场流程；supervisor 本身 stopAll 幂等已覆盖。
3. **runSupCommand start 分支 dwell 替身返回后落穿 usage 兜底**（返回 2 而非 0）——补显式 return；测试注入 dwell 使常驻路径可测。
4. **waitForHealthUrl 首版正则补路径法脆弱**——改为 pathname 判空补 /healthz。

## 设计核对（对照 05 §3.10）

- [x] spawn 参数含 `--backend chrome --data-dir <root/i/profile> --trajectory-dir <root/i/trajectories>`（审查 P5 处置）
- [x] env 不设 BW_DAEMON（禁用子进程空闲退出——审查 P5）
- [x] token 经 env（argv 不落 ps）；state.json 0600 + tmp/rename 原子写（审查 P2-21）
- [x] lockfile O_EXCL 防并发双 spawn（审查 P2-21）
- [x] 退出码非 0/信号 → 退避 1s/2s/5s；exit 0 不重启（测试实证两档退避时长）
- [x] /healthz 10s 轮询、连续 3 失败重启（probeInstance 抽出可测：200 复位/非 200 计数/3 失败触发/stopping 抑制）
- [x] 实例 ≤16；租户路由不做（文档化）
- [x] bw sup start|status|stop CLI（runSupCommand 可测化：status 空/stop 杀 pid+清锁/usage/锁冲突/dwell happy/warning/非 SupError 重抛）

## 验证

- 四门：tsc 0 / lint 0-0 / build OK / 506 pass + coverage PASS（supervisor 行 100%，函数 86.8%→豁免 min=80——5 个仅生产路径闭包：真 spawn 默认/dwell 默认/健康重启闭包）
- 真 chrome 冒烟：spawn → healthz 200 → stop 全绿，无孤儿残留
