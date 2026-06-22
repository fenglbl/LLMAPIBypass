# 排错手册

本文档按常见报错关键字整理排查步骤。优先看网关日志里的 `protocol`、`provider`、`providerType`、`modelAlias`、`model`、`status`、`errorType` 和 `message`，不要把 prompt、response 正文或 key 写进日志。

## 快速定位流程

1. 先确认客户端请求打到的地址是 `http://127.0.0.1:8787/v1`，不是具体接口路径。
2. 确认客户端传的 `model` 是 `config.json` 里的业务 alias。
3. 看日志里的 `modelAlias` 和 `model`：前者是客户端看到的别名，后者是真实上游模型。
4. 看日志里的 `providerType` 和 `targetProtocol` 配置是否描述真实上游，而不是描述客户端。
5. 如果是流式问题，先看是否有 `event: error`、`event: response.failed` 或 OpenAI error envelope。

## Invalid token / 401

典型日志：

~~~text
status: 401
errorType: provider_error
message: Invalid token
~~~

含义：真实上游拒绝了客户端透传的 key。通常不是协议转换问题。

检查点：

- OpenAI 风格入口是否传了 `Authorization: Bearer xxx`。
- Anthropic 风格入口是否传了 `x-api-key: xxx`。
- 如果 Anthropic 客户端接 OpenAI-compatible 上游，网关会把 `x-api-key` 转成 `Authorization: Bearer xxx`。
- key 是否属于当前上游服务、分组或渠道。
- key 前面是否重复写了 `Bearer Bearer`；网关会清理一个 Bearer 前缀，但客户端仍建议只传标准格式。

处理方式：

- 换一个确认可用的上游 key。
- 用最小请求直接打真实上游验证 key。
- 确认 `config.json` 的 `providers.*.baseUrl` 指向正确服务。

## model_not_found / No available channel for model

典型日志：

~~~text
code: model_not_found
message: No available channel for model gpt-5.5
~~~

含义：网关已经把请求转到了上游，但上游账号、分组或渠道没有这个真实模型。

检查点：

- 客户端传的是 alias，例如 `gpt-5.5`、`claude-opus-4-8`。
- `config.json` 里 `modelAliases.<alias>.model` 是否是上游真正支持的模型。
- 上游服务是否要求使用另一个模型名，例如 `mimo-v2.5`。
- 日志里的 `modelAlias` 和 `model` 是否符合预期。

处理方式：

- 修改 `modelAliases.<alias>.model` 为上游实际可用模型。
- 不需要改客户端模型名，除非你想换业务 alias。
- 修改配置后重启网关。

## Anthropic messages only support user and assistant roles

含义：Anthropic 客户端回放的历史里出现了系统消息或工具消息形态不符合入口协议。当前网关已经兼容 `system` role 和 `tool` role 回放，但旧版本或异常客户端 payload 仍可能触发。

检查点：

- 客户端发送到 `/v1/messages` 的 `messages` 里是否有非 `user`、`assistant`、`system`、`tool` 的 role。
- system 提示是否也可放在 Anthropic 标准的顶层 `system` 字段。
- tool 结果是否有 `tool_call_id` 或 `tool_use_id`。

处理方式：

- 升级到当前网关代码后重试。
- 保证工具结果消息带上对应的调用 id。
- 如果还有新 role，把请求体样例脱敏后加入测试集。

## Unsupported Anthropic content part type: thinking

含义：Anthropic/Claude 客户端回放了 `thinking` 或 `redacted_thinking` 内容块。当前网关会接收并丢弃这类私有思考块，不会转发上游。

处理方式：

- 升级到当前网关代码。
- 如果客户端还发送新的私有块类型，按同样策略评估：能安全丢弃就丢弃，不能表达就显式报错。

## No tool output found for function call

典型报错：

~~~text
No tool output found for function call call_xxx
~~~

含义：OpenAI-compatible 上游看到 assistant 的 `tool_calls` 后，后续历史里没有对应 `tool` 结果消息。

检查点：

- Anthropic `tool_result.tool_use_id` 是否等于之前 `tool_use.id`。
- OpenAI `tool` message 的 `tool_call_id` 是否等于之前 `tool_calls[].id`。
- 是否一次 assistant 返回多个工具调用，但只回填了其中一个结果。
- 日志里失败请求是否发生在工具调用后的第二轮。

处理方式：

- 确保客户端把每个工具调用结果都带回网关。
- 当前网关会把每个 Anthropic `tool_result` 渲染成独立 OpenAI `tool` message，保留调用 id。
- 如果仍失败，抓取脱敏后的 messages 顺序，重点看 assistant tool_use 后是否紧跟对应结果。

## Tool definition requires a name

含义：工具定义不是标准 function tool，或者原生工具发到了不能表达它的入口/上游组合。

常见场景：

- OpenAI Responses 原生工具：`{ "type": "web_search_preview" }`。
- OpenAI Chat Completions function tool 缺少 `function.name`。
- Anthropic tool 缺少 `name`。

处理方式：

- function tool 必须带 `name` 和 schema。
- Responses native tool 只能转发到 `targetProtocol: "openai_responses"` 的 OpenAI 上游。
- 如果真实上游是 `openai_chat_completions` 或 `anthropic_messages`，网关会明确报 native tool 不能跨协议转换。

## OpenAI Responses native tools can only be forwarded

含义：客户端发送了 `web_search_preview` 这类 Responses native tool，但当前 alias 路由到 Chat Completions 或 Anthropic Messages 上游。

处理方式：

- 如果上游支持 Responses API，把 alias 改成 `targetProtocol: "openai_responses"`。
- 如果上游只支持 Chat Completions，关闭客户端里的 Responses native tools。
- 不要把 `web_search_preview` 伪装成 function tool；它不是普通函数工具。

## Configuration error

含义：服务启动时配置硬校验失败，网关不会继续运行。

常见原因：

- `providers.*.id` 重复。
- `modelAliases.*.provider` 引用了不存在的 provider。
- `provider.type` 和 `targetProtocol` 不匹配。
- `supportsStreaming`、`supportsImages`、`supportsTools` 写成了字符串 `true` 或 `"false"`，而不是 boolean。
- `server.port`、`timeoutMs`、`retryCount` 写成了字符串。

处理方式：

- 对照 `CONFIG_JSON.md` 的启动期配置校验章节修改。
- Anthropic 客户端入口不等于 Anthropic 上游；真实上游是 OpenAI-compatible 时，provider.type 应写 `openai`。
- 修改配置后重启服务。

## Selected provider does not support streaming/images/tools

含义：请求使用了流式、图片或工具能力，但当前 provider 显式声明不支持。

检查点：

- `providers.*.supportsStreaming` 是否为 `false`。
- `providers.*.supportsImages` 是否为 `false`。
- `providers.*.supportsTools` 是否为 `false`。
- 客户端是否默认开启了 stream、图片输入或工具调用。

处理方式：

- 如果上游实际支持，把对应能力改成 `true` 或删除该字段。
- 如果上游不支持，关闭客户端对应能力。
- 能力开关必须是 boolean，不能写成字符串。

## Responses output_text 为空

现象：

~~~json
{ "output": [{ "content": [] }], "output_text": "" }
~~~

含义：OpenAI-compatible 上游返回的结构可能不是标准 Responses 内容数组，或者文本放在兼容字段里。当前网关已兼容 `output_text`、Responses `output[].content[]` 和 Chat Completions `choices[].message.content`。

处理方式：

- 升级到当前网关代码。
- 用 live test 验证：`node --test test/live-responses.test.ts`。
- 如果仍为空，保存脱敏后的上游响应结构，加到 `parseProviderResponse` 测试里。

## 流式中途断开 / response.failed / event: error

含义：上游 SSE 中途返回错误事件，或连接读取过程中断开。当前网关会按入口协议输出错误事件：

- Anthropic 入口：`event: error`。
- OpenAI Responses 入口：`event: response.failed`。
- OpenAI Chat/Completions 入口：`data: {"error": ...}`。

检查点：

- 上游是否超时、限流或主动断开连接。
- `timeoutMs` 是否过短。
- 客户端是否正确消费 SSE，而不是只读第一段。
- 日志里是否出现 `gateway_error` 或 provider error。

处理方式：

- 增大 `timeoutMs`。
- 检查上游限流、模型渠道和网络稳定性。
- 如果是 provider 原生错误，优先处理上游返回的 code/message。

## /v1/models 相关问题

现象：客户端启动时先请求模型列表。

说明：

- `GET /v1/models` 返回的是 `modelAliases` 的业务 alias。
- `GET /v1/models/:id` 也只接受业务 alias。
- 网关不会暴露真实上游模型名。
- 返回格式会根据请求头偏向 OpenAI 或 Anthropic 风格。

处理方式：

- 客户端里填写的 model 应该是 alias，例如 `claude-opus-4-8` 或 `gpt-5.5`。
- alias 对应的真实模型在 `modelAliases.<alias>.model` 中配置。

## live test 排查

Responses live test：

~~~powershell
$env:RUN_LIVE_RESPONSES_TEST = "1"
$env:TEST_API_KEY = "你的真实上游 Key"
$env:TEST_GATEWAY_URL = "http://127.0.0.1:8787"
$env:TEST_MODEL_ALIAS = "gpt-5.5"
node --test test/live-responses.test.ts
~~~

Anthropic Messages live test：

~~~powershell
$env:RUN_LIVE_ANTHROPIC_TEST = "1"
$env:TEST_API_KEY = "你的真实上游 Key"
$env:TEST_GATEWAY_URL = "http://127.0.0.1:8787"
$env:TEST_ANTHROPIC_MODEL_ALIAS = "claude-opus-4-8"
node --test test/live-anthropic-messages.test.ts
~~~

## 需要新增测试时

如果遇到新问题，优先补一个最小复现测试：

- 协议转换问题：加到 `test/core.test.ts`。
- 真实上游兼容问题：先用 live test 确认，再把脱敏响应结构做成 mocked test。
- 配置问题：用临时 JSON 文件测试 `loadConfig`。
- 流式问题：直接测试 `createStreamTranslator` 或用模拟 HTTP provider。
