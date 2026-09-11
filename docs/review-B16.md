# 对抗审查：B16（评测装置 + 小规模真跑）——自审记录

> 本批为评测装置 + 真跑；装置自测（假 server/假 fetch）进默认门，真跑走 real 门。
> 自审（无独立子 agent——数字诚实性核对由用户可复算：报告原始数字直接来自脚本 stdout）。

## 数字诚实性核对

- 首跑装置 bug：锚点评级用答案前 100 字（answerHead）——pwmcp 的 docs-webview-api 答对但 "chrome" 关键词在截断外，被误判未中（4/5）。**已修为完整答案评级并复跑**：双端 5/5。首跑结果废弃，报告为复跑数据；修正记录写入报告头部。
- 复跑原始数（stdout）：bw done 5/5 · steps 11 · in/out 52,299/7,907；pwmcp done 5/5 · steps 14 · in/out 102,545/2,257。token 合计 bw 60,206 vs pwmcp 104,802（**少 42.6%**）；steps 少 21.4%。
- 墙钟未列（bw 侧事件流消费实现缺计时；pwmcp 含模型串行等待）——不比墙钟，避免不公平对比，报告未声称。
- 样本量：5 任务 × 1 轮（用户裁决）；不外推为普适结论，README 措辞为「真站实测（5 任务 × GLM）」如实带样本量。

## 装置验证

- MCP client：initialize/list/call 往返、error 透传、超时、stop 幂等+pending 拒绝（假 server 5 用例）
- agent 循环：工具结果回传、done 收束、maxSteps 截断、provider 错误、坏 JSON 参数、工具失败 ERROR 回传、空 choice（假 fetch 7 用例）
- 任务集：锚点小写命中/未中双侧
- 门槛：装置测试 11 例进默认门；coverage-gate 对 eval 包生效（mcp-client 100% 函数）

## 已知限制（登记）

- 锚点评级宽松（防误判优先于精确断言）——全量评测时应升级为程序化校验（DOM 断言）
- pwmcp 侧无产品级提示词调优（其生态惯例即裸提示词）——提示词差异已披露，非隐藏变量
- bw 侧墙钟未计（不影响 token/steps 结论）
