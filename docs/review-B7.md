# B7 记录（非对抗审查——服务层无安全核心面）

> B7 为服务化批次（HTTP/CLI/轨迹读取），无独立对抗审查（03-units U7 不涉及安全核心）。
> 覆盖率豁免理由见 `scripts/coverage-exemptions`。B8 集成测试补齐后清空。

## 交付

- HTTP 服务（`@bw/service/server.ts`）：
  - POST /tasks → 202 {id}；GET /tasks/:id（running/finished）；GET /tasks/:id/events（SSE）
  - POST /tasks/:id/steer · /abort · /confirmations/:cid
  - Bearer 鉴权（无 token 配置 = 401 全拒）
  - 并发 ≤8（超出 429）
  - SSE 有界队列（1000 条，溢出合并丢 message_update）；task_done 恰好一次且最后
- CLI（`bw run` / `bw serve`）：
  - `bw run "goal" [--url] [--json]`——.env/~/.bw/.env/env 三层 key 发现
  - `bw serve [--port] [--token]`——HTTP 服务
- 覆盖率门升级：支持部分豁免（`min=N` 格式——文件在 lcov 但允许低于 90，理由必须落档）
