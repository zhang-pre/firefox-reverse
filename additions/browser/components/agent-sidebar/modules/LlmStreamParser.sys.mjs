/* LlmStreamParser.sys.mjs - protocol-aware SSE readers.
 *
 * Stream framing and incremental accumulation live here. Request execution
 * supplies activity and UI callbacks; protocol response parsing remains pure.
 */

import {
  looksLikeToolCallLeak,
  parseLlmResponse,
  PROTOCOLS,
  recoverInlineToolCalls,
} from "./LlmProtocol.sys.mjs";

export async function readLlmStream(
  protocol,
  response,
  {
    onDelta,
    onReasoning,
    onActivity,
    parseResponse = json => parseLlmResponse(protocol, json),
  } = {}
) {
  return protocol === PROTOCOLS.ANTHROPIC
    ? readAnthropicStream(response, {
        onDelta,
        onActivity,
        parseResponse,
      })
    : readOpenAiStream(response, {
        onDelta,
        onReasoning,
        onActivity,
        parseResponse,
      });
}

export async function readOpenAiStream(
  response,
  { onDelta, onReasoning, onActivity, parseResponse } = {}
) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return (parseResponse ||
      (json => parseLlmResponse(PROTOCOLS.OPENAI, json)))(JSON.parse(text));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  const toolCalls = [];
  let finishReason = "";
  let usage = null;
  let leakSuppressed = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (onActivity) {
      onActivity();
    }
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices && chunk.choices[0];
      const delta = (choice && choice.delta) || {};
      if (delta.content) {
        content += delta.content;
        if (!leakSuppressed && looksLikeToolCallLeak(content)) {
          leakSuppressed = true;
        }
        if (!leakSuppressed) {
          try {
            onDelta && onDelta(delta.content);
          } catch {
            // Consumer callbacks must not interrupt stream parsing.
          }
        }
      }
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        try {
          onReasoning && onReasoning(delta.reasoning_content);
        } catch {
          // Consumer callbacks must not interrupt stream parsing.
        }
      }
      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index || 0;
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCall.id || "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          }
          if (toolCall.id) {
            toolCalls[index].id = toolCall.id;
          }
          if (toolCall.function) {
            if (toolCall.function.name) {
              toolCalls[index].function.name = toolCall.function.name;
            }
            if (toolCall.function.arguments) {
              toolCalls[index].function.arguments +=
                toolCall.function.arguments;
            }
          }
        }
      }
      if (choice && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  }

  let outputContent = content;
  let outputToolCalls = toolCalls.filter(Boolean);
  if (outputToolCalls.length === 0) {
    const recovered = recoverInlineToolCalls(outputContent);
    if (recovered) {
      outputToolCalls = recovered.toolCalls;
      outputContent = recovered.content;
    }
  }
  return {
    content: outputContent,
    reasoningContent,
    toolCalls: outputToolCalls,
    finishReason,
    usage,
    raw: null,
  };
}

export async function readAnthropicStream(
  response,
  { onDelta, onActivity, parseResponse } = {}
) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const json = JSON.parse(await response.text());
    return (parseResponse ||
      (value => parseLlmResponse(PROTOCOLS.ANTHROPIC, value)))(json);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const blocks = {};
  const toolCalls = [];
  let finishReason = "";
  let usage = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (onActivity) {
      onActivity();
    }
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "message_start") {
        if (event.message && event.message.usage) {
          usage = { ...(usage || {}), ...event.message.usage };
        }
      } else if (event.type === "content_block_start") {
        const block = event.content_block || {};
        if (block.type === "tool_use") {
          const toolCall = {
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          };
          blocks[event.index] = { toolCall };
          toolCalls.push(toolCall);
        } else {
          blocks[event.index] = {};
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta || {};
        if (delta.type === "text_delta" && delta.text) {
          content += delta.text;
          try {
            onDelta && onDelta(delta.text);
          } catch {
            // Consumer callbacks must not interrupt stream parsing.
          }
        } else if (
          delta.type === "input_json_delta" &&
          delta.partial_json != null
        ) {
          const block = blocks[event.index];
          if (block && block.toolCall) {
            block.toolCall.function.arguments += delta.partial_json;
          }
        }
      } else if (event.type === "message_delta") {
        if (event.delta && event.delta.stop_reason) {
          finishReason = event.delta.stop_reason;
        }
        if (event.usage) {
          usage = { ...(usage || {}), ...event.usage };
        }
      }
    }
  }
  return {
    content,
    reasoningContent: "",
    toolCalls,
    finishReason,
    usage,
    raw: null,
  };
}
