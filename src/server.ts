/**
 * Minimal OpenAI-compatible HTTP server mapping Zed requests onto Antigravity.
 *
 * Endpoints:
 *   GET  /health               liveness (no secrets, no network)
 *   GET  /v1/models            model catalog via fetchAvailableModels
 *   POST /v1/chat/completions  chat (streaming SSE or JSON)
 *
 * The Zed API key configured for this provider is ignored: short-lived
 * Bearer tokens are minted per request from the stored OAuth grants.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  ANTIGRAVITY_ENDPOINT,
  detectErrorType,
  getAntigravityUserAgent,
  prepareAntigravityRequest,
  registerAdvertisedModelIds,
} from "./upstream";
import { getLiveAuth, listAccountSummaries } from "./accounts";
import {
  mapFinishReason,
  newCompletionId,
  openAICompletion,
  openAIError,
  openAIStreamChunk,
  openAIUsageChunk,
  openAIToGemini,
  parseAntigravityEnvelope,
  TranslationError,
  type ParsedUsage,
} from "./translate";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const NON_STREAM_TIMEOUT_MS = 300_000;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const { status: s, body } = openAIError(status, message);
  res.writeHead(s, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new TranslationError(413, "Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  maxTokens?: number;
}

export async function fetchModelCatalog(): Promise<ModelInfo[]> {
  const { auth, projectId } = await getLiveAuth();
  const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "Content-Type": "application/json",
      "User-Agent": getAntigravityUserAgent(),
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`fetchAvailableModels failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const payload = (await response.json()) as {
    models?: Record<string, { displayName?: string; modelName?: string; maxTokens?: number; disabled?: boolean; selectable?: boolean }>;
  };
  const models = payload.models ?? {};
  const ids = Object.keys(models);
  registerAdvertisedModelIds(ids);
  return ids
    .filter((id) => {
      const entry = models[id];
      if (!entry || typeof entry !== "object" || entry.disabled || entry.selectable === false) return false;
      // The catalog mixes in unrelated experiments/prompts (e.g. tab-completion
      // and chat-title helpers); only real chat models are useful to Zed.
      if (/^(chat_|tab_)/i.test(id)) return false;
      return true;
    })
    .map((id) => ({ id, displayName: models[id].displayName, maxTokens: models[id].maxTokens }));
}

async function handleModels(res: ServerResponse): Promise<void> {
  try {
    const models = await fetchModelCatalog();
    sendJson(res, 200, {
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "antigravity",
      })),
    });
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : String(error));
  }
}

async function handleHealth(res: ServerResponse): Promise<void> {
  try {
    const accounts = await listAccountSummaries();
    sendJson(res, 200, {
      status: "ok",
      accounts: accounts.length,
      emails: accounts.map((a) => a.email ?? "unknown"),
    });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

interface PreparedUpstream {
  url: string;
  init: RequestInit;
  effectiveModel: string;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    sendError(res, error instanceof TranslationError ? error.status : 400, error instanceof Error ? error.message : String(error));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  const wantStream = body.stream !== false;
  let geminiPayload: ReturnType<typeof openAIToGemini>;
  const requestedModel = typeof body.model === "string" && body.model ? body.model : "gemini-3-flash";
  try {
    geminiPayload = openAIToGemini({
      model: requestedModel,
      messages: (body.messages ?? []) as never,
      stream: wantStream,
      tools: body.tools as never,
      tool_choice: body.tool_choice as never,
      temperature: body.temperature as never,
      top_p: body.top_p as never,
      max_tokens: body.max_tokens as never,
      max_completion_tokens: body.max_completion_tokens as never,
      stop: body.stop as never,
    });
  } catch (error) {
    sendError(res, error instanceof TranslationError ? error.status : 400, error instanceof Error ? error.message : String(error));
    return;
  }

  let live: Awaited<ReturnType<typeof getLiveAuth>>;
  try {
    live = await getLiveAuth();
  } catch (error) {
    sendError(res, 401, error instanceof Error ? error.message : String(error));
    return;
  }

  const action = wantStream ? "streamGenerateContent" : "generateContent";
  const fakeInput = `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:${action}`;
  const baseInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiPayload),
  };

  const attempt = async (forceThinkingRecovery: boolean): Promise<PreparedUpstream> => {
    const prepared = prepareAntigravityRequest(
      fakeInput,
      baseInit,
      live.auth.access ?? "",
      live.projectId,
      undefined,
      "antigravity",
      forceThinkingRecovery,
    );
    return {
      url: typeof prepared.request === "string" ? prepared.request : prepared.request.toString(),
      init: prepared.init,
      effectiveModel: prepared.effectiveModel ?? requestedModel,
    };
  };

  const doFetch = async (forceRecovery: boolean): Promise<Response> => {
    const { url, init } = await attempt(forceRecovery);
    const controller = new AbortController();
    const timeout = wantStream ? undefined : setTimeout(() => controller.abort(), NON_STREAM_TIMEOUT_MS);
    try {
      const upstream = await fetch(url, { ...init, signal: controller.signal });
      return upstream;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  let upstream: Response;
  try {
    upstream = await doFetch(false);
    if (!upstream.ok && wantStream) {
      const recovery = await maybeThinkingRecovery(upstream);
      if (recovery === "retry") upstream = await doFetch(true);
    } else if (!upstream.ok && !wantStream) {
      const recovery = await maybeThinkingRecovery(upstream);
      if (recovery === "retry") upstream = await doFetch(true);
    }
  } catch (error) {
    sendError(res, 502, `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!upstream.ok) {
    await sendUpstreamError(upstream, res);
    return;
  }

  if (!wantStream) {
    try {
      const payload = (await upstream.json()) as unknown;
      const { candidate, usage } = parseAntigravityEnvelope(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(openAICompletion(newCompletionId(), Math.floor(Date.now() / 1000), requestedModel, candidate, usage));
    } catch (error) {
      sendError(res, 502, `Failed to parse upstream response: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  await relayStream(upstream, res, requestedModel, () => doFetch(true));
}

/** Returns "retry" when the failure is a recoverable thinking-block error. */
async function maybeThinkingRecovery(upstream: Response): Promise<"retry" | "no"> {
  try {
    const text = await upstream.text();
    const message = extractErrorMessage(text);
    return detectErrorType(message) === "thinking_block_order" ? "retry" : "no";
  } catch {
    return "no";
  }
}

function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    return text;
  } catch {
    return text;
  }
}

async function sendUpstreamError(upstream: Response, res: ServerResponse): Promise<void> {
  const text = await upstream.text().catch(() => "");
  const message = extractErrorMessage(text).slice(0, 1000) || `Upstream error ${upstream.status}`;
  let status = upstream.status;
  let hint = message;
  if (upstream.status === 401 || upstream.status === 403 || /invalid_grant|revoked|reauth/i.test(message)) {
    status = 401;
    hint = `${message} — re-run \`npm run login\` to reconnect the Google account.`;
  } else if (upstream.status === 429) {
    hint = `${message} — quota exhausted for now; the request can be retried later.`;
  }
  sendError(res, status, hint);
}

class UpstreamEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamEnvelopeError";
  }
}

/** Yields parsed Antigravity envelopes from an SSE body; throws on error envelopes. */
async function* upstreamEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
        throw new UpstreamEnvelopeError(extractErrorMessage(payload));
      }
      yield parsed;
    }
  }
}

async function relayStream(
  upstream: Response,
  res: ServerResponse,
  requestedModel: string,
  retryOnce: () => Promise<Response>,
): Promise<void> {
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (data: string): boolean => res.write(`data: ${data}\n\n`);
  const toolIndexById = new Map<string, number>();
  let toolCounter = 0;
  let contentEmitted = false;
  let finishReason: string | undefined;
  let usage: ParsedUsage | undefined;
  let retried = false;
  let failed = false;

  const finish = (): void => {
    res.end("data: [DONE]\n\n");
  };

  try {
    if (!upstream.body) throw new Error("Upstream returned an empty body");
    let events = upstreamEvents(upstream.body as unknown as AsyncIterable<Uint8Array>);
    for (;;) {
      try {
        for await (const parsed of events) onEvent(parsed);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // One clean retry with forced thinking recovery, but only when the
        // failure arrived before any content (nothing relayed yet).
        if (
          error instanceof UpstreamEnvelopeError &&
          !contentEmitted &&
          !retried &&
          detectErrorType(message) === "thinking_block_order"
        ) {
          retried = true;
          const retry = await retryOnce();
          if (!retry.ok || !retry.body) {
            emit(JSON.stringify({ error: { message, type: "antigravity_error" } }));
            failed = true;
            break;
          }
          events = upstreamEvents(retry.body as unknown as AsyncIterable<Uint8Array>);
          continue;
        }
        emit(
          JSON.stringify({
            error: {
              message,
              type: error instanceof UpstreamEnvelopeError ? "antigravity_error" : "shim_error",
            },
          }),
        );
        failed = true;
        break;
      }
    }
    if (!failed) finishWithUsage();
  } catch (error) {
    emit(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "shim_error" } }));
  }
  finish();

  function onEvent(parsed: unknown): void {
    const { candidate, usage: eventUsage } = parseAntigravityEnvelope(parsed);
    if (eventUsage) usage = { ...(usage ?? {}), ...eventUsage };
    if (!candidate) return;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate.parts) {
      if (part.kind === "text") {
        contentEmitted = true;
        emit(openAIStreamChunk(id, created, requestedModel, { content: part.text }));
      } else if (part.kind === "reasoning") {
        contentEmitted = true;
        emit(openAIStreamChunk(id, created, requestedModel, { reasoning_content: part.text }));
      } else {
        contentEmitted = true;
        const key = part.id ?? `anon-${toolCounter}`;
        let index = toolIndexById.get(key);
        if (index === undefined) {
          index = toolCounter++;
          toolIndexById.set(key, index);
          emit(
            openAIStreamChunk(id, created, requestedModel, {
              tool_calls: [
                {
                  index,
                  id: part.id ?? `call-${index}`,
                  type: "function",
                  function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
                },
              ],
            }),
          );
        } else {
          emit(
            openAIStreamChunk(id, created, requestedModel, {
              tool_calls: [{ index, function: { arguments: JSON.stringify(part.args ?? {}) } }],
            }),
          );
        }
      }
    }
  }

  function finishWithUsage(): void {
    emit(
      openAIStreamChunk(
        id,
        created,
        requestedModel,
        {},
        mapFinishReason(finishReason, toolIndexById.size > 0),
      ),
    );
    if (usage) emit(openAIUsageChunk(id, created, requestedModel, usage));
  }

}

export function startServer(port: number): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      void handleHealth(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      void handleModels(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      void handleChat(req, res).catch((error) => {
        if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error));
        else res.end();
      });
      return;
    }
    sendError(res, 404, `Unknown endpoint: ${url.pathname}`);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`antigravity-zed-shim listening on http://127.0.0.1:${port}`);
    console.log(`Health: http://127.0.0.1:${port}/health`);
  });
}
