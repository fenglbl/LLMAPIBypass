/**
 * 配置加载和模型别名解析。
 *
 * 客户端传业务别名，网关通过 modelAliases 解析到真实 provider、真实模型名和目标协议。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { badRequest } from "./errors.ts";
import type { GatewayConfig, ModelAliasConfig, Protocol, ProviderConfig, ProviderType, ResolvedProviderConfig } from "./types.ts";

/** 将轻量 YAML 里的简单标量解析成 boolean/null/number/string。 */
function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, "");
}

/** 统计 YAML 缩进，用于识别层级。 */
function countIndent(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

/** 去掉 YAML 注释；仅用于简单示例配置。 */
function stripComment(line: string): string {
  const index = line.indexOf("#");
  return index >= 0 ? line.slice(0, index) : line;
}

/** 解析项目示例 YAML；复杂配置建议使用 config.json。 */
export function parseYaml(input: string): unknown {
  const lines = input.split(/\r?\n/).map(stripComment).filter((line) => line.trim().length > 0);
  const result: Record<string, unknown> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (countIndent(line) !== 0) {
      index += 1;
      continue;
    }
    const key = line.trim().replace(/:$/, "");
    index += 1;

    if (key === "server") {
      const server: Record<string, unknown> = {};
      while (index < lines.length && countIndent(lines[index]) === 2) {
        const [field, ...rest] = lines[index].trim().split(":");
        server[field] = scalar(rest.join(":").trim());
        index += 1;
      }
      result.server = server;
      continue;
    }

    if (key === "providers") {
      const providers: ProviderConfig[] = [];
      while (index < lines.length && countIndent(lines[index]) >= 2) {
        const lineText = lines[index].trim();
        if (!lineText.startsWith("- ")) {
          index += 1;
          continue;
        }
        const provider: Record<string, unknown> = {};
        const first = lineText.slice(2);
        const [firstKey, ...firstRest] = first.split(":");
        provider[firstKey] = scalar(firstRest.join(":").trim());
        index += 1;
        while (index < lines.length && countIndent(lines[index]) === 4) {
          const [field, ...rest] = lines[index].trim().split(":");
          provider[field] = scalar(rest.join(":").trim());
          index += 1;
        }
        providers.push(provider as unknown as ProviderConfig);
      }
      result.providers = providers;
      continue;
    }

    if (key === "modelAliases") {
      const aliases: Record<string, ModelAliasConfig> = {};
      while (index < lines.length && countIndent(lines[index]) >= 2) {
        if (countIndent(lines[index]) !== 2 || !lines[index].trim().endsWith(":")) {
          index += 1;
          continue;
        }
        const aliasName = lines[index].trim().slice(0, -1);
        const alias: Record<string, unknown> = {};
        index += 1;
        while (index < lines.length && countIndent(lines[index]) >= 4) {
          const currentIndent = countIndent(lines[index]);
          const [field, ...rest] = lines[index].trim().split(":");
          if (field === "defaults" && rest.join(":").trim() === "") {
            const defaults: Record<string, unknown> = {};
            index += 1;
            while (index < lines.length && countIndent(lines[index]) === 6) {
              const [defaultField, ...defaultRest] = lines[index].trim().split(":");
              defaults[defaultField] = scalar(defaultRest.join(":").trim());
              index += 1;
            }
            alias.defaults = defaults;
            continue;
          }
          if (currentIndent === 4) {
            alias[field] = scalar(rest.join(":").trim());
          }
          index += 1;
        }
        aliases[aliasName] = alias as unknown as ModelAliasConfig;
      }
      result.modelAliases = aliases;
    }
  }

  return result;
}

/** 判断运行时值是否是普通对象，配置文件解析后先用它做安全访问。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 配置错误统一加前缀，启动失败时能和普通请求错误区分开。 */
function configError(message: string): never {
  badRequest(undefined, "Configuration error: " + message);
}

/** provider.type 只允许当前内置的两类真实上游。 */
function isProviderType(value: unknown): value is ProviderType {
  return value === "openai" || value === "anthropic";
}

/** targetProtocol 只允许核心转换层已经声明支持的协议。 */
function isProtocol(value: unknown): value is Protocol {
  return value === "openai_completions"
    || value === "openai_chat_completions"
    || value === "openai_responses"
    || value === "anthropic_messages";
}

/** 检查可选数字字段，避免配置里把超时或重试写成字符串后悄悄失效。 */
function assertOptionalNumber(record: Record<string, unknown>, field: string, owner: string): void {
  if (field in record && typeof record[field] !== "number") {
    configError(owner + "." + field + " must be a number");
  }
}

/** 检查可选布尔能力开关，避免字符串 true/false 被误当成开启。 */
function assertOptionalBoolean(record: Record<string, unknown>, field: string, owner: string): void {
  if (field in record && typeof record[field] !== "boolean") {
    configError(owner + "." + field + " must be a boolean");
  }
}

/** 上游 provider 类型必须能表达 alias 指定的目标协议。 */
function providerCanUseTargetProtocol(providerType: ProviderType, targetProtocol: Protocol): boolean {
  return providerType === "anthropic" ? targetProtocol === "anthropic_messages" : targetProtocol !== "anthropic_messages";
}

/** 启动期完整校验 provider 与 modelAliases 的引用和协议匹配关系。 */
function validateConfig(config: GatewayConfig): void {
  if (!isRecord(config.server)) {
    configError("server must be an object");
  }
  if (typeof config.server.host !== "string" || config.server.host.length === 0) {
    configError("server.host must be a non-empty string");
  }
  if (typeof config.server.port !== "number") {
    configError("server.port must be a number");
  }
  if (typeof config.server.requestBodyLimitBytes !== "number") {
    configError("server.requestBodyLimitBytes must be a number");
  }

  const providersById = new Map<string, ProviderConfig>();
  for (const [index, provider] of config.providers.entries()) {
    const owner = "providers[" + index + "]";
    if (!isRecord(provider)) {
      configError(owner + " must be an object");
    }
    if (typeof provider.id !== "string" || provider.id.length === 0) {
      configError(owner + ".id must be a non-empty string");
    }
    if (providersById.has(provider.id)) {
      configError("Duplicate provider id: " + provider.id);
    }
    if (!isProviderType(provider.type)) {
      configError(owner + ".type must be openai or anthropic");
    }
    if (typeof provider.baseUrl !== "string" || provider.baseUrl.length === 0) {
      configError(owner + ".baseUrl must be a non-empty string");
    }
    assertOptionalNumber(provider, "timeoutMs", owner);
    assertOptionalNumber(provider, "retryCount", owner);
    assertOptionalBoolean(provider, "supportsStreaming", owner);
    assertOptionalBoolean(provider, "supportsImages", owner);
    assertOptionalBoolean(provider, "supportsTools", owner);
    assertOptionalBoolean(provider, "supportsTokenCounting", owner);
    providersById.set(provider.id, provider);
  }

  for (const [aliasName, alias] of Object.entries(config.modelAliases)) {
    const owner = "modelAliases." + aliasName;
    if (!isRecord(alias)) {
      configError(owner + " must be an object");
    }
    if (typeof alias.provider !== "string" || alias.provider.length === 0) {
      configError(owner + ".provider must be a non-empty string");
    }
    if (typeof alias.model !== "string" || alias.model.length === 0) {
      configError(owner + ".model must be a non-empty string");
    }
    if (!isProtocol(alias.targetProtocol)) {
      configError(owner + ".targetProtocol is not supported");
    }
    const provider = providersById.get(alias.provider);
    if (!provider) {
      configError(owner + " references missing provider: " + alias.provider);
    }
    if (!providerCanUseTargetProtocol(provider.type, alias.targetProtocol)) {
      configError(owner + ".targetProtocol " + alias.targetProtocol + " is incompatible with provider " + provider.id + " type " + provider.type);
    }
    if (alias.defaults !== undefined && !isRecord(alias.defaults)) {
      configError(owner + ".defaults must be an object");
    }
  }
}

/** 填充 server 默认值并做基础结构校验。 */
function assertConfig(value: unknown): GatewayConfig {
  if (!isRecord(value)) {
    badRequest(undefined, "Configuration must be an object");
  }
  const config = value as unknown as GatewayConfig;
  if (config.server === undefined || config.server === null) {
    config.server = { host: "127.0.0.1", port: 8787, requestBodyLimitBytes: 1048576 };
  }
  if (!isRecord(config.server)) {
    configError("server must be an object");
  }
  config.server.host ??= "127.0.0.1";
  config.server.port ??= 8787;
  config.server.requestBodyLimitBytes ??= 1048576;
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    badRequest(undefined, "Configuration requires providers[]");
  }
  if (!isRecord(config.modelAliases)) {
    badRequest(undefined, "Configuration requires modelAliases");
  }
  validateConfig(config);
  return config;
}

/** 从 CONFIG_PATH 或默认配置文件加载网关配置。 */
export async function loadConfig(configPath = process.env.CONFIG_PATH ?? "config.example.yaml"): Promise<GatewayConfig> {
  const absolutePath = resolve(configPath);
  const text = await readFile(absolutePath, "utf8");
  const parsed = configPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return assertConfig(parsed);
}

/** 根据模型别名解析目标供应商、真实模型和目标协议。 */
export function resolveProvider(config: GatewayConfig, modelAlias: string): ResolvedProviderConfig {
  const alias = config.modelAliases[modelAlias];
  if (!alias) {
    badRequest(undefined, "Unknown model alias: " + modelAlias);
  }
  const provider = config.providers.find((candidate) => candidate.id === alias.provider);
  if (!provider) {
    badRequest(undefined, "Model alias references missing provider: " + alias.provider);
  }
  return { ...provider, model: alias.model, targetProtocol: alias.targetProtocol, defaults: alias.defaults };
}
