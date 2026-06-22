/**
 * 核心转换和 HTTP 网关单元测试。
 *
 * 这些测试使用模拟供应商，不依赖真实网络；主要锁定协议转换、鉴权头、工具调用和模型列表行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseYaml, resolveProvider } from "../src/config.ts";
import { GatewayError, renderError } from "../src/errors.ts";
import { createStreamTranslator, parseInboundRequest, parseProviderResponse, renderInboundResponse, renderOutboundRequest } from "../src/core.ts";
import { createGateway } from "../src/gateway.ts";
import type { GatewayConfig, ResolvedProviderConfig } from "../src/types.ts";

const anthropicProvider: ResolvedProviderConfig = { id: "anthropic-main", type: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", targetProtocol: "anthropic_messages", supportsStreaming: true, supportsImages: true, supportsTools: true, defaults: { maxTokens: 256 } };
const openaiProvider: ResolvedProviderConfig = { id: "openai-main", type: "openai", baseUrl: "https://api.openai.com", model: "gpt-4.1", targetProtocol: "openai_responses", supportsStreaming: true, supportsImages: true, supportsTools: true, defaults: { maxTokens: 256 } };

test("converts OpenAI chat with data-url image and tool to Anthropic", () => {
  const normalized = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", { model: "general-claude", stream: true, messages: [{ role: "system", content: "Be terse." }, { role: "user", content: [{ type: "text", text: "What is in this image?" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }], tools: [{ type: "function", function: { name: "lookup", description: "Lookup a value", parameters: { type: "object", properties: { q: { type: "string" } } } } }], x_unknown: "preserved" });
  assert.equal(normalized.extensions.x_unknown, "preserved");
  const outbound = renderOutboundRequest(normalized, anthropicProvider);
  assert.equal(outbound.path, "/v1/messages");
  assert.equal(outbound.body.system, "Be terse.");
  assert.deepEqual((outbound.body.messages as any[])[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
  assert.equal((outbound.body.tools as any[])[0].name, "lookup");
});

test("converts OpenAI completions prompt to OpenAI Responses", () => {
  const normalized = parseInboundRequest("openai_completions", "/v1/completions", { model: "general-openai", prompt: "Say hello", max_tokens: 12 });
  const outbound = renderOutboundRequest(normalized, openaiProvider);
  assert.equal(outbound.path, "/v1/responses");
  assert.equal((outbound.body.input as any[])[0].content[0].text, "Say hello");
  assert.equal(outbound.body.max_output_tokens, 12);
});

test("renders Anthropic provider response as OpenAI chat", () => {
  const normalized = parseProviderResponse("anthropic", { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
  const rendered = renderInboundResponse("openai_chat_completions", normalized);
  const body = rendered.body as any;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hello");
  assert.equal(body.usage.total_tokens, 5);
});

test("rejects unsupported stateful Responses fields", () => {
  assert.throws(() => parseInboundRequest("openai_responses", "/v1/responses", { model: "general-openai", input: "hello", previous_response_id: "resp_123" }), GatewayError);
});

test("maps errors and translates text stream events", () => {
  const rendered = renderError(new GatewayError(400, "unsupported_feature", "Nope"), "anthropic_messages");
  assert.deepEqual(rendered.body, { type: "error", error: { type: "unsupported_feature", message: "Nope" } });
  const translator = createStreamTranslator("openai_chat_completions", anthropicProvider);
  const lines = translator.translateLine('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}');
  assert.match(lines[0], /"content":"Hi"/);
  assert.deepEqual(translator.finish(), ["data: [DONE]"]);
});

test("parses YAML config and resolves aliases", () => {
  const yaml = "server:\n  host: 127.0.0.1\n  port: 8787\n  requestBodyLimitBytes: 1024\nproviders:\n  - id: openai-main\n    type: openai\n    baseUrl: https://api.openai.com\nmodelAliases:\n  fast:\n    provider: openai-main\n    model: gpt-4.1\n    targetProtocol: openai_responses\n    defaults:\n      maxTokens: 64\n";
  const parsed = parseYaml(yaml) as GatewayConfig;
  const provider = resolveProvider(parsed, "fast");
  assert.equal(provider.id, "openai-main");
  assert.deepEqual(provider.defaults, { maxTokens: 64 });
});


test("routes gpt-5.5 alias to OpenAI Chat Completions upstream", () => {
  const provider: ResolvedProviderConfig = { ...openaiProvider, model: "gpt-5.5", targetProtocol: "openai_chat_completions" };
  const normalized = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", { model: "gpt-5.5", messages: [{ role: "user", content: "Hello" }] });
  const outbound = renderOutboundRequest(normalized, provider);
  assert.equal(outbound.path, "/v1/chat/completions");
  assert.equal(outbound.body.model, "gpt-5.5");
  assert.equal((outbound.body.messages as any[])[0].content, "Hello");
});

test("parses OpenAI Chat Completions provider responses", () => {
  const normalized = parseProviderResponse("openai", { id: "chatcmpl_1", model: "gpt-5.5", choices: [{ index: 0, message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  const rendered = renderInboundResponse("openai_chat_completions", normalized);
  const body = rendered.body as any;
  assert.equal(body.choices[0].message.content, "Hi there");
  assert.equal(body.usage.total_tokens, 5);
});


test("forwards Anthropic x-api-key to OpenAI-compatible Authorization", async () => {
  let receivedAuthorization: string | undefined;
  const { createServer } = await import("node:http");
  const providerServer = createServer(async (request, response) => {
    receivedAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_mock",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address() as { port: number };

  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:" + providerAddress.port, supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: { "claude-opus-4-8": { provider: "mock-openai", model: "gpt-5.5", targetProtocol: "openai_chat_completions" } }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "Bearer clean-token" },
      body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(response.status, 200);
    assert.equal(receivedAuthorization, "Bearer clean-token");
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => providerServer.close(() => resolve()))
    ]);
  }
});


test("accepts Anthropic system messages inside messages", () => {
  const normalized = parseInboundRequest("anthropic_messages", "/v1/messages", {
    model: "claude-opus-4-8",
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: "hello" }
    ]
  });
  assert.equal(normalized.messages[0].role, "system");
  assert.equal(normalized.messages[1].role, "user");
});

test("accepts Anthropic tool role messages as tool results", () => {
  const normalized = parseInboundRequest("anthropic_messages", "/v1/messages", {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: "call a tool" },
      { role: "tool", tool_call_id: "toolu_1", content: "tool output" }
    ]
  });
  assert.equal(normalized.messages[1].role, "tool");
  assert.deepEqual(normalized.messages[1].content[0], { type: "tool_result", toolCallId: "toolu_1", content: [{ type: "text", text: "tool output" }] });
});

test("drops Anthropic thinking blocks from replayed messages", () => {
 const normalized = parseInboundRequest("anthropic_messages", "/v1/messages", {
 model: "claude-opus-4-8",
 messages: [
 {
 role: "assistant",
 content: [
 { type: "thinking", thinking: "private reasoning", signature: "sig" },
 { type: "redacted_thinking", data: "opaque" },
 { type: "text", text: "visible answer" }
 ]
 },
 { role: "user", content: "continue" }
 ]
 });
 assert.deepEqual(normalized.messages[0].content, [{ type: "text", text: "visible answer" }]);
});

test("renders every Anthropic tool_result as OpenAI tool message", () => {
 const normalized = parseInboundRequest("anthropic_messages", "/v1/messages", {
 model: "claude-opus-4-8",
 messages: [
 {
 role: "assistant",
 content: [
 { type: "tool_use", id: "call_01_a", name: "first", input: {} },
 { type: "tool_use", id: "call_01_b", name: "second", input: {} }
 ]
 },
 {
 role: "user",
 content: [
 { type: "tool_result", tool_use_id: "call_01_a", content: "one" },
 { type: "tool_result", tool_use_id: "call_01_b", content: "two" }
 ]
 }
 ]
 });
 const outbound = renderOutboundRequest(normalized, { ...openaiProvider, targetProtocol: "openai_chat_completions" });
 const messages = outbound.body.messages as any[];
 assert.equal(messages[1].tool_call_id, "call_01_a");
 assert.equal(messages[2].tool_call_id, "call_01_b");
});


test("parses OpenAI Responses output_text provider responses", () => {
 const normalized = parseProviderResponse("openai", {
 id: "resp_1",
 model: "gpt-5.5",
 output_text: "hello from output_text",
 usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
 });
 const rendered = renderInboundResponse("openai_responses", normalized);
 const body = rendered.body as any;
 assert.equal(body.output_text, "hello from output_text");
 assert.equal(body.output[0].content[0].text, "hello from output_text");
});


test("serves OpenAI-compatible models list from aliases", async () => {
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:1", supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: {
      "gpt-5.5": { provider: "mock-openai", model: "real-gpt", targetProtocol: "openai_chat_completions" },
      "claude-opus-4-8": { provider: "mock-openai", model: "real-claude", targetProtocol: "openai_chat_completions" }
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/models");
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.object, "list");
    assert.deepEqual(body.data.map((model: any) => model.id), ["claude-opus-4-8", "gpt-5.5"]);
    assert.equal(body.data[0].object, "model");
    assert.equal(body.data[0].owned_by, "gateway");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});


// 验证 OpenAI 指定 function 的 tool_choice 转发到 Anthropic 时会变成 Anthropic tool 选择。
test("maps OpenAI function tool_choice to Anthropic tool choice", () => {
  const normalized = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", {
    model: "general-claude",
    messages: [{ role: "user", content: "Use lookup" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    tool_choice: { type: "function", function: { name: "lookup" } }
  });
  const outbound = renderOutboundRequest(normalized, anthropicProvider);
  assert.deepEqual(outbound.body.tool_choice, { type: "tool", name: "lookup" });
});

// 验证 Anthropic 指定 tool 的 tool_choice 转发到 OpenAI Chat 时会变成 OpenAI function 选择。
test("maps Anthropic tool_choice to OpenAI Chat function choice", () => {
  const normalized = parseInboundRequest("anthropic_messages", "/v1/messages", {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Use lookup" }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: "lookup" }
  });
  const outbound = renderOutboundRequest(normalized, { ...openaiProvider, targetProtocol: "openai_chat_completions" });
  assert.deepEqual(outbound.body.tool_choice, { type: "function", function: { name: "lookup" } });
});

// 验证 required/any 这类“必须调用工具”的语义会按目标协议改名。
test("maps required and any tool_choice modes across providers", () => {
  const requiredForAnthropic = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", {
    model: "general-claude",
    messages: [{ role: "user", content: "Use a tool" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    tool_choice: "required"
  });
  const anthropicOutbound = renderOutboundRequest(requiredForAnthropic, anthropicProvider);
  assert.deepEqual(anthropicOutbound.body.tool_choice, { type: "any" });

  const anyForOpenAI = parseInboundRequest("anthropic_messages", "/v1/messages", {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Use a tool" }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "any" }
  });
  const openAIOutbound = renderOutboundRequest(anyForOpenAI, { ...openaiProvider, targetProtocol: "openai_chat_completions" });
  assert.equal(openAIOutbound.body.tool_choice, "required");
});
test("passes OpenAI Responses native tools through to Responses upstream", () => {
  const normalized = parseInboundRequest("openai_responses", "/v1/responses", {
    model: "gpt-5.5",
    input: "search briefly",
    tools: [{ type: "web_search_preview" }]
  });
  const outbound = renderOutboundRequest(normalized, { ...openaiProvider, targetProtocol: "openai_responses" });
  assert.deepEqual(outbound.body.tools, [{ type: "web_search_preview" }]);
});

test("rejects OpenAI Responses native tools for Chat Completions upstream", () => {
  const normalized = parseInboundRequest("openai_responses", "/v1/responses", {
    model: "gpt-5.5",
    input: "search briefly",
    tools: [{ type: "web_search_preview" }]
  });
  assert.throws(() => renderOutboundRequest(normalized, { ...openaiProvider, targetProtocol: "openai_chat_completions" }), GatewayError);
});


// 验证 OpenAI Chat Completions 的流式 tool_calls 增量可以转换成 Anthropic tool_use 事件。
test("translates OpenAI streaming tool call deltas to Anthropic tool_use events", () => {
  const translator = createStreamTranslator("anthropic_messages", openaiProvider);
  const event = {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"q\":" }
        }]
      },
      finish_reason: null
    }]
  };
  const lines = translator.translateLine("data: " + JSON.stringify(event));
  assert.match(lines.join("\n"), /content_block_start/);
  assert.match(lines.join("\n"), /tool_use/);
  assert.match(lines.join("\n"), /input_json_delta/);
  assert.match(lines.join("\n"), /call_1/);
  assert.match(lines.join("\n"), /lookup/);
});

// 验证 Anthropic 的 tool_use 与 input_json_delta 可以转换成 OpenAI Chat tool_calls 增量。
test("translates Anthropic streaming tool_use events to OpenAI tool call deltas", () => {
  const translator = createStreamTranslator("openai_chat_completions", anthropicProvider);
  const startLines = translator.translateLine("data: " + JSON.stringify({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} }
  }));
  const deltaLines = translator.translateLine("data: " + JSON.stringify({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: "{\"q\":" }
  }));
  assert.match(startLines.join("\n"), /tool_calls/);
  assert.match(startLines.join("\n"), /toolu_1/);
  assert.match(startLines.join("\n"), /lookup/);
  assert.match(deltaLines.join("\n"), /tool_calls/);
  assert.match(deltaLines.join("\n"), /input_json_delta|arguments/);
});


// 验证 OpenAI 客户端可以按模型 ID 查询某个 alias，返回时不泄露真实上游模型名。
test("serves OpenAI-compatible single model by alias", async () => {
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:1", supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: {
      "gpt-5.5": { provider: "mock-openai", model: "real-gpt", targetProtocol: "openai_chat_completions" }
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/models/gpt-5.5", {
      headers: { authorization: "Bearer test-key" }
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body, { id: "gpt-5.5", object: "model", created: 0, owned_by: "gateway" });
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

// 验证 Anthropic 客户端访问 /v1/models 时拿到 Anthropic 风格 envelope。
test("serves Anthropic-compatible models list from aliases", async () => {
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:1", supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: {
      "gpt-5.5": { provider: "mock-openai", model: "real-gpt", targetProtocol: "openai_chat_completions" },
      "claude-opus-4-8": { provider: "mock-openai", model: "real-claude", targetProtocol: "openai_chat_completions" }
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/models", {
      headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" }
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.has_more, false);
    assert.equal(body.first_id, "claude-opus-4-8");
    assert.equal(body.last_id, "gpt-5.5");
    assert.deepEqual(body.data.map((model: any) => model.id), ["claude-opus-4-8", "gpt-5.5"]);
    assert.equal(body.data[0].type, "model");
    assert.equal(body.data[0].display_name, "claude-opus-4-8");
    assert.equal(body.data[0].created_at, "1970-01-01T00:00:00.000Z");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});

// 验证 Anthropic 客户端可以按模型 ID 查询，并且找不到时返回 Anthropic 风格错误。
test("serves Anthropic-compatible single model and not-found error", async () => {
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:1", supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: {
      "claude-opus-4-8": { provider: "mock-openai", model: "real-claude", targetProtocol: "openai_chat_completions" }
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };
  const headers = { "x-api-key": "test-key", "anthropic-version": "2023-06-01" };

  try {
    const found = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/models/claude-opus-4-8", { headers });
    assert.equal(found.status, 200);
    assert.equal(((await found.json()) as any).id, "claude-opus-4-8");

    const missing = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/models/missing", { headers });
    assert.equal(missing.status, 404);
    const body = await missing.json() as any;
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "not_found_error");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});


// 验证 Anthropic 客户端常用的 count_tokens 辅助接口可以返回本地估算，并且不会访问真实上游。
test("serves Anthropic-compatible local count_tokens estimates", async () => {
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:1", supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: {
      "claude-opus-4-8": { provider: "mock-openai", model: "real-claude", targetProtocol: "openai_chat_completions" }
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        system: "You are concise.",
        messages: [{ role: "user", content: [{ type: "text", text: "你好，count these tokens please." }] }],
        tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }]
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(typeof body.input_tokens, "number");
    assert.ok(body.input_tokens > 0);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});
// 验证 Chat Completions 入口收到 Responses 原生工具时，不再误报缺少 function.name。
test("rejects Responses native tools from Chat Completions clients with clear error", () => {
  const normalized = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "search briefly" }],
    tools: [{ type: "web_search_preview" }]
  });
  assert.throws(
    () => renderOutboundRequest(normalized, { ...openaiProvider, targetProtocol: "openai_chat_completions" }),
    (error) => error instanceof GatewayError
      && error.code === "unsupported_feature"
      && error.message.includes("OpenAI Responses native tools can only be forwarded")
      && error.message.includes("web_search_preview")
  );
});

// 验证 Anthropic 入口收到 Responses 原生工具时，也会在跨协议边界给出明确错误。
test("rejects Responses native tools from Anthropic clients with clear error", () => {
  const normalized = parseInboundRequest("anthropic_messages", "/v1/messages", {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "search briefly" }],
    tools: [{ type: "web_search_preview" }]
  });
  assert.throws(
    () => renderOutboundRequest(normalized, anthropicProvider),
    (error) => error instanceof GatewayError
      && error.code === "unsupported_feature"
      && error.message.includes("cannot convert to Anthropic Messages")
      && error.message.includes("web_search_preview")
  );
});


// 验证 OpenAI Responses 原生工具流可以转换成 Anthropic tool_use 与参数增量。
test("translates OpenAI Responses streaming function calls to Anthropic tool_use events", () => {
  const translator = createStreamTranslator("anthropic_messages", openaiProvider);
  const startLines = translator.translateLine("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" }
  }));
  const deltaLines = translator.translateLine("data: " + JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "fc_1",
    delta: "{\"q\":"
  }));
  assert.match(startLines.join("\n"), /content_block_start/);
  assert.match(startLines.join("\n"), /tool_use/);
  assert.match(startLines.join("\n"), /call_1/);
  assert.match(startLines.join("\n"), /lookup/);
  assert.match(deltaLines.join("\n"), /input_json_delta/);
  assert.match(deltaLines.join("\n"), /\{\\\"q\\\":/);
});

// 验证 OpenAI Responses 入站协议会收到 Responses 风格 SSE 事件名，而不是 Chat 风格 choices。
test("renders OpenAI Responses streaming text and tool deltas as Responses SSE", () => {
  const translator = createStreamTranslator("openai_responses", openaiProvider);
  const textLines = translator.translateLine("data: " + JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
  const toolLines = translator.translateLine("data: " + JSON.stringify({
    type: "response.output_item.added",
    output_index: 1,
    item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "lookup", arguments: "" }
  }));
  const argsLines = translator.translateLine("data: " + JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: "fc_2",
    delta: "{\"q\":"
  }));
  const doneLines = translator.translateLine("data: " + JSON.stringify({ type: "response.completed" }));
  assert.deepEqual(textLines[0], "event: response.output_text.delta");
  assert.match(textLines[1], /response.output_text.delta/);
  assert.equal(toolLines[0], "event: response.output_item.added");
  assert.match(toolLines.join("\n"), /call_2/);
  assert.equal(argsLines[0], "event: response.function_call_arguments.delta");
  assert.match(argsLines.join("\n"), /\{\\\"q\\\":/);
  assert.equal(doneLines[0], "event: response.completed");
});

// 验证 Anthropic 工具流转成 Responses SSE 时会保留 tool_use 的 id/name 上下文。
test("translates Anthropic streaming tool_use events to OpenAI Responses function call events", () => {
  const translator = createStreamTranslator("openai_responses", anthropicProvider);
  const startLines = translator.translateLine("data: " + JSON.stringify({
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "toolu_2", name: "lookup", input: {} }
  }));
  const deltaLines = translator.translateLine("data: " + JSON.stringify({
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: "{\"q\":" }
  }));
  assert.equal(startLines[0], "event: response.output_item.added");
  assert.match(startLines.join("\n"), /toolu_2/);
  assert.match(startLines.join("\n"), /lookup/);
  assert.equal(deltaLines[0], "event: response.function_call_arguments.delta");
  assert.match(deltaLines.join("\n"), /toolu_2/);
  assert.match(deltaLines.join("\n"), /\{\\\"q\\\":/);
});


// 验证 OpenAI Responses 上游失败事件会转换成 Anthropic 入口可识别的 error 事件。
test("translates OpenAI Responses stream failures to Anthropic error events", () => {
  const translator = createStreamTranslator("anthropic_messages", openaiProvider);
  const lines = translator.translateLine("data: " + JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error: { code: "rate_limit", message: "too many requests" } }
  }));
  assert.equal(lines[0], "event: error");
  assert.match(lines[1], /too many requests/);
  assert.match(lines[1], /rate_limit/);
});

// 验证 Anthropic error 事件会转换成 OpenAI Responses 入站协议的 response.failed 事件。
test("translates Anthropic stream errors to OpenAI Responses failed events", () => {
  const translator = createStreamTranslator("openai_responses", anthropicProvider);
  const lines = translator.translateLine("data: " + JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "provider overloaded" }
  }));
  assert.equal(lines[0], "event: response.failed");
  assert.match(lines[1], /response.failed/);
  assert.match(lines[1], /provider overloaded/);
  assert.match(lines[1], /overloaded_error/);
});

// 验证 OpenAI/Responses 风格错误事件转到 Chat Completions 入口时保持 OpenAI error envelope。
test("translates provider stream errors to OpenAI chat error envelopes", () => {
  const translator = createStreamTranslator("openai_chat_completions", openaiProvider);
  const lines = translator.translateLine("data: " + JSON.stringify({
    error: { type: "server_error", code: "upstream_failed", message: "upstream stream failed" }
  }));
  assert.match(lines[0], /\"error\"/);
  assert.match(lines[0], /upstream stream failed/);
  assert.match(lines[0], /upstream_failed/);
});


// 验证上游 SSE 连接中途断开时，网关会返回入口协议格式的流式错误事件。
test("renders gateway stream read failures as Responses SSE errors", async () => {
  const { createServer } = await import("node:http");
  const providerServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: " + JSON.stringify({ type: "response.output_text.delta", delta: "partial" }) + "\n\n");
    setTimeout(() => response.destroy(new Error("upstream socket closed")), 5);
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address() as { port: number };

  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:" + providerAddress.port, supportsStreaming: true, supportsImages: true, supportsTools: true }],
    modelAliases: { "gpt-5.5": { provider: "mock-openai", model: "gpt-5.5", targetProtocol: "openai_responses" } }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /response.output_text.delta/);
    assert.match(text, /event: response.failed/);
    assert.match(text, /gateway_error/);
    assert.match(text, /terminated|socket|closed|aborted/i);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => providerServer.close(() => resolve()))
    ]);
  }
});



// 验证 alias defaults 会给常用出站参数兜底，并且客户端显式参数优先。
test("merges alias defaults for outbound parameters", () => {
  const provider: ResolvedProviderConfig = {
    ...openaiProvider,
    targetProtocol: "openai_chat_completions",
    defaults: {
      maxTokens: 99,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      metadata: { tenant: "default", trace: "default" },
      tool_choice: "auto",
      response_format: { type: "json_object" }
    }
  };
  const normalized = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "json please" }],
    temperature: 0.4,
    metadata: { trace: "request" }
  });
  const outbound = renderOutboundRequest(normalized, provider);
  assert.equal(outbound.body.max_tokens, 99);
  assert.equal(outbound.body.temperature, 0.4);
  assert.equal(outbound.body.top_p, 0.8);
  assert.deepEqual(outbound.body.stop, ["END"]);
  assert.deepEqual(outbound.body.metadata, { tenant: "default", trace: "request" });
  assert.equal(outbound.body.tool_choice, "auto");
  assert.deepEqual(outbound.body.response_format, { type: "json_object" });
});

// 验证 response_format 转 Anthropic 上游时不会被静默忽略。
test("rejects response_format for Anthropic upstream", () => {
  const normalized = parseInboundRequest("openai_chat_completions", "/v1/chat/completions", {
    model: "general-claude",
    messages: [{ role: "user", content: "return json" }],
    response_format: { type: "json_object" }
  });
  assert.throws(
    () => renderOutboundRequest(normalized, anthropicProvider),
    (error) => error instanceof GatewayError
      && error.code === "unsupported_feature"
      && error.message.includes("response_format cannot be reliably converted")
  );
});

// 验证 Responses function_call_output 回放会转成原生上游 input item。
test("renders Responses function_call_output as native input item", () => {
  const normalized = parseInboundRequest("openai_responses", "/v1/responses", {
    model: "gpt-5.5",
    input: [{ type: "function_call_output", call_id: "call_1", output: "tool result" }]
  });
  const outbound = renderOutboundRequest(normalized, { ...openaiProvider, targetProtocol: "openai_responses" });
  assert.deepEqual((outbound.body.input as any[])[0], { type: "function_call_output", call_id: "call_1", output: "tool result" });
});

// 验证 Responses 工具调用响应会按 Responses 原生 output item 返回客户端。
test("renders Responses tool calls as native output items", () => {
  const normalized = parseProviderResponse("openai", {
    id: "resp_tool",
    model: "gpt-5.5",
    output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" }]
  });
  const rendered = renderInboundResponse("openai_responses", normalized);
  const body = rendered.body as any;
  assert.deepEqual(body.output[0], { id: "call_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: JSON.stringify({ q: "x" }) });
});

// 验证旧 Completions 不能可靠转换的字段会显式报错。
test("rejects unsupported legacy completions fields", () => {
  assert.throws(
    () => parseInboundRequest("openai_completions", "/v1/completions", { model: "gpt-5.5", prompt: "hello", logprobs: 1 }),
    (error) => error instanceof GatewayError
      && error.code === "unsupported_feature"
      && error.message.includes("logprobs")
  );
});

// 验证 provider 错误会解析成稳定的入口协议错误结构，而不是直接返回原始 JSON 字符串。
test("maps provider error payloads to stable gateway errors", async () => {
  const { createServer } = await import("node:http");
  const providerServer = createServer((request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "rate_limit_exceeded", type: "rate_limit_error", message: "slow down" } }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address() as { port: number };
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-openai", type: "openai", baseUrl: "http://127.0.0.1:" + providerAddress.port }],
    modelAliases: { "gpt-5.5": { provider: "mock-openai", model: "real-gpt", targetProtocol: "openai_chat_completions" } }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(response.status, 429);
    const body = await response.json() as any;
    assert.equal(body.error.message, "slow down");
    assert.equal(body.error.code, "rate_limit_exceeded");
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => providerServer.close(() => resolve()))
    ]);
  }
});

// 验证 Anthropic 上游声明支持时，count_tokens 会走真实供应商接口。
test("forwards count_tokens to Anthropic providers when enabled", async () => {
  let receivedModel: string | undefined;
  let receivedKey: string | undefined;
  const { createServer } = await import("node:http");
  const providerServer = createServer(async (request, response) => {
    receivedKey = request.headers["x-api-key"] as string | undefined;
    let raw = "";
    for await (const chunk of request) raw += chunk;
    receivedModel = JSON.parse(raw).model;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 7 }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address() as { port: number };
  const gateway = createGateway({
    server: { host: "127.0.0.1", port: 0, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "mock-anthropic", type: "anthropic", baseUrl: "http://127.0.0.1:" + providerAddress.port, supportsTokenCounting: true }],
    modelAliases: { "claude-alias": { provider: "mock-anthropic", model: "claude-real", targetProtocol: "anthropic_messages" } }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as { port: number };

  try {
    const response = await fetch("http://127.0.0.1:" + gatewayAddress.port + "/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-alias", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 7 });
    assert.equal(receivedModel, "claude-real");
    assert.equal(receivedKey, "test-key");
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => providerServer.close(() => resolve()))
    ]);
  }
});
// 验证配置文件在启动加载阶段会拦截常见错误，而不是等请求进来才失败。
test("rejects invalid gateway config during load", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "llm-api-gateway-config-"));
  const baseConfig = {
    server: { host: "127.0.0.1", port: 8787, requestBodyLimitBytes: 1048576 },
    providers: [{ id: "openai-main", type: "openai", baseUrl: "https://api.openai.test" }],
    modelAliases: { fast: { provider: "openai-main", model: "gpt-test", targetProtocol: "openai_responses" } }
  };
  const cases = [
    {
      name: "duplicate-provider",
      config: { ...baseConfig, providers: [...baseConfig.providers, { id: "openai-main", type: "openai", baseUrl: "https://other.test" }] },
      message: /Duplicate provider id: openai-main/
    },
    {
      name: "missing-provider",
      config: { ...baseConfig, modelAliases: { fast: { provider: "missing", model: "gpt-test", targetProtocol: "openai_responses" } } },
      message: /references missing provider: missing/
    },
    {
      name: "protocol-provider-mismatch",
      config: { ...baseConfig, providers: [{ id: "anthropic-main", type: "anthropic", baseUrl: "https://api.anthropic.test" }], modelAliases: { fast: { provider: "anthropic-main", model: "claude-test", targetProtocol: "openai_responses" } } },
      message: /targetProtocol openai_responses is incompatible/
    },
    {
      name: "bad-capability-type",
      config: { ...baseConfig, providers: [{ id: "openai-main", type: "openai", baseUrl: "https://api.openai.test", supportsStreaming: "true" }] },
      message: /supportsStreaming must be a boolean/
    }
  ];

  try {
    for (const item of cases) {
      const configPath = join(directory, item.name + ".json");
      await writeFile(configPath, JSON.stringify(item.config), "utf8");
      await assert.rejects(() => loadConfig(configPath), item.message);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
