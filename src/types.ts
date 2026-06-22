/**
 * 全局类型定义文件。
 *
 * 这里定义协议转换网关的“中间语言”：入口请求先转成 NormalizedRequest，
 * 上游响应再转成 NormalizedResponse，最后按下游协议渲染。
 */
/** 支持的入口/目标协议；路由层和转换层依赖它选择解析与渲染策略。 */
export type Protocol =
  | "openai_completions"
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages";

/** 真实上游供应商类型；OpenAI 兼容中转商也归入 openai。 */
export type ProviderType = "openai" | "anthropic";
/** 统一消息角色；tool 用于承载工具结果回填。 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 统一内容块：文本、图片、工具调用和工具结果都收敛到这个结构。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType?: string; url?: string; base64?: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; toolCallId: string; content: ContentPart[]; isError?: boolean };

/** 统一消息结构；一条消息可以包含多个不同类型的内容块。 */
export interface NormalizedMessage {
  role: Role;
  content: ContentPart[];
  name?: string;
}

/** 工具定义：function 可跨协议转换，native 是 OpenAI Responses 原生工具，只能在 Responses 上游透传。 */
export type ToolDefinition =
  | { kind: "function"; name: string; description?: string; inputSchema: Record<string, unknown> }
  | { kind: "native"; nativeType: string; raw: Record<string, unknown> };

/** 统一 token 用量；不同供应商字段名不同，解析后统一到这里。 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** 入口请求标准形态；original/extensions 用于内部保留上下文，但不会盲目转发。 */
export interface NormalizedRequest {
  protocol: Protocol;
  endpoint: string;
  modelAlias: string;
  stream: boolean;
  messages: NormalizedMessage[];
  tools?: ToolDefinition[];
  toolChoice?: unknown;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  metadata?: Record<string, unknown>;
  responseFormat?: unknown;
  original: unknown;
  extensions: Record<string, unknown>;
}

/** 上游响应标准形态；所有入口协议最终都从这里渲染回客户端。 */
export interface NormalizedResponse {
  provider: ProviderType;
  id?: string;
  model?: string;
  role: "assistant";
  content: ContentPart[];
  stopReason?: string | null;
  usage?: Usage;
  raw: unknown;
}

/** 上游供应商配置；描述 baseUrl、超时、重试和能力开关。 */
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  baseUrl: string;
  timeoutMs?: number;
  retryCount?: number;
  supportsStreaming?: boolean;
  supportsImages?: boolean;
  supportsTools?: boolean;
  supportsTokenCounting?: boolean;
}

/** model alias 解析后的供应商配置，包含真实模型名和目标协议。 */
export interface ResolvedProviderConfig extends ProviderConfig {
  model: string;
  targetProtocol: Protocol;
  defaults?: Record<string, unknown>;
}

/** 业务模型别名配置；客户端只看到 alias，不需要知道真实上游模型名。 */
export interface ModelAliasConfig {
  provider: string;
  model: string;
  targetProtocol: Protocol;
  defaults?: Record<string, unknown>;
}

/** 网关完整配置；当前通过静态 JSON/YAML 文件加载，修改后重启生效。 */
export interface GatewayConfig {
  server: {
    host: string;
    port: number;
    requestBodyLimitBytes: number;
  };
  providers: ProviderConfig[];
  modelAliases: Record<string, ModelAliasConfig>;
}

/** 渲染后的上游请求；HTTP 层只负责发送这个结构。 */
export interface ProviderRequest {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  protocol: Protocol;
  stream: boolean;
}

/** 渲染后的下游响应；按入口协议返回 OpenAI 或 Anthropic 兼容结构。 */
export interface ClientResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** SSE 流式事件翻译器接口。 */
export interface StreamTranslator {
  translateLine(line: string): string[];
  finish(): string[];
}
