import { createAgentRuntime } from "../modules/runtime/AgentRuntime.sys.mjs";

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) {
    pass++;
    console.log("OK  ", name);
  } else {
    fail++;
    console.error("FAIL", name);
  }
}

let clock = 500;
let shutdownCallback = null;
let unregistered = false;
const clientCreations = [];
const clientCalls = [];
const contexts = [];
const dispatches = [];
const messages = [];
const statuses = [];
const usages = [];

const config = {
  getContextStrategy() {
    return "legacy";
  },
  getActiveModelProfile() {
    return {
      id: "node-profile",
      provider: "node",
      model: "node-model",
    };
  },
  getActiveProvider() {
    return "node";
  },
  getModel() {
    return "node-model";
  },
};

const conversations = {
  async consumeCancellationBoundary() {
    return false;
  },
  async setThreadTurnStatus(threadId, status) {
    statuses.push({ threadId, status });
  },
  async getThread() {
    return null;
  },
  async getModelMessages() {
    return [];
  },
  async setContextProjection() {},
  async appendMessage(threadId, message) {
    messages.push({ threadId, ...message });
  },
  async addThreadUsage(threadId, usage) {
    usages.push({ threadId, ...usage });
  },
};

const transport = {
  async fetch() {
    throw new Error("network transport is unused by the fake client");
  },
  createAbortController() {
    return new AbortController();
  },
  setTimeout,
  clearTimeout,
};

const client = {
  providerId: "node",
  protocol: "openai",
  model: "node-model",
  async chat(requestMessages, options) {
    clientCalls.push({ messages: requestMessages, options });
    return {
      content: "node runtime ok",
      reasoningContent: "",
      finishReason: "stop",
      toolCalls: [],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    };
  },
};

const router = {
  maxChars: 20000,
  listSpecs() {
    return [
      {
        type: "function",
        function: {
          name: "echo",
          parameters: { type: "object" },
        },
      },
    ];
  },
  needsConfirm() {
    return false;
  },
  async dispatch(name, args, context) {
    dispatches.push({ name, args, context });
    return { ok: true, data: args };
  },
};

const backends = {
  ledger: {
    async digest() {
      return "node ledger";
    },
    async mergeHandoff() {},
  },
  workspace: {
    async write({ path }) {
      return { path };
    },
  },
};

const runtime = createAgentRuntime({
  clock: {
    now() {
      return clock++;
    },
    setTimeout,
    clearTimeout,
  },
  config,
  conversations,
  llm: {
    transport,
    createClient(input) {
      clientCreations.push(input);
      return client;
    },
    isVisionModel() {
      return false;
    },
  },
  tools: {
    getRouter() {
      return router;
    },
    getBackends() {
      return backends;
    },
    createContext(input) {
      contexts.push(input);
      return {
        root: input.workspaceRoot,
        target: input.hostContext?.target || null,
        signal: input.signal,
      };
    },
  },
  lifecycle: {
    onShutdown(callback) {
      shutdownCallback = callback;
      return () => {
        unregistered = true;
      };
    },
  },
});

check(
  "factory returns a frozen versioned runtime",
  Object.isFrozen(runtime) && runtime.version === 1
);
check(
  "tool discovery uses only the Router port",
  runtime.listTools().ok && runtime.listTools().tools[0].function.name === "echo"
);

await runtime.run("node-thread", {
  systemPrompt: "node system",
  dynamicContext: "node dynamic",
  convo: [{ role: "user", content: "run outside Firefox" }],
  workspaceRoot: "/node/work",
  hostContext: { target: "terminal" },
  maxRounds: 2,
  assist: true,
});

const state = runtime.getState("node-thread");
check(
  "real AgentLoop completes through the factory",
  clientCalls.length === 1 &&
    state.settled &&
    state.content === "node runtime ok" &&
    !state.running
);
check(
  "LLM factory receives attenuated config and transport ports",
  clientCreations.length === 1 &&
    clientCreations[0].config !== config &&
    Object.keys(clientCreations[0].config).sort().join(",") ===
      "getActiveModelProfile,getActiveProvider,getContextStrategy,getModel" &&
    clientCreations[0].transport !== transport &&
    typeof clientCreations[0].transport.fetch === "function"
);
check(
  "opaque host context is translated by the tools port",
  contexts.length === 1 &&
    contexts[0].hostContext.target === "terminal" &&
    contexts[0].workspaceRoot === "/node/work"
);
check(
  "conversation lifecycle and final message are persisted",
  statuses.map(item => item.status).join(",") === "running,completed" &&
    messages.length === 1 &&
    messages[0].content === "node runtime ok"
);
check(
  "provider usage is persisted outside Firefox",
  usages.length === 1 &&
    usages[0].inputTokens === 9 &&
    usages[0].outputTokens === 4
);
check(
  "run log uses the injected clock",
  runtime.getRunLog().length === 1 &&
    runtime.getRunLog()[0].threadId === "node-thread" &&
    runtime.getRunLog()[0].at === 500
);

const raw = await runtime.callTool(
  "echo",
  { value: 7 },
  {
    workspaceRoot: "/raw/work",
    hostContext: { target: "raw" },
  }
);
check(
  "raw tool calls use the same generic context port",
  raw.ok &&
    dispatches.length === 1 &&
    dispatches[0].context.root === "/raw/work" &&
    dispatches[0].context.target === "raw"
);
check(
  "host lifecycle callback is registered",
  typeof shutdownCallback === "function"
);

let portError = "";
try {
  createAgentRuntime({});
} catch (error) {
  portError = String(error.message || error);
}
check(
  "incomplete ports fail fast with a precise path",
  portError.includes("ports.clock")
);

check(
  "dispose is idempotent and unregisters host lifecycle",
  runtime.dispose() === true &&
    runtime.dispose() === false &&
    unregistered
);

let disposedError = "";
try {
  await runtime.run("after-dispose");
} catch (error) {
  disposedError = String(error.message || error);
}
check(
  "disposed runtime rejects new work",
  disposedError.includes("disposed")
);

console.log(
  `\nAgentRuntime factory selftest: ${pass} passed, ${fail} failed`
);
process.exit(fail ? 1 : 0);
