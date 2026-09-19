/* AgentRuntime.sys.mjs — platform-neutral Agent composition root. */

import { runAgentTurn } from "./AgentLoop.sys.mjs";
import { AgentRuntimeCore } from "./AgentRuntimeCore.sys.mjs";
import {
  assertAgentBackendsPort,
  assertAgentRouterPort,
  defineAgentRuntimePorts,
} from "./AgentRuntimePorts.sys.mjs";
import { AgentTurnOrchestrator } from "./AgentTurnOrchestrator.sys.mjs";
import { emptyUsage } from "../llm/Usage.sys.mjs";

function createToolContext(ports, input) {
  const context = ports.tools.createContext(input);
  if (!context || typeof context !== "object") {
    throw new TypeError(
      "AgentRuntimePorts: ports.tools.createContext() must return an object"
    );
  }
  return context;
}

/**
 * Assemble one fully independent Agent runtime from host-provided ports.
 *
 * The factory imports no Firefox adapter. A Node process, test runner, browser,
 * or another application can host the same runtime by implementing the Ports
 * contract from AgentRuntimePorts.sys.mjs.
 *
 * @param {import("./AgentRuntimePorts.sys.mjs").AgentRuntimePorts} inputPorts
 * @returns {Readonly<object>}
 */
export function createAgentRuntime(inputPorts) {
  const ports = defineAgentRuntimePorts(inputPorts);
  const runtimeCore = new AgentRuntimeCore({
    now: ports.clock.now,
    setTimeout: ports.clock.setTimeout,
    clearTimeout: ports.clock.clearTimeout,
    createUsage: emptyUsage,
  });
  const getRouter = () =>
    assertAgentRouterPort(ports.tools.getRouter());
  const getBackends = () =>
    assertAgentBackendsPort(ports.tools.getBackends());
  const turnOrchestrator = new AgentTurnOrchestrator({
    runtimeCore,
    ports,
    runAgentTurn,
  });
  const runLog = [];
  let disposed = false;
  let unregisterShutdown = null;

  function ensureActive() {
    if (disposed) {
      throw new Error("AgentRuntime has been disposed");
    }
  }

  function dispose() {
    if (disposed) {
      return false;
    }
    disposed = true;
    runtimeCore.abortAll();
    const unregister = unregisterShutdown;
    unregisterShutdown = null;
    if (typeof unregister === "function") {
      try {
        unregister();
      } catch {
        // Host shutdown may already have removed its own listener.
      }
    }
    return true;
  }

  const runtime = {
    version: ports.version,

    isRunning(threadId) {
      return runtimeCore.isRunning(threadId);
    },

    listRunning() {
      return runtimeCore.listRunning();
    },

    listTools() {
      try {
        return { ok: true, tools: getRouter().listSpecs() };
      } catch (error) {
        return {
          ok: false,
          error: String((error && error.message) || error),
        };
      }
    },

    async callTool(name, args, options = {}) {
      ensureActive();
      if (!name || typeof name !== "string") {
        return { ok: false, error: "callTool: name (string) required" };
      }
      const running = runtimeCore.listRunning();
      if (running.length) {
        return {
          ok: false,
          error:
            `agent 正在运行（${running.map(item => item.id).join(", ")}）——raw 工具直调已暂时禁用：` +
            "它与运行中的 agent 共享同一工具环境，并发会相互干扰。" +
            "请先等待当前 agent 停止或主动停止，再直调工具。",
          running,
        };
      }
      const context = createToolContext(ports, {
        workspaceRoot: options.workspaceRoot || null,
        hostContext: options.hostContext || null,
        signal: null,
      });
      return await getRouter().dispatch(name, args || {}, context);
    },

    acquireThread(candidateIds, owner) {
      ensureActive();
      return runtimeCore.acquireThread(candidateIds, owner);
    },

    renewThread(threadId, owner) {
      ensureActive();
      return runtimeCore.renewThread(threadId, owner);
    },

    releaseThread(threadId, owner) {
      runtimeCore.releaseThread(threadId, owner);
    },

    getState(threadId) {
      return runtimeCore.getState(threadId);
    },

    subscribe(threadId, callback) {
      ensureActive();
      return runtimeCore.subscribe(threadId, callback);
    },

    respondConfirm(threadId, id, approved, all) {
      ensureActive();
      return runtimeCore.respondConfirm(threadId, id, approved, all);
    },

    steer(threadId, content) {
      ensureActive();
      return runtimeCore.enqueueSteer(threadId, content);
    },

    stop(threadId) {
      if (runtimeCore.abortThread(threadId)) {
        void ports.conversations
          .setThreadTurnStatus(threadId, "cancelled")
          .catch(() => {});
      }
    },

    async run(threadId, options = {}) {
      ensureActive();
      runLog.push({
        threadId,
        at: ports.clock.now(),
        convoLen: Array.isArray(options.convo) ? options.convo.length : -1,
      });
      return await turnOrchestrator.run(threadId, options);
    },

    getRunLog() {
      return runLog.slice(-20);
    },

    dispose,
  };

  Object.freeze(runtime);
  if (ports.lifecycle.onShutdown) {
    const unregister = ports.lifecycle.onShutdown(dispose);
    if (typeof unregister === "function") {
      if (disposed) {
        try {
          unregister();
        } catch {
          // A synchronous shutdown callback may already own cleanup.
        }
      } else {
        unregisterShutdown = unregister;
      }
    }
  }
  return runtime;
}
