/* AgentRuntimePorts.sys.mjs — formal host boundary for AgentRuntime.
 *
 * JavaScript has no runtime interfaces, so this module defines the contract in
 * JSDoc and validates it at the composition root. Runtime code may only reach
 * host capabilities through the normalized object returned here.
 */

export const AGENT_RUNTIME_PORTS_VERSION = 1;

/**
 * @typedef {object} AgentRuntimeClockPort
 * @property {function(): number} now
 * @property {function(Function, number): *} setTimeout
 * @property {function(*): void} clearTimeout
 */

/**
 * @typedef {object} AgentRuntimeConfigPort
 * @property {function(): "legacy"|"projected"|string} getContextStrategy
 * @property {function(): object|null} getActiveModelProfile
 * @property {function(): string} getActiveProvider
 * @property {function(string): string} getModel
 */

/**
 * @typedef {object} AgentRuntimeConversationPort
 * @property {function(string): Promise<boolean>} consumeCancellationBoundary
 * @property {function(string, string): Promise<void>} setThreadTurnStatus
 * @property {function(string): Promise<object|null>} getThread
 * @property {function(string, object): Promise<Array>} getModelMessages
 * @property {function(string, object): Promise<void>} setContextProjection
 * @property {function(string, object): Promise<void>} appendMessage
 * @property {function(string, object): Promise<void>} addThreadUsage
 */

/**
 * @typedef {object} AgentRuntimeTransportPort
 * @property {function(...*): Promise<*>} fetch
 * @property {function(): AbortController} createAbortController
 * @property {function(Function, number): *} setTimeout
 * @property {function(*): void} clearTimeout
 */

/**
 * @typedef {object} AgentRuntimeLlmPort
 * @property {AgentRuntimeTransportPort} transport
 * @property {function(object): object} createClient
 * @property {function(string): boolean} [isVisionModel]
 */

/**
 * @typedef {object} AgentRuntimeRouterPort
 * @property {number} [maxChars]
 * @property {function(): Array} listSpecs
 * @property {function(string): boolean} needsConfirm
 * @property {function(string, object, object): Promise<object>} dispatch
 */

/**
 * @typedef {object} AgentRuntimeBackendsPort
 * @property {{digest: Function, mergeHandoff: Function}} ledger
 * @property {{write: Function}} workspace
 */

/**
 * @typedef {object} AgentRuntimeToolsPort
 * @property {function(): AgentRuntimeRouterPort} getRouter
 * @property {function(): AgentRuntimeBackendsPort} getBackends
 * @property {function(object): object} createContext
 */

/**
 * @typedef {object} AgentRuntimeLifecyclePort
 * @property {function(Function): (Function|void)} [onShutdown]
 */

/**
 * @typedef {object} AgentRuntimePorts
 * @property {AgentRuntimeClockPort} clock
 * @property {AgentRuntimeConfigPort} config
 * @property {AgentRuntimeConversationPort} conversations
 * @property {AgentRuntimeLlmPort} llm
 * @property {AgentRuntimeToolsPort} tools
 * @property {AgentRuntimeLifecyclePort} [lifecycle]
 */

function requireObject(value, path) {
  if (!value || typeof value !== "object") {
    throw new TypeError("AgentRuntimePorts: " + path + " must be an object");
  }
  return value;
}

function requireMethod(target, path, name) {
  if (typeof target[name] !== "function") {
    throw new TypeError(
      "AgentRuntimePorts: " + path + "." + name + " must be a function"
    );
  }
}

function requireMethods(target, path, names) {
  for (const name of names) {
    requireMethod(target, path, name);
  }
}

function bound(target, name) {
  return target[name].bind(target);
}

export function assertAgentRouterPort(router) {
  const value = requireObject(router, "ports.tools.getRouter()");
  requireMethods(value, "ports.tools.getRouter()", [
    "listSpecs",
    "needsConfirm",
    "dispatch",
  ]);
  return Object.freeze({
    get maxChars() {
      return value.maxChars;
    },
    set maxChars(next) {
      value.maxChars = next;
    },
    listSpecs: bound(value, "listSpecs"),
    needsConfirm: bound(value, "needsConfirm"),
    dispatch: bound(value, "dispatch"),
  });
}

export function assertAgentBackendsPort(backends) {
  const value = requireObject(backends, "ports.tools.getBackends()");
  const ledger = requireObject(
    value.ledger,
    "ports.tools.getBackends().ledger"
  );
  const workspace = requireObject(
    value.workspace,
    "ports.tools.getBackends().workspace"
  );
  requireMethods(ledger, "ports.tools.getBackends().ledger", [
    "digest",
    "mergeHandoff",
  ]);
  requireMethods(workspace, "ports.tools.getBackends().workspace", ["write"]);
  return Object.freeze({
    ledger: Object.freeze({
      digest: bound(ledger, "digest"),
      mergeHandoff: bound(ledger, "mergeHandoff"),
    }),
    workspace: Object.freeze({
      write: bound(workspace, "write"),
    }),
  });
}

/**
 * Validate and normalize one complete AgentRuntime host contract.
 *
 * The returned wrappers are frozen, but caller-owned stores/backends are not.
 * Methods are bound to their original port object so class-based adapters work.
 *
 * @param {AgentRuntimePorts} input
 * @returns {Readonly<AgentRuntimePorts>}
 */
export function defineAgentRuntimePorts(input) {
  const ports = requireObject(input, "ports");
  const clock = requireObject(ports.clock, "ports.clock");
  const config = requireObject(ports.config, "ports.config");
  const conversations = requireObject(
    ports.conversations,
    "ports.conversations"
  );
  const llm = requireObject(ports.llm, "ports.llm");
  const transport = requireObject(ports.llm.transport, "ports.llm.transport");
  const tools = requireObject(ports.tools, "ports.tools");
  const lifecycle =
    ports.lifecycle == null
      ? {}
      : requireObject(ports.lifecycle, "ports.lifecycle");

  requireMethods(clock, "ports.clock", ["now", "setTimeout", "clearTimeout"]);
  requireMethods(config, "ports.config", [
    "getContextStrategy",
    "getActiveModelProfile",
    "getActiveProvider",
    "getModel",
  ]);
  requireMethods(conversations, "ports.conversations", [
    "consumeCancellationBoundary",
    "setThreadTurnStatus",
    "getThread",
    "getModelMessages",
    "setContextProjection",
    "appendMessage",
    "addThreadUsage",
  ]);
  requireMethod(llm, "ports.llm", "createClient");
  if (llm.isVisionModel != null) {
    requireMethod(llm, "ports.llm", "isVisionModel");
  }
  requireMethods(transport, "ports.llm.transport", [
    "fetch",
    "createAbortController",
    "setTimeout",
    "clearTimeout",
  ]);
  requireMethods(tools, "ports.tools", [
    "getRouter",
    "getBackends",
    "createContext",
  ]);
  if (lifecycle.onShutdown != null) {
    requireMethod(lifecycle, "ports.lifecycle", "onShutdown");
  }

  const normalizedTransport = Object.freeze({
    fetch: bound(transport, "fetch"),
    createAbortController: bound(transport, "createAbortController"),
    setTimeout: bound(transport, "setTimeout"),
    clearTimeout: bound(transport, "clearTimeout"),
  });
  const normalizedConfig = Object.freeze({
    getContextStrategy: bound(config, "getContextStrategy"),
    getActiveModelProfile: bound(config, "getActiveModelProfile"),
    getActiveProvider: bound(config, "getActiveProvider"),
    getModel: bound(config, "getModel"),
  });
  const normalizedConversations = Object.freeze({
    consumeCancellationBoundary: bound(
      conversations,
      "consumeCancellationBoundary"
    ),
    setThreadTurnStatus: bound(conversations, "setThreadTurnStatus"),
    getThread: bound(conversations, "getThread"),
    getModelMessages: bound(conversations, "getModelMessages"),
    setContextProjection: bound(conversations, "setContextProjection"),
    appendMessage: bound(conversations, "appendMessage"),
    addThreadUsage: bound(conversations, "addThreadUsage"),
  });

  return Object.freeze({
    version: AGENT_RUNTIME_PORTS_VERSION,
    clock: Object.freeze({
      now: bound(clock, "now"),
      setTimeout: bound(clock, "setTimeout"),
      clearTimeout: bound(clock, "clearTimeout"),
    }),
    config: normalizedConfig,
    conversations: normalizedConversations,
    llm: Object.freeze({
      transport: normalizedTransport,
      createClient: bound(llm, "createClient"),
      isVisionModel:
        llm.isVisionModel == null
          ? () => false
          : bound(llm, "isVisionModel"),
    }),
    tools: Object.freeze({
      getRouter: bound(tools, "getRouter"),
      getBackends: bound(tools, "getBackends"),
      createContext: bound(tools, "createContext"),
    }),
    lifecycle: Object.freeze({
      onShutdown:
        lifecycle.onShutdown == null
          ? null
          : bound(lifecycle, "onShutdown"),
    }),
  });
}
