/**
 * 鍗忚杞崲鏍稿績銆?
 *
 * 杩欓噷涓嶅鐞?HTTP锛屽彧璐熻矗鍏ュ彛璇锋眰鏍囧噯鍖栥€佷笂娓歌姹傛覆鏌撱€佷笂娓稿搷搴旀爣鍑嗗寲銆佷笅娓稿搷搴旀覆鏌撱€?
 */
import { badRequest, unsupported } from "./errors.ts";
import type {
  ClientResponse,
  ContentPart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  Protocol,
  ProviderConfig,
  ProviderRequest,
  ProviderType,
  ResolvedProviderConfig,
  StreamTranslator,
  ToolDefinition,
  Usage
} from "./types.ts";

/** 宸茬煡鍏叡瀛楁锛涙湭鐭ュ瓧娈佃繘鍏?extensions锛屽唴閮ㄤ繚鐣欎絾榛樿涓嶈浆鍙戙€?*/
const KNOWN_COMMON_FIELDS = new Set([
  "model",
  "messages",
  "prompt",
  "input",
  "stream",
  "tools",
  "functions",
  "tool_choice",
  "function_call",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "stop",
  "stop_sequences",
  "metadata",
  "response_format",
  "system"
]);

/** 鍒ゆ柇 unknown 鏄惁鏄櫘閫氬璞★紝閬垮厤鐩存帴璁块棶澶栭儴 JSON銆?*/
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 瑕佹眰璇锋眰鎴栧搷搴斾綋蹇呴』鏄?JSON 瀵硅薄銆?*/
function requireRecord(value: unknown, protocol: Protocol): Record<string, unknown> {
  if (!isRecord(value)) {
    badRequest(protocol, "Request body must be a JSON object");
  }
  return value;
}

/** 璇诲彇蹇呭～瀛楃涓插瓧娈碉紝渚嬪 model銆?*/
function stringField(body: Record<string, unknown>, field: string, protocol: Protocol): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    badRequest(protocol, "Missing required string field: " + field);
  }
  return value;
}

/** 璇诲彇鍙€夋暟瀛楀瓧娈碉紝涓嶅仛瀛楃涓插埌鏁板瓧鐨勯殣寮忚浆鎹€?*/
function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return typeof value === "number" ? value : undefined;
}

/** 灏嗗瓧绗︿覆鎴?OpenAI content parts 缁熶竴鎴?ContentPart[]銆?*/
function normalizeTextContent(value: unknown, protocol: Protocol): ContentPart[] {
  if (typeof value === "string") {
    return value.length === 0 ? [] : [{ type: "text", text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((part) => normalizeOpenAIContentPart(part, protocol));
  }
  if (value == null) {
    return [];
  }
  badRequest(protocol, "Message content must be a string or content-part array", value);
}

/** 瑙ｆ瀽 OpenAI 鍥剧墖 URL锛岃瘑鍒?data URL 骞舵媶鍑?base64銆?*/
function imageFromOpenAIUrl(imageUrl: string, protocol: Protocol): ContentPart {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(imageUrl);
  if (match) {
    return { type: "image", mediaType: match[1], base64: match[2], url: imageUrl };
  }
  return { type: "image", url: imageUrl };
}

/** 灏?OpenAI content part 鏍囧噯鍖栥€?*/
function normalizeOpenAIContentPart(part: unknown, protocol: Protocol): ContentPart[] {
  if (!isRecord(part)) {
    badRequest(protocol, "Content part must be an object", part);
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      badRequest(protocol, "OpenAI text content part requires text");
    }
    return [{ type: "text", text: part.text }];
  }
  if (part.type === "input_text") {
    if (typeof part.text !== "string") {
      badRequest(protocol, "OpenAI input_text content part requires text");
    }
    return [{ type: "text", text: part.text }];
  }
  if (part.type === "image_url") {
    const imageUrl = isRecord(part.image_url) ? part.image_url.url : undefined;
    if (typeof imageUrl !== "string") {
      badRequest(protocol, "OpenAI image_url content part requires image_url.url");
    }
    return [imageFromOpenAIUrl(imageUrl, protocol)];
  }
  if (part.type === "input_image") {
    const imageUrl = typeof part.image_url === "string" ? part.image_url : undefined;
    if (!imageUrl) {
      badRequest(protocol, "OpenAI input_image content part requires image_url");
    }
    return [imageFromOpenAIUrl(imageUrl, protocol)];
  }
  if (part.type === "tool_result") {
    if (typeof part.tool_call_id !== "string") {
      badRequest(protocol, "tool_result content part requires tool_call_id");
    }
    return [{ type: "tool_result", toolCallId: part.tool_call_id, content: normalizeTextContent(part.content, protocol) }];
  }
  unsupported(protocol, "Unsupported OpenAI content part type: " + String(part.type), part);
}

/** 灏?Anthropic content block 鏍囧噯鍖栵紱thinking 绫诲潡鎺ュ彈浣嗕笉杞彂銆?*/
function normalizeAnthropicContentPart(part: unknown, protocol: Protocol): ContentPart[] {
  if (typeof part === "string") {
    return [{ type: "text", text: part }];
  }
  if (!isRecord(part)) {
    badRequest(protocol, "Anthropic content part must be an object", part);
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      badRequest(protocol, "Anthropic text part requires text");
    }
    return [{ type: "text", text: part.text }];
  }
  if (part.type === "image") {
    const source = isRecord(part.source) ? part.source : undefined;
    if (!source || source.type !== "base64" || typeof source.data !== "string") {
      unsupported(protocol, "Only Anthropic base64 image parts are supported", part);
    }
    return [{ type: "image", mediaType: typeof source.media_type === "string" ? source.media_type : undefined, base64: source.data }];
  }
  if (part.type === "tool_use") {
    if (typeof part.id !== "string" || typeof part.name !== "string") {
      badRequest(protocol, "Anthropic tool_use requires id and name");
    }
    return [{ type: "tool_call", id: part.id, name: part.name, arguments: part.input ?? {} }];
  }
  if (part.type === "tool_result") {
    if (typeof part.tool_use_id !== "string") {
      badRequest(protocol, "Anthropic tool_result requires tool_use_id");
    }
    const content = Array.isArray(part.content)
      ? part.content.flatMap((inner) => normalizeAnthropicContentPart(inner, protocol))
      : normalizeTextContent(part.content ?? "", protocol);
    return [{ type: "tool_result", toolCallId: part.tool_use_id, content, isError: part.is_error === true }];
  }
  if (part.type === "thinking" || part.type === "redacted_thinking") {
 return [];
 }
 unsupported(protocol, "Unsupported Anthropic content part type: " + String(part.type), part);
}

/** 灏?OpenAI message 鏍囧噯鍖栵紝鍖呭惈 tool message/tool_calls/function_call銆?*/
function normalizeOpenAIMessage(message: unknown, protocol: Protocol): NormalizedMessage {
  if (!isRecord(message)) {
    badRequest(protocol, "OpenAI message must be an object", message);
  }
  const role = message.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    badRequest(protocol, "Unsupported OpenAI message role: " + String(role));
  }
  const content: ContentPart[] = [];
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string") {
      badRequest(protocol, "OpenAI tool message requires tool_call_id");
    }
    content.push({ type: "tool_result", toolCallId: message.tool_call_id, content: normalizeTextContent(message.content ?? "", protocol) });
  } else {
    content.push(...normalizeTextContent(message.content, protocol));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall) || typeof toolCall.id !== "string" || !isRecord(toolCall.function) || typeof toolCall.function.name !== "string") {
        badRequest(protocol, "OpenAI tool_calls require id and function.name", toolCall);
      }
      const rawArguments = typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "{}";
      let parsedArguments: unknown = rawArguments;
      try {
        parsedArguments = JSON.parse(rawArguments);
      } catch {
        parsedArguments = rawArguments;
      }
      content.push({ type: "tool_call", id: toolCall.id, name: toolCall.function.name, arguments: parsedArguments });
    }
  }
  if (isRecord(message.function_call) && typeof message.function_call.name === "string") {
    const rawArguments = typeof message.function_call.arguments === "string" ? message.function_call.arguments : "{}";
    content.push({ type: "tool_call", id: "function_call", name: message.function_call.name, arguments: JSON.parse(rawArguments) });
  }
  return { role, content, name: typeof message.name === "string" ? message.name : undefined };
}

/** 灏?Anthropic message 鏍囧噯鍖栵紝鍏煎 system/tool role 鍥炴斁銆?*/
function normalizeAnthropicMessage(message: unknown, protocol: Protocol): NormalizedMessage {
  if (!isRecord(message)) {
    badRequest(protocol, "Anthropic message must be an object", message);
  }
  if (message.role === "system") {
    return { role: "system", content: normalizeTextContent(message.content ?? "", protocol) };
  }
  if (message.role === "tool") {
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : typeof message.tool_use_id === "string" ? message.tool_use_id : "tool_result";
    const content = Array.isArray(message.content)
      ? message.content.flatMap((part) => normalizeAnthropicContentPart(part, protocol))
      : normalizeTextContent(message.content ?? "", protocol);
    return { role: "tool", content: [{ type: "tool_result", toolCallId, content }] };
  }
  if (message.role !== "user" && message.role !== "assistant") {
    badRequest(protocol, "Anthropic messages only support user, assistant, system, or tool roles");
  }
  const content = Array.isArray(message.content)
    ? message.content.flatMap((part) => normalizeAnthropicContentPart(part, protocol))
    : normalizeTextContent(message.content, protocol);
  return { role: message.role, content };
}

/** 鏍囧噯鍖栧伐鍏峰畾涔夛紱function 鍙法鍗忚杞崲锛孯esponses native tool 鍙兘閫忎紶鍒?Responses銆?*/
function normalizeTools(body: Record<string, unknown>, protocol: Protocol): ToolDefinition[] | undefined {
  const rawTools = Array.isArray(body.tools) ? body.tools : Array.isArray(body.functions) ? body.functions : undefined;
  if (!rawTools) {
    return undefined;
  }
  return rawTools.map((tool) => {
    if (!isRecord(tool)) {
      badRequest(protocol, "Tool definition must be an object", tool);
    }
    const nativeType = typeof tool.type === "string" && tool.type !== "function" && !isRecord(tool.function) ? tool.type : undefined;
    if (nativeType) {
      return { kind: "native", nativeType, raw: tool };
    }
    const definition = isRecord(tool.function) ? tool.function : tool;
    if (typeof definition.name !== "string") {
      if (tool.type === "function") {
        badRequest(protocol, "OpenAI function tool requires function.name", tool);
      }
      badRequest(protocol, "Tool definition requires a name; OpenAI Responses native tools must use /v1/responses", tool);
    }
    const inputSchema = isRecord(definition.parameters)
      ? definition.parameters
      : isRecord(definition.input_schema)
        ? definition.input_schema
        : { type: "object", properties: {} };
    return {
      kind: "function",
      name: definition.name,
      description: typeof definition.description === "string" ? definition.description : undefined,
      inputSchema
    };
  });
}

/** 鏀堕泦鏈煡瀛楁锛岄伩鍏嶅叆鍙ｇ鏈夊瓧娈佃浼犱笂娓搞€?*/
function collectExtensions(body: Record<string, unknown>): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!KNOWN_COMMON_FIELDS.has(key)) {
      extensions[key] = value;
    }
  }
  return extensions;
}

/** 鍏ュ彛璇锋眰瑙ｆ瀽鎬诲叆鍙ｃ€?*/
export function parseInboundRequest(protocol: Protocol, endpoint: string, body: unknown, headers: Headers | Record<string, string | string[] | undefined> = {}): NormalizedRequest {
  const requestBody = requireRecord(body, protocol);
  if (protocol === "openai_responses" && ("previous_response_id" in requestBody || "conversation" in requestBody)) {
    unsupported(protocol, "Stateful Responses fields are not supported in v1");
  }
  const modelAlias = stringField(requestBody, "model", protocol);
  const stream = requestBody.stream === true;
  const tools = normalizeTools(requestBody, protocol);
  const common = {
    protocol,
    endpoint,
    modelAlias,
    stream,
    tools,
    toolChoice: requestBody.tool_choice ?? requestBody.function_call,
    temperature: optionalNumber(requestBody, "temperature"),
    topP: optionalNumber(requestBody, "top_p"),
    maxTokens: optionalNumber(requestBody, "max_tokens") ?? optionalNumber(requestBody, "max_completion_tokens") ?? optionalNumber(requestBody, "max_output_tokens"),
    stop: typeof requestBody.stop === "string" || Array.isArray(requestBody.stop) ? requestBody.stop as string | string[] : typeof requestBody.stop_sequences === "string" || Array.isArray(requestBody.stop_sequences) ? requestBody.stop_sequences as string | string[] : undefined,
    metadata: isRecord(requestBody.metadata) ? requestBody.metadata : undefined,
    responseFormat: requestBody.response_format,
    original: body,
    extensions: collectExtensions(requestBody)
  };

  if (protocol === "openai_completions") {
    for (const field of ["echo", "logprobs", "best_of", "suffix"] as const) {
      if (field in requestBody) {
        unsupported(protocol, "OpenAI Completions field is not supported by this protocol gateway: " + field, requestBody[field]);
      }
    }
    const prompt = requestBody.prompt;
    if (Array.isArray(prompt)) {
      if (prompt.length !== 1 || typeof prompt[0] !== "string") {
        unsupported(protocol, "Only a single string prompt is supported for completions conversion", prompt);
      }
      return { ...common, messages: [{ role: "user", content: [{ type: "text", text: prompt[0] }] }] };
    }
    if (typeof prompt !== "string") {
      badRequest(protocol, "Completions request requires a string prompt");
    }
    return { ...common, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
  }

  if (protocol === "openai_chat_completions") {
    if (!Array.isArray(requestBody.messages)) {
      badRequest(protocol, "Chat Completions request requires messages[]");
    }
    return { ...common, messages: requestBody.messages.map((message) => normalizeOpenAIMessage(message, protocol)) };
  }

  if (protocol === "openai_responses") {
    const input = requestBody.input;
    if (typeof input === "string") {
      return { ...common, messages: [{ role: "user", content: [{ type: "text", text: input }] }] };
    }
    if (Array.isArray(input)) {
      return { ...common, messages: input.map((message) => normalizeOpenAIResponsesInputItem(message, protocol)) };
    }
    badRequest(protocol, "Responses request requires string or message-array input");
  }

  const systemMessages: NormalizedMessage[] = [];
  if (typeof requestBody.system === "string") {
    systemMessages.push({ role: "system", content: [{ type: "text", text: requestBody.system }] });
  }
  if (!Array.isArray(requestBody.messages)) {
    badRequest(protocol, "Anthropic Messages request requires messages[]");
  }
  return { ...common, messages: [...systemMessages, ...requestBody.messages.map((message) => normalizeAnthropicMessage(message, protocol))] };
}

/** 灏嗙粺涓€鍐呭鍧楁覆鏌撴垚 OpenAI Responses input content銆?*/
function renderOpenAIContent(content: ContentPart[]): unknown[] {
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    if (part.type === "image") {
      const imageUrl = part.url ?? (part.base64 ? "data:" + (part.mediaType ?? "image/png") + ";base64," + part.base64 : undefined);
      if (!imageUrl) {
        throw new Error("OpenAI rendering requires image URL data");
      }
      return { type: "input_image", image_url: imageUrl };
    }
    if (part.type === "tool_result") {
      return { type: "function_call_output", call_id: part.toolCallId, output: renderText(part.content) };
    }
    return { type: "tool_call", call_id: part.id, name: part.name, arguments: part.arguments };
  });
}

/** 灏嗙粺涓€娑堟伅鍒楄〃娓叉煋鎴?OpenAI Responses input銆?*/
/** 将 OpenAI Responses input item 标准化；兼容 message 与 function_call_output 两类常见回放项。 */
function normalizeOpenAIResponsesInputItem(item: unknown, protocol: Protocol): NormalizedMessage {
  if (!isRecord(item)) {
    badRequest(protocol, "Responses input item must be an object", item);
  }
  if (item.type === "function_call_output") {
    if (typeof item.call_id !== "string") {
      badRequest(protocol, "Responses function_call_output requires call_id", item);
    }
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    return { role: "tool", content: [{ type: "tool_result", toolCallId: item.call_id, content: normalizeTextContent(output, protocol) }] };
  }
  return normalizeOpenAIMessage(item, protocol);
}
function renderOpenAIInput(messages: NormalizedMessage[]): unknown[] {
  return messages.flatMap((message) => {
    const items: unknown[] = [];
    const content = message.content.filter((part) => {
      if (part.type === "tool_result") {
        items.push({ type: "function_call_output", call_id: part.toolCallId, output: renderText(part.content) });
        return false;
      }
      return true;
    });
    if (content.length > 0 && message.role !== "tool") {
      items.unshift({ role: message.role, content: renderOpenAIContent(content) });
    }
    return items;
  });
}

/** 灏嗙粺涓€鍐呭鍧楁覆鏌撴垚 Chat Completions message.content銆?*/
function renderChatContent(content: ContentPart[]): unknown {
  const text = renderText(content);
  const imageParts = content.filter((part): part is Extract<ContentPart, { type: "image" }> => part.type === "image");
  if (imageParts.length === 0) {
    return text;
  }
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...imageParts.map((part) => ({
      type: "image_url",
      image_url: {
        url: part.url ?? "data:" + (part.mediaType ?? "image/png") + ";base64," + part.base64
      }
    }))
  ];
}

/** 娓叉煋 Chat messages锛涙瘡涓?tool_result 閮藉繀椤讳繚鐣欎负鐙珛 tool 娑堟伅銆?*/
function renderChatMessages(messages: NormalizedMessage[]): unknown[] {
 return messages.flatMap((message) => {
 const toolMessages: unknown[] = [];
 const messageContent: ContentPart[] = [];
 for (const part of message.content) {
 if (part.type === "tool_result") {
 toolMessages.push({ role: "tool", tool_call_id: part.toolCallId, content: renderText(part.content) });
 } else {
 messageContent.push(part);
 }
 }
 if (message.role === "tool") {
 return toolMessages;
 }
 if (messageContent.length === 0) {
 return toolMessages;
 }
 const toolCalls: unknown[] = [];
 for (const part of messageContent) {
 if (part.type === "tool_call") {
 toolCalls.push({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } });
 }
 }
 const rendered: { [key: string]: unknown } = {
 role: message.role,
 content: renderChatContent(messageContent)
 };
 if (toolCalls.length > 0) {
 rendered.tool_calls = toolCalls;
 }
 return [...toolMessages, rendered];
 });
}

/** 灏嗙粺涓€鍐呭鍧楁覆鏌撴垚 Anthropic content blocks銆?*/
function renderAnthropicContent(content: ContentPart[]): unknown[] {
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      if (!part.base64) {
        unsupported("anthropic_messages", "Anthropic rendering requires base64 image data");
      }
      return { type: "image", source: { type: "base64", media_type: part.mediaType ?? "image/png", data: part.base64 } };
    }
    if (part.type === "tool_call") {
      return { type: "tool_use", id: part.id, name: part.name, input: part.arguments };
    }
    return { type: "tool_result", tool_use_id: part.toolCallId, content: renderAnthropicContent(part.content), is_error: part.isError === true };
  });
}

/** 鎻愬彇骞舵嫾鎺ユ枃鏈潡锛岀敤浜庡彧鑳借〃杈剧函鏂囨湰鐨勪綅缃€?*/
function renderText(content: ContentPart[]): string {
  return content.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("");
}

/** 筛出 OpenAI Responses 原生工具，用于判断是否可跨协议转换。 */
function nativeTools(tools?: ToolDefinition[]): Extract<ToolDefinition, { kind: "native" }>[] {
  return tools?.filter((tool): tool is Extract<ToolDefinition, { kind: "native" }> => tool.kind === "native") ?? [];
}

/** 返回 native tool 的类型名称，用于生成清晰的跨协议错误。 */
function nativeToolNames(tools?: ToolDefinition[]): string[] {
  return nativeTools(tools).map((tool) => tool.nativeType);
}

/** 拦截无法跨协议表达的 OpenAI Responses 原生工具。 */
function rejectNativeTools(normalized: NormalizedRequest, targetDescription: string): void {
  const names = nativeToolNames(normalized.tools);
  if (names.length > 0) {
    unsupported(normalized.protocol, "OpenAI Responses native tools can only be forwarded to an OpenAI Responses upstream; cannot convert to " + targetDescription + ": " + names.join(", "));
  }
}

/** 娓叉煋 OpenAI tools锛汻esponses native tool 鍘熸牱閫忎紶銆?*/
function renderToolsForOpenAI(tools?: ToolDefinition[]): unknown[] | undefined {
  return tools?.map((tool) => tool.kind === "native" ? tool.raw : { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } });
}

/** 娓叉煋 Anthropic tools锛沶ative tool 鏃犵瓑浠疯〃杈炬椂鏄庣‘鎶ヤ笉鏀寔銆?*/
function renderToolsForAnthropic(tools?: ToolDefinition[]): unknown[] | undefined {
  return tools?.map((tool) => {
    if (tool.kind === "native") {
      unsupported("anthropic_messages", "OpenAI Responses native tool cannot be rendered as an Anthropic tool: " + tool.nativeType, tool.raw);
    }
    return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
  });
}
/** 将 tool_choice 字符串规范成跨协议通用语义；any 是 Anthropic 的“必须选一个工具”。 */
function normalizedToolChoiceMode(value: string): "auto" | "none" | "required" | "any" | undefined {
  if (value === "auto" || value === "none" || value === "required" || value === "any") {
    return value;
  }
  return undefined;
}

/** 从 OpenAI/Anthropic 常见 tool_choice 对象里提取被指定的工具名。 */
function toolChoiceName(choice: Record<string, unknown>): string | undefined {
  if (typeof choice.name === "string") {
    return choice.name;
  }
  if (isRecord(choice.function) && typeof choice.function.name === "string") {
    return choice.function.name;
  }
  return undefined;
}

/** 渲染 OpenAI 目标协议的 tool_choice；Chat 和 Responses 指定 function 的对象形状不同。 */
function renderToolChoiceForOpenAI(toolChoice: unknown, protocol: Protocol, targetProtocol: "openai_chat_completions" | "openai_responses"): unknown {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    const mode = normalizedToolChoiceMode(toolChoice);
    if (!mode) {
      unsupported(protocol, "Unsupported tool_choice mode for OpenAI upstream: " + toolChoice);
    }
    return mode === "any" ? "required" : mode;
  }
  if (!isRecord(toolChoice)) {
    badRequest(protocol, "tool_choice must be a string or object", toolChoice);
  }
  if (typeof toolChoice.type === "string") {
    const mode = normalizedToolChoiceMode(toolChoice.type);
    if (mode) {
      return mode === "any" ? "required" : mode;
    }
  }
  const name = toolChoiceName(toolChoice);
  if (name) {
    return targetProtocol === "openai_responses"
      ? { type: "function", name }
      : { type: "function", function: { name } };
  }
  if (targetProtocol === "openai_responses" && typeof toolChoice.type === "string") {
    return toolChoice;
  }
  unsupported(protocol, "Unsupported tool_choice object for OpenAI upstream", toolChoice);
}

/** 渲染 Anthropic 目标协议的 tool_choice；OpenAI function 选择会转成 Anthropic tool 选择。 */
function renderToolChoiceForAnthropic(toolChoice: unknown, protocol: Protocol): unknown {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    const mode = normalizedToolChoiceMode(toolChoice);
    if (!mode) {
      unsupported(protocol, "Unsupported tool_choice mode for Anthropic upstream: " + toolChoice);
    }
    return { type: mode === "required" ? "any" : mode };
  }
  if (!isRecord(toolChoice)) {
    badRequest(protocol, "tool_choice must be a string or object", toolChoice);
  }
  if (typeof toolChoice.type === "string") {
    const mode = normalizedToolChoiceMode(toolChoice.type);
    if (mode) {
      return { type: mode === "required" ? "any" : mode };
    }
    if (toolChoice.type === "tool") {
      const name = toolChoiceName(toolChoice);
      if (name) {
        return { type: "tool", name };
      }
      badRequest(protocol, "Anthropic tool_choice type=tool requires name", toolChoice);
    }
  }
  const name = toolChoiceName(toolChoice);
  if (name) {
    return { type: "tool", name };
  }
  unsupported(protocol, "Unsupported tool_choice object for Anthropic upstream", toolChoice);
}

/** 从 alias defaults 里按多个候选字段读取数字，兼容 camelCase 与协议原字段名。 */
function defaultNumber(defaults: Record<string, unknown> | undefined, fields: string[]): number | undefined {
  for (const field of fields) {
    const value = defaults?.[field];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/** 从 alias defaults 里按多个候选字段读取结构值，用于 tool_choice/response_format 等对象字段。 */
function defaultValue(defaults: Record<string, unknown> | undefined, fields: string[]): unknown {
  for (const field of fields) {
    if (defaults && field in defaults) {
      return defaults[field];
    }
  }
  return undefined;
}

/** 读取默认 stop/stop_sequences；只接受协议能表达的字符串或字符串数组。 */
function defaultStop(defaults: Record<string, unknown> | undefined): string | string[] | undefined {
  const value = defaultValue(defaults, ["stop", "stopSequences", "stop_sequences"]);
  return typeof value === "string" || Array.isArray(value) ? value as string | string[] : undefined;
}

/** 合并 metadata 默认值；客户端显式 metadata 覆盖 alias defaults 中的同名字段。 */
function mergedMetadata(defaults: Record<string, unknown> | undefined, metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const defaultMetadata = isRecord(defaults?.metadata) ? defaults.metadata : undefined;
  if (!defaultMetadata && !metadata) {
    return undefined;
  }
  return { ...(defaultMetadata ?? {}), ...(metadata ?? {}) };
}

/** response_format 目前只能可靠转发给 OpenAI 风格上游，转 Anthropic 时必须显式拒绝。 */
function rejectResponseFormatForAnthropic(normalized: NormalizedRequest, responseFormat: unknown): void {
  if (responseFormat !== undefined) {
    unsupported(normalized.protocol, "response_format cannot be reliably converted to Anthropic Messages; route this alias to an OpenAI upstream or remove response_format", responseFormat);
  }
}
/** 鏍规嵁 provider 鑳藉姏澹版槑鎻愬墠鎷︽埅鍥剧墖銆佸伐鍏枫€佹祦寮忕瓑涓嶆敮鎸佽兘鍔涖€?*/
function capabilityCheck(normalized: NormalizedRequest, provider: ResolvedProviderConfig): void {
  const hasImages = normalized.messages.some((message) => message.content.some((part) => part.type === "image"));
  const hasTools = Boolean(normalized.tools?.length) || normalized.messages.some((message) => message.content.some((part) => part.type === "tool_call" || part.type === "tool_result"));
  if (hasImages && provider.supportsImages === false) {
    unsupported(normalized.protocol, "Selected provider does not support image input");
  }
  if (hasTools && provider.supportsTools === false) {
    unsupported(normalized.protocol, "Selected provider does not support tools");
  }
  if (normalized.stream && provider.supportsStreaming === false) {
    unsupported(normalized.protocol, "Selected provider does not support streaming");
  }
}

/** 灏?NormalizedRequest 娓叉煋鎴愮湡瀹炰笂娓歌姹傘€?*/
export function renderOutboundRequest(normalized: NormalizedRequest, provider: ResolvedProviderConfig): ProviderRequest {
  capabilityCheck(normalized, provider);
  const defaults = provider.defaults;
  const maxTokens = normalized.maxTokens ?? defaultNumber(defaults, ["maxTokens", "max_tokens", "max_completion_tokens", "max_output_tokens"]);
  const temperature = normalized.temperature ?? defaultNumber(defaults, ["temperature"]);
  const topP = normalized.topP ?? defaultNumber(defaults, ["topP", "top_p"]);
  const stop = normalized.stop ?? defaultStop(defaults);
  const metadata = mergedMetadata(defaults, normalized.metadata);
  const toolChoice = normalized.toolChoice ?? defaultValue(defaults, ["toolChoice", "tool_choice", "function_call"]);
  const responseFormat = normalized.responseFormat ?? defaultValue(defaults, ["responseFormat", "response_format"]);
  if (provider.type === "openai") {
    if (provider.targetProtocol === "openai_chat_completions") {
      rejectNativeTools(normalized, "OpenAI Chat Completions");
      const body: Record<string, unknown> = {
        model: provider.model,
        messages: renderChatMessages(normalized.messages),
        stream: normalized.stream || undefined,
        tools: renderToolsForOpenAI(normalized.tools),
        tool_choice: renderToolChoiceForOpenAI(toolChoice, normalized.protocol, "openai_chat_completions"),
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        stop,
        metadata,
        response_format: responseFormat
      };
      pruneUndefined(body);
      return { method: "POST", path: "/v1/chat/completions", body, protocol: "openai_chat_completions", stream: normalized.stream };
    }
    const body: Record<string, unknown> = {
      model: provider.model,
      input: renderOpenAIInput(normalized.messages),
      stream: normalized.stream || undefined,
      tools: renderToolsForOpenAI(normalized.tools),
      tool_choice: renderToolChoiceForOpenAI(toolChoice, normalized.protocol, "openai_responses"),
      temperature,
      top_p: topP,
      max_output_tokens: maxTokens,
      metadata,
      response_format: responseFormat
    };
    pruneUndefined(body);
    return { method: "POST", path: "/v1/responses", body, protocol: "openai_responses", stream: normalized.stream };
  }

  rejectNativeTools(normalized, "Anthropic Messages");
  rejectResponseFormatForAnthropic(normalized, responseFormat);
  const system = normalized.messages.filter((message) => message.role === "system").map((message) => renderText(message.content)).join("\n");
  const messages = normalized.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role === "tool" ? "user" : message.role, content: renderAnthropicContent(message.content) }));
  const body: Record<string, unknown> = {
    model: provider.model,
    system: system.length > 0 ? system : undefined,
    messages,
    stream: normalized.stream || undefined,
    tools: renderToolsForAnthropic(normalized.tools),
    tool_choice: renderToolChoiceForAnthropic(toolChoice, normalized.protocol),
    temperature,
    top_p: topP,
    max_tokens: maxTokens ?? 1024,
    metadata,
    stop_sequences: stop
  };
  pruneUndefined(body);
  return { method: "POST", path: "/v1/messages", body, protocol: "anthropic_messages", stream: normalized.stream };
}

/** 鍒犻櫎 undefined 瀛楁锛屼繚鎸佷笂娓?JSON 骞插噣銆?*/
function pruneUndefined(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
}

/** 灏嗕笂娓稿搷搴旇В鏋愭垚 NormalizedResponse銆?*/
export function parseProviderResponse(provider: ProviderType, response: unknown): NormalizedResponse {
  const body = requireRecord(response, provider === "anthropic" ? "anthropic_messages" : "openai_responses");
  if (provider === "openai") {
    const content: ContentPart[] = [];
 if (typeof body.output_text === "string") {
 content.push({ type: "text", text: body.output_text });
 }
    let stopReason: string | null = typeof body.status === "string" ? body.status : null;
    if (Array.isArray(body.choices)) {
      const choice = body.choices.find((candidate) => isRecord(candidate)) as Record<string, unknown> | undefined;
      const message = choice && isRecord(choice.message) ? choice.message : undefined;
      if (message) {
        content.push(...normalizeTextContent(message.content ?? "", "openai_chat_completions"));
        if (Array.isArray(message.tool_calls)) {
          for (const toolCall of message.tool_calls) {
            if (isRecord(toolCall) && typeof toolCall.id === "string" && isRecord(toolCall.function) && typeof toolCall.function.name === "string") {
              const rawArguments = typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "{}";
              let parsedArguments: unknown = rawArguments;
              try {
                parsedArguments = JSON.parse(rawArguments);
              } catch {
                parsedArguments = rawArguments;
              }
              content.push({ type: "tool_call", id: toolCall.id, name: toolCall.function.name, arguments: parsedArguments });
            }
          }
        }
      }
      stopReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : stopReason;
    } else {
      const output = Array.isArray(body.output) ? body.output : [];
      for (const item of output) {
        if (!isRecord(item)) {
          continue;
        }
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
              content.push({ type: "text", text: part.text });
            }
            if (isRecord(part) && part.type === "refusal" && typeof part.refusal === "string") {
              content.push({ type: "text", text: part.refusal });
            }
          }
        }
        if ((item.type === "function_call" || item.type === "tool_call") && typeof item.call_id === "string" && typeof item.name === "string") {
          let parsedArguments: unknown = item.arguments ?? {};
          if (typeof parsedArguments === "string") {
            try {
              parsedArguments = JSON.parse(parsedArguments);
            } catch {
              // OpenAI-compatible providers sometimes return non-JSON arguments; preserve them rather than dropping the tool call.
            }
          }
          content.push({ type: "tool_call", id: item.call_id, name: item.name, arguments: parsedArguments });
        }
        if (item.type === "reasoning" && Array.isArray(item.summary)) {
          for (const summaryPart of item.summary) {
            if (isRecord(summaryPart) && typeof summaryPart.text === "string") {
              content.push({ type: "text", text: summaryPart.text });
            }
          }
        }
      }
    }
    return {
      provider,
      id: typeof body.id === "string" ? body.id : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      role: "assistant",
      content,
      stopReason,
      usage: normalizeOpenAIUsage(body.usage),
      raw: response
    };
  }

  const content = Array.isArray(body.content) ? body.content.flatMap((part) => normalizeAnthropicContentPart(part, "anthropic_messages")) : [];
  return {
    provider,
    id: typeof body.id === "string" ? body.id : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    role: "assistant",
    content,
    stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null,
    usage: normalizeAnthropicUsage(body.usage),
    raw: response
  };
}

/** 鍏煎 OpenAI Chat/Responses 鐨?usage 瀛楁宸紓銆?*/
function normalizeOpenAIUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  return { inputTokens, outputTokens, totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens && outputTokens ? inputTokens + outputTokens : undefined };
}

/** 瑙ｆ瀽 Anthropic usage銆?*/
function normalizeAnthropicUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  return { inputTokens, outputTokens, totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : undefined };
}

/** 灏嗙粺涓€ usage 娓叉煋鎴?OpenAI 椋庢牸 token 瀛楁銆?*/
/** 将标准响应内容渲染成 OpenAI Responses output item，避免把内部 ContentPart 形状直接暴露给客户端。 */
function renderResponsesOutput(id: string, content: ContentPart[]): unknown[] {
  const messageContent = content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => ({ type: "output_text", text: part.text }));
  const output: unknown[] = messageContent.length > 0 ? [{ id: id + "-msg", type: "message", role: "assistant", content: messageContent }] : [];
  for (const part of content) {
    if (part.type === "tool_call") {
      output.push({ id: part.id, type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
    }
    if (part.type === "tool_result") {
      output.push({ type: "function_call_output", call_id: part.toolCallId, output: renderText(part.content) });
    }
  }
  return output.length > 0 ? output : [{ id: id + "-msg", type: "message", role: "assistant", content: [] }];
}

/** 将供应商停止原因映射成 OpenAI finish_reason。 */
function finishReasonForOpenAI(stopReason: string | null | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  if (stopReason === "max_tokens" || stopReason === "length") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "content_filter") return "content_filter";
  return "stop";
}

/** 将供应商停止原因映射成 Anthropic stop_reason。 */
function stopReasonForAnthropic(stopReason: string | null | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  if (stopReason === "length") return "max_tokens";
  if (stopReason === "stop") return "end_turn";
  return stopReason ?? "end_turn";
}
function usageForOpenAI(usage?: Usage): Record<string, number> | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  };
}

/** 灏?NormalizedResponse 娓叉煋鍥炲叆鍙ｅ崗璁搷搴斻€?*/
export function renderInboundResponse(protocol: Protocol, normalized: NormalizedResponse): ClientResponse {
  const id = normalized.id ?? "gateway-response";
  const model = normalized.model ?? "gateway-model";
  if (protocol === "openai_completions") {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        id,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ text: renderText(normalized.content), index: 0, finish_reason: normalized.stopReason ?? "stop" }],
        usage: usageForOpenAI(normalized.usage)
      }
    };
  }
  if (protocol === "openai_chat_completions") {
    const toolCalls = normalized.content.filter((part): part is Extract<ContentPart, { type: "tool_call" }> => part.type === "tool_call");
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: renderText(normalized.content) || null,
            tool_calls: toolCalls.length > 0 ? toolCalls.map((part) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } })) : undefined
          },
          finish_reason: finishReasonForOpenAI(normalized.stopReason, toolCalls.length > 0)
        }],
        usage: usageForOpenAI(normalized.usage)
      }
    };
  }
  if (protocol === "openai_responses") {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model,
        output: renderResponsesOutput(id, normalized.content),
 output_text: renderText(normalized.content),
        usage: normalized.usage ? { input_tokens: normalized.usage.inputTokens ?? 0, output_tokens: normalized.usage.outputTokens ?? 0, total_tokens: normalized.usage.totalTokens ?? 0 } : undefined
      }
    };
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: renderAnthropicContent(normalized.content),
      stop_reason: stopReasonForAnthropic(normalized.stopReason, normalized.content.some((part) => part.type === "tool_call")),
      stop_sequence: null,
      usage: normalized.usage ? { input_tokens: normalized.usage.inputTokens ?? 0, output_tokens: normalized.usage.outputTokens ?? 0 } : undefined
    }
  };
}

/** 鍒涘缓 SSE 娴佸紡缈昏瘧鍣ㄣ€?*/
export function createStreamTranslator(inboundProtocol: Protocol, provider: ProviderConfig): StreamTranslator {
  return new BasicStreamTranslator(inboundProtocol, provider.type);
}

/** 鍩虹 SSE 缈昏瘧鍣紱璐熻矗鎶婁笂娓?SSE 琛岃浆鎹㈡垚涓嬫父鍏ュ彛鍗忚浜嬩欢銆?*/
class BasicStreamTranslator implements StreamTranslator {
  private readonly inboundProtocol: Protocol;
  private readonly provider: ProviderType;
  private anthropicTextStarted = false;
  private anthropicNextIndex = 0;
  private readonly anthropicToolIndexes = new Map<number, number>();
  private readonly openAIToolCallIds = new Map<number, string>();
  private readonly openAIToolCallNames = new Map<number, string>();
  private readonly openAIResponsesToolStarted = new Set<number>();

  constructor(inboundProtocol: Protocol, provider: ProviderType) {
    this.inboundProtocol = inboundProtocol;
    this.provider = provider;
  }

  translateLine(line: string): string[] {
    if (!line.startsWith("data:")) {
      return [line];
    }
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      return this.done();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [line];
    }
    if (!isRecord(parsed)) {
      return [];
    }
    return this.provider === "anthropic"
      ? this.translateAnthropicProviderEvent(parsed)
      : this.translateOpenAIProviderEvent(parsed);
  }

  finish(): string[] {
    return this.done();
  }

  /** 将 OpenAI Chat/Responses 风格流事件翻译成入口协议事件。 */
  private translateOpenAIProviderEvent(event: Record<string, unknown>): string[] {
    const lines: string[] = [];

    // Responses 原生流事件没有 choices.delta，需要先按事件 type 识别。
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      return this.renderTextDelta(event.delta);
    }
    if (event.type === "response.output_item.added" && isRecord(event.item)) {
      const item = event.item;
      if ((item.type === "function_call" || item.type === "tool_call") && (typeof item.call_id === "string" || typeof item.id === "string") && typeof item.name === "string") {
        const index = typeof event.output_index === "number" ? event.output_index : this.openAIToolCallIds.size;
        const id = typeof item.call_id === "string" ? item.call_id : item.id as string;
        this.openAIToolCallIds.set(index, id);
        this.openAIToolCallNames.set(index, item.name);
        lines.push(...this.renderToolDelta(index, id, item.name, undefined));
      }
    }
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const index = typeof event.output_index === "number" ? event.output_index : 0;
      const id = this.openAIToolCallIds.get(index) ?? (typeof event.item_id === "string" ? event.item_id : "call_" + index);
      const name = this.openAIToolCallNames.get(index) ?? "tool";
      lines.push(...this.renderToolDelta(index, id, name, event.delta));
    }
    if (event.type === "response.failed" || event.type === "response.cancelled" || isRecord(event.error)) {
      lines.push(...this.renderStreamError(event, event.type === "response.cancelled" ? "cancelled" : "stream_error"));
    }
    if (event.type === "response.completed") {
      lines.push(...this.done());
    }
    if (lines.length > 0) {
      return lines;
    }

    const choice = Array.isArray(event.choices) && isRecord(event.choices[0]) ? event.choices[0] : undefined;
    const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
    const text = delta && typeof delta.content === "string"
      ? delta.content
      : typeof event.delta === "string"
        ? event.delta
        : typeof event.output_text === "string"
          ? event.output_text
          : undefined;
    if (text) {
      lines.push(...this.renderTextDelta(text));
    }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const rawToolCall of delta.tool_calls) {
        if (!isRecord(rawToolCall)) {
          continue;
        }
        const index = typeof rawToolCall.index === "number" ? rawToolCall.index : 0;
        const id = typeof rawToolCall.id === "string" ? rawToolCall.id : this.openAIToolCallIds.get(index) ?? "call_" + index;
        const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {};
        const name = typeof fn.name === "string" ? fn.name : this.openAIToolCallNames.get(index) ?? "tool";
        const argsDelta = typeof fn.arguments === "string" ? fn.arguments : undefined;
        this.openAIToolCallIds.set(index, id);
        this.openAIToolCallNames.set(index, name);
        lines.push(...this.renderToolDelta(index, id, name, argsDelta));
      }
    }
    if (typeof choice?.finish_reason === "string") {
      lines.push(...this.done());
    }
    return lines;
  }
  /** 灏?Anthropic Messages 椋庢牸娴佷簨浠剁炕璇戞垚鍏ュ彛鍗忚浜嬩欢銆?*/
  private translateAnthropicProviderEvent(event: Record<string, unknown>): string[] {
    if (event.type === "error" || isRecord(event.error)) {
      return this.renderStreamError(event, "stream_error");
    }
    if (event.type === "content_block_delta" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        return this.renderTextDelta(event.delta.text);
      }
      if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        const index = typeof event.index === "number" ? event.index : 0;
        const id = this.openAIToolCallIds.get(index) ?? "tool_" + index;
        const name = this.openAIToolCallNames.get(index) ?? "tool";
        return this.renderToolDelta(index, id, name, event.delta.partial_json);
      }
    }
    if (event.type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "tool_use") {
      const tool = event.content_block;
      const index = typeof event.index === "number" ? event.index : 0;
      const id = typeof tool.id === "string" ? tool.id : "tool_" + index;
      const name = typeof tool.name === "string" ? tool.name : "tool";
      this.openAIToolCallIds.set(index, id);
      this.openAIToolCallNames.set(index, name);
      return this.renderToolDelta(index, id, name, undefined);
    }
    if (event.type === "message_stop") {
      return this.done();
    }
    return [];
  }

  /** 娓叉煋鏂囨湰澧為噺锛汚nthropic 鍗忚闇€瑕佸厛鍙戦€?content_block_start锛屽啀鍙戦€?delta銆?*/
  private renderTextDelta(text: string): string[] {
    if (this.inboundProtocol === "anthropic_messages") {
      const lines: string[] = [];
      if (!this.anthropicTextStarted) {
        this.anthropicTextStarted = true;
        lines.push("event: content_block_start", "data: " + JSON.stringify({ type: "content_block_start", index: this.anthropicNextIndex, content_block: { type: "text", text: "" } }));
      }
      lines.push("event: content_block_delta", "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
      return lines;
    }
    if (this.inboundProtocol === "openai_chat_completions") {
      return ["data: " + JSON.stringify({ choices: [{ delta: { content: text }, index: 0, finish_reason: null }] })];
    }
    if (this.inboundProtocol === "openai_completions") {
      return ["data: " + JSON.stringify({ choices: [{ text, index: 0, finish_reason: null }] })];
    }
    return ["event: response.output_text.delta", "data: " + JSON.stringify({ type: "response.output_text.delta", delta: text })];
  }

  /** 娓叉煋宸ュ叿璋冪敤澧為噺锛涘彧鏈?Anthropic 鍜?OpenAI Chat 鑳借緝鑷劧琛ㄨ揪宸ュ叿璋冪敤娴併€?*/
  private renderToolDelta(index: number, id: string, name: string, argsDelta: string | undefined): string[] {
    if (this.inboundProtocol === "anthropic_messages") {
      const lines: string[] = [];
      let blockIndex = this.anthropicToolIndexes.get(index);
      if (blockIndex === undefined) {
        blockIndex = this.anthropicNextIndex + this.anthropicToolIndexes.size + (this.anthropicTextStarted ? 1 : 0);
        this.anthropicToolIndexes.set(index, blockIndex);
        lines.push("event: content_block_start", "data: " + JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name, input: {} } }));
      }
      if (argsDelta) {
        lines.push("event: content_block_delta", "data: " + JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: argsDelta } }));
      }
      return lines;
    }
    if (this.inboundProtocol === "openai_chat_completions") {
      return ["data: " + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: argsDelta ?? "" } }] }, finish_reason: null }] })];
    }
    if (this.inboundProtocol === "openai_responses") {
      const lines: string[] = [];
      if (!this.openAIResponsesToolStarted.has(index)) {
        this.openAIResponsesToolStarted.add(index);
        this.openAIToolCallIds.set(index, id);
        this.openAIToolCallNames.set(index, name);
        lines.push("event: response.output_item.added", "data: " + JSON.stringify({ type: "response.output_item.added", output_index: index, item: { id, type: "function_call", call_id: id, name, arguments: "" } }));
      }
      if (argsDelta) {
        lines.push("event: response.function_call_arguments.delta", "data: " + JSON.stringify({ type: "response.function_call_arguments.delta", output_index: index, item_id: id, delta: argsDelta }));
      }
      return lines;
    }
    return [];
  }

  /** 从 OpenAI/Anthropic 流式错误事件里提取类型和消息。 */
  private streamErrorInfo(source: Record<string, unknown>, fallbackType: string): { type: string; message: string; code: string } {
    const response = isRecord(source.response) ? source.response : undefined;
    const error = isRecord(source.error) ? source.error : response && isRecord(response.error) ? response.error : undefined;
    const type = typeof error?.type === "string" ? error.type : typeof error?.code === "string" ? error.code : fallbackType;
    const code = typeof error?.code === "string" ? error.code : type;
    const message = typeof error?.message === "string"
      ? error.message
      : typeof source.message === "string"
        ? source.message
        : typeof response?.status === "string"
          ? "Stream ended with status: " + response.status
          : "Provider stream returned an error";
    return { type, message, code };
  }

  /** 按入口协议渲染流式错误事件，避免中途失败被静默吞掉。 */
  private renderStreamError(source: Record<string, unknown>, fallbackType: string): string[] {
    const error = this.streamErrorInfo(source, fallbackType);
    if (this.inboundProtocol === "anthropic_messages") {
      return ["event: error", "data: " + JSON.stringify({ type: "error", error: { type: error.type, message: error.message } })];
    }
    if (this.inboundProtocol === "openai_responses") {
      return ["event: response.failed", "data: " + JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: error.code, message: error.message } } })];
    }
    return ["data: " + JSON.stringify({ error: { message: error.message, type: error.type, code: error.code } })];
  }

  /** 娓叉煋缁撴潫浜嬩欢锛汚nthropic 闇€瑕佽ˉ content_block_stop锛孫penAI 椋庢牸鐢?[DONE]銆?*/
  private done(): string[] {
    if (this.inboundProtocol === "anthropic_messages") {
      const lines: string[] = [];
      if (this.anthropicTextStarted) {
        lines.push("event: content_block_stop", "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }));
      }
      for (const blockIndex of this.anthropicToolIndexes.values()) {
        lines.push("event: content_block_stop", "data: " + JSON.stringify({ type: "content_block_stop", index: blockIndex }));
      }
      lines.push("event: message_stop", "data: {\"type\":\"message_stop\"}");
      return lines;
    }
    if (this.inboundProtocol === "openai_responses") {
      return ["event: response.completed", "data: " + JSON.stringify({ type: "response.completed", response: { status: "completed" } })];
    }
    return ["data: [DONE]"];
  }
}

