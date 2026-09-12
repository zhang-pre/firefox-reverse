/* LlmClient.sys.mjs - stable facade for the platform-neutral LLM stack.
 *
 * Wire formats live in LlmProtocol, SSE framing in LlmStreamParser, resilient
 * I/O in LlmRequestExecutor, and host primitives in LlmTransport. This class
 * keeps the existing public API while owning only normalized client config.
 */

import {
  buildLlmRequest,
  LlmError,
  looksLikeToolCallLeak,
  parseLlmResponse,
  PROTOCOLS,
  recoverInlineToolCalls,
  toAnthropicMessages,
} from "./LlmProtocol.sys.mjs";
import {
  createLlmCompatibilityState,
  executeLlmChat,
} from "./LlmRequestExecutor.sys.mjs";
import {
  readAnthropicStream,
  readOpenAiStream,
} from "./LlmStreamParser.sys.mjs";
import { createLlmTransport } from "./LlmTransport.sys.mjs";

export {
  LlmError,
  looksLikeToolCallLeak,
  PROTOCOLS,
  recoverInlineToolCalls,
  toAnthropicMessages,
};

/**
 * @typedef {{ role: "system"|"user"|"assistant"|"tool",
 *             content: string }} ChatMessage
 * @typedef {{ content: string, toolCalls: Array, finishReason: string,
 *             usage: object|null, raw: object }} ChatResult
 */

export class LlmClient {
  /**
   * @param {object} config
   * @param {string} config.protocol
   * @param {string} config.baseUrl
   * @param {string} config.chatPath
   * @param {string} config.apiKey
   * @param {string} config.model
   * @param {string} [config.providerId]
   * @param {string} [config.promptCacheMode]
   * @param {string} [config.promptCacheTtl]
   * @param {object} [config.transport]
   * @param {object} [config.request]
   */
  constructor(config) {
    if (!config || typeof config !== "object") {
      throw new LlmError("LlmClient: config object required");
    }
    this.transport = createLlmTransport(config.transport || config.runtime);
    this.protocol = config.protocol || PROTOCOLS.OPENAI;
    this.baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
    this.chatPath = config.chatPath || "/v1/chat/completions";
    this.apiKey = config.apiKey || "";
    this.model = config.model || "";
    this.providerId = config.providerId || "custom";
    this.promptCacheMode =
      config.promptCacheMode === "off" ? "off" : "auto";
    this.promptCacheTtl =
      config.promptCacheTtl === "5m" || config.promptCacheTtl === "1h"
        ? config.promptCacheTtl
        : "default";
    this.request = Object.assign(
      {
        timeout_ms: 300000,
        max_tokens: 32768,
        temperature: 0.7,
        stream: false,
      },
      config.request || {}
    );
    this.compatibility = createLlmCompatibilityState({
      protocol: this.protocol,
      baseUrl: this.baseUrl,
      chatPath: this.chatPath,
    });
  }

  get endpoint() {
    return this.baseUrl + this.chatPath;
  }

  _protocolConfig() {
    return {
      protocol: this.protocol,
      baseUrl: this.baseUrl,
      chatPath: this.chatPath,
      apiKey: this.apiKey,
      model: this.model,
      providerId: this.providerId,
      promptCacheMode: this.promptCacheMode,
      promptCacheTtl: this.promptCacheTtl,
      request: this.request,
      compatibility: this.compatibility,
    };
  }

  /**
   * Build a request without performing I/O.
   *
   * @param {ChatMessage[]} messages
   * @param {object} [opts]
   */
  buildRequest(messages, opts = {}) {
    return buildLlmRequest(this._protocolConfig(), messages, opts);
  }

  /**
   * Normalize one non-streaming protocol response.
   *
   * @param {object} json
   * @returns {ChatResult}
   */
  parseResponse(json) {
    return parseLlmResponse(this.protocol, json);
  }

  /**
   * Execute one resilient completion request.
   *
   * @param {ChatMessage[]} messages
   * @param {object} [opts]
   * @returns {Promise<ChatResult>}
   */
  async chat(messages, opts = {}) {
    return await executeLlmChat(
      {
        apiKey: this.apiKey,
        protocol: this.protocol,
        request: this.request,
        transport: this.transport,
        compatibility: this.compatibility,
        buildRequest: (inputMessages, inputOptions) =>
          this.buildRequest(inputMessages, inputOptions),
        parseResponse: json => this.parseResponse(json),
      },
      messages,
      opts
    );
  }

  _delay(ms) {
    return this.transport.delay(ms);
  }

  // Compatibility wrappers retained for existing focused tests and diagnostics.
  async _readStream(response, onDelta, onReasoning, onActivity) {
    return await readOpenAiStream(response, {
      onDelta,
      onReasoning,
      onActivity,
      parseResponse: json => this.parseResponse(json),
    });
  }

  async _readStreamAnthropic(response, onDelta, onActivity) {
    return await readAnthropicStream(response, {
      onDelta,
      onActivity,
      parseResponse: json => this.parseResponse(json),
    });
  }
}

/**
 * Build a client from an agent.json-style provider entry.
 *
 * @param {object} providerConfig
 * @param {object} [requestConfig]
 * @param {object} [opts]
 */
export function clientFromProviderConfig(
  providerConfig,
  requestConfig,
  opts = {}
) {
  let apiKey = providerConfig.api_key || "";
  if (!apiKey && opts.apiKeyFallbackEnv && globalThis.process?.env) {
    apiKey = globalThis.process.env[opts.apiKeyFallbackEnv] || "";
  }
  return new LlmClient({
    protocol: providerConfig.protocol,
    baseUrl: providerConfig.base_url,
    chatPath: providerConfig.chat_path,
    apiKey,
    model: providerConfig.default_model,
    transport: opts.transport,
    request: requestConfig,
  });
}
