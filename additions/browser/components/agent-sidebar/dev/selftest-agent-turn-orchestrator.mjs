import { AgentRuntimeCore } from "../modules/runtime/AgentRuntimeCore.sys.mjs";
import { defineAgentRuntimePorts } from "../modules/runtime/AgentRuntimePorts.sys.mjs";
import { AgentTurnOrchestrator } from "../modules/runtime/AgentTurnOrchestrator.sys.mjs";
import {
  buildEvidencePacket,
  inferDirectorTrigger,
  parseDirectorDecision,
} from "../modules/runtime/AgentSupervisor.sys.mjs";
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
  directorDecisions = [],
  summaryError = false,
} = {}) {
  let clock = 1000;
  const calls = [];
  const messages = [];
  const statuses = [];
  const usage = [];
  const writes = [];
  const directorCalls = [];
  const clientCreations = [];
  const order = [];
  const summaryCalls = [];
  const router = {
    name: "test-router",
    listSpecs: () => [],
    needsConfirm: () => false,
    async dispatch(name, args, ctx) {
      order.push("director-tool");
      if (name !== "run_node" || args.file !== "out/solver.js" || ctx.workspaceRoot !== "/work") throw new Error("wrong verification context");
      return { ok: true, data: { ok: true, exitCode: 0, output: 'HTTP 200 {"data":[1,2]}' } };
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
    async chat(messages, options) {
      order.push("worker-summary");
      summaryCalls.push({ messages, options });
      if (summaryError) throw new Error("summary unavailable");
      return { content: "已验证：入口已定位。未完成：接口实打仍失败。证据：HTTP 403。产物 out/solver.js 尚未验收。是否风控未知；需确认网络访问条件后恢复。", usage: { prompt_tokens: 4, completion_tokens: 3 } };
    },
  };
  const directorClient = {
    providerId: "director-mock",
    protocol: "openai",
    model: "director-model",
    async chat(requestMessages, options) {
      order.push("director");
      directorCalls.push({ messages: requestMessages, options });
      const next = directorDecisions.shift();
      return {
        ...(next?.toolCalls ? next : { content: JSON.stringify(next) }),
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      };
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
      getModelProfile: id => ({ id, provider: "mock", model: id }),
      getWorkerModelProfileId: () => "worker-profile",
      getDirectorModelProfileId: () => "director-profile",
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
        return input.role === "director" ? directorClient : client;
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
      order.push("worker");
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
    directorCalls,
    clientCreations,
    order,
    summaryCalls,
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

const incompletePacket = buildEvidencePacket({
  objective: "produce a verified client",
  result: {
    content: "candidate_complete: true",
    stopReason: "final",
    toolCalls: [],
  },
});
check(
  "explicit incomplete evidence cannot be mistaken for a final candidate",
  inferDirectorTrigger({
    content: "phase: P2\ncandidate_complete: false\nP2 已完成",
    stopReason: "final",
  }) === "stage_gate"
);
const failedArtifactPacket = buildEvidencePacket({
  result: {
    content: "candidate_complete: false",
    toolCalls: [
      {
        id: "failed-file",
        name: "fs_write",
        args: { path: "out/not-created.js" },
        env: { ok: false, error: "write failed" },
      },
    ],
  },
});
check(
  "failed tool calls cannot create artifact evidence",
  failedArtifactPacket.artifacts.length === 0
);
const rejectedFinish = parseDirectorDecision(
  JSON.stringify({
    action: "finish",
    reason: "worker says it is done",
    guidance: "run the missing verification",
    nextPhase: "P6",
    requiredEvidence: ["standalone artifact", "live response"],
    finalAcceptance: {
      independentArtifactVerified: true,
      liveRequestVerified: true,
      evidenceRefs: ["made-up"],
    },
  }),
  incompletePacket
);
check(
  "finish is rejected when artifact/live evidence cannot be resolved",
  rejectedFinish.action === "continue" && !rejectedFinish.finalAccepted
);

const supervised = makeHarness({
  turns: [
    {
      delta: "worker phase one",
      result: {
        content:
          "[WORKER_EVIDENCE]\nphase: P4\ncandidate_complete: false\n[/WORKER_EVIDENCE]",
        stopReason: "final",
        messages: [
          { role: "user", content: "build a verified client" },
          { role: "assistant", content: "phase P4" },
        ],
        toolCalls: [
          {
            id: "file-1",
            name: "fs_write",
            args: { path: "out/solver.js" },
            env: { ok: true, data: { path: "out/solver.js" } },
          },
        ],
      },
    },
    {
      delta: "worker final",
      result: {
        content:
          "[WORKER_EVIDENCE]\nphase: P6\ncandidate_complete: true\n[/WORKER_EVIDENCE]",
        stopReason: "final",
        messages: [{ role: "assistant", content: "phase P6" }],
        toolCalls: [
          {
            id: "live-1",
            name: "run_node",
            args: {
              file: "out/solver.js",
              url: "https://api.example.test/data",
            },
            env: {
              ok: true,
              data: { statusCode: 200, response: { records: 2 } },
            },
          },
        ],
      },
    },
  ],
  directorDecisions: [
    {
      action: "redirect",
      reason: "缺少真实接口成功响应",
      guidance: "运行独立脚本并保留 HTTP 状态与响应摘要",
      nextPhase: "P6",
      requiredEvidence: ["live request"],
      finalAcceptance: {
        independentArtifactVerified: false,
        liveRequestVerified: false,
        evidenceRefs: ["tool:file-1"],
      },
    },
    { toolCalls: [{ id: "verify-1", type: "function", function: { name: "run_node", arguments: JSON.stringify({ file: "out/solver.js", args: [] }) } }] },
    {
      action: "finish",
      reason: "独立产物和真实接口响应均已由工具证明",
      guidance: "",
      nextPhase: "",
      requiredEvidence: [],
      finalAcceptance: {
        independentArtifactVerified: true,
        liveRequestVerified: true,
        evidenceRefs: ["director:2:1"],
      },
    },
  ],
});
await supervised.orchestrator.run("thread-supervised", {
  convo: [{ role: "user", content: "build a verified client" }],
  supervised: true,
  workspaceRoot: "/work",
});
const supervisedState = supervised.core.getState("thread-supervised");
check(
  "supervised mode is strictly sequential",
  supervised.order.join(",") === "worker,director,worker,director,director-tool,director"
);
check(
  "Director only receives execution tools at final acceptance",
  supervised.directorCalls.length === 3 &&
    supervised.directorCalls[0].options.tools == null &&
    supervised.directorCalls[1].options.tools.map(t => t.function.name).join(",") === "run_node,run_python"
);
check(
  "worker and Director use their selected model profiles",
  supervised.clientCreations.map(call => `${call.role}:${call.profileId}`).join(",") ===
    "worker:worker-profile,director:director-profile"
);
check(
  "Director redirect is injected into the next Worker stage",
  supervised.calls.length === 2 &&
    supervised.calls.every(call => call.assist === true) &&
    supervised.calls[1].messages.at(-1).content.includes("Director 决策：redirect")
);
check(
  "final acceptance keeps a visible Director decision and evidence-backed result",
  supervisedState.settled &&
    supervisedState.content.includes("Director 最终验收") &&
    supervisedState.steps.some(
      step => step.kind === "director" && step.action === "finish"
    )
);
check(
  "supervised segments and Director usage are persisted",
  supervised.messages.length === 2 &&
    supervised.usage.length === 1 &&
    supervised.usage[0].requests === 3
);

const blockedTurn = () => ({ result: {
  content: "candidate_complete: false\nblocked: true\n接口 HTTP 403；原因未知",
  stopReason: "final",
  toolCalls: [{ id: "request", name: "run_node", args: { file: "out/solver.js" }, env: { ok: true, data: { ok: false, exitCode: 1, output: "HTTP 403" } } }],
} });
const rejection = () => ({ action: "continue", blocked: true, blocker: "HTTP 403", reason: "修复仍未成功", guidance: "检查访问条件", requiredEvidence: ["成功响应"] });
const stuck = makeHarness({ turns: Array.from({ length: 5 }, blockedTurn), directorDecisions: Array.from({ length: 5 }, rejection) });
await stuck.orchestrator.run("stuck", { supervised: true, workspaceRoot: "/work", convo: [{ role: "user", content: "完成客户端" }] });
check("three blocked reviews stop execution and request one Worker report", stuck.calls.length === 3 && stuck.directorCalls.length === 3 && stuck.summaryCalls.length === 1);
check("report is tool-free and is never sent for another Director review", stuck.summaryCalls[0].options.tools == null && stuck.order.at(-1) === "worker-summary");
check("stopped task remains incomplete and records the stop decision", stuck.statuses.at(-1).status === "failed" && stuck.core.getState("stuck").content.includes("任务未完成") && stuck.core.getState("stuck").steps.some(s => s.action === "stop" && !s.finalAccepted));
check("Director receives retry count and previous reasons", JSON.parse(stuck.directorCalls[2].messages[1].content.split("\n").slice(1).join("\n")).retryBudget.consecutiveFailures === 2);

const rejectedFinals = makeHarness({
  turns: Array.from({ length: 4 }, () => ({ result: { ...blockedTurn().result, content: "candidate_complete: true" } })),
  directorDecisions: Array.from({ length: 4 }, () => ({ ...rejection(), blocked: false })),
});
await rejectedFinals.orchestrator.run("final-rejections", { supervised: true, workspaceRoot: "/work" });
check("three rejected final candidates stop even if Director omits blocked", rejectedFinals.calls.length === 3 && rejectedFinals.summaryCalls.length === 1);

const progress = makeHarness({
  turns: Array.from({ length: 6 }, () => ({ result: { ...blockedTurn().result, content: "candidate_complete: false", toolCalls: [{ name: "fs_read", env: { ok: true, data: { content: "new evidence" } } }] } })),
  directorDecisions: [rejection(), rejection(), { ...rejection(), blocked: false, reason: "已取得可验证进展" }, rejection(), rejection(), rejection()],
});
await progress.orchestrator.run("progress", { supervised: true, workspaceRoot: "/work" });
check("a productive intermediate stage resets consecutive blocker count", progress.calls.length === 6 && progress.summaryCalls.length === 1);

for (const action of ["stop", "ask_user"]) {
  const early = makeHarness({ turns: [blockedTurn()], directorDecisions: [{ ...rejection(), action }], summaryError: true });
  await early.orchestrator.run(`early-${action}`, { supervised: true, workspaceRoot: "/work" });
  check(`${action} stops immediately and preserves evidence when report generation fails`, early.calls.length === 1 && early.summaryCalls.length === 1 && early.core.getState(`early-${action}`).content.includes("HTTP 403") && early.statuses.at(-1).status === "failed");
}

const capped = makeHarness({ turns: Array.from({ length: 12 }, () => ({ result: { ...blockedTurn().result, content: "candidate_complete: false", toolCalls: [{ name: "fs_read", env: { ok: true, data: { content: "new evidence" } } }] } })), directorDecisions: Array.from({ length: 12 }, () => ({ ...rejection(), blocked: false })) });
await capped.orchestrator.run("review-cap", { supervised: true, workspaceRoot: "/work" });
check("overall review cap also produces a final Worker report", capped.calls.length === 12 && capped.summaryCalls.length === 1 && capped.statuses.at(-1).status === "failed");

const failedTools = makeHarness({ turns: Array.from({ length: 4 }, () => ({ result: { ...blockedTurn().result, content: "candidate_complete: false" } })), directorDecisions: Array.from({ length: 4 }, () => ({ ...rejection(), blocked: false })) });
await failedTools.orchestrator.run("failed-tools", { supervised: true, workspaceRoot: "/work" });
check("failed subprocess envelopes cannot reset the retry budget", failedTools.calls.length === 3 && failedTools.summaryCalls.length === 1);

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
