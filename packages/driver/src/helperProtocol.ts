/**
 * B22 S1：helper RPC 协议（unix socket，换行分隔 JSON）。
 * 帧型三：请求（带 id）/ 响应（对 id）/ 事件推送（无 id，server→client）。
 * 每个页面态字段（url/title/loading）随响应搭车返回——客户端代理缓存零额外往返保鲜。
 */

export interface HelperRequest {
  id: number;
  method: HelperMethod;
  params?: Record<string, unknown>;
}

export type HelperMethod =
  // 驱动级
  | "info"
  | "createPage"
  | "pages"
  | "closeDriver"
  | "shutdown"
  | "navEvents"
  | "netRequests"
  // 页面级
  | "pageInfo"
  | "navigate"
  | "evaluate"
  | "click"
  | "clickAt"
  | "type"
  | "press"
  | "scroll"
  | "scrollTo"
  | "screenshot"
  | "resize"
  | "reload"
  | "cdp"
  | "cdpPierceNodes"
  | "closePage"
  | "subscribeCdp"
  | "unsubscribeCdp";

export interface HelperResponse {
  id: number;
  ok: true;
  result: unknown;
  /** 搭车页面态（页面级方法必有） */
  state?: PageState;
}

export interface HelperErrorResponse {
  id: number;
  ok: false;
  code: string;
  error: string;
}

export type HelperEventFrame = {
  event: "navigated" | "navigationFailed" | "cdp" | "pageClosed";
  pageId: number;
  data?: unknown;
};

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
}

export interface PageSummary extends PageState {
  pageId: number;
}

export interface NavEventEntry {
  seq: number;
  url: string;
  ts: number;
  /** 多 tab 会话的事件归属（P2-11：违规判定要能定位到 tab） */
  pageId: number;
}

/** helper 就绪文件内容 */
export interface HelperReady {
  pid: number;
  backend: "webkit" | "chrome";
}

/** 编码/解码（行式帧）——socket data handler 内使用。
 * 单 TextDecoder + stream 模式：多字节 UTF-8 跨 chunk 不腐坏（S1 审查 P1-3） */
/**
 * 帧写入器：处理 Bun unix socket 的部分写（macOS 内核缓冲 8KB——write 返回已写字节，
 * 剩余必须续写；S2 实测单帧 >8KB 只送到 8192B）。写不完的挂队列，drain 事件恢复。
 */
/** 可写面：字符串或字节都收（Bun Socket.write 返回已写字节数；undefined=全收） */
export interface WritableEnd {
  write(d: Uint8Array | string): number | undefined | null;
}

export class FrameWriter {
  /** 字节一致：pending 按 UTF-8 字节管理（write 返回字节——按字符切片会在多字节
   * 边界截断腐坏载荷，S2 实测中文注释表达式在 8192 处被腰斩） */
  private pending: Uint8Array | null = null;
  private enc = new TextEncoder();
  constructor(private readonly sock: WritableEnd) {}

  /** 入队一帧并尽力刷写 */
  write(line: string): void {
    const frame = this.enc.encode(`${line}\n`);
    this.pending =
      this.pending === null || this.pending.length === 0
        ? frame
        : new Uint8Array([...this.pending, ...frame]);
    this.flush();
  }

  flush(): void {
    for (;;) {
      if (this.pending === null || this.pending.length === 0) {
        this.pending = null;
        return;
      }
      const n = this.sock.write(this.pending);
      if (n === undefined || n === null) {
        this.pending = null; // 全量接收
        return;
      }
      if (n === -1) {
        // Bun 契约：-1 = socket 已关——弃帧停写（误当背压会让帧滞留到 close）
        this.pending = null;
        return;
      }
      if (n <= 0) return; // 缓冲满——drain 恢复
      this.pending = this.pending.subarray(n);
    }
  }
}

export class LineCodec {
  private buf = "";
  private decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() !== "") lines.push(line);
    }
    return lines;
  }
}
