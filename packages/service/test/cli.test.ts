import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) },
    out,
    err,
  };
}

describe("runCli", () => {
  test("--version 打印版本号退出 0", () => {
    const { io, out } = fakeIo();
    expect(runCli(["--version"], io)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  test("-v 等价 --version", () => {
    const { io, out } = fakeIo();
    expect(runCli(["-v"], io)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  test("--help 含 usage 且退出 0", () => {
    const { io, out } = fakeIo();
    expect(runCli(["--help"], io)).toBe(0);
    expect(out[0]).toContain("Usage:");
  });

  test("无参数显示 help 退出 0", () => {
    const { io, out } = fakeIo();
    expect(runCli([], io)).toBe(0);
    expect(out).toHaveLength(1);
  });

  test("未知命令 stderr 报错退出 2", () => {
    const { io, err } = fakeIo();
    expect(runCli(["nope"], io)).toBe(2);
    expect(err).toEqual(["unknown command: nope"]);
  });
});
