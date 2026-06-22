/**
 * 统一错误模型。
 *
 * 内部统一抛 GatewayError，最后按入口协议渲染成 OpenAI 或 Anthropic 风格错误。
 */
import type { Protocol } from "./types.ts";

/** 带 HTTP 状态码和网关错误码的业务异常。 */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly protocol?: Protocol;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, options: { protocol?: Protocol; details?: unknown } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.protocol = options.protocol;
    this.details = options.details;
  }
}

/** 当前协议或目标供应商无法可靠表达该能力时使用。 */
export function unsupported(protocol: Protocol, message: string, details?: unknown): never {
  throw new GatewayError(400, "unsupported_feature", message, { protocol, details });
}

/** 客户端请求结构不合法时使用。 */
export function badRequest(protocol: Protocol | undefined, message: string, details?: unknown): never {
  throw new GatewayError(400, "bad_request", message, { protocol, details });
}

/** 按入口协议包装错误 envelope。 */
export function renderError(error: unknown, protocol?: Protocol) {
  const gatewayError = error instanceof GatewayError
    ? error
    : new GatewayError(500, "internal_error", error instanceof Error ? error.message : "Internal gateway error", { protocol });

  if (protocol === "anthropic_messages") {
    return {
      status: gatewayError.status,
      body: {
        type: "error",
        error: {
          type: gatewayError.code,
          message: gatewayError.message
        }
      }
    };
  }

  return {
    status: gatewayError.status,
    body: {
      error: {
        message: gatewayError.message,
        type: gatewayError.code,
        code: gatewayError.code
      }
    }
  };
}
