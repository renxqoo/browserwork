/**
 * B25 Fix A 测试口径（docs/design-B25-rnw-fixes.md）：
 * click_text 定位表达式的单源契约——squeeze 归一（字母 s 正则 bug 回归）、
 * 横向出界、祖先裁剪、遮挡复核、两阶段滚动（best 不被后续滚动顶走）、
 * live 视口、文本注入安全。纯字符串断言，无驱动。
 */
import { describe, expect, test } from "bun:test";
import { CLICK_TEXT_LOCATE_EXPRESSION } from "../src/script.ts";

describe("CLICK_TEXT_LOCATE_EXPRESSION（表达式生成契约）", () => {
  test("空白归一用 \\s+（回归：字母 s 的 /s+/g bug——嵌套 div innerText 含换行必失配）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("查看示例对话");
    expect(expr).toContain("\\s+");
    expect(expr).not.toMatch(/[^\\]\/s\+\/g/); // 不允许任何未转义的 /s+/g 残留
  });

  test("live 视口：缺省参数时表达式读 window.innerWidth/innerHeight（B25 审查 6——烘焙 1280×720 与小视口打架）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("深色");
    expect(expr).toContain("window.innerWidth");
    expect(expr).toContain("window.innerHeight");
  });

  test("视口可注入（测试/夹具用；显式参数优先于 live 值）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("深色", 390, 844);
    expect(expr).toContain("390");
    expect(expr).toContain("844");
    expect(expr).not.toContain("window.innerWidth");
  });

  test("两阶段：收集阶段不滚动，滚动只发生在选定候选上（审查 1/7——循环滚动互相顶走 + 布局抖动）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("返回");
    // 收集循环体内不得出现 scrollIntoView（只在阶段 2 的滚入分支里）
    const collectLoop = expr.slice(expr.indexOf("const cands"), expr.indexOf("cands.sort"));
    expect(expr.indexOf("const cands")).toBeGreaterThanOrEqual(0);
    expect(expr.indexOf("cands.sort")).toBeGreaterThan(expr.indexOf("const cands"));
    expect(collectLoop).not.toContain("scrollIntoView");
    expect(expr.indexOf("scrollIntoView")).toBeGreaterThan(expr.indexOf("cands.sort"));
  });

  test("反例：无第二套文档序 .find 定位逻辑（审查 9——旧滚动 re-locate 形态不得回归）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("深色");
    expect(expr).not.toContain(".find((e)");
    expect(expr).toContain("scrollIntoView"); // 滚入能力仍在（阶段 2）
  });

  test("clipped 跳过 fixed/sticky（审查 2——body overflow-x:hidden 全站标配下 fixed 横幅假阳性）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("Cookie 设置");
    expect(expr).toContain("fixed");
    expect(expr).toContain("sticky");
  });

  test("clipped 用中心点判定（审查 2——半裁剪元素中心可见即可点，不整块出局）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("更多");
    // 中心点参与裁剪判定（而非全外矩形判定）
    expect(expr).toMatch(/width\s*\/\s*2/);
  });

  test("遮挡复核在页面内完成（elementFromPoint 中心采样）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("返回");
    expect(expr).toContain("elementFromPoint");
  });

  test("文本经 JSON.stringify 注入（引号/换行/正则元字符安全）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION('点"我"(\n*)');
    expect(expr).toContain(JSON.stringify('点"我"(\n*)'));
  });

  test("超长文本（10k）注入仍合法（表达式口径：JSON 字面量承载）", () => {
    const long = "长".repeat(10_000);
    const expr = CLICK_TEXT_LOCATE_EXPRESSION(long);
    expect(expr).toContain(JSON.stringify(long));
    // 生成的表达式本身可编译（new Function 语法校验——注入不破坏结构）
    expect(() => new Function(expr)).not.toThrow();
  });

  test("失败返回双计数（审查 8——offscreen 与 occluded 并存时都报）", () => {
    const expr = CLICK_TEXT_LOCATE_EXPRESSION("日K");
    expect(expr).toContain("offscreenCount");
    expect(expr).toContain("occludedCount");
  });

  test("生成的表达式可编译（语法完整性——任意注入文本不破坏结构）", () => {
    // 故意含模板串语法/标签/引号/换行的恶意文本——JSON 字面量承载不破结构
    const evil = ["a", "`", "b ", "$", "{c}", " </script> ", '"', " \\ ", "\n"].join("");
    const expr = CLICK_TEXT_LOCATE_EXPRESSION(evil);
    expect(() => new Function(expr)).not.toThrow();
  });
});
