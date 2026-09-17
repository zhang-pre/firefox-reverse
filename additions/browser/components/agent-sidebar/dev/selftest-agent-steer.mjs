import assert from "node:assert/strict";
import { createAgentRuntime } from "../modules/runtime/AgentRuntime.sys.mjs";
import { AgentRuntimeCore } from "../modules/runtime/AgentRuntimeCore.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";

const reply = (content = "done", toolCalls = []) => ({ content, toolCalls, finishReason: "stop" });
const call = id => ({ id, type: "function", function: { name: "echo", arguments: "{}" } });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("test condition timed out");
}
function harness({ chat, dispatch, confirm = false, append, directorChat } = {}) {
  const history = [], requests = [], dispatches = [];
  const config = {
    getContextStrategy: () => "legacy",
    getActiveModelProfile: () => null,
    getActiveProvider: () => "test",
    getModel: () => "test",
    getWorkerModelProfileId: () => "worker",
    getDirectorModelProfileId: () => "director",
  };
  const client = {
    model: "test", providerId: "test", protocol: "openai",
    async chat(messages, options) {
      requests.push(structuredClone(messages));
      return chat ? chat(messages, options, requests.length) : reply();
    },
  };
  const router = {
    listSpecs: () => [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
    needsConfirm: () => confirm,
    async dispatch(name, args, ctx) {
      dispatches.push(name);
      return dispatch ? dispatch(name, args, ctx) : { ok: true, data: "ok" };
    },
  };
  const runtime = createAgentRuntime({
    clock: { now: Date.now, setTimeout, clearTimeout },
    config,
    conversations: {
      consumeCancellationBoundary: async () => false,
      setThreadTurnStatus: async () => {},
      getThread: async () => null,
      getModelMessages: async () => [],
      setContextProjection: async () => {},
      addThreadUsage: async () => {},
      async appendMessage(id, message) {
        if (append) await append(id, message);
        history.push({ id, ...structuredClone(message) });
      },
    },
    llm: {
      transport: { fetch: async () => { throw Error("no network"); }, createAbortController: () => new AbortController(), setTimeout, clearTimeout },
      createClient: ({ role }) => role === "director" ? { ...client, chat: directorChat } : client,
      isVisionModel: () => false,
    },
    tools: {
      getRouter: () => router,
      getBackends: () => ({ ledger: { digest: async () => "", mergeHandoff: async () => {} }, workspace: { write: async () => ({}) } }),
      createContext: input => input,
    },
  });
  return {
    runtime, requests, history, dispatches,
    run: (options = {}) => runtime.run("t", { convo: [{ role: "user", content: "original" }], assist: true, maxRounds: 5, ...options }),
  };
}

// Runtime admission, FIFO, snapshot isolation, thread isolation and run reset.
{
  const core = new AgentRuntimeCore();
  assert.equal(core.enqueueSteer("t", "x").ok, false);
  const state = core.beginRun("t");
  state.abort = new AbortController();
  assert.equal(core.beginRun("t"), null);
  assert.equal(core.enqueueSteer("t", " ").ok, false);
  assert.equal(core.enqueueSteer("other", "x").ok, false);
  core.enqueueSteer("t", "one");
  core.enqueueSteer("t", "two");
  core.getState("t").steering[0].content = "mutated";
  assert.deepEqual(core.takeSteering(state).map(x => x.content), ["one", "two"]);
  core.abortThread("t");
  assert.ok(state.abort.signal.aborted);
  assert.ok(state.steering.every(x => x.status === "cancelled"));
  assert.equal(core.enqueueSteer("t", "late").ok, false);
  core.settle(state);
  assert.deepEqual(core.beginRun("t").steering, []);
  core.settle(state);
}

// An in-flight LLM finishes; steering supersedes its unstarted tool batch.
{
  const gate = deferred();
  const h = harness({ chat: async (_m, _o, n) => n === 1 ? gate.promise : reply("redirected") });
  const run = h.run();
  await until(() => h.requests.length === 1);
  assert.ok(h.runtime.steer("t", "first").ok);
  assert.ok(h.runtime.steer("t", "second").ok);
  assert.equal(h.requests.length, 1);
  gate.resolve(reply("old direction", [call("a"), call("b")]));
  await run;
  assert.deepEqual(h.dispatches, []);
  const next = h.requests[1];
  assert.deepEqual(next.filter(x => x.role === "tool").map(x => x.tool_call_id), ["a", "b"]);
  assert.deepEqual(next.slice(-2).map(x => x.content), ["first", "second"]);
  assert.deepEqual(h.history.filter(x => x.role === "user").map(x => x.content), ["first", "second"]);
  assert.ok(h.runtime.getState("t").steering.every(x => x.status === "applied"));
  assert.equal(h.runtime.getRunLog().length, 1);
  h.runtime.dispose();
}

// Finish the active tool, skip the rest, then let the same run see the message.
{
  const gate = deferred();
  const h = harness({
    chat: async (_m, _o, n) => n === 1 ? reply("", [call("a"), call("b")]) : reply(),
    dispatch: async () => gate.promise,
  });
  const run = h.run();
  await until(() => h.dispatches.length === 1);
  h.runtime.steer("t", "change direction");
  assert.equal(h.runtime.getState("t").steering[0].status, "queued");
  gate.resolve({ ok: true, data: "finished active tool" });
  await run;
  assert.equal(h.dispatches.length, 1);
  assert.ok(h.requests[1].some(x => x.content === "change direction"));
  h.runtime.dispose();
}

// A text-only final response cannot swallow an accepted steer.
{
  const gate = deferred();
  const h = harness({ chat: async (_m, _o, n) => n === 1 ? gate.promise : reply("new answer") });
  const run = h.run();
  await until(() => h.requests.length === 1);
  h.runtime.steer("t", "new request");
  gate.resolve(reply("old final"));
  await run;
  assert.equal(h.requests.length, 2);
  assert.equal(h.runtime.getState("t").content, "new answer");
  h.runtime.dispose();
}

// Steering declines pending approval; it never approves or dispatches that tool.
{
  const h = harness({ confirm: true, chat: async (_m, _o, n) => n === 1 ? reply("", [call("a")]) : reply() });
  const run = h.run({ confirmMode: true });
  await until(() => h.runtime.getState("t")?.pendingConfirm);
  h.runtime.steer("t", "do not run that");
  await run;
  assert.deepEqual(h.dispatches, []);
  assert.equal(h.runtime.getState("t").pendingConfirm, null);
  h.runtime.dispose();
}

// Stop cancels pending steering, never queues follow-up work in the next run.
{
  const gate = deferred();
  const h = harness({ chat: async (_m, _o, n) => n === 1 ? gate.promise : reply() });
  const run = h.run();
  await until(() => h.requests.length === 1);
  h.runtime.steer("t", "pending");
  h.runtime.stop("t");
  gate.resolve(reply());
  await run;
  assert.equal(h.runtime.getState("t").steering[0].status, "cancelled");
  assert.equal(h.history.some(x => x.content === "pending"), false);
  await h.run();
  assert.deepEqual(h.runtime.getState("t").steering, []);
  assert.equal(h.requests[1].some(x => x.content === "pending"), false);
  h.runtime.dispose();
}

// Failure to persist a steer must not silently send it to the model.
{
  const gate = deferred();
  const h = harness({
    chat: async () => gate.promise,
    append: async (_id, message) => { if (message.role === "user") throw Error("disk failed"); },
  });
  const run = h.run();
  await until(() => h.requests.length === 1);
  h.runtime.steer("t", "unsaved");
  gate.resolve(reply());
  await run;
  assert.equal(h.requests.length, 1);
  assert.match(h.runtime.getState("t").error, /disk failed/);
  assert.equal(h.runtime.getState("t").steering[0].status, "cancelled");
  h.runtime.dispose();
}

// Admission is already closed while the final assistant is being persisted.
{
  const gate = deferred();
  let saving = false;
  const h = harness({ append: async () => { saving = true; await gate.promise; } });
  const run = h.run();
  await until(() => saving);
  assert.equal(h.runtime.steer("t", "too late").ok, false);
  gate.resolve();
  await run;
  h.runtime.dispose();
}

// A pending steer invalidates the old Director decision; its next review sees it.
{
  const gate = deferred();
  const reviews = [];
  const decision = { action: "ask_user", reason: "need input", instruction: "report", finalAccepted: false };
  const h = harness({
    chat: async () => reply("candidate_complete: true"),
    directorChat: async messages => {
      reviews.push(structuredClone(messages));
      return reviews.length === 1 ? gate.promise : reply(JSON.stringify(decision));
    },
  });
  const run = h.run({ supervised: true, convo: [{ role: "user", content: "original".repeat(1000) }] });
  await until(() => reviews.length === 1);
  h.runtime.steer("t", "updated objective");
  gate.resolve(reply(JSON.stringify(decision)));
  await run;
  assert.equal(reviews.length, 2);
  assert.match(JSON.stringify(reviews[1]), /updated objective/);
  assert.equal(h.runtime.getRunLog().length, 1);
  h.runtime.dispose();
}
// Exact corrections survive compression even if the model's summary omits them.
{
  let round = 0, summaries = 0, injected = false;
  const requests = [];
  await runAgentTurn({
    client: { model: "test", async chat(messages, options) {
      if (!options.tools) { summaries++; return reply("summary without user correction"); }
      requests.push(structuredClone(messages));
      round++;
      return round <= 7 ? reply("", [call("c" + round)]) : reply("done");
    } },
    router: {
      listSpecs: () => [], needsConfirm: () => false,
      dispatch: async () => ({ ok: true, data: "x".repeat(49000) }),
    },
    messages: [{ role: "user", content: "original task" }],
    maxRounds: 10, assist: true, autoApprove: true,
    hasSteering: () => round === 1 && !injected,
    consumeSteering: async () => {
      if (round !== 1 || injected) return [];
      injected = true;
      return [{ role: "user", content: "EXACT_USER_CORRECTION" }];
    },
  });
  assert.ok(summaries > 0);
  assert.match(JSON.stringify(requests.at(-1)), /EXACT_USER_CORRECTION/);
}
console.log("Steer selftest: all passed");
