/**
 * B22 S2（U4）：secret 无状态重解析——配置是唯一明文来源，会话不产生新明文落盘。
 * 声明文件 ~/.bw/secrets（0600 JSON，与策略层 SecretsConfig 同形）：
 *   { "github-pw": {"source":"env","ref":"GITHUB_PW"} | {"source":"literal","value":"…"} }
 * 每命令进程全量重解析 → resolveSecret 供 policy（origin 绑定 + redact 集）。
 */
import { existsSync } from "node:fs";
import type { SecretRef } from "@bw/core";
import { BWError, readJsonIfPossible, secretsFile } from "@bw/core";

export interface SecretDeclaration {
  source: "env" | "literal";
  ref?: string;
  value?: string;
}

export type SecretsConfigFile = Record<string, SecretDeclaration>;

/** 读声明文件——每次直读不缓存（配置即真相：同进程内文件可变——SDK 常驻用法/测试
 * 写文件后立即生效；文件极小，读取代价可忽略） */
export function loadSecretsConfig(): SecretsConfigFile {
  const path = secretsFile();
  return existsSync(path) ? (readJsonIfPossible<SecretsConfigFile>(path) ?? {}) : {};
}

/** 按名解析（origin 绑定与变体登记在 policy.resolveSecret——这里只取值） */
export async function resolveSecretValue(name: string): Promise<string> {
  const decl = loadSecretsConfig()[name];
  if (decl === undefined) {
    throw new BWError("SECRET_UNRESOLVED", `secret '${name}' not declared in ${secretsFile()}`);
  }
  if (decl.source === "literal") {
    if (typeof decl.value !== "string" || decl.value === "") {
      throw new BWError("SECRET_UNRESOLVED", `secret '${name}': literal missing value`);
    }
    return decl.value;
  }
  const v = decl.ref !== undefined ? process.env[decl.ref] : undefined;
  if (v === undefined || v === "") {
    throw new BWError("SECRET_UNRESOLVED", `secret '${name}': env ${decl.ref ?? "(none)"} unset`);
  }
  return v;
}

/** 声明名清单（供 prompt/诊断） */
export function secretNames(): string[] {
  return Object.keys(loadSecretsConfig());
}

export type { SecretRef };
