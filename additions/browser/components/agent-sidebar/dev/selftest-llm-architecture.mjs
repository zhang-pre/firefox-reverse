/* Verify that the LLM stack keeps its platform-neutral module boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LlmClient,
  PROTOCOLS as facadeProtocols,
  toAnthropicMessages as facadeToAnthropicMessages,
} from "../modules/LlmClient.sys.mjs";
import {
  buildLlmRequest,
  PROTOCOLS,
  toAnthropicMessages,
} from "../modules/LlmProtocol.sys.mjs";

const readModule = name =>
  fs.readFileSync(
    fileURLToPath(new URL(`../modules/${name}`, import.meta.url)),
    "utf8"
  );
const sources = {
  client: readModule("LlmClient.sys.mjs"),
  protocol: readModule("LlmProtocol.sys.mjs"),
  executor: readModule("LlmRequestExecutor.sys.mjs"),
  stream: readModule("LlmStreamParser.sys.mjs"),
};

assert.equal(facadeProtocols, PROTOCOLS);
assert.equal(facadeToAnthropicMessages, toAnthropicMessages);
assert.ok(sources.client.split(String.fromCharCode(10)).length <= 240);
assert.equal(sources.client.includes("transport.fetch("), false);
assert.equal(sources.client.includes("new TextDecoder"), false);
assert.equal(sources.protocol.includes("transport.fetch("), false);
assert.equal(sources.protocol.includes("new TextDecoder"), false);
assert.equal(sources.executor.includes("transport.fetch("), true);
assert.equal(sources.stream.includes("new TextDecoder"), true);
for (const [name, source] of Object.entries(sources)) {
  for (const forbidden of [
    "ChromeUtils",
    "Services",
    "Components",
    "resource://",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `${name} uses ${forbidden}`
    );
  }
}

const config = {
  protocol: PROTOCOLS.OPENAI,
  baseUrl: "https://llm.invalid",
  chatPath: "/v1/chat/completions",
  apiKey: "test-key",
  model: "test-model",
  providerId: "custom",
  promptCacheMode: "off",
  request: { max_tokens: 123, temperature: 0.25, stream: false },
  compatibility: {
    cacheFieldsRejected: false,
    streamUsageRejected: false,
  },
};
const messages = [{ role: "user", content: "hello" }];
const built = buildLlmRequest(config, messages);
assert.equal(built.url, "https://llm.invalid/v1/chat/completions");
assert.deepEqual(new LlmClient(config).buildRequest(messages), built);

console.log("LlmClient facade and LLM architecture boundaries: OK");
