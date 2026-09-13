/* LlmProtocol.sys.mjs - pure request/response protocol adapters.
 *
 * This module owns wire-format translation only. It performs no I/O, retry,
 * timeout, or stream reading, so adapters can be tested as deterministic
 * functions and extended without growing the LlmClient facade.
 */

import { normalizeReasoningEffort } from "./ReasoningEffort.sys.mjs";

export const PROTOCOLS = Object.freeze({
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GEMINI: "gemini",
});

export class LlmError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status ?? null;
    this.body = body ?? null;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Build one protocol-specific HTTP request without sending it.
 *
 * @param {object} config Normalized LlmClient configuration.
 * @param {Array} messages
 * @param {object} [opts]
 * @returns {{url:string, init:object, cacheApplied:boolean,
 *            streamUsageApplied?:boolean}}
 */
export function buildLlmRequest(config, messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError("buildRequest: messages must be a non-empty array");
  }
  const protocol = config.protocol || PROTOCOLS.OPENAI;
  const request = config.request || {};
  const compatibility = config.compatibility || {};
  const baseUrl = config.baseUrl || "";
  const chatPath = config.chatPath || "/v1/chat/completions";
  const endpoint = baseUrl + chatPath;
  // Context-window suffixes such as [1m] are internal Agent hints, not model IDs.
  const model = String(opts.model || config.model || "").replace(
    /\s*\[\d+[a-z]?\]\s*$/i,
    ""
  );
  if (!model) {
    throw new LlmError("buildRequest: model is required");
  }
  const cacheKey = String(opts.cacheKey || "").trim().slice(0, 64);
  const cacheEnabled =
    config.promptCacheMode === "auto" &&
    !compatibility.cacheFieldsRejected &&
    !opts.disablePromptCache &&
    !!cacheKey;

  if (protocol === PROTOCOLS.OPENAI) {
    const reasoningEffort = normalizeReasoningEffort(
      opts.reasoningEffort ?? request.reasoning_effort
    );
    const body = {
      model,
      messages,
      stream: opts.stream ?? request.stream ?? false,
      max_tokens: opts.maxTokens ?? request.max_tokens,
    };
    if (reasoningEffort === "auto") {
      body.temperature = request.temperature;
    } else {
      body.reasoning_effort = reasoningEffort;
    }
    if (opts.tools) {
      body.tools = opts.tools;
    }
    const streamUsageApplied =
      body.stream === true &&
      !compatibility.streamUsageRejected &&
      !opts.disableStreamUsage;
    if (streamUsageApplied) {
      body.stream_options = { include_usage: true };
    }
    const cacheApplied =
      cacheEnabled && config.providerId === "custom";
    if (cacheApplied) {
      body.prompt_cache_key = cacheKey;
    }
    return {
      url: endpoint,
      cacheApplied,
      streamUsageApplied,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey || ""}`,
        },
        body: JSON.stringify(body),
      },
    };
  }

  if (protocol === PROTOCOLS.ANTHROPIC) {
    const { system, messages: anthropicMessages } =
      toAnthropicMessages(messages);
    const body = {
      model,
      max_tokens: opts.maxTokens ?? request.max_tokens ?? 32768,
      messages: anthropicMessages,
      stream: opts.stream ?? request.stream ?? false,
    };
    if (system) {
      body.system = system;
    }
    if (opts.tools) {
      body.tools = opts.tools.map(tool => {
        const fn = tool.function || tool;
        return {
          name: fn.name,
          description: fn.description || "",
          input_schema: fn.parameters || {
            type: "object",
            properties: {},
          },
        };
      });
    }
    const cacheApplied = cacheEnabled;
    if (cacheApplied) {
      body.cache_control = {
        type: "ephemeral",
        ...(config.promptCacheTtl === "1h" ? { ttl: "1h" } : {}),
      };
    }
    const path = /messages\/?$/.test(chatPath)
      ? chatPath
      : "/v1/messages";
    return {
      url: baseUrl + path,
      cacheApplied,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey || "",
          Authorization: `Bearer ${config.apiKey || ""}`,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      },
    };
  }

  throw new LlmError(
    `protocol "${protocol}" not implemented (only "openai" / "anthropic")`
  );
}

export function parseLlmResponse(protocol, json) {
  if (protocol === PROTOCOLS.ANTHROPIC) {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    let content = "";
    const toolCalls = [];
    for (const block of blocks) {
      if (block.type === "text") {
        content += block.text || "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
    return {
      content,
      reasoningContent: "",
      toolCalls,
      finishReason: json?.stop_reason || "",
      usage: json?.usage || null,
      raw: json,
    };
  }
  if (protocol !== PROTOCOLS.OPENAI) {
    throw new LlmError(
      `parseResponse: protocol "${protocol}" not implemented`
    );
  }
  const choice = json?.choices?.[0];
  const message = choice?.message || {};
  let content = message.content ?? "";
  let toolCalls = message.tool_calls ?? [];
  if ((!toolCalls || toolCalls.length === 0) && content) {
    const recovered = recoverInlineToolCalls(content);
    if (recovered) {
      toolCalls = recovered.toolCalls;
      content = recovered.content;
    }
  }
  return {
    content,
    reasoningContent: message.reasoning_content ?? "",
    toolCalls,
    finishReason: choice?.finish_reason ?? "",
    usage: json?.usage ?? null,
    raw: json,
  };
}

const INLINE_LEAK_MARKERS = ["DSML｜", "tool▁call", "<｜tool"];

export function looksLikeToolCallLeak(value) {
  if (typeof value !== "string" || !value) {
    return false;
  }
  return INLINE_LEAK_MARKERS.some(marker => value.includes(marker));
}

export function recoverInlineToolCalls(content) {
  if (typeof content !== "string" || !content) {
    return null;
  }
  if (
    !/invoke\s+name\s*=\s*"/.test(content) ||
    !/<\/[^>]*?invoke\s*>/.test(content)
  ) {
    return null;
  }
  const calls = [];
  const invokePattern =
    /invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*?invoke\s*>/g;
  let invoke;
  while ((invoke = invokePattern.exec(content))) {
    const args = {};
    const parameterPattern =
      /parameter\s+name\s*=\s*"([^"]+)"([^>]*)>([\s\S]*?)<\/[^>]*?parameter\s*>/g;
    let parameter;
    while ((parameter = parameterPattern.exec(invoke[2] || ""))) {
      const attrs = parameter[2] || "";
      const raw = String(parameter[3]).trim();
      let value = raw;
      if (!/string\s*=\s*"true"/.test(attrs)) {
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
      }
      args[parameter[1]] = value;
    }
    calls.push({
      id: "inline_" + (calls.length + 1) + "_" + Date.now().toString(36),
      type: "function",
      function: {
        name: invoke[1],
        arguments: JSON.stringify(args),
      },
    });
  }
  if (!calls.length) {
    return null;
  }

  let cut = content.length;
  for (const marker of [
    "<｜｜DSML｜｜tool_calls",
    "DSML｜｜tool_calls",
    "<｜｜DSML｜｜invoke",
    "DSML｜｜invoke",
  ]) {
    const index = content.indexOf(marker);
    if (index >= 0 && index < cut) {
      cut = index;
    }
  }
  if (cut === content.length) {
    const index = content.search(/<[^>]*invoke\s+name\s*=\s*"/);
    if (index >= 0) {
      cut = index;
    }
  }
  return {
    toolCalls: calls,
    content: content.slice(0, cut).trim(),
  };
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === "text")
      .map(block => block.text)
      .join("");
  }
  return content == null ? "" : String(content);
}

function toAnthropicUserBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block && block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (
        block &&
        block.type === "image_url" &&
        block.image_url &&
        block.image_url.url
      ) {
        const url = block.image_url.url;
        const match = /^data:([^;]+);base64,(.*)$/.exec(url);
        return match
          ? {
              type: "image",
              source: {
                type: "base64",
                media_type: match[1],
                data: match[2],
              },
            }
          : {
              type: "image",
              source: { type: "url", url },
            };
      }
      return {
        type: "text",
        text: typeof block === "string" ? block : JSON.stringify(block),
      };
    });
  }
  return [{
    type: "text",
    text: content == null ? "" : String(content),
  }];
}

export function toAnthropicMessages(messages) {
  let system = "";
  const output = [];
  const pushMerged = (role, blocks) => {
    const last = output[output.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      output.push({ role, content: blocks });
    }
  };

  for (const message of messages || []) {
    if (message.role === "system") {
      system += (system ? "\n\n" : "") + textOf(message.content);
    } else if (message.role === "tool") {
      pushMerged("user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      }]);
    } else if (message.role === "assistant") {
      const blocks = [];
      const text = textOf(message.content);
      if (text) {
        blocks.push({ type: "text", text });
      }
      for (const toolCall of message.tool_calls || []) {
        let input = {};
        try {
          input =
            toolCall.function && toolCall.function.arguments
              ? JSON.parse(toolCall.function.arguments)
              : {};
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function && toolCall.function.name,
          input,
        });
      }
      pushMerged(
        "assistant",
        blocks.length ? blocks : [{ type: "text", text: "" }]
      );
    } else {
      pushMerged("user", toAnthropicUserBlocks(message.content));
    }
  }
  return { system, messages: output };
}
