import assert from "node:assert/strict";
import fs from "node:fs";
import { createTurnContext, modelBudget } from "../modules/state/TurnContext.sys.mjs";

const history = () => [
  { role: "user", content: "original", steps: ["UI only"] },
  { role: "assistant", content: "progress", tool_calls: [{ id: "c1", function: { name: "echo", arguments: "{}" } }], reasoning_content: "reason" },
  { role: "tool", tool_call_id: "c1", content: "x".repeat(1000) },
];
const smallBudget = { compactAt: 100, maxChars: 300, resultCap: 50 };
function options(extra = {}) {
  return {
    client: { model: "test", chat: async () => ({ content: "handoff", usage: { total_tokens: 3 } }) },
    messages: history(),
    systemPrompt: "stable system",
    dynamicContext: "workspace=/work",
    budget: smallBudget,
    ...extra,
  };
}

// Policies remain the same after moving out of AgentLoop.
assert.deepEqual(modelBudget("unknown"), { compactAt: 250000, maxChars: 320000, resultCap: 50000 });
assert.deepEqual(modelBudget("deepseek-v4-flash"), { compactAt: 800000, maxChars: 1000000, resultCap: 150000 });

// Sanitization and context setup never mutate source history or system policy.
{
  const source = history();
  const before = structuredClone(source);
  const ctx = await createTurnContext(options({ messages: source }));
  assert.deepEqual(source, before);
  assert.equal(ctx.initialMessages[0].content, "stable system");
  assert.match(ctx.initialMessages[1].content, /workspace=\/work/);
  assert.equal(ctx.initialMessages[1].steps, undefined);
  assert.equal(ctx.initialMessages[2].reasoning_content, "reason");
  assert.equal(ctx.initialMessages[3].tool_call_id, "c1");
  const restored = await createTurnContext(options({ messages: ctx.initialMessages.slice(1) }));
  assert.equal((restored.initialMessages[1].content.match(/workspace=\/work/g) || []).length, 1);
}

// Cadence, checkpoint ordering, model cache key/signal/usage, fresh ledger and steering.
{
  const order = [], requests = [], usages = [];
  let ledger = 0;
  const controller = new AbortController();
  const ctx = await createTurnContext(options({
    client: { model: "test", chat: async (messages, opts) => {
      requests.push({ messages, opts });
      return { content: "summary", usage: { total_tokens: 3 } };
    } },
    getLedger: async () => "ledger=" + (++ledger),
    cacheKey: "cache", signal: controller.signal,
    onUsage: (usage, info) => usages.push({ usage, info }),
    onEvent: () => order.push("event"),
    onCheckpoint: async () => order.push("persist"),
  }));
  const source = ctx.initialMessages;
  ctx.appendSteering(source, [{ role: "user", content: "exact correction", steps: ["discard"] }]);
  assert.equal(source.at(-1).steps, undefined);
  assert.equal(await ctx.compact(1, source), source);
  const compacted = await ctx.compact(2, source);
  assert.notEqual(compacted, source);
  assert.equal(compacted[0].content, "stable system");
  assert.match(compacted[1].content, /original[\s\S]*exact correction/);
  assert.match(compacted[1].content, /ledger=2/);
  assert.equal(compacted[2].content, "summary");
  assert.deepEqual(order, ["event", "persist"]);
  assert.equal(requests[0].opts.cacheKey, "cache:handoff");
  assert.equal(requests[0].opts.signal, controller.signal);
  assert.equal(requests[0].opts.tools, undefined);
  assert.ok(requests[0].messages.every(m => !m.tool_calls && !m.tool_call_id));
  assert.equal(usages[0].info.phase, "handoff");
  assert.equal(await ctx.compact(3, compacted), compacted);
  assert.equal(requests.length, 1);
}

// Model, observer, persistence and ledger failures retain the mechanical fallback.
{
  let reads = 0;
  const ctx = await createTurnContext(options({
    client: { chat: async () => { throw Error("offline"); } },
    getLedger: async () => { if (++reads > 1) throw Error("ledger unavailable"); return "initial ledger"; },
    onEvent: () => { throw Error("observer"); },
    onCheckpoint: async () => { throw Error("disk"); },
  }));
  const compacted = await ctx.compact(2, ctx.initialMessages);
  assert.match(compacted[2].content, /进展存档·自动压缩/);
  assert.match(compacted[2].content, /echo/);
  assert.match(compacted[1].content, /initial ledger/);
}

// Request trimming is a view, preserving head and matching tool-result ancestry.
{
  const ctx = await createTurnContext(options());
  const messages = [{ role: "system", content: "policy" }, { role: "user", content: "task" }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", tool_calls: [{ id: "t" + i, function: { name: "echo", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: "t" + i, content: "x".repeat(200) });
  }
  const before = structuredClone(messages);
  const request = ctx.requestMessages(messages);
  assert.deepEqual(messages, before);
  assert.equal(request[0], messages[0]);
  assert.equal(request[1], messages[1]);
  assert.ok(request.length < messages.length);
  const ids = new Set(request.flatMap(m => (m.tool_calls || []).map(call => call.id)));
  assert.ok(request.filter(m => m.role === "tool").every(m => ids.has(m.tool_call_id)));
}

// Parallel contexts do not share compaction cadence or steering anchors.
{
  const a = await createTurnContext(options());
  const b = await createTurnContext(options());
  a.appendSteering(a.initialMessages, [{ role: "user", content: "only A" }]);
  const ca = await a.compact(2, a.initialMessages);
  const cb = await b.compact(2, b.initialMessages);
  assert.match(ca[1].content, /only A/);
  assert.doesNotMatch(cb[1].content, /only A/);
  assert.notEqual(cb, b.initialMessages);
}

// Architectural guard: the loop delegates context algorithms to the state layer.
const loop = fs.readFileSync(new URL("../modules/runtime/AgentLoop.sys.mjs", import.meta.url), "utf8");
assert.match(loop, /from "\.\.\/state\/TurnContext\.sys\.mjs"/);
for (const name of ["function trimContext", "function buildCheckpointSummary", "function summarizeForHandoff", "const HANDOFF_PROMPT"]) {
  assert.equal(loop.includes(name), false, name + " must live outside AgentLoop");
}
const contextSource = fs.readFileSync(new URL("../modules/state/TurnContext.sys.mjs", import.meta.url), "utf8");
assert.doesNotMatch(contextSource, /ChromeUtils|resource:\/\/|from ["']\.\.\/runtime\//);
console.log("TurnContext selftest: all passed");
