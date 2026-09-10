# B3 对抗审查处置记录

> 审查者：独立子 agent（无实现上下文），静态 + 一次性探针真 WebKit 实证（探针已删）。
> 结论：**15 条全部处置（修复 11 / 登记限制 2 / 改文档语义 2）**；修复过程中另发现并修复
> 「子帧坐标系偏移缺失」实现 bug（裁剪重写时引入，自测抓出）。

## P0（全部修复 + 回归用例）

| ID | 问题 | 处置 |
|---|---|---|
| P0-1 陈旧 bw-id 撞号 → locate 错位（实证：隐藏元素保留旧 id，新提取撞号，locate 命中隐藏元素且校验全绿） | **全局单调序列**（`window.__bwIdSeq`）：id 页面生命周期内永不出复；旧打点残留为无害垃圾（导航/document.open 清空）。回归：显隐变化后 id 唯一、locate(新 id) 命中正确元素、locate(旧 id) found:false |
| P0-2 隐藏 iframe 幽灵节点（display:none/visibility:hidden/opacity:0 iframe 内容全部进快照，实证 4 个幽灵） | 进入 iframe 前检查 **iframe 元素自身可见性**；不可见 → 整体跳过。回归：三态隐藏 iframe 内容零节点 |
| P0-3 locate 未找到返回裸 null（违反 `{found:false}` 契约） | 归一返回 `{found:false}`。回归用例补 |

## P1（全部修复）

| ID | 处置 |
|---|---|
| P1-1 frame 边界裁剪缺失（实证：滚出 frame 的按钮点击命中主文档背后元素） | **rect 与 frame 盒求交**（提取与 locate 同规则）：frame 相对坐标先加 frame 左上偏移到主视口系再裁剪；完全裁剪 → 不入快照。回归：所有 iframe 内节点渲染矩形 ⊆ frame 盒（几何包含断言） |
| P1-2 settle 观察者对 shadow/iframe 全盲（实证：lastChange 不动） | walk 收集 shadowRoot + 同源 iframe 文档，观察者统一挂载（同 observer 多 root）；尽力而为（后加载子帧下次提取补挂） |
| P1-3 document.open 后观察者死亡且 guard 阻止重装（实证：lastChange 永冻结） | **每次提取无条件重装**（替换 guarded 安装）——顺带击穿 P2-7 的页面伪造 |
| P1-4 不可见过滤缺同色/aria-hidden（规格成员） | 两项补齐（前景=背景且非透明 → 不可见；aria-hidden="true" → 不可见）。回归用例补 |

## P2（处置）

P2-1 跨源 iframe 双重打点 → iframe 专属分支先行处理 ✓ · P2-2 frameset/object 不遍历 → **登记 U3 不处理清单**（legacy 形态，明确不支持） · P2-3 视口外「附近」语义 → 距离升序排序（below/above 统一按距视口距离）+ D2 大容器语义（below = y > vh 完全下方）✓ · P2-4 退化预算超限 → 页脚三级回退（全页脚→短页脚→无页脚），结构化 truncated 恒准确 ✓ · P2-5 href 不钳长 → 钳 500 ✓ · P2-6 横向滚动 → scrollX 入 Snapshot + isSameView；iframe 内滚 → **登记限制**（主文档 scrollX/Y 之外不参与复用判定） · P2-7 settle 伪造 → 无条件重装消解大部分；残余（提取间隙内篡改）登记为尽力而为层已知限制 · P2-8 弱断言 → 全部按上述回归重写（跨源占位「可点」断言降为定位器可达 + 几何包含，真实点击交互归 B4 动作层）

## 修复过程中自测发现的实现 bug

- **子帧坐标系偏移缺失**：裁剪重写时 pushNode/locate 直接用 frame 相对 rect 与主视口系 frame 盒求交 → 同源 iframe 内容全部交空丢失。修复：先加 frame 左上偏移再裁剪（提取/定位器/嵌套 iframe 三处同规则）
- document.write 产生空 title → clampText 返回 undefined → 渲染崩溃。normalize 头部字段防御归一（`?? ""`）

## 已验证为正确（对抗未击穿）

嵌套 iframe 递归偏移（y=50+30+10 精确）、iframe 内部滚动换算、XML/无 body/闭合 shadow 不崩溃、domHash 各口径、单行化防伪造、密码掩码（含 iframe 内/大写）、路径遍历防护、双 origin 构造。
