/**
 * OpenAI Responses live 测试。
 *
 * 默认跳过；设置 RUN_LIVE_RESPONSES_TEST=1 后请求本机网关，TEST_API_KEY 从环境变量读取。
 */
import test from "node:test";
import assert from "node:assert/strict";

const runLive = process.env.RUN_LIVE_RESPONSES_TEST === "1";

function responseTextFromOutput(output: unknown): string {
 if (!Array.isArray(output)) {
 return "";
 }
 const chunks: string[] = [];
 for (const item of output) {
 if (typeof item !== "object") {
 continue;
 }
 if (item === null) {
 continue;
 }
 if (Array.isArray(item)) {
 continue;
 }
 const content = (item as { content?: unknown }).content;
 if (!Array.isArray(content)) {
 continue;
 }
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
 const isTextPart = ["output_text", "text"].includes(String(typedPart.type));
 if (isTextPart) {
 if (typeof typedPart.text === "string") {
 chunks.push(typedPart.text);
 }
 }
 }
 }
 return chunks.join("");
}

test("live gateway OpenAI Responses request", { skip: runLive ? false : "Set RUN_LIVE_RESPONSES_TEST=1 to run this live test" }, async function () {
 const apiKey = process.env.TEST_API_KEY;
 assert.ok(apiKey, "Set TEST_API_KEY before running the live test");

 const baseUrl = (process.env.TEST_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
 const model = process.env.TEST_MODEL_ALIAS ?? "gpt-5.5";
 const maxOutputTokens = Number(process.env.TEST_MAX_OUTPUT_TOKENS ?? "512");
 const response = await fetch(baseUrl + "/v1/responses", {
 method: "POST",
 headers: {
 "content-type": "application/json",
 authorization: "Bearer " + apiKey
 },
 body: JSON.stringify({
 model,
 input: "Reply with exactly: responses live test ok",
 max_output_tokens: maxOutputTokens
 })
 });

 const text = await response.text();
 assert.equal(response.ok, true, "Expected 2xx from gateway, got " + response.status + ": " + text);

 const body = JSON.parse(text) as { object?: unknown; output?: unknown; output_text?: unknown };
 assert.equal(body.object, "response");
 const outputText = typeof body.output_text === "string" ? body.output_text : responseTextFromOutput(body.output);
 assert.notEqual(outputText.length, 0, "Expected non-empty Responses output text. Body: " + text.slice(0, 1000));
});
