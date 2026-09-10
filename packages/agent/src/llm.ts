/**
 * LLM 装配（U6）：GLM（OpenAI 兼容）真实模型 + ScriptedLLM 测试替身。
 * GLM 实证见 docs/probe-report.md p11：端点 200、tools 正确、reasoning 计入 completion。
 */
import type { AssistantMessage, Context, Model, ToolCall, Usage } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

export interface GlmEnv {
  GLM_API_KEY: string;
  /** 完整端点或 base（兼容两种写法——.env 实测是完整端点） */
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
}

export function glmModelFromEnv(env: GlmEnv): Model<"openai-completions"> {
  const rawBase = env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  const baseUrl = rawBase.replace(/\/chat\/completions\/?$/, "");
  const id = env.GLM_MODEL ?? "glm-5.3-flash";
  return {
    id,
    name: `GLM ${id}`,
    api: "openai-completions",
    provider: "zai",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    // 未知价：cost 全零 → budget 的 costUsd 维度自动停用（01 §6.4）
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

/** ScriptedLLM 剧本步：纯文本回复 / 工具调用 */
export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  usage?: { input?: number; output?: number };
}

const FAKE_USAGE: Usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 脚本化 LLM：每次 streamFn 调用弹出下一个剧本步，产出合法的
 * AssistantMessageEventStream（start → toolcall_end×n / text_delta → done）。
 * 记录收到的 context 供测试断言（工具结果是否进入上下文等）。
 */
export function scriptLLM(script: ScriptStep[]): {
  streamFn: (
    model: Model<never>,
    context: Context,
  ) => ReturnType<typeof createAssistantMessageEventStream>;
  calls: Context[];
  model: Model<"openai-completions">;
} {
  const calls: Context[] = [];
  const queue = [...script];
  const fakeModel: Model<"openai-completions"> = {
    id: "scripted",
    name: "Scripted",
    api: "openai-completions",
    provider: "test",
    baseUrl: "http://scripted.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const streamFn = (
    _model: Model<never>,
    context: Context,
  ): ReturnType<typeof createAssistantMessageEventStream> => {
    // tools 含函数不可 structuredClone——只快照可 JSON 化面
    calls.push(JSON.parse(JSON.stringify(context)) as Context);
    const step = queue.shift() ?? { text: "(script exhausted)" };
    const s = createAssistantMessageEventStream();
    const usage: Usage = {
      ...FAKE_USAGE,
      ...(step.usage !== undefined
        ? {
            input: step.usage.input ?? FAKE_USAGE.input,
            output: step.usage.output ?? FAKE_USAGE.output,
            totalTokens:
              (step.usage.input ?? FAKE_USAGE.input) + (step.usage.output ?? FAKE_USAGE.output),
            cost: { ...FAKE_USAGE.cost, total: 0 },
          }
        : {}),
    };
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "scripted",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    s.push({ type: "start", partial: message });
    let index = 0;
    if (step.text !== undefined) {
      s.push({ type: "text_start", contentIndex: index, partial: message });
      s.push({ type: "text_delta", contentIndex: index, delta: step.text, partial: message });
      message.content.push({ type: "text", text: step.text });
      s.push({ type: "text_end", contentIndex: index, content: step.text, partial: message });
      index += 1;
      message.stopReason = "stop";
    }
    if (step.toolCalls !== undefined) {
      let n = 1;
      for (const tc of step.toolCalls) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: `call-${calls.length}-${n}`,
          name: tc.name,
          arguments: tc.arguments,
        };
        s.push({ type: "toolcall_start", contentIndex: index, partial: message });
        message.content.push(toolCall);
        s.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
        index += 1;
        n += 1;
      }
      message.stopReason = "toolUse";
    }
    s.end(message);
    return s;
  };
  return { streamFn, calls, model: fakeModel };
}
