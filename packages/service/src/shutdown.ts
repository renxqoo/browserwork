/**
 * 优雅退出（B13 §3.6）：SIGTERM/SIGINT → 停收请求 → abort 活动任务 → 关会话
 * → 清 PID 文件 → exit。二次信号强退。
 */

export interface ShutdownDeps {
  /** 停服（可返回 promise——abort 任务等异步收尾等它完成，审查 P2-8） */
  stop: () => void | Promise<void>;
  cleanup?: () => void;
  /** 退出函数必填（注入 process.exit；测试注入记录器——消灭不可测默认分支） */
  exit: (code: number) => void;
}

/** 安装信号处理器；返回卸载函数（测试用）。幂等：二次信号立即强退。 */
export function installSignalHandlers(deps: ShutdownDeps): () => void {
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) {
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    void (async () => {
      try {
        await deps.stop();
        deps.cleanup?.();
      } catch {
        /* 尽力而为 */
      }
      deps.exit(0);
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}
