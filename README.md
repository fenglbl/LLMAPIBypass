# LLM API Bypass

一个 Node.js/TypeScript 大模型 API 协议转换网关，用来在 OpenAI 风格接口、OpenAI Responses、Anthropic Messages 和 OpenAI-compatible 上游之间做协议转换。

当前定位是内网可信代理：客户端仍然传真实供应商 Key，网关只做协议转换、模型别名路由、错误映射和元数据日志，不做独立鉴权、限流或配额。

## 当前能力

- OpenAI 风格入口：`/v1/completions`、`/v1/chat/completions`、`/v1/responses`。
- Anthropic 风格入口：`/v1/messages`。
- 模型列表入口：`/v1/models` 和 `/v1/models/:id`，只暴露业务 alias。
- Anthropic 辅助入口：`POST /v1/messages/count_tokens`，返回本地估算的 `input_tokens`，方便 Anthropic 客户端做上下文预算。
- 健康检查：`/healthz`。
- 支持文本、图片、function tools、tool_use/tool_result、usage 映射、SSE 流式文本和工具调用事件。
- 支持 OpenAI Responses 原生工具透传到 Responses 上游；不能跨协议表达的 native tool 会明确报错。
- 支持流式错误事件映射；上游中途报错或网关读流失败时，会按入口协议返回可读错误事件。

## 安装与启动

安装依赖：

~~~bash
npm install
~~~

首次使用时可以从公开示例复制一份本地配置：

~~~bash
cp config.example.json config.json
~~~

Windows PowerShell：

~~~powershell
Copy-Item config.example.json config.json
~~~

使用 JSON 配置启动：

~~~bash
CONFIG_PATH=config.json npm start
~~~

Windows PowerShell：

~~~powershell
$env:CONFIG_PATH = "config.json"
npm start
~~~

默认监听配置来自本地 `config.json`；仓库里提供 `config.example.json` 和 `config.example.yaml` 作为公开示例。通常监听：

~~~text
http://127.0.0.1:8787/v1
~~~

## 客户端接入

OpenAI 风格客户端：

~~~text
baseURL: http://127.0.0.1:8787/v1
apiKey: 真实上游 Key
model: config.json 里的业务 alias，例如 gpt-5.5 或 mimo
~~~

Anthropic 风格客户端：

~~~text
baseURL: http://127.0.0.1:8787/v1
apiKey: 真实上游 Key
model: config.json 里的业务 alias，例如 claude-opus-4-8
~~~

密钥透传规则：OpenAI 风格入口读取 `Authorization: Bearer ...`，Anthropic 风格入口读取 `x-api-key`。转发到真实上游时，网关会按 provider 类型转换成对应鉴权头。

## 配置要点

详细字段说明见 `CONFIG_JSON.md`。最重要的是区分两个概念：

- 客户端入口协议：客户端请求打到 `/v1/messages`、`/v1/chat/completions` 或 `/v1/responses`。
- 上游目标协议：`modelAliases.*.targetProtocol`，表示网关转发到真实 provider 时使用什么协议。

如果你用 Anthropic 客户端接入，但真实上游是 OpenAI-compatible 服务，例如当前这类配置：

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

这里 alias 可以叫 `claude-opus-4-8`，因为它只是客户端看到的业务模型名；但 `provider.type` 和 `targetProtocol` 必须描述真实上游，所以要写 `openai` 和 `openai_chat_completions`。

启动时会校验 provider id 唯一性、alias 引用、targetProtocol 与 provider.type 是否匹配、能力开关类型等。配置错误会以 `Configuration error: ...` 形式直接启动失败。

## 模型列表

网关支持：

- `GET /v1/models`：返回所有业务 alias。
- `GET /v1/models/:id`：返回某个业务 alias。

返回格式会根据请求头自动偏向 OpenAI 或 Anthropic 风格，但都只暴露 alias，不暴露真实上游模型名。

## Token 计数

Anthropic 客户端如果调用 `POST /v1/messages/count_tokens`，网关会返回：

~~~json
{
  "input_tokens": 123
}
~~~

默认情况下这个值是网关本地估算，用于客户端上下文预算和预检查，不等同于真实上游 tokenizer 的精确计数。如果 Anthropic provider 配置 `supportsTokenCounting: true`，网关会转发到真实 `/v1/messages/count_tokens` 获取供应商计数。接口会校验 `model` 是否是已配置的业务 alias，不会记录 prompt、response 或 Key。

## 测试

运行单元测试：

~~~bash
npm test
~~~

类型检查：

~~~bash
npm run typecheck
~~~

live 测试默认跳过，需要你本地已启动网关并显式设置环境变量：

~~~powershell
$env:RUN_LIVE_RESPONSES_TEST = "1"
$env:TEST_API_KEY = "你的真实上游 Key"
$env:TEST_GATEWAY_URL = "http://127.0.0.1:8787"
$env:TEST_MODEL_ALIAS = "gpt-5.5"
node --test test/live-responses.test.ts
~~~

Anthropic Messages live 测试：

~~~powershell
$env:RUN_LIVE_ANTHROPIC_TEST = "1"
$env:TEST_API_KEY = "你的真实上游 Key"
$env:TEST_GATEWAY_URL = "http://127.0.0.1:8787"
$env:TEST_ANTHROPIC_MODEL_ALIAS = "claude-opus-4-8"
node --test test/live-anthropic-messages.test.ts
~~~

## 日志与安全边界

- 日志只记录协议、provider、model alias、真实模型、耗时、状态码、usage 和错误类型。
- 不记录 prompt、response 正文或 Key。
- 第一版假设部署在可信内网。公网部署前建议增加网关鉴权、限流、审计、密钥隔离和更严格的日志策略。
- `config.json` 是本地私有配置，已被 `.gitignore` 排除；公开仓库只提交 `config.example.json` / `config.example.yaml`。
