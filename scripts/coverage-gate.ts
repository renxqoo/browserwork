/**
 * 覆盖率真门（docs/02-build-plan.md §1）。
 * 背景：Bun 1.4.2 的 bunfig coverageThreshold 不执行，且覆盖率只统计被 import 过的
 * 文件（未测文件隐形）。本脚本解析 lcov 强制阈值，并要求所有源文件出现在报告中
 * （或显式豁免并写明理由——豁免清单随批次清空，B8 收口必须为空）。
 * Bun 的 lcov 无分支记录（BRDA），分支纪律由单元卡的双侧边界用例 + 对抗审查承担。
 */
import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";

const LCOV_PATH = "coverage/lcov.info";
const EXEMPT_PATH = "scripts/coverage-exemptions";
const THRESHOLD_PCT = 90;

interface FileCov {
  fnf: number;
  fnh: number;
  lf: number;
  lh: number;
}

function parseLcov(text: string): Map<string, FileCov> {
  const map = new Map<string, FileCov>();
  let path: string | null = null;
  let cov: FileCov | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      path = line.slice(3);
      cov = { fnf: 0, fnh: 0, lf: 0, lh: 0 };
    } else if (cov && path) {
      if (line.startsWith("FNF:")) cov.fnf = Number(line.slice(4));
      else if (line.startsWith("FNH:")) cov.fnh = Number(line.slice(4));
      else if (line.startsWith("LF:")) cov.lf = Number(line.slice(3));
      else if (line.startsWith("LH:")) cov.lh = Number(line.slice(3));
      else if (line === "end_of_record") {
        map.set(path, cov);
        path = null;
        cov = null;
      }
    }
  }
  return map;
}

interface Exemption {
  reason: string;
  /** 阈值豁免：允许的最低覆盖率（默认 = 完全豁免——文件不应出现在 lcov） */
  minPct?: number;
}

function loadExemptions(): Map<string, Exemption> {
  const map = new Map<string, Exemption>();
  if (!existsSync(EXEMPT_PATH)) return map;
  for (const line of readFileSync(EXEMPT_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) {
      console.error(`coverage-gate: 豁免行缺理由（格式：路径<TAB>理由[<TAB>min=N]）：${trimmed}`);
      process.exit(2);
    }
    const rest = trimmed.slice(tab + 1);
    const minMatch = /\tmin=(\d+)$/.exec(rest);
    const reason = minMatch !== null ? rest.slice(0, minMatch.index) : rest;
    map.set(trimmed.slice(0, tab), {
      reason,
      ...(minMatch !== null ? { minPct: Number(minMatch[1]) } : {}),
    });
  }
  return map;
}

function main(): number {
  if (!existsSync(LCOV_PATH)) {
    console.error(`coverage-gate: ${LCOV_PATH} 不存在——bun test 未生成覆盖率报告`);
    return 2;
  }
  const cov = parseLcov(readFileSync(LCOV_PATH, "utf8"));
  const exemptions = loadExemptions();
  const failures: string[] = [];

  const srcFiles = [...new Glob("packages/*/src/**/*.ts").scanSync({ dot: false })].sort();
  for (const file of srcFiles) {
    const fc = cov.get(file);
    const exemption = exemptions.get(file);
    if (!fc) {
      if (exemption !== undefined) continue;
      failures.push(`未测文件（不在 lcov 中，未豁免）: ${file}`);
      continue;
    }
    if (exemption !== undefined && exemption.minPct === undefined) {
      failures.push(`豁免失效：${file} 已在 lcov 中（若为部分覆盖改用 min=N 格式）`);
      continue;
    }
    const threshold = exemption?.minPct ?? THRESHOLD_PCT;
    if (fc.lf > 0) {
      const linePct = (fc.lh / fc.lf) * 100;
      if (linePct < threshold) {
        failures.push(`行覆盖 ${linePct.toFixed(1)}% < ${threshold}%: ${file} (${fc.lh}/${fc.lf})`);
      }
    }
    if (fc.fnf > 0) {
      const fnPct = (fc.fnh / fc.fnf) * 100;
      if (fnPct < threshold) {
        failures.push(
          `函数覆盖 ${fnPct.toFixed(1)}% < ${threshold}%: ${file} (${fc.fnh}/${fc.fnf})`,
        );
      }
    }
  }

  const staleExemptions = [...exemptions.keys()].filter((p) => !srcFiles.includes(p));
  for (const p of staleExemptions) {
    failures.push(`豁免清单指向不存在的文件: ${p}`);
  }

  if (failures.length > 0) {
    console.error(`coverage-gate: FAIL (${failures.length} 项)`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  const totalLf = [...cov.values()].reduce((s, c) => s + c.lf, 0);
  const totalLh = [...cov.values()].reduce((s, c) => s + c.lh, 0);
  const totalFnf = [...cov.values()].reduce((s, c) => s + c.fnf, 0);
  const totalFnh = [...cov.values()].reduce((s, c) => s + c.fnh, 0);
  const linePct = totalLf > 0 ? ((totalLh / totalLf) * 100).toFixed(1) : "n/a";
  const fnPct = totalFnf > 0 ? ((totalFnh / totalFnf) * 100).toFixed(1) : "n/a";
  console.log(
    `coverage-gate: PASS — 源文件 ${srcFiles.length}（豁免 ${exemptions.size}）行 ${linePct}% / 函数 ${fnPct}%（阈值 ≥${THRESHOLD_PCT}%）`,
  );
  return 0;
}

process.exit(main());
