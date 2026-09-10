# B5 对抗审查处置记录

> 审查者：两个独立子 agent（无实现上下文），静态 + 一次性探针实证（探针已删）。
> 结论：**无 P0**——S1/S4 核心边界（协议白名单/IP 全记法/origin 匹配/S3）在可达输入域内
> 全部经受住攻击（尾点 IP、0x/十/八进制、短形、userinfo 伪造、反斜杠、%2e 主机、全角句点、
> zone-id IPv6、DNS 反弹内网等均被拦）。P1×5 全部修复 + 回归用例；P2×12 处置。

## P1（全部修复 + 回归用例）

| ID | 问题 | 处置 |
|---|---|---|
| P1-1 S5 token 阈值 32 ≠ 规格明文 ≥24；且点分隔（JWT 三段）完全绕过 | 阈值改 24；token 检测对分隔符剥离面二次检测 | 回归：23/24 边界 + 84 字符 JWT 拦截 |
| P1-2 S6 redact 无解码轮：双重编码 secret 实测泄漏；base64url/hex/大写不替换 | 变体注册补 base64url/hex；redact 替换 v/enc(v)/enc(enc(v)) 三形态 + 大小写镜像回替 | 回归：五种形态全替换 |
| P1-3 S5 只挂在 allow 分支——confirm 场景用户看不到外发风险，批准后重发若直通则 S5 永不生效 | guardUrl 重排：S4 → S5 → S1 三态（S5 无条件先行） | 回归：新域+token → block |
| P1-4 action 确认无「批准后放行」通道——U6 重发即死锁或整体跳检（真洞） | 一次性放行令牌：approve(action cid) → 记签名；onAction 同签名匹配 → 放行一次后消费 | 回归：批准→放行→再发→再确认 |
| P1-5 S2 词面匹配被零宽字符/分隔符/全角击穿（实测「支​付」「Ｐｕｒｃｈａｓｅ」全过） | NFKC 归一化 + 剥离零宽/分隔符后匹配 | 回归：四种混淆形态全部进确认门 |

## P2（处置）

| ID | 处置 |
|---|---|
| contextWindow 死代码（consume/assert 双 no-op——B6 必踩坑） | consume 走 tokensInput 账户、assert 比对 contextWindow 限值、维度报告 contextWindow ✓ 回归 |
| about:blank settled 自触发违规→回滚循环 | settled 显式豁免 about:blank（自家回滚目标）✓ 回归 |
| 预算 NaN 永久失效维度 / 负数回冲 / usage 活引用 | consume 拒绝非有限/负数；usage 返回副本 ✓ 回归 |
| DNS 失败缓存（SERVFAIL 永久当通过） | 仅缓存成功解析；失败每次重查 ✓ 回归（resolver 调用计数） |
| 迟到批准洗白白名单 | settled 违规主机入 violatedHosts；批准被拒 ✓ 回归 |
| redact 前缀碰撞泄漏长者尾巴 | 长度降序替换 ✓ 回归 |
| block reason 内嵌带 query 的 URL（secret 经 reason 出域） | reason 只带 origin+path（stripQuery）✓ 回归 |
| 尾点主机误报 + 空标签主机（.trusted.test）匹配空洞 | normalizeHost 去尾点；空标签/首点/连续点拒绝 ✓ 回归 |
| isBlockedIPv6 解析失败 fail-open | 保留 false 但仅在 URL 规范化路径可达（Bun URL 先拒）；DNS 路径喂入的畸形串经 hex 段校验拒绝——登记已知残余 |
| submit 双 cid（origin confirm + action confirm） | **裁决保留**：S1 与 S2 是两道独立闸（B6 按顺序消费，先 origin 后 action）；登记 U6 接线注意 |
| testPolicyConfig 静默丢弃 base 字段 | 改合并语义（数组拼接）✓ 回归 |
| 默认词表泛化英文词（send/delete/remove）确认疲劳 | 收窄为领域词（checkout/purchase/withdraw/pay now + 中文词）；宽覆盖走配置 ✓ |
| confirmations map 只增不减 | 上限 256 淘汰最旧 ✓ |
| S3 文档笔误（∉ 应为 ∈） | 01-baseline 已修 ✓ |

## 已知残余（登记）

- secret 的其他编码形态（rot13、自定义混淆）不在 S5/S6 覆盖——规格只要求 base64/URL 变体，已超配 hex/base64url/大小写/双重编码
- 手机号带连字符/空格的 egress 检测未做分隔符折叠（登记 B8 前评估）
- 引擎部分依赖 Bun URL 的激进规范化（审查确认这是运气而非设计）——parseIPv4/expandIPv6 的独立单测表已钉住非规范化形态，换 URL 实现时该表是回归屏障
