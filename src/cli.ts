#!/usr/bin/env node
/**
 * CLI for the Antigravity Zed shim.
 *
 *   serve [--port N]   Start the OpenAI-compatible proxy (default 8123)
 *   login              Google OAuth sign-in, stores the grant locally
 *   models             Print a settings.json snippet with live model ids
 *   self-test          Offline unit checks for the translators (no network)
 */
import { fetchModelCatalog, startServer } from "./server";
import { runLogin } from "./login";
import { listAccountSummaries } from "./accounts";
import { defaultEffort, groupEffortVariants, resolveEffortModel } from "./effort";
import {
  mapFinishReason,
  openAICompletion,
  openAIStreamChunk,
  openAIToGemini,
  openAIUsageChunk,
  parseAntigravityEnvelope,
  TranslationError,
} from "./translate";

const DEFAULT_PORT = 8123;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve": {
      const portFlag = rest.indexOf("--port");
      const port =
        portFlag >= 0 && rest[portFlag + 1] ? Number.parseInt(rest[portFlag + 1], 10) : DEFAULT_PORT;
      if (!Number.isFinite(port)) throw new Error("Invalid --port value");
      startServer(port);
      break;
    }
    case "login": {
      await runLogin();
      break;
    }
    case "models": {
      await printModelsSnippet();
      break;
    }
    case "self-test": {
      runSelfTest();
      break;
    }
    default: {
      console.log("Usage: cli.ts <serve [--port N] | login | models | self-test>");
      process.exitCode = 1;
    }
  }
}

function defaultMaxTokens(id: string, catalogMax?: number): number {
  if (catalogMax && catalogMax > 0) return catalogMax;
  return id.toLowerCase().includes("claude") ? 200_000 : 1_000_000;
}

async function printModelsSnippet(): Promise<void> {
  const accounts = await listAccountSummaries();
  if (accounts.length === 0) {
    throw new Error("No accounts found. Run the `login` command first.");
  }
  const models = await fetchModelCatalog();
  const snippet = {
    language_models: {
      openai_compatible: {
        Antigravity: {
          api_url: "http://127.0.0.1:8123/v1",
          available_models: models.map((m) => ({
            name: m.id,
            display_name: m.displayName ?? m.id,
            max_tokens: defaultMaxTokens(m.id, m.maxTokens),
            ...(m.efforts?.length
              ? { reasoning_effort: defaultEffort(m.efforts), reasoning_effort_levels: m.efforts }
              : {}),
          })),
        },
      },
    },
  };
  console.log(JSON.stringify(snippet, null, 2));
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function runSelfTest(): void {
  // 1. OpenAI -> Gemini translation (system, history, tools, tool results).
  const gemini = openAIToGemini({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "calc", arguments: "{\"expr\":\"2+2\"}" } }],
      },
      { role: "tool", tool_call_id: "call-1", name: "calc", content: "{\"result\":4}" },
      { role: "user", content: "Thanks" },
    ],
    tools: [{ type: "function", function: { name: "calc", description: "Calculate", parameters: { type: "object" } } }],
    tool_choice: "auto",
    temperature: 0.5,
    max_completion_tokens: 1024,
  });
  // user / model(functionCall) / user(functionResponse) / user(follow-up text)
  assert(gemini.contents.length === 4, `expected 4 contents, got ${gemini.contents.length}`);
  assert(gemini.contents[0].role === "user" && gemini.contents[0].parts[0].text === "What is 2+2?", "user text");
  assert(gemini.contents[1].role === "model", "assistant maps to model");
  assert(
    gemini.contents[2].role === "user" &&
      gemini.contents[2].parts[0].functionResponse?.name === "calc",
    "tool result kept in dedicated user content",
  );
  assert(
    gemini.contents[3].role === "user" &&
      gemini.contents[3].parts[0].text === "Thanks",
    "follow-up user content preserved",
  );
  assert(gemini.systemInstruction?.parts[0].text === "Be concise.", "system instruction");
  assert(gemini.tools?.[0].functionDeclarations[0].name === "calc", "tool declarations");
  assert(gemini.toolConfig?.functionCallingConfig.mode === "AUTO", "tool choice auto");
  assert(gemini.generationConfig?.maxOutputTokens === 1024, "max tokens");
  assert(gemini.generationConfig?.temperature === 0.5, "temperature");

  const multimodal = openAIToGemini({
    model: "claude-sonnet-4-6",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Check this screenshot and doc" },
          { type: "image_url", image_url: { url: "data:image/png;name=snap.png;base64,SNAPDATA" } },
          { type: "file", file_data: "data:application/pdf;base64,PDFDATA", filename: "specs.pdf" },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-media-1", type: "function", function: { name: "take_screenshot", arguments: "{}" } },
          { id: "call-media-2", type: "function", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-media-1",
        name: "take_screenshot",
        content: JSON.stringify([
          { type: "text", text: "captured" },
          { type: "file", uri: "data:image/jpeg;base64,TOOLJPEG", mime: "image/jpeg" },
        ]),
      },
      { role: "tool", tool_call_id: "call-media-2", name: "list_files", content: "a.txt" },
      { role: "user", content: "Done?" },
    ],
  });
  assert(multimodal.contents.length === 4, `expected 4 multimodal contents, got ${multimodal.contents.length}`);
  assert(multimodal.contents[0].parts.some((p) => p.inlineData?.mimeType === "image/png"), "png inlineData");
  assert(multimodal.contents[0].parts.some((p) => p.inlineData?.mimeType === "application/pdf"), "pdf inlineData");
  assert(
    multimodal.contents[2].parts.length === 2 &&
      multimodal.contents[2].parts.every((p) => p.functionResponse),
    "parallel tool responses grouped right after the calls",
  );
  assert(
    multimodal.contents[3].parts[0].inlineData?.mimeType === "image/jpeg" &&
      multimodal.contents[3].parts[1].text === "Done?",
    "tool media follows the response group",
  );

  let remoteError: unknown;
  try {
    openAIToGemini({
      model: "gemini-3-flash",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    });
  } catch (error) {
    remoteError = error;
  }
  assert(remoteError instanceof TranslationError && remoteError.status === 400, "remote image URL rejected");

  const grouped = groupEffortVariants([
    { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576 },
    { id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)", maxTokens: 1048576 },
    { id: "gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)", maxTokens: 1048576 },
    { id: "gemini-3.8-flash-tiered", displayName: "gemini-3.8-flash-tiered" },
    { id: "gemini-4-hydrogen-low", displayName: "Gemini 4 Hydrogen (Low)" },
    { id: "gemini-4-hydrogen-xhigh", displayName: "Gemini 4 Hydrogen (XHigh)" },
    { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)" },
    { id: "gemini-3-flash", displayName: "Gemini 3 Flash" },
  ]);
  assert(
    JSON.stringify(grouped.map((m) => m.id)) ===
      JSON.stringify(["gemini-3.8-flash", "gemini-3.8-flash-tiered", "gemini-4-hydrogen", "gpt-oss-120b-medium", "gemini-3-flash"]),
    `effort variants grouped, got ${grouped.map((m) => m.id).join(",")}`,
  );
  const flash = grouped[0];
  assert(flash.displayName === "Gemini 3.8 Flash" && flash.maxTokens === 1048576, "grouped display name and max tokens");
  assert(JSON.stringify(flash.efforts) === JSON.stringify(["low", "medium", "high"]), "efforts sorted by strength");
  assert(resolveEffortModel("gemini-3.8-flash", "LOW") === "gemini-3.8-flash-low", "requested effort");
  assert(resolveEffortModel("gemini-3.8-flash", undefined) === "gemini-3.8-flash-high", "default effort");
  assert(resolveEffortModel("gemini-3.8-flash", "xhigh") === "gemini-3.8-flash-high", "effort clamps down");
  assert(resolveEffortModel("gemini-4-hydrogen", "medium") === "gemini-4-hydrogen-low", "clamps to nearest lower");
  assert(resolveEffortModel("gemini-4-hydrogen", "minimal") === "gemini-4-hydrogen-low", "below range takes lowest");
  assert(resolveEffortModel("gemini-4-hydrogen", undefined) === "gemini-4-hydrogen-xhigh", "default without high");
  assert(resolveEffortModel("gemini-3.8-flash-low", "high") === "gemini-3.8-flash-low", "raw variant ids pass through");
  assert(resolveEffortModel("gpt-oss-120b-medium", "high") === "gpt-oss-120b-medium", "single variant untouched");

  // 2. Text envelope from the API spec.
  const text = parseAntigravityEnvelope({
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "Hello" }, { text: " world" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 4, totalTokenCount: 20 },
      modelVersion: "claude-sonnet-4-6",
      responseId: "msg_vrtx_abc",
    },
    traceId: "trace-1",
  });
  assert(text.candidate?.parts.length === 2, "two text parts");
  assert(text.candidate?.parts[0].kind === "text", "text kind");
  assert(text.usage?.totalTokens === 20, "usage totals");

  // 3. Function-call envelope.
  const tool = parseAntigravityEnvelope({
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "get_weather", args: { location: "Paris" }, id: "toolu_1" } }],
          },
          finishReason: "OTHER",
        },
      ],
    },
  });
  const call = tool.candidate?.parts[0];
  assert(call?.kind === "toolCall" && call.name === "get_weather", "function call mapping");
  assert(mapFinishReason(tool.candidate?.finishReason, true) === "tool_calls", "tool_calls finish");
  assert(mapFinishReason("STOP", false) === "stop", "stop finish");
  assert(mapFinishReason("MAX_TOKENS", false) === "length", "length finish");

  // 4. Thought part maps to reasoning.
  const thinking = parseAntigravityEnvelope({
    response: {
      candidates: [{ content: { role: "model", parts: [{ thought: true, text: "Let me think" }] } }],
    },
  });
  assert(thinking.candidate?.parts[0].kind === "reasoning", "thought maps to reasoning");

  // 5. OpenAI shapes parse and carry the expected fields.
  const created = 1700000000;
  const chunk = JSON.parse(openAIStreamChunk("id-1", created, "m", { content: "Hi" })) as {
    choices: Array<{ delta: { content?: string }; finish_reason: null }>;
  };
  assert(chunk.choices[0].delta.content === "Hi", "stream chunk content");
  const usageChunk = JSON.parse(
    openAIUsageChunk("id-1", created, "m", { promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
  ) as { usage: { total_tokens: number } };
  assert(usageChunk.usage.total_tokens === 3, "usage chunk totals");
  const completion = JSON.parse(
    openAICompletion("id-1", created, "m", tool.candidate, { promptTokens: 5, completionTokens: 6, totalTokens: 11 }),
  ) as {
    choices: Array<{ message: { tool_calls: unknown[] }; finish_reason: string }>;
    usage: { total_tokens: number };
  };
  assert(completion.choices[0].message.tool_calls.length === 1, "completion tool calls");
  assert(completion.choices[0].finish_reason === "tool_calls", "completion finish");
  assert(completion.usage.total_tokens === 11, "completion usage");
  const thinkingCompletion = JSON.parse(
    openAICompletion("id-2", created, "m", thinking.candidate, undefined),
  ) as { choices: Array<{ message: { content: string | null; reasoning_content?: string } }> };
  assert(
    thinkingCompletion.choices[0].message.content === null &&
      thinkingCompletion.choices[0].message.reasoning_content === "Let me think",
    "completion keeps reasoning out of content",
  );

  console.log("self-test: all checks passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
