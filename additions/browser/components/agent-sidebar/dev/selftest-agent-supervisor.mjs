import assert from "node:assert/strict";
import { AgentSupervisor } from "../modules/AgentSupervisor.sys.mjs";

const call = (file = "out/main.js", name = "run_node", extra = {}) => ({
  id: `call-${file}`, type: "function",
  function: { name, arguments: JSON.stringify({ file, ...extra }) },
});
const finish = {
  action: "finish", reason: "返回了目标业务数据", guidance: "", requiredEvidence: [],
  finalAcceptance: { independentArtifactVerified: true, liveRequestVerified: true, evidenceRefs: ["director:1:1"] },
};
const success = { ok: true, data: { ok: true, exitCode: 0, output: 'HTTP 200 {"data":[1]}' } };
async function run(responses, env = success, trigger = "final_candidate", controller = new AbortController()) {
  const executed = [], requests = [];
  const result = await new AgentSupervisor().review({
    packet: { trigger, reviewIndex: 1, artifacts: [{ id: "artifact:1", independentScriptCandidate: true, executionVerified: true }], evidence: [{ id: "tool:old", ok: true, liveRequestCandidate: true }] },
    signal: controller.signal,
    client: { async chat(messages, options) {
      requests.push({ messages: structuredClone(messages), options });
      return responses.shift() || { content: JSON.stringify(finish) };
    } },
    executeTool: async (name, args) => { executed.push({ name, args }); return typeof env === "function" ? env() : env; },
  });
  return { ...result, executed, requests };
}
let result = await run([{ content: JSON.stringify({ ...finish, finalAcceptance: { ...finish.finalAcceptance, evidenceRefs: ["artifact:1", "tool:old"] } }) }]);
assert.equal(result.decision.finalAccepted, false, "Worker history is not a fresh execution");

result = await run([{ toolCalls: [call()] }]);
assert.equal(result.decision.finalAccepted, true);
assert.equal(result.executed[0].args.timeoutMs, 30000);
assert.equal(result.requests[1].messages.at(-1).role, "tool");
assert.equal(result.decision.verificationRuns[0].file, "out/main.js");

result = await run([{ toolCalls: [call("out/main.py", "run_python")] }]);
assert.equal(result.decision.finalAccepted, true);
assert.equal(result.executed[0].name, "run_python");

for (const data of [
  { ok: false, exitCode: 1 },
  { ok: true, exitCode: 0, timedOut: true },
  { ok: true, exitCode: 0, aborted: true },
  { ok: true, exitCode: 0, capped: true },
  { _truncated: true, preview: "HTTP 200" },
  { ok: true, exitCode: 0, output: "x".repeat(7000) },
]) {
  result = await run([{ toolCalls: [call()] }], { ok: true, data });
  assert.equal(result.decision.action, "continue", JSON.stringify(data));
  assert.equal(result.decision.finalAccepted, false);
  assert.ok(result.decision.guidance.includes("director:1:1"));
}

result = await run([{ toolCalls: [call()] }, { content: JSON.stringify({ ...finish, action: "continue", reason: "HTTP 200 但业务 data 为空" }) }]);
assert.equal(result.decision.finalAccepted, false, "semantic rejection remains rejection despite exit 0");
result = await run([{ toolCalls: [call()] }, { content: JSON.stringify({ ...finish, requiredEvidence: ["第5页尚未验证"] }) }]);
assert.equal(result.decision.finalAccepted, false, "finish cannot retain unmet requirements");

for (const invalid of [call("out/../main.js"), call("work/main.js"), call("out/a\\main.js"), call("out/main.js", "fs_write"), call("out/main.js", "run_node", { code: "console.log(1)" })]) {
  result = await run([{ toolCalls: [invalid] }]);
  assert.equal(result.executed.length, 0, JSON.stringify(invalid));
  assert.equal(result.decision.finalAccepted, false);
}
result = await run([{ toolCalls: [call(), call(), call(), call()] }]);
assert.equal(result.executed.length, 3, "batch calls share the same budget");
assert.equal(result.requests[1].options.tools, undefined);
assert.equal(result.decision.finalAccepted, false);

result = await run([{ toolCalls: [call()] }, { toolCalls: [call()] }, { toolCalls: [call()] }, { toolCalls: [call()] }]);
assert.equal(result.executed.length, 3, "budget is per review, not per response");
assert.equal(result.decision.finalAccepted, false);

result = await run([{ toolCalls: [call()] }], success, "stage_gate");
assert.equal(result.executed.length, 0);
assert.equal(result.requests[0].options.tools, undefined);

result = await run([{ toolCalls: [call()] }], () => { throw new Error("process unavailable"); });
assert.equal(result.decision.finalAccepted, false);
assert.ok(result.decision.verificationRuns[0].error.includes("process unavailable"));

const controller = new AbortController();
await assert.rejects(run([{ toolCalls: [call(), call()] }], () => { controller.abort(); return success; }, "final_candidate", controller), /aborted/);
console.log("AgentSupervisor selftest: all passed (fresh execution, Node/Python, rejection, budgets, scope, cancellation)");
