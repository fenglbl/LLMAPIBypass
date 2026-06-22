/**
 * HTTP 网关层。
 *
 * 这一层只处理 HTTP 相关的事情：路由、请求体读取、Key 头转换、上游调用、日志和响应写回。
 * 真正的协议解析与渲染全部委托给 core.ts，避免路由代码变成第二套转换逻辑。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { resolveProvider } from "./config.ts";
import { createStreamTranslator, parseInboundRequest, parseProviderResponse, renderInboundResponse, renderOutboundRequest } from "./core.ts";
import { GatewayError, renderError } from "./errors.ts";
import type { GatewayConfig, Protocol, ProviderRequest, ResolvedProviderConfig } from "./types.ts";

type ModelsResponseStyle = "openai" | "anthropic";

/** 根据 URL path 判断入口协议；未命中的路径由路由层返回 404。 */
function protocolForPath(pathname: string): Protocol | undefined {
  if (pathname === "/v1/completions") return "openai_completions";
  if (pathname === "/v1/chat/completions") return "openai_chat_completions";
  if (pathname === "/v1/responses") return "openai_responses";
  if (pathname === "/v1/messages") return "anthropic_messages";
  return undefined;
}

/** 读取 JSON body，并在读取过程中执行请求体大小限制，避免把超大请求完整放进内存。 */
async function readJson(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limitBytes) {
      throw new GatewayError(413, "payload_too_large", "Request body exceeds configured limit");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(400, "invalid_json", "Request body must be valid JSON");
  }
}

/** Node header 可能是字符串或数组，这里统一取第一个值。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 清理 Bearer 前缀，转发时再按目标供应商格式重建，避免出现 Bearer Bearer xxx。 */
function cleanApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/^Bearer\s+/i, "") : undefined;
}

/** 按入口协议读取客户端 key；为方便混用 SDK，也允许两个常见头互相兜底。 */
function inboundApiKey(protocol: Protocol, request: IncomingMessage): string | undefined {
  const anthropicKey = firstHeader(request.headers["x-api-key"]);
  const authorizationKey = firstHeader(request.headers.authorization);
  if (protocol === "anthropic_messages") {
    return cleanApiKey(anthropicKey ?? authorizationKey);
  }
  return cleanApiKey(authorizationKey ?? anthropicKey);
}

/** 按目标供应商生成鉴权头；客户端传来的 key 不落盘，只做当前请求透传。 */
function providerHeaders(provider: ResolvedProviderConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.type === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = "Bearer " + apiKey;
  }
  return headers;
}

/** 请求真实上游，包含超时和有限重试；只对网络错误和 5xx 做配置化重试。 */
async function fetchProvider(provider: ResolvedProviderConfig, request: ProviderRequest, apiKey: string | undefined): Promise<Response> {
  const url = provider.baseUrl.replace(/\/$/, "") + request.path;
  const retryCount = provider.retryCount ?? 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeoutMs ?? 60000);
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: providerHeaders(provider, apiKey),
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.status >= 500 && attempt < retryCount) {
        lastError = new GatewayError(response.status, "provider_error", "Provider returned retryable error");
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt >= retryCount) break;
    }
  }
  throw new GatewayError(502, "provider_unavailable", lastError instanceof Error ? lastError.message : "Provider request failed");
}

/** 写 JSON 响应；调用方可以覆盖或补充响应头。 */
function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
/** 从供应商错误响应里尽量提取标准 code/type/message，避免把整段 JSON 字符串直接暴露给客户端。 */
function parseProviderErrorPayload(text: string): { code?: string; type?: string; message?: string; raw: unknown } {
  if (text.trim().length === 0) {
    return { raw: text };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const error = isJsonRecord(parsed) && isJsonRecord(parsed.error) ? parsed.error : isJsonRecord(parsed) ? parsed : undefined;
    return {
      code: typeof error?.code === "string" && error.code.length > 0 ? error.code : undefined,
      type: typeof error?.type === "string" && error.type.length > 0 ? error.type : undefined,
      message: typeof error?.message === "string" && error.message.length > 0 ? error.message : undefined,
      raw: parsed
    };
  } catch {
    return { message: text, raw: text };
  }
}

/** 按 HTTP 状态码补齐供应商错误类型，保证入口协议能拿到稳定错误 code。 */
function providerErrorCode(status: number, parsed: { code?: string; type?: string }): string {
  if (parsed.code) return parsed.code;
  if (parsed.type) return parsed.type;
  if (status === 400) return "bad_request";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found";
  if (status === 408) return "provider_timeout";
  if (status === 413) return "context_length_exceeded";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "provider_unavailable";
  return "provider_error";
}

/** 将供应商 HTTP 错误转换成网关内部错误，保留状态码但规范 message/code。 */
function providerErrorFromResponse(status: number, text: string): GatewayError {
  const parsed = parseProviderErrorPayload(text);
  return new GatewayError(status, providerErrorCode(status, parsed), parsed.message ?? "Provider returned an error", { details: parsed.raw });
}

/** 只记录元数据，不记录 prompt、response 正文或 key，方便排查同时降低敏感信息风险。 */
function logMeta(meta: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...meta }));
}
/** 判断 JSON 值是否为普通对象；计数接口只用它安全读取字段，不复用核心协议解析。 */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 对文本做轻量 token 估算：中文按单字计，英文和数字按约 4 字符一个 token 计，符号单独计。 */
function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const cjkMatches = trimmed.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? [];
  const withoutCjk = trimmed.replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, " ");
  const pieces = withoutCjk.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu) ?? [];
  let total = cjkMatches.length;
  for (const piece of pieces) {
    total += /^[A-Za-z0-9_]+$/.test(piece) ? Math.max(1, Math.ceil(piece.length / 4)) : 1;
  }
  return total;
}

/** 估算结构化 JSON 的 token 数，用于工具 schema、工具参数和无法细分的内容块。 */
function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/** 递归估算 Anthropic/OpenAI 常见 content block；图片按固定成本估算，避免读取或解析图片正文。 */
function estimateContentTokens(value: unknown): number {
  if (typeof value === "string") {
    return estimateTextTokens(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateContentTokens(item), 0);
  }
  if (!isJsonRecord(value)) {
    return 0;
  }
  if ((value.type === "text" || value.type === "input_text" || value.type === "output_text") && typeof value.text === "string") {
    return estimateTextTokens(value.text);
  }
  if (value.type === "image" || value.type === "input_image" || value.type === "image_url") {
    return 85;
  }
  if (value.type === "tool_use") {
    const nameTokens = typeof value.name === "string" ? estimateTextTokens(value.name) : 0;
    return 8 + nameTokens + estimateJsonTokens(value.input ?? {});
  }
  if (value.type === "tool_result") {
    return 8 + estimateContentTokens(value.content ?? "");
  }
  if (value.type === "function_call" || value.type === "tool_call") {
    const nameTokens = typeof value.name === "string" ? estimateTextTokens(value.name) : 0;
    return 8 + nameTokens + estimateJsonTokens(value.arguments ?? {});
  }
  return estimateJsonTokens(value);
}

/** 本地估算 Anthropic count_tokens 请求；这是客户端预算辅助，不声称等同真实供应商 tokenizer。 */
function estimateAnthropicInputTokens(body: Record<string, unknown>): number {
  let total = 0;
  total += estimateContentTokens(body.system ?? "");
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      total += 4;
      if (isJsonRecord(message)) {
        total += estimateContentTokens(message.content ?? "");
      } else {
        total += estimateContentTokens(message);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      total += 12 + estimateJsonTokens(tool);
    }
  }
  if (body.tool_choice !== undefined) {
    total += estimateJsonTokens(body.tool_choice);
  }
  return Math.max(1, total);
}

/** Anthropic 兼容的 token 计数入口；Anthropic 上游显式支持时走真实计数，否则返回本地估算。 */
async function handleAnthropicCountTokens(config: GatewayConfig, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const body = await readJson(request, config.server.requestBodyLimitBytes);
  if (!isJsonRecord(body)) {
    throw new GatewayError(400, "bad_request", "Request body must be a JSON object");
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new GatewayError(400, "bad_request", "Missing required string field: model");
  }
  const modelAlias = body.model;
  const provider = resolveProvider(config, modelAlias);

  if (provider.type === "anthropic" && provider.supportsTokenCounting === true) {
    const upstream = await fetchProvider(provider, {
      method: "POST",
      path: "/v1/messages/count_tokens",
      protocol: "anthropic_messages",
      stream: false,
      body: { ...body, model: provider.model }
    }, inboundApiKey("anthropic_messages", request));
    logMeta({
      protocol: "anthropic_messages",
      endpoint: "/v1/messages/count_tokens",
      provider: provider.id,
      providerType: provider.type,
      modelAlias,
      model: provider.model,
      status: upstream.status,
      tokenCountMode: "provider",
      durationMs: Date.now() - startedAt
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      throw providerErrorFromResponse(upstream.status, text);
    }
    writeJson(response, 200, text.trim().length > 0 ? JSON.parse(text) : { input_tokens: 0 });
    return;
  }

  const inputTokens = estimateAnthropicInputTokens(body);
  logMeta({
    protocol: "anthropic_messages",
    endpoint: "/v1/messages/count_tokens",
    provider: provider.id,
    providerType: provider.type,
    modelAlias,
    model: provider.model,
    status: 200,
    tokenCountMode: "estimate",
    durationMs: Date.now() - startedAt
  });
  writeJson(response, 200, { input_tokens: inputTokens });
}

/** 给流式响应补入口协议期望的起始事件，减少严格 SDK 对首帧状态的误判。 */
function streamStartLines(protocol: Protocol): string[] {
  if (protocol === "anthropic_messages") {
    return ["event: message_start", "data: " + JSON.stringify({ type: "message_start", message: { id: "gateway-stream", type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })];
  }
  if (protocol === "openai_chat_completions") {
    return ["data: " + JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })];
  }
  if (protocol === "openai_responses") {
    return [
      "event: response.created",
      "data: " + JSON.stringify({ type: "response.created", response: { id: "gateway-stream", object: "response", status: "in_progress" } }),
      "event: response.in_progress",
      "data: " + JSON.stringify({ type: "response.in_progress", response: { id: "gateway-stream", object: "response", status: "in_progress" } })
    ];
  }
  return [];
}
/** 将网关侧流读取异常渲染成入口协议能识别的 SSE 错误事件。 */
function streamGatewayErrorLines(protocol: Protocol, error: unknown): string[] {
  const message = error instanceof Error ? error.message : "Gateway stream failed";
  if (protocol === "anthropic_messages") {
    return ["event: error", "data: " + JSON.stringify({ type: "error", error: { type: "gateway_error", message } })];
  }
  if (protocol === "openai_responses") {
    return ["event: response.failed", "data: " + JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "gateway_error", message } } })];
  }
  return ["data: " + JSON.stringify({ error: { message, type: "gateway_error", code: "gateway_error" } })];
}

/** 处理 SSE 流式响应并转换事件；这里按行处理 data/event，不解析完整业务响应。 */
async function streamResponse(clientResponse: ServerResponse, providerResponse: Response, protocol: Protocol, provider: ResolvedProviderConfig): Promise<void> {
  if (!providerResponse.body) {
    throw new GatewayError(502, "empty_stream", "Provider returned an empty stream");
  }
  const translator = createStreamTranslator(protocol, provider);
  clientResponse.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const outputLine of streamStartLines(protocol)) {
    clientResponse.write(outputLine + "\n");
  }

  const reader = providerResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const outputLine of translator.translateLine(line)) {
          clientResponse.write(outputLine + "\n");
        }
        if (line.length === 0) clientResponse.write("\n");
      }
    }
    for (const outputLine of translator.finish()) {
      clientResponse.write(outputLine + "\n");
    }
  } catch (error) {
    for (const outputLine of streamGatewayErrorLines(protocol, error)) {
      clientResponse.write(outputLine + "\n");
    }
  } finally {
    clientResponse.end("\n");
  }
}

/** 单次推理请求主流程：入口解析 -> alias 路由 -> 上游调用 -> 响应渲染。 */
async function handleApiRequest(config: GatewayConfig, request: IncomingMessage, response: ServerResponse, protocol: Protocol, pathname: string): Promise<void> {
  const startedAt = Date.now();
  const body = await readJson(request, config.server.requestBodyLimitBytes);
  const normalized = parseInboundRequest(protocol, pathname, body, request.headers);
  const provider = resolveProvider(config, normalized.modelAlias);
  const outbound = renderOutboundRequest(normalized, provider);
  const apiKey = inboundApiKey(protocol, request);
  const providerResponse = await fetchProvider(provider, outbound, apiKey);

  logMeta({
    protocol,
    provider: provider.id,
    providerType: provider.type,
    modelAlias: normalized.modelAlias,
    model: provider.model,
    status: providerResponse.status,
    stream: normalized.stream,
    durationMs: Date.now() - startedAt
  });

  if (!providerResponse.ok) {
    const text = await providerResponse.text();
    throw providerErrorFromResponse(providerResponse.status, text);
  }

  if (normalized.stream) {
    await streamResponse(response, providerResponse, protocol, provider);
    return;
  }

  const providerBody = await providerResponse.json();
  const rendered = renderInboundResponse(protocol, parseProviderResponse(provider.type, providerBody));
  writeJson(response, rendered.status, rendered.body, rendered.headers);
}

/** 根据请求头判断 /v1/models 应该返回 OpenAI 还是 Anthropic 风格。 */
function modelsResponseStyle(request: IncomingMessage): ModelsResponseStyle {
  const hasAnthropicSignal = Boolean(firstHeader(request.headers["anthropic-version"]) || firstHeader(request.headers["x-api-key"]));
  const hasOpenAISignal = Boolean(firstHeader(request.headers.authorization));
  return hasAnthropicSignal && !hasOpenAISignal ? "anthropic" : "openai";
}

/** Anthropic 模型对象需要 ISO 时间；本地 alias 没有真实创建时间，所以使用稳定占位值。 */
function anthropicModel(id: string): Record<string, unknown> {
  return { id, type: "model", display_name: id, created_at: "1970-01-01T00:00:00.000Z" };
}

/** OpenAI 模型对象同样只暴露业务 alias，不泄露真实供应商模型名。 */
function openAIModel(id: string): Record<string, unknown> {
  return { id, object: "model", created: 0, owned_by: "gateway" };
}

/** 返回模型列表；同一路径按客户端风格返回不同 envelope，列表内容都来自 modelAliases。 */
function renderModels(config: GatewayConfig, style: ModelsResponseStyle) {
  const ids = Object.keys(config.modelAliases).sort();
  if (style === "anthropic") {
    return {
      data: ids.map(anthropicModel),
      has_more: false,
      first_id: ids[0] ?? null,
      last_id: ids.at(-1) ?? null
    };
  }
  return { object: "list", data: ids.map(openAIModel) };
}

/** 返回单个模型 alias 的详情；不存在时保持入口协议风格的 404 错误。 */
function renderModel(config: GatewayConfig, id: string, style: ModelsResponseStyle) {
  if (!Object.hasOwn(config.modelAliases, id)) {
    return style === "anthropic"
      ? { status: 404, body: { type: "error", error: { type: "not_found_error", message: "Model not found: " + id } } }
      : { status: 404, body: { error: { message: "Model not found: " + id, type: "not_found", code: "not_found" } } };
  }
  return { status: 200, body: style === "anthropic" ? anthropicModel(id) : openAIModel(id) };
}

/** 创建 HTTP server；HTTP 层只做分发，协议转换仍集中在 core.ts。 */
export function createGateway(config: GatewayConfig) {
  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/v1/models") {
      writeJson(response, 200, renderModels(config, modelsResponseStyle(request)));
      return;
    }
    if (request.method === "GET" && pathname.startsWith("/v1/models/")) {
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
      const rendered = renderModel(config, modelId, modelsResponseStyle(request));
      writeJson(response, rendered.status, rendered.body);
      return;
    }
    if (request.method === "GET" && pathname === "/healthz") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && pathname === "/v1/messages/count_tokens") {
      try {
        await handleAnthropicCountTokens(config, request, response);
      } catch (error) {
        const rendered = renderError(error, "anthropic_messages");
        logMeta({ protocol: "anthropic_messages", endpoint: "/v1/messages/count_tokens", status: rendered.status, errorType: error instanceof GatewayError ? error.code : "gateway_error", message: error instanceof Error ? error.message : "Unknown gateway error" });
        writeJson(response, rendered.status, rendered.body);
      }
      return;
    }
    const protocol = protocolForPath(pathname);
    if (request.method !== "POST" || !protocol) {
      writeJson(response, 404, { error: { message: "Not found", type: "not_found", code: "not_found" } });
      return;
    }
    try {
      await handleApiRequest(config, request, response, protocol, pathname);
    } catch (error) {
      const rendered = renderError(error, protocol);
      logMeta({ protocol, status: rendered.status, errorType: error instanceof GatewayError ? error.code : "gateway_error", message: error instanceof Error ? error.message : "Unknown gateway error" });
      writeJson(response, rendered.status, rendered.body);
    }
  });
}
