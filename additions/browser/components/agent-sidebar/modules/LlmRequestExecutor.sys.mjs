/* LlmRequestExecutor.sys.mjs - resilient request execution for LlmClient.
 *
 * This module owns fetch, idle watchdogs, retry policy, optional-field
 * compatibility fallback, and selection of the protocol stream parser.
 */

import { LlmError } from "./LlmProtocol.sys.mjs";
import { readLlmStream } from "./LlmStreamParser.sys.mjs";

const cacheFieldRejectedEndpoints = new Set();
const streamUsageRejectedEndpoints = new Set();

/**
 * Compatibility decisions are shared for the process lifetime so a gateway
 * that rejects optional fields is probed only once per endpoint.
 */
export function createLlmCompatibilityState({
  protocol,
  baseUrl,
  chatPath,
}) {
  const key = `${protocol}|${baseUrl}|${chatPath}`;
  let cacheFieldsRejected = cacheFieldRejectedEndpoints.has(key);
  let streamUsageRejected = streamUsageRejectedEndpoints.has(key);

  return Object.freeze({
    get cacheFieldsRejected() {
      return cacheFieldsRejected;
    },
    get streamUsageRejected() {
      return streamUsageRejected;
    },
    rejectOptionalFields({ cacheApplied, streamUsageApplied }) {
      if (cacheApplied) {
        cacheFieldsRejected = true;
        cacheFieldRejectedEndpoints.add(key);
      }
      if (streamUsageApplied) {
        streamUsageRejected = true;
        streamUsageRejectedEndpoints.add(key);
      }
    },
  });
}

/**
 * Execute one LLM chat request using host-neutral collaborators.
 *
 * @param {object} context
 * @param {string} context.apiKey
 * @param {string} context.protocol
 * @param {object} context.request
 * @param {object} context.transport
 * @param {object} context.compatibility
 * @param {function(Array, object): object} context.buildRequest
 * @param {function(object): object} context.parseResponse
 * @param {Array} messages
 * @param {object} [opts]
 */
export async function executeLlmChat(context, messages, opts = {}) {
  const {
    apiKey,
    protocol,
    request,
    transport,
    compatibility,
    buildRequest,
    parseResponse,
  } = context;
  if (!apiKey) {
    throw new LlmError(
      "chat: apiKey is empty — 在 SettingsPane 填写或在 agent.json 配置"
    );
  }

  const streaming = typeof opts.onDelta === "function";
  const requestOpts = { ...opts, stream: streaming };
  let built = buildRequest(messages, requestOpts);
  let optionalFieldFallbackUsed = false;
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const abortController = transport.createAbortController();
    let stalled = false;
    const idleMs = request.timeout_ms;
    let watchdog = null;
    const bump = () => {
      if (watchdog) {
        transport.clearTimeout(watchdog);
      }
      watchdog = transport.setTimeout(() => {
        stalled = true;
        abortController.abort();
      }, idleMs);
    };
    const stopWatch = () => {
      if (watchdog) {
        transport.clearTimeout(watchdog);
        watchdog = null;
      }
    };

    bump();
    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => abortController.abort(),
        { once: true }
      );
    }

    let response;
    try {
      response = await transport.fetch(built.url, {
        ...built.init,
        signal: abortController.signal,
      });
      bump();
    } catch (error) {
      stopWatch();
      if (opts.signal && opts.signal.aborted) {
        throw new LlmError("request aborted", { cause: error });
      }
      if (stalled) {
        throw new LlmError(
          `连接超时：${Math.round(idleMs / 1000)}s 内服务端无任何响应，可直接重发。`,
          { cause: error }
        );
      }
      lastError = new LlmError(
        `network error calling ${built.url}: ${error.message}`,
        { cause: error }
      );
      if (attempt < maxAttempts) {
        await transport.delay(500 * attempt);
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      stopWatch();
      const errorText = await response.text().catch(() => "");
      if (
        (built.cacheApplied || built.streamUsageApplied) &&
        !optionalFieldFallbackUsed &&
        [400, 404, 422].includes(response.status)
      ) {
        compatibility.rejectOptionalFields(built);
        optionalFieldFallbackUsed = true;
        built = buildRequest(messages, {
          ...requestOpts,
          disablePromptCache: true,
          disableStreamUsage: true,
        });
        attempt--;
        continue;
      }

      const transient =
        [429, 500, 502, 503, 504].includes(response.status) ||
        /upstream|gateway|timeout|temporar|overload/i.test(errorText);
      if (transient && attempt < maxAttempts) {
        lastError = new LlmError(
          `LLM API ${response.status} ${response.statusText}`,
          {
            status: response.status,
            body: errorText.slice(0, 2000),
          }
        );
        await transport.delay(700 * attempt);
        continue;
      }
      const suffix = transient
        ? `（网关/上游暂时不可用，已自动重试 ${maxAttempts} 次；可稍后再试或换模型）`
        : "";
      throw new LlmError(
        `LLM API ${response.status} ${response.statusText}${suffix}`,
        {
          status: response.status,
          body: errorText.slice(0, 2000),
        }
      );
    }

    if (streaming) {
      try {
        return await readLlmStream(protocol, response, {
          onDelta: opts.onDelta,
          onReasoning: opts.onReasoning,
          onActivity: bump,
          parseResponse,
        });
      } catch (error) {
        if (opts.signal && opts.signal.aborted) {
          throw new LlmError("request aborted", { cause: error });
        }
        if (stalled) {
          throw new LlmError(
            `流式响应中断：连续 ${Math.round(idleMs / 1000)}s 无数据（服务端疑似断流），可直接重发。`,
            { cause: error }
          );
        }
        throw error;
      } finally {
        stopWatch();
      }
    }

    const text = await response.text();
    stopWatch();
    try {
      return parseResponse(JSON.parse(text));
    } catch (error) {
      throw new LlmError(`invalid JSON from ${built.url}`, {
        body: text.slice(0, 500),
        cause: error,
      });
    }
  }
  throw lastError;
}
