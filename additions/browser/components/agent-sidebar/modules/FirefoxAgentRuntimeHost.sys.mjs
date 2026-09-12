/* FirefoxAgentRuntimeHost.sys.mjs — Firefox-only adapter for AgentRuntime.
 *
 * All privileged composition lives here: Timer.sys.mjs, application shutdown,
 * browser tool backends, and the ToolRouter singleton. Platform-neutral runtime
 * code depends on this narrow host object instead of importing Firefox APIs.
 */

import { ToolRouter } from "./ToolRouter.sys.mjs";
import { createBuiltinTools } from "./Tools.sys.mjs";
import { getBackends } from "./Backends.sys.mjs";

const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
let sharedRouter = null;

function router() {
  if (!sharedRouter) {
    sharedRouter = new ToolRouter();
    sharedRouter.registerAll(createBuiltinTools(getBackends()));
  }
  return sharedRouter;
}

function onShutdown(callback) {
  const observer = {
    observe() {
      callback();
    },
  };
  Services.obs.addObserver(observer, "quit-application-granted");
  return () => {
    try {
      Services.obs.removeObserver(observer, "quit-application-granted");
    } catch {
      // The observer service may already be shutting down.
    }
  };
}

const clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
});

const llmTransport = Object.freeze({
  fetch: (...args) => globalThis.fetch(...args),
  createAbortController: () => new AbortController(),
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
});

function createToolContext({
  workspaceRoot = null,
  hostContext = null,
  signal = null,
} = {}) {
  return {
    workspaceRoot,
    win:
      hostContext && typeof hostContext === "object"
        ? hostContext.win || null
        : null,
    signal,
  };
}

const lifecycle = Object.freeze({ onShutdown });
const tools = Object.freeze({
  getRouter: router,
  getBackends,
  createContext: createToolContext,
});

export function createFirefoxAgentRuntimePorts({
  config,
  conversations,
  createClient,
  isVisionModel,
} = {}) {
  return {
    clock,
    config,
    conversations,
    llm: {
      transport: llmTransport,
      createClient,
      isVisionModel,
    },
    tools,
    lifecycle,
  };
}

export const firefoxAgentRuntimeHost = Object.freeze({
  clock,
  lifecycle,
  tools,
  timers: clock,
  router,
  backends: getBackends,
  onShutdown,
  createToolContext,
  llmTransport,
});
