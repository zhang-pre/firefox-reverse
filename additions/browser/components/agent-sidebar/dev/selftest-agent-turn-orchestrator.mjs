import { AgentRuntimeCore } from "../modules/runtime/AgentRuntimeCore.sys.mjs";
import { defineAgentRuntimePorts } from "../modules/runtime/AgentRuntimePorts.sys.mjs";
import { AgentTurnOrchestrator } from "../modules/runtime/AgentTurnOrchestrator.sys.mjs";
import { emptyUsage } from "../modules/llm/Usage.sys.mjs";

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

function makeHarness({
  turns = [],
  boundary = false,
  backendError = null,
} = {}) {
  let clock = 1000;
  const calls = [];
  const messages = [];
  const statuses = [];
  const usage = [];
  const writes = [];
  const clientCreations = [];
  const router = {
    name: "test-router",
    listSpecs: () => [],
    needsConfirm: () => false,
    async dispatch() {
      throw new Error("unexpected tool dispatch");
    },
  };
  const core = new AgentRuntimeCore({
    now: () => clock++,
    createUsage: emptyUsage,
    notifyThrottleMs: 0,
  });
  const conversationStore = {
    async consumeCancellationBoundary() {
      return boundary;
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
    async addThreadUsage(threadId, record) {
      usage.push({ threadId, ...record });
    },
  };
  const backends = {
    ledger: {
      async digest() {
        return "ledger";
      },
      async mergeHandoff() {},
    },
    workspace: {
      async write(input, context) {
        writes.push({ input, context });
        return { path: input.path };
      },
    },
  };
  const client = {
    providerId: "mock",
    protocol: "openai",
    model: "vision-model",
    async chat() {
      throw new Error("unexpected projection request");
    },
  };
  const ports = defineAgentRuntimePorts({
    clock: {
      now: () => clock++,
      setTimeout,
      clearTimeout,
    },
    config: {
      getContextStrategy: () => "legacy",
      getActiveModelProfile: () => ({
        id: "profile/main",
        provider: "mock",
        model: "vision-model",
      }),
      getActiveProvider: () => "mock",
      getModel: () => "vision-model",
    },
    conversations: conversationStore,
    llm: {
      transport: {
        fetch: async () => {
          throw new Error("unused transport");
        },
        createAbortController: () => new AbortController(),
        setTimeout,
        clearTimeout,
      },
      createClient: input => {
        clientCreations.push(input);
        return client;
      },
      isVisionModel: model => model === "vision-model",
    },
    tools: {
      getRouter: () => router,
      getBackends: () => {
        if (backendError) {
          throw backendError;
        }
        return backends;
      },
      createContext: ({ workspaceRoot, hostContext, signal }) => ({
        workspaceRoot,
        target: hostContext?.target || null,
        signal,
      }),
    },
  });
  const orchestrator = new AgentTurnOrchestrator({
    runtimeCore: core,
    ports,
    runAgentTurn: async options => {
      calls.push(options);
      const turn = turns.shift() || { result: { content: "", stopReason: "final" } };
      if (turn.delta) {
        options.onDelta(turn.delta);
      }
      if (turn.reasoning) {
        options.onReasoning(turn.reasoning);
      }
      if (turn.usage) {
        options.onUsage(turn.usage, { phase: "chat" });
      }
      return turn.result;
    },
  });
  return {
    orchestrator,
    core,
    calls,
    messages,
    statuses,
    usage,
    writes,
    router,
    clientCreations,
  };
}

const completed = makeHarness({
  boundary: true,
  turns: [
    {
      delta: "streamed",
      reasoning: "thought",
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      result: {
        content: "done",
        stopReason: "final",
        messages: [{ role: "assistant", content: "done" }],
      },
    },
  ],
});
await completed.orchestrator.run("thread-complete", {
  systemPrompt: "system",
  dynamicContext: "dynamic",
  convo: [{ role: "user", content: "task" }],
  maxRounds: 5,
  maxPerTool: 2,
  confirmMode: true,
  workspaceRoot: "/work",
  hostContext: { target: "window" },
});

const completedState = completed.core.getState("thread-complete");
check(
  "completed turn is settled with its final content",
  completedState.settled &&
    !completedState.running &&
    completedState.content === "done"
);
check(
  "turn lifecycle status is persisted",
  completed.statuses.map(item => item.status).join(",") === "running,completed"
);
check(
  "final assistant message includes reduced stream steps",
  completed.messages.length === 1 &&
    completed.messages[0].content === "done" &&
    completed.messages[0].steps.some(step => step.kind === "text")
);
check(
  "loop receives injected router and run limits",
  completed.calls[0].router !== completed.router &&
    Object.keys(completed.calls[0].router).sort().join(",") ===
      "dispatch,listSpecs,maxChars,needsConfirm" &&
    completed.calls[0].maxRounds === 5 &&
    completed.calls[0].maxPerTool === 2 &&
    completed.calls[0].autoApprove === false &&
    typeof completed.calls[0].confirm === "function"
);
check(
  "cancellation boundary is appended only to dynamic context",
  completed.calls[0].dynamicContext.includes("手动取消边界") &&
    completed.calls[0].systemPrompt === "system"
);
check(
  "model metadata drives vision and a sanitized cache key",
  completed.calls[0].vision === true &&
    completed.calls[0].cacheKey ===
      "frx-v1:thread-complete:profile_main:vision-model"
);
check(
  "one active model client is created for the turn",
  completed.clientCreations.length === 1 &&
    !("profileId" in completed.clientCreations[0]) &&
    !("role" in completed.clientCreations[0])
);
check(
  "provider usage is normalized and persisted once",
  completed.usage.length === 1 &&
    completed.usage[0].requests === 1 &&
    completed.usage[0].inputTokens === 7 &&
    completed.usage[0].outputTokens === 3
);
check(
  "tool context keeps the thread workspace binding",
  completed.calls[0].toolCtx.workspaceRoot === "/work" &&
    completed.calls[0].toolCtx.target === "window"
);
check(
  "ledger and artifact ports remain available to AgentLoop",
  (await completed.calls[0].getLedger()) === "ledger" &&
    (
      await completed.calls[0].persistToolArtifact({
        id: "call/1",
        name: "page info",
        content: "{}",
      })
    ).path.includes("page_info_call_1.json") &&
    completed.writes.length === 1
);

const continued = makeHarness({
  turns: [
    {
      delta: "phase stream",
      result: {
        content: "phase one",
        stopReason: "max_rounds",
        messages: [
          { role: "system", content: "old system" },
          { role: "assistant", content: "phase one" },
        ],
      },
    },
    {
      delta: "final stream",
      result: { content: "all done", stopReason: "final" },
    },
  ],
});
await continued.orchestrator.run("thread-continue", {
  convo: [{ role: "user", content: "long task" }],
});
const continuedState = continued.core.getState("thread-continue");
check(
  "non-terminal result starts a fresh segment",
  continued.calls.length === 2 &&
    continuedState.checkpointSeq === 1 &&
    continued.messages.map(item => item.content).join(",") ===
      "phase one,all done"
);
check(
  "automatic continuation removes the old system message",
  !continued.calls[1].messages.some(message => message.role === "system") &&
    continued.calls[1].messages.at(-1).content.includes("自动续跑")
);
check(
  "new segment owns only its own live steps",
  continuedState.steps.length === 1 &&
    continuedState.steps[0].text === "final stream"
);

const failed = makeHarness({
  backendError: new Error("backend unavailable"),
});
await failed.orchestrator.run("thread-failed");
const failedState = failed.core.getState("thread-failed");
check(
  "setup failure still settles the runtime state",
  failedState.settled &&
    !failedState.running &&
    failedState.error === "backend unavailable"
);
check(
  "setup failure records a failed terminal status",
  failed.statuses.map(item => item.status).join(",") === "running,failed"
);
check(
  "failure before streamed progress does not create a fake assistant message",
  failed.messages.length === 0
);

console.log(
  `\nAgentTurnOrchestrator selftest: ${pass} passed, ${fail} failed`
);
process.exit(fail ? 1 : 0);
