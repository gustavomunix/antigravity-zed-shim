/**
 * Translation between OpenAI Chat Completions (what Zed sends) and the
 * Antigravity `v1internal` envelope (what Google expects).
 *
 * Request direction reuses upstream `prepareAntigravityRequest` — we only
 * convert OpenAI messages/tools into Gemini-format `contents` and let the
 * vendored code build the `{project, model, request, ...}` envelope, apply
 * thinking/tool normalization, and sign the request.
 *
 * Response direction is implemented here per
 * `vendor/auth-src/docs/ANTIGRAVITY_API_SPEC.md`: SSE `data:` lines carry
 * `{response: {candidates: [...], usageMetadata: {...}}}`.
 */

import { cleanJSONSchemaForAntigravity } from "./upstream";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: string } }
  >;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: "auto" | "required" | "none" | { type: string; function?: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequestPayload {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>;
  toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } };
  generationConfig?: Record<string, unknown>;
}

export class TranslationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TranslationError";
    this.status = status;
  }
}

function textOf(content: OpenAIMessage["content"]): { text: string; images: Array<{ mimeType: string; data: string }> } {
  if (content == null) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  let text = "";
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const part of content) {
    if (part.type === "text") {
      text += part.text;
    } else if (part.type === "image_url") {
      const url = part.image_url.url;
      const match = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (!match) {
        throw new TranslationError(400, "Only base64 data-URL images are supported (got a remote URL)");
      }
      images.push({ mimeType: match[1], data: match[2] });
    }
  }
  return { text, images };
}

/**
 * Converts an OpenAI chat-completions body into a Gemini-format request
 * payload. History `reasoning_content` is intentionally dropped: thought
 * signatures cannot round-trip through the OpenAI shape, and the upstream
 * request builder re-injects its `skip_thought_signature_validator` sentinel
 * where the API requires one.
 */
export function openAIToGemini(body: OpenAIChatRequest): GeminiRequestPayload {
  const contents: GeminiContent[] = [];
  const systemTexts: string[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of body.messages ?? []) {
    if (message.role === "system") {
      const { text } = textOf(message.content);
      if (text.trim()) systemTexts.push(text);
      continue;
    }
    if (message.role === "tool") {
      const { text } = textOf(message.content);
      let response: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(text);
        response = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { text };
      } catch {
        response = { text };
      }
      const name = message.name ?? toolNameById.get(message.tool_call_id ?? "") ?? "unknown_tool";
      pushContent(contents, "user", {
        functionResponse: { name, id: message.tool_call_id, response },
      });
      continue;
    }
    if (message.role === "assistant") {
      const { text, images } = textOf(message.content);
      void images; // Images in assistant history have no Gemini equivalent; text is kept.
      const parts: GeminiPart[] = [];
      if (text) parts.push({ text });
      for (const call of message.tool_calls ?? []) {
        if (call.function?.name) toolNameById.set(call.id, call.function.name);
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.function?.arguments ?? "{}");
          if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
        } catch {
          throw new TranslationError(400, `Tool call "${call.function?.name}" has invalid JSON arguments`);
        }
        parts.push({ functionCall: { name: call.function.name, args, id: call.id } });
      }
      if (parts.length > 0) pushContent(contents, "model", ...parts);
      continue;
    }
    // user
    const { text, images } = textOf(message.content);
    const parts: GeminiPart[] = [];
    for (const image of images) parts.push({ inlineData: image });
    if (text) parts.push({ text });
    if (parts.length > 0) pushContent(contents, "user", ...parts);
  }

  if (contents.length === 0) {
    throw new TranslationError(400, "No user/model content to send");
  }

  const payload: GeminiRequestPayload = { contents };
  if (systemTexts.length > 0) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }

  const declarations =
    body.tools
      ?.filter((tool) => tool.type === "function" && tool.function?.name)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? "",
        parameters: cleanJSONSchemaForAntigravity(
          tool.function.parameters ?? { type: "object", properties: {} },
        ) as Record<string, unknown>,
      })) ?? [];
  if (declarations.length > 0) {
    payload.tools = [{ functionDeclarations: declarations }];
    const choice = body.tool_choice;
    if (choice === "required") {
      payload.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    } else if (choice === "none") {
      payload.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (choice && typeof choice === "object" && choice.function?.name) {
      payload.toolConfig = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] },
      };
    } else {
      payload.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  const maxOutput = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxOutput === "number") {
    // OpenAI clients (like Zed) often forward their context-window size as max_tokens.
    // Upstream Antigravity rejects maxOutputTokens exceeding the model's output ceiling (64k).
    generationConfig.maxOutputTokens = Math.min(maxOutput, 64000);
  }
  if (body.stop) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;

  return payload;
}

/** Appends parts, merging with the previous content when the role matches. */
function pushContent(contents: GeminiContent[], role: "user" | "model", ...parts: GeminiPart[]): void {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
    return;
  }
  contents.push({ role, parts: [...parts] });
}

// ---------------------------------------------------------------------------
// Antigravity response parsing
// ---------------------------------------------------------------------------

export interface ParsedTextPart {
  kind: "text";
  text: string;
}

export interface ParsedReasoningPart {
  kind: "reasoning";
  text: string;
}

export interface ParsedToolCallPart {
  kind: "toolCall";
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type ParsedPart = ParsedTextPart | ParsedReasoningPart | ParsedToolCallPart;

export interface ParsedCandidate {
  parts: ParsedPart[];
  /** Raw finish reason from the API (STOP, MAX_TOKENS, OTHER, ...). */
  finishReason?: string;
}

export interface ParsedUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ParsedEnvelope {
  candidate?: ParsedCandidate;
  usage?: ParsedUsage;
}

/**
 * Parses one Antigravity response envelope
 * (`{response: {candidates: [...], usageMetadata: {...}}}`).
 * Tolerates already-unwrapped payloads and arrays of envelopes.
 */
export function parseAntigravityEnvelope(raw: unknown): ParsedEnvelope {
  const root = unwrapEnvelope(raw);
  if (!root || typeof root !== "object") return {};
  const response = (root as Record<string, unknown>).response ?? root;
  if (!response || typeof response !== "object") return {};
  const res = response as Record<string, unknown>;

  let candidate: ParsedCandidate | undefined;
  const candidates = res.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0] as Record<string, unknown>;
    const content = (first.content ?? {}) as Record<string, unknown>;
    const rawParts = Array.isArray(content.parts) ? content.parts : [];
    const parts: ParsedPart[] = [];
    for (const rawPart of rawParts) {
      const part = rawPart as Record<string, unknown>;
      if (part.functionCall && typeof part.functionCall === "object") {
        const call = part.functionCall as Record<string, unknown>;
        if (typeof call.name === "string") {
          const args =
            call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
          parts.push({
            kind: "toolCall",
            id: typeof call.id === "string" ? call.id : undefined,
            name: call.name,
            args,
          });
          continue;
        }
      }
      if (typeof part.text === "string" && part.text.length > 0) {
        parts.push(part.thought === true ? { kind: "reasoning", text: part.text } : { kind: "text", text: part.text });
      }
    }
    candidate = {
      parts,
      finishReason: typeof first.finishReason === "string" ? first.finishReason : undefined,
    };
  }

  let usage: ParsedUsage | undefined;
  const meta = res.usageMetadata;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    // Thinking tokens are billed as output; fold them into completionTokens.
    const completionTokens =
      (toNumber(m.candidatesTokenCount) ?? 0) + (toNumber(m.thoughtsTokenCount) ?? 0) || undefined;
    usage = {
      promptTokens: toNumber(m.promptTokenCount),
      completionTokens,
      totalTokens: toNumber(m.totalTokenCount),
    };
  }
  return { candidate, usage };
}

function unwrapEnvelope(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.length > 0 ? unwrapEnvelope(raw[0]) : undefined;
  return raw;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function mapFinishReason(finishReason: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  if (finishReason === "MAX_TOKENS") return "length";
  return "stop";
}

// ---------------------------------------------------------------------------
// OpenAI chunk builders (shapes Zed's `ResponseStreamEvent` accepts)
// ---------------------------------------------------------------------------

let completionCounter = 0;

export function newCompletionId(): string {
  completionCounter += 1;
  return `chatcmpl-antigravity-${Date.now().toString(36)}-${completionCounter}`;
}

export function openAIStreamChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export function openAIUsageChunk(
  id: string,
  created: number,
  model: string,
  usage: ParsedUsage,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    usage: {
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens: usage.completionTokens ?? 0,
      total_tokens:
        usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    },
  });
}

export function openAIError(status: number, message: string, code = "antigravity_error"): { status: number; body: string } {
  return {
    status,
    body: JSON.stringify({ error: { message, type: code, code: String(status) } }),
  };
}

export function openAICompletion(
  id: string,
  created: number,
  model: string,
  candidate: ParsedCandidate | undefined,
  usage: ParsedUsage | undefined,
): string {
  let content = "";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  let callIndex = 0;
  for (const part of candidate?.parts ?? []) {
    if (part.kind === "text" || part.kind === "reasoning") content += part.text;
    else {
      callIndex += 1;
      toolCalls.push({
        id: part.id ?? `call-${callIndex}`,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
      });
    }
  }
  return JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: usage?.promptTokens ?? 0,
      completion_tokens: usage?.completionTokens ?? 0,
      total_tokens: usage?.totalTokens ?? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
    },
  });
}
