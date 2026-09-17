import assert from "node:assert/strict";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
import { AgentSupervisor, createEvidenceReader, buildEvidencePacket, parseDirectorDecision } from "../modules/runtime/AgentSupervisor.sys.mjs";

const call = (id, name = "page_eval", args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const checkpoint = { phase: "P2", candidate: "r(t,o)", evidenceRefs: ["tool:1:1"], verified: ["入口"], unverified: ["随机填充"], proposedNextStep: "保留原实现初始化链" };
async function loop(batches, options = {}) {
  const dispatched = [], requests = [];
  const result = await runAgentTurn({
    client: { model: "test", async chat(messages, opts) {
      requests.push({ messages: structuredClone(messages), tools: opts.tools });
      const toolCalls = batches.shift() || [];
      return { content: "candidate_complete: true", toolCalls, finishReason: "stop" };
    } },
    router: { listSpecs: () => [{ type: "function", function: { name: "page_eval", parameters: { type: "object" } } }], needsConfirm: () => false,
      async dispatch(name) { dispatched.push(name); return { ok: true, data: { output: "sample matched" } }; } },
    messages: [{ role: "user", content: "test" }], maxRounds: 120, assist: true,
    stageGate: { stage: "DISCOVERY", scope: 1, toolBudget: 90 },
    ...options,
  });
  return { result, dispatched, requests };
}

let h = await loop([[call("a"), call("checkpoint", "stage_checkpoint", checkpoint), call("must-not-run")]]);
assert.equal(h.result.stopReason, "stage_checkpoint");
assert.equal(h.result.checkpoint.phase, "P2");
assert.deepEqual(h.dispatched, ["page_eval"]);
assert.equal(h.requests.length, 1, "no extra Worker summary call");
assert.equal(h.result.messages.filter(m => m.role === "tool").length, 3, "all batch tool calls have protocol replies");
assert.equal(JSON.parse(h.result.messages.at(-1).content).skipped, true);
assert.equal(h.result.toolCalls[0].evidenceId, "tool:1:1");
assert.ok(h.result.messages.find(m => m.tool_call_id === "a").content.includes("tool:1:1"));

h = await loop([Array.from({ length: 95 }, (_, i) => call(`batch-${i}`))]);
assert.equal(h.result.stopReason, "segment_budget");
assert.equal(h.dispatched.length, 90);
assert.equal(h.result.messages.filter(m => m.role === "tool").length, 95);
assert.equal(h.result.toolCalls.length, 90, "skipped tail is not evidence");
assert.equal(h.requests.length, 1);

h = await loop(Array.from({ length: 95 }, (_, i) => [call(`round-${i}`)]));
assert.equal(h.dispatched.length, 90);
assert.equal(h.requests.length, 90);

h = await loop([[call("bad", "stage_checkpoint", { phase: "P2" }), call("a")], []]);
assert.equal(h.result.stopReason, "final");
assert.equal(h.dispatched.length, 1, "invalid checkpoint cannot change stage");

h = await loop([[call("a"), call("b")], []], { stageGate: null });
assert.equal(h.dispatched.length, 2);
assert.ok(!h.requests[0].tools.some(t => t.function.name === "stage_checkpoint"), "ordinary modes unchanged");

let dispatchCount = 0;
h = await loop([Array.from({ length: 35 }, (_, i) => call(`pending-${i}`))], { stageGate: { stage: "DISCOVERY", scope: 1, toolBudget: 30, onDispatch: () => dispatchCount++ } });
assert.equal(h.dispatched.length, 30);
assert.equal(dispatchCount, 30, "runtime counter only observes actual dispatch, not skipped tail");
assert.equal(h.result.messages.filter(m => m.role === "tool").length, 35);
h = await loop([[call("denied")], []], { router: { listSpecs: () => [], needsConfirm: () => true, dispatch: async () => { throw new Error("must not dispatch"); } }, onConfirm: async () => false, autoApprove: false, stageGate: { stage: "DISCOVERY", scope: 1, toolBudget: 30, onDispatch: () => dispatchCount++ } });
assert.equal(dispatchCount, 30, "denied tool does not consume dispatch budget");

const records = [
  { evidenceId: "tool:1:1", name: "page_eval", args: { expression: "r(t,o)" }, env: { ok: true, data: { output: "observed:" + "x".repeat(8000) } } },
  { evidenceId: "tool:1:2", name: "fs_write", args: { path: "out/main.js" }, env: { ok: true, data: { content: "algorithm proven" } } },
  { evidenceId: "tool:1:3", name: "run_node", args: {}, env: { ok: true, data: { ok: false, exitCode: 1, output: "failure" } } },
  { evidenceId: "tool:1:4", name: "page_eval", args: {}, env: { ok: true, data: { _truncated: true, preview: "matched" } } },
];
const readEvidence = createEvidenceReader(records);
const first = readEvidence({ evidenceId: "tool:1:1", limit: 100 });
assert.equal(first.content.length, 100);
assert.equal(first.nextOffset, 100);
assert.equal(readEvidence({ evidenceId: "tool:1:1", offset: 100, limit: 100 }).offset, 100);
assert.equal(first.reviewable, true);
for (const id of ["tool:1:2", "tool:1:3", "tool:1:4"]) assert.equal(readEvidence({ evidenceId: id }).reviewable, false);
for (const args of [{ evidenceId: "../../ledger.md" }, { evidenceId: "tool:99:1" }, { evidenceId: "tool:1:1", limit: 6001 }, { evidenceId: "tool:1:1", offset: -1 }]) assert.throws(() => readEvidence(args));
const many = [...records, ...Array.from({ length: 30 }, (_, i) => ({ ...records[0], evidenceId: `tool:2:${i}` }))];
const packet = { ...buildEvidencePacket({ result: { checkpoint, stopReason: "stage_checkpoint", toolCalls: many } }), stage: "DISCOVERY" };
assert.ok(packet.evidence.some(e => e.id === "tool:1:1"), "selected early evidence survives recent-result cap");
assert.ok(packet.evidence.length <= 24);
const approval = { action: "continue", nextStage: "IMPLEMENTATION", reason: "入口证据充分，保留未知项", p2Review: { entry: "observed", inputs: "t,o", outputScope: "中间值", stateAndEncoding: "状态需保留", limitations: "尚未证明独立实现", evidenceRefs: ["tool:1:1"] } };
assert.equal(parseDirectorDecision(JSON.stringify(approval), packet).p2Approved, false, "summary-only approval rejected");
const readPacket = { ...packet, evidenceReads: [{ ...first, ok: true }] };
assert.equal(parseDirectorDecision(JSON.stringify(approval), readPacket).p2Approved, true);
assert.equal(parseDirectorDecision(JSON.stringify(approval), { ...readPacket, checkpoint: null }).p2Approved, false);
assert.equal(parseDirectorDecision(JSON.stringify({ ...approval, nextStage: "ACCEPTANCE" }), readPacket).nextStage, "DISCOVERY");
assert.equal(parseDirectorDecision(JSON.stringify({ ...approval, p2Review: { ...approval.p2Review, evidenceRefs: ["tool:unknown"] } }), readPacket).p2Approved, false);
assert.equal(parseDirectorDecision(JSON.stringify({ ...approval, p2Review: { ...approval.p2Review, outputScope: "" } }), readPacket).p2Approved, false);
assert.equal(parseDirectorDecision(JSON.stringify({ ...approval, action: "finish" }), { ...readPacket, trigger: "final_candidate", directorRuns: [{ id: "director:1:1", ok: true }] }).finalAccepted, false);

let attempts = 0;
const directorRequests = [];
const responses = [{ toolCalls: [call("read", "evidence_read", { evidenceId: "tool:1:1" })] }, { content: JSON.stringify(approval) }];
let review = await new AgentSupervisor().review({ packet, readEvidence: args => { attempts++; return readEvidence(args); }, client: { async chat(messages, options) { directorRequests.push(options); return responses.shift(); } } });
assert.equal(review.decision.p2Approved, true);
assert.equal(attempts, 1);
assert.deepEqual(directorRequests[0].tools.map(t => t.function.name), ["evidence_read"]);
let n = 0;
attempts = 0;
review = await new AgentSupervisor().review({ packet, readEvidence: args => { attempts++; return readEvidence(args); }, client: { async chat() {
  return n++ === 0 ? { toolCalls: [call("r1", "evidence_read", { evidenceId: "tool:1:1" }), call("r2", "evidence_read", { evidenceId: "tool:1:1", offset: 100 }), call("r3", "evidence_read", { evidenceId: "tool:1:1" })] } : { content: JSON.stringify(approval) };
} } });
assert.equal(attempts, 2, "read budget is enforced across batch");
const finalDecision = { action: "finish", reason: "真实业务响应符合目标", finalAcceptance: { independentArtifactVerified: true, liveRequestVerified: true, evidenceRefs: ["director:1:1"] } };
const combinedResponses = [
  { toolCalls: [call("read", "evidence_read", { evidenceId: "tool:1:1" })] },
  { content: JSON.stringify(approval) },
  { toolCalls: [call("execute", "run_node", { file: "out/main.js" })] },
  { content: JSON.stringify(finalDecision) },
];
const combinedTools = [];
let executed = 0;
review = await new AgentSupervisor().review({ packet: { ...packet, pendingFinal: true, trigger: "final_candidate", reviewIndex: 1 }, readEvidence,
  executeTool: async () => { executed++; return { ok: true, data: { ok: true, exitCode: 0, output: 'HTTP 200 {"data":[1]}' } }; },
  client: { async chat(messages, options) { combinedTools.push(options.tools?.map(t => t.function.name)); return combinedResponses.shift(); } },
});
assert.equal(review.decision.finalAccepted, true);
assert.equal(review.decision.p2Approved, true);
assert.equal(executed, 1);
assert.deepEqual(combinedTools[0], ["evidence_read"]);
assert.deepEqual(combinedTools[2], ["run_node", "run_python"]);
assert.equal(review.decision.evidenceReads.length, 1);

console.log("Stage gates: PASS (90-call budgets, raw evidence, P2 guards, combined P2/final acceptance)");
