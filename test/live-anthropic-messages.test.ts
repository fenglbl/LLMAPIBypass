/**
 * Anthropic Messages live 测试。
 *
 * 默认跳过，只有设置 RUN_LIVE_ANTHROPIC_TEST=1 才会请求本机网关；key 通过 TEST_API_KEY 环境变量传入。
 * 这个测试用于模拟 OpenCode/Anthropic 客户端走 /v1/messages 的基础文本链路。
 */
import test from "node:test";
import assert from "node:assert/strict";

const runLive = process.env.RUN_LIVE_ANTHROPIC_TEST === "1";

/** 从 Anthropic message.content 中提取可见文本，避免测试依赖完整响应对象细节。 */
function textFromAnthropicContent(content: unknown): string {
 if (!Array.isArray(content)) {
 return "";
 }
 const chunks: string[] = [];
 for (const part of content) {
 if (typeof part !== "object") {
 continue;
 }
 if (part === null) {
 continue;
 }
 if (Array.isArray(part)) {
 continue;
 }
 const typedPart = part as { type?: unknown; text?: unknown };
 if (typedPart.type === "text") {
 if (typeof typedPart.text === "string") {
 chunks.push(typedPart.text);
 }
 }
 }
 return chunks.join("");
}

test("live gateway Anthropic Messages request", { skip: runLive ? false : "Set RUN_LIVE_ANTHROPIC_TEST=1 to run this live test" }, async function () {
 const apiKey = process.env.TEST_API_KEY;
 assert.ok(apiKey, "Set TEST_API_KEY before running the live test");

 const baseUrl = (process.env.TEST_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
 const model = process.env.TEST_ANTHROPIC_MODEL_ALIAS ?? "claude-opus-4-8";
 const maxTokens = Number(process.env.TEST_MAX_TOKENS ?? "512");
 const response = await fetch(baseUrl + "/v1/messages", {
 method: "POST",
 headers: {
 "content-type": "application/json",
 "x-api-key": apiKey
 },
 body: JSON.stringify({
 model,
 max_tokens: maxTokens,
 system: "你是一个简洁的中文测试助手。",
 messages: [
 { role: "user", content: "用一句中文回复：anthropic messages live test ok" }
 ]
 })
 });

 const text = await response.text();
 assert.equal(response.ok, true, "Expected 2xx from gateway, got " + response.status + ": " + text);

 const body = JSON.parse(text) as { type?: unknown; role?: unknown; content?: unknown };
 assert.equal(body.type, "message");
 assert.equal(body.role, "assistant");
 assert.notEqual(textFromAnthropicContent(body.content).length, 0, "Expected non-empty Anthropic message text. Body: " + text.slice(0, 1000));
});
