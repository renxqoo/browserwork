/**
 * MCP 驱动的 agent 循环（B16 §3.9）：GLM（OpenAI 兼容 chat completions 直连）
 * + MCP 工具循环 + 指标采集。对打口径：同一模型同一预算；提示词差异披露于报告。
 */

export interface EvalUsage {
  input: number;
  output: number;
}

export interface EvalStep {
  toolName: string;
  ok: boolean;
  ms: number;
}

export interface EvalRunResult {
  ok: boolean;
  answer: string;
  steps: EvalStep[];
  usage: EvalUsage;
  wallMs: number;
  error?: string;
}

export interface McpLoopOptions {
  goal: string;
  startUrl?: string;
  /** OpenAI 兼容端点 */
  baseUrl: string;
  apiKey: string;
  model: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  maxSteps?: number;
  /** 提示词（对打口径披露项——双端各自产品自然提示词） */
  systemPrompt: string;
  finishTool: string;
  fetchFn?: typeof fetch;
}

/** 单次 MCP-agent 任务循环（与 @bw/agent 的 pi 循环对打用——不是产品代码） */
export async function runMcpAgentLoop(opts: McpLoopOptions): Promise<EvalRunResult> {
  const maxSteps = opts.maxSteps ?? 30;
  const started = Date.now();
  const usage: EvalUsage = { input: 0, output: 0 };
  const steps: EvalStep[] = [];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: opts.systemPrompt },
    {
      role: "user",
      content:
        opts.startUrl !== undefined ? `${opts.goal}\n\nStart at: ${opts.startUrl}` : opts.goal,
    },
  ];
  const tools = opts.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
  const f = opts.fetchFn ?? fetch;

  let answer = "";
  for (let step = 0; step < maxSteps; step++) {
    let res: Response;
    try {
      res = await f(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          tools,
          tool_choice: "auto",
        }),
      });
    } catch (e) {
      return {
        ok: false,
        answer: "",
        steps,
        usage,
        wallMs: Date.now() - started,
        error: `provider fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        answer: "",
        steps,
        usage,
        wallMs: Date.now() - started,
        error: `provider ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const body = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    usage.input += body.usage?.prompt_tokens ?? 0;
    usage.output += body.usage?.completion_tokens ?? 0;
    const msg = body.choices?.[0]?.message;
    if (msg === undefined) {
      return {
        ok: false,
        answer: "",
        steps,
        usage,
        wallMs: Date.now() - started,
        error: "empty choice",
      };
    }
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      answer = msg.content ?? "";
      messages.push({ role: "assistant", content: answer });
      break;
    }
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id ?? `call-${step}`,
        type: "function",
        function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "{}" },
      })),
    });
    let finished = false;
    for (const tc of toolCalls) {
      const name = tc.function?.name ?? "";
      const t0 = Date.now();
      if (name === opts.finishTool) {
        try {
          const parsed = JSON.parse(tc.function?.arguments ?? "{}") as { answer?: string };
          answer = parsed.answer ?? "";
        } catch {
          answer = "";
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id ?? `call-${step}`,
          content: answer || "task complete",
        });
        finished = true;
        steps.push({ toolName: name, ok: true, ms: Date.now() - t0 });
        break;
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const r = await opts.callTool(name, args);
      steps.push({ toolName: name, ok: r.ok, ms: Date.now() - t0 });
      messages.push({
        role: "tool",
        tool_call_id: tc.id ?? `call-${step}`,
        content: r.ok ? r.text.slice(0, 12_000) : `ERROR: ${r.text.slice(0, 500)}`,
      });
    }
    if (finished) break;
  }
  return { ok: answer !== "", answer, steps, usage, wallMs: Date.now() - started };
}
