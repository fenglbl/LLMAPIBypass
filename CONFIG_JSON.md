# config.json 字段说明

本文档说明网关的 JSON 配置文件格式。服务启动时，如果 CONFIG_PATH 指向 .json 文件，会使用 JSON 解析；否则默认按 YAML 解析。

## 启动方式

~~~bash
CONFIG_PATH=config.json npm start
~~~

Windows PowerShell 可使用：

~~~powershell
$env:CONFIG_PATH = "config.json"
npm start
~~~

## 完整示例

~~~json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "requestBodyLimitBytes": 1048576
  },
  "providers": [
    {
      "id": "openai-main",
      "type": "openai",
      "baseUrl": "https://api.openai.com",
      "timeoutMs": 60000,
      "retryCount": 1,
      "supportsStreaming": true,
      "supportsImages": true,
      "supportsTools": true
    },
    {
      "id": "anthropic-main",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "timeoutMs": 60000,
      "retryCount": 1,
      "supportsStreaming": true,
      "supportsImages": true,
      "supportsTools": true
    }
  ],
  "modelAliases": {
    "general-openai": {
      "provider": "openai-main",
      "model": "gpt-4.1",
      "targetProtocol": "openai_responses",
      "defaults": {
        "maxTokens": 1024
      }
    },
    "general-claude": {
      "provider": "anthropic-main",
      "model": "claude-sonnet-4-5",
      "targetProtocol": "anthropic_messages",
      "defaults": {
        "maxTokens": 1024
      }
    }
  }
}
~~~

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| server | object | 否 | HTTP 服务监听配置；未配置时使用默认值。 |
| providers | array | 是 | 后端供应商列表，目前支持 OpenAI 和 Anthropic。 |
| modelAliases | object | 是 | 业务模型别名映射表，客户端请求中的 model 会在这里解析到真实供应商和模型。 |

## server

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| host | string | 127.0.0.1 | 服务监听地址。内网部署可改为 0.0.0.0。 |
| port | number | 8787 | 服务监听端口。 |
| requestBodyLimitBytes | number | 1048576 | 单个请求体最大字节数，超过后返回 413。 |

示例：

~~~json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8787,
    "requestBodyLimitBytes": 2097152
  }
}
~~~

## providers

providers 是后端供应商数组。每个供应商描述一个可转发目标，例如 OpenAI 官方接口、Anthropic 官方接口，或后续扩展的兼容服务。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | string | 是 | 供应商唯一 ID，被 modelAliases.*.provider 引用。 |
| type | string | 是 | 供应商类型，目前支持 openai 或 anthropic。 |
| baseUrl | string | 是 | 供应商 API 根地址，不要带具体接口路径。 |
| timeoutMs | number | 否 | 请求超时时间，单位毫秒；未配置时默认 60000。 |
| retryCount | number | 否 | 供应商网络错误或 5xx 时的重试次数；不会自动换模型。 |
| supportsStreaming | boolean | 否 | 是否支持流式输出。配置为 false 时，流式请求会被显式拒绝。 |
| supportsImages | boolean | 否 | 是否支持图片输入。配置为 false 时，含图片请求会被显式拒绝。 |
| supportsTools | boolean | 否 | 是否支持工具调用。配置为 false 时，含工具请求会被显式拒绝。 |
| supportsTokenCounting | boolean | 否 | 是否支持真实 Anthropic `/v1/messages/count_tokens`。只有 `type: "anthropic"` 且该项为 true 时，计数接口会转发到上游；否则使用本地估算。 |

OpenAI 示例：

~~~json
{
  "id": "openai-main",
  "type": "openai",
  "baseUrl": "https://api.openai.com",
  "timeoutMs": 60000,
  "retryCount": 1,
  "supportsStreaming": true,
  "supportsImages": true,
  "supportsTools": true
}
~~~

Anthropic 示例：

~~~json
{
  "id": "anthropic-main",
  "type": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "timeoutMs": 60000,
  "retryCount": 1,
  "supportsStreaming": true,
  "supportsImages": true,
  "supportsTools": true
}
~~~

## modelAliases

modelAliases 是业务模型别名表。客户端请求中的 model 字段不需要是真实供应商模型名，而是这里定义的业务别名。

例如客户端传：

~~~json
{
  "model": "general-claude",
  "messages": []
}
~~~

网关会查找 modelAliases.general-claude，并转发到对应 provider 和真实 model。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| provider | string | 是 | 引用 providers 中的 id。 |
| model | string | 是 | 真实供应商模型名。 |
| targetProtocol | string | 是 | 转发到供应商时使用的目标协议。当前常用 openai_responses 或 anthropic_messages。 |
| defaults | object | 否 | 该别名的默认参数。客户端显式参数优先；当前支持 `maxTokens`、`temperature`、`topP/top_p`、`stop/stop_sequences`、`metadata`、`toolChoice/tool_choice`、`responseFormat/response_format`。 |

OpenAI Responses 后端别名：

~~~json
{
  "general-openai": {
    "provider": "openai-main",
    "model": "gpt-4.1",
    "targetProtocol": "openai_responses",
    "defaults": {
      "maxTokens": 1024
    }
  }
}
~~~

Anthropic Messages 后端别名：

~~~json
{
  "general-claude": {
    "provider": "anthropic-main",
    "model": "claude-sonnet-4-5",
    "targetProtocol": "anthropic_messages",
    "defaults": {
      "maxTokens": 1024
    }
  }
}
~~~

## targetProtocol 可选值

| 值 | 说明 | 允许的 provider.type |
| --- | --- | --- |
| openai_chat_completions | 后端请求渲染为 OpenAI Chat Completions API，适合 OpenAI-compatible 网关和 OpenCode。 | openai |
| openai_responses | 后端请求渲染为 OpenAI Responses API。 | openai |
| anthropic_messages | 后端请求渲染为 Anthropic Messages API。 | anthropic |

targetProtocol 描述的是“网关转发到真实上游时使用的协议”，不是客户端入口协议。客户端可以用 Anthropic 风格 `/v1/messages` 访问一个 OpenAI-compatible 上游，但该 alias 的 provider.type 仍应配置为 `openai`，targetProtocol 也应配置成真实上游支持的 `openai_chat_completions` 或 `openai_responses`。

虽然核心类型中也定义了 openai_completions 作为入口协议，但第一版后端转发目标建议按后端实际能力选择：OpenAI-compatible 服务通常用 openai_chat_completions，OpenAI 官方新接口可用 openai_responses，Anthropic 官方接口用 anthropic_messages。

## 启动期配置校验

服务启动加载配置时会做一轮硬校验；失败时会抛出 `Configuration error: ...`，服务不会继续以错误配置运行。

当前会校验：

| 校验项 | 规则 |
| --- | --- |
| server | 必须是 object；host 必须是非空 string；port 和 requestBodyLimitBytes 必须是 number。 |
| providers | 必须是非空 array；每项必须是 object。 |
| providers.*.id | 必须是非空 string，且不能重复。 |
| providers.*.type | 只能是 openai 或 anthropic。 |
| providers.*.baseUrl | 必须是非空 string，且只写根地址。 |
| providers.*.timeoutMs / retryCount | 如果配置，必须是 number。 |
| providers.*.supportsStreaming / supportsImages / supportsTools / supportsTokenCounting | 如果配置，必须是 boolean，不能写成字符串 "true" 或 "false"。 |
| modelAliases | 必须是 object。 |
| modelAliases.*.provider | 必须引用 providers 中存在的 id。 |
| modelAliases.*.model | 必须是非空 string。 |
| modelAliases.*.targetProtocol | 必须是受支持的目标协议，并且要和 provider.type 匹配。 |
| modelAliases.*.defaults | 如果配置，必须是 object。 |

协议匹配规则：

| provider.type | 允许的 targetProtocol |
| --- | --- |
| openai | openai_chat_completions、openai_responses |
| anthropic | anthropic_messages |

例如，你现在用 Anthropic 客户端接入 `/v1/messages`，但真实上游是 OpenAI-compatible 的 `codeapi`，配置应类似：

~~~json
{
  "providers": [
    {
      "id": "codeapi",
      "type": "openai",
      "baseUrl": "https://codeapi.example.com",
      "supportsStreaming": true,
      "supportsImages": true,
      "supportsTools": true
    }
  ],
  "modelAliases": {
    "claude-opus-4-8": {
      "provider": "codeapi",
      "model": "gpt-5.5",
      "targetProtocol": "openai_chat_completions",
      "defaults": {
        "maxTokens": 1024
      }
    }
  }
}
~~~

这里的 alias 可以叫 `claude-opus-4-8`，因为它是客户端看到的业务模型名；但 provider.type 和 targetProtocol 必须描述真实上游，也就是 OpenAI-compatible。

## 密钥透传规则

第一版按内网可信代理设计，不做网关自己的 API Key、用户体系、限流或配额。客户端传来的供应商 Key 会按目标供应商格式透传：

| 入口协议 | 客户端传入 | 转发到 OpenAI | 转发到 Anthropic |
| --- | --- | --- | --- |
| OpenAI 风格接口 | Authorization: Bearer xxx | Authorization: Bearer xxx | x-api-key: xxx |
| Anthropic 风格接口 | x-api-key: xxx | Authorization: Bearer xxx | x-api-key: xxx |

## 常见配置组合

只接 OpenAI 后端：

~~~json
{
  "providers": [
    {
      "id": "openai-main",
      "type": "openai",
      "baseUrl": "https://api.openai.com"
    }
  ],
  "modelAliases": {
    "default": {
      "provider": "openai-main",
      "model": "gpt-4.1",
      "targetProtocol": "openai_responses"
    }
  }
}
~~~

只接 Anthropic 后端：

~~~json
{
  "providers": [
    {
      "id": "anthropic-main",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com"
    }
  ],
  "modelAliases": {
    "default": {
      "provider": "anthropic-main",
      "model": "claude-sonnet-4-5",
      "targetProtocol": "anthropic_messages"
    }
  }
}
~~~


## 协议能力矩阵

| 能力 / 字段 | OpenAI 上游 | Anthropic 上游 | 策略 |
| --- | --- | --- | --- |
| 文本输入输出 | 支持 | 支持 | 双向转换。 |
| 图片输入 | 支持 URL 或 data URL | 仅可靠支持 base64 | 转 Anthropic 时如果没有 base64 会显式报错。 |
| function tools | 支持 | 支持 | OpenAI `tools/function` 与 Anthropic `tools/input_schema` 双向转换。 |
| OpenAI Responses native tools | 仅 OpenAI Responses | 不支持 | 只允许转发到 OpenAI Responses；跨协议显式报错。 |
| tool_choice | 支持 | 支持 | `auto/none/required/any` 与指定工具名会按目标协议改形状。 |
| response_format | 支持 | 无等价字段 | 转 OpenAI 上游透传；转 Anthropic 显式报错。 |
| stop / stop_sequences | 支持 | 支持 | 按目标协议字段名渲染。 |
| usage | 支持 | 支持 | 映射为入口协议的 usage 字段。 |
| 流式文本 | 支持 | 支持 | SSE 事件按入口协议转换，并补起始/结束事件。 |
| 流式工具调用 | 支持 | 支持 | 保留 tool/function call id 与参数增量。 |
| `/v1/messages/count_tokens` | 无统一真实接口 | 可选真实接口 | Anthropic provider 配 `supportsTokenCounting: true` 时转发，否则本地估算。 |
| 旧 Completions `logprobs/echo/best_of/suffix` | 不可靠 | 不可靠 | 显式拒绝，不静默忽略。 |
## 注意事项

- JSON 不支持注释，也不允许尾随逗号。
- `config.json` 通常包含本地上游地址或模型别名，已建议放入 `.gitignore`；公开仓库请提交 `config.example.json`。
- baseUrl 只写根地址，例如 https://api.openai.com，不要写 /v1/responses。
- provider 的 id 必须唯一。
- modelAliases 中的 provider 必须能在 providers 中找到。
- modelAliases.*.targetProtocol 必须和真实 provider.type 匹配；客户端入口协议不影响这里的配置。
- 客户端请求里的 model 必须是 modelAliases 中配置过的别名。
- retryCount 只做同一供应商、同一模型的有限重试，不会自动切换模型。
- 如果公网部署，建议后续补充网关鉴权、限流、配额和密钥隔离。
