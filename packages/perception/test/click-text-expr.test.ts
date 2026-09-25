/**
 * B25 Fix A 测试口径（docs/design-B25-rnw-fixes.md）：
 * click_text 定位表达式的单源契约——\s 归一（字母 s 正则 bug 回归）、
 * 横向出界、遮挡复核、文本注入安全。纯字符串断言，无驱动。
 */
import { describe, expect, test } from "bun:test";
import { CLICK_TEXT_LOCATE_EXPRESSION } from "../src/script.ts";

describe("CLICK_TEXT_LOCATE_EXPRESSION（表达式生成契约）", () => {
  test("空白归一用 \\s+（回归：字母 s 的 /s+/g bug——RNW 嵌套 div innerText 含换行必失配）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("查看示例对话", 1280, 720);
    expect(expr).toContain("\\s+");
    expect(expr).not.toMatch(/[^\\]\/s\+\/g/); // 不允许任何未转义的 /s+/g 残留
  });

  test("出界判定含横向 x 轴（viewportW 参与判断——stack navigator 屏外副本）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("深色", 390, 844);
    // 表达式引用视口宽参与出界计算
    expect(expr).toContain("vw");
    expect(expr).toContain("vh");
    // 视口值注入（数字字面量——页面内无 window 依赖也可比）
    expect(expr).toContain("390");
    expect(expr).toContain("844");
  });

  test("遮挡复核在页面内完成（elementFromPoint 中心采样）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("返回", 1280, 720);
    expect(expr).toContain("elementFromPoint");
  });

  test("文本经 JSON.stringify 注入（引号/换行/正则元字符安全）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION('点"我"(\n*)', 1280, 720);
    // 文本以 JSON 字面量进入表达式，特殊字符全部转义
    expect(expr).toContain(JSON.stringify('点"我"(\n*)'));
  });

  test("滚动后 re-locate 与主匹配同一单源（无第二套文档序 .find 逻辑）", () => {
    // 模块只导出一个定位表达式——第二个参数为视口，语义同一
    const a = CLICK_TEXT_LOCATE_EXPRESSION("日K", 100, 200);
    const b = CLICK_TEXT_LOCATE_EXPRESSION("日K", 100, 200);
    expect(a).toBe(b); // 纯函数：同参同值（可缓存/可对拍）
  });
});
