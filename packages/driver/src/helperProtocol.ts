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
