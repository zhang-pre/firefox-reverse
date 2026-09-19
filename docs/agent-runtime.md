# Agent Runtime architecture

The Agent runtime is split into a platform-neutral core and Firefox adapters.
Dependency arrows must point from adapters toward the core, never back from the
core into privileged browser APIs.

## Layers

Sources are grouped under `additions/browser/components/agent-sidebar/modules/`:
`runtime/`, `llm/`, `providers/`,
`state/`, `tools/`, `backends/`, and `host/`.
The [module directory guide](../additions/browser/components/agent-sidebar/modules/README.md)
maps responsibilities and installation paths. All callers must import these grouped
paths. Flat compatibility URLs have been removed; external scripts must migrate
to the grouped paths as well.

1. **AgentRuntimeCore** owns in-memory thread state, event reduction,
   subscriptions, confirmation state, cancellation, and window reservations.
   It has no Firefox imports and is directly testable in Node.
2. **AgentRuntimePorts** validates and attenuates the host capabilities exposed
   to the portable runtime: clock, config, conversations, LLM, tools, and
   lifecycle.
3. **AgentRuntime** is the platform-neutral composition root. It assembles the
   state core, turn orchestrator, loop, and normalized ports.
4. **AgentTurnOrchestrator** coordinates projection, persistence, usage,
   checkpoints, and automatic continuation.
5. **AgentLoop** is the decision engine. It receives an LLM client, a tool
   router, messages, limits, and callbacks. It does not know which browser or
   operating system executes a tool.
6. **LlmClient** is the stable facade over LlmProtocol, LlmStreamParser,
   LlmRequestExecutor, and LlmTransport. Fetch, abort controllers, and timers
   are supplied through the transport port.
7. **FirefoxAgentRuntimeHost** adapts Firefox timers, shutdown, ToolRouter,
   backends, transport, and opaque host contexts to the formal ports.
8. **AgentSession** is the thin Firefox entry point. It creates the ports and
   exports the process-lifetime shared runtime used by the sidebar and MCP.
9. **Backends and AgentEvalChild** implement capabilities. These are outside the
   runtime core and are reached only through ToolRouter dispatch.

## Runtime flow

```text
AgentPanel
  -> AgentSession
     -> FirefoxAgentRuntimeHost -> AgentRuntimePorts
     -> AgentRuntime
        -> AgentRuntimeCore
        -> AgentTurnOrchestrator
           -> LlmClient -> LlmRequestExecutor -> LlmTransport
           -> AgentLoop -> ToolRouter -> Firefox backends -> JSWindowActor/Gecko
```

## Context ownership

- **state/ContextProjection** owns cross-turn model-history projection. The
  conversation store retains the full UI history and the persisted projection.
- **state/TurnContext** owns one turn's model budget, request trimming, sanitized
  history, task anchor, steering retention, handoff summary and compaction rebuild.
  Its injected client and callbacks keep it independent of Firefox and storage.
- **runtime/AgentLoop** chooses safe boundaries and calls TurnContext; it still
  owns LLM/tool execution, steering consumption, tool-result folding and loop guards.
- **runtime/AgentTurnOrchestrator** supplies checkpoint/usage callbacks and owns
  persistence, workspace handoff files and lifecycle. TurnContext never calls it
  directly.

TurnContext is created per loop segment. Its initialMessages seeds the loop;
requestMessages(history) returns a bounded request view without mutating history;
appendSteering(history, incoming) preserves corrections in the task anchor;
compact(round, history) returns the retained or rebuilt history.
The existing thresholds, handoff prompt and fallback behavior are unchanged.
Cross-turn projection and within-turn compaction intentionally remain separate.

## Steering the active run

- Idle Send starts a run. During a run, the UI sends text through
  `agentSession.steer(threadId, content)` and offers a separate Stop button.
- `steer` synchronously returns `{ ok, id }` or `{ ok: false, error }`.
  Acceptance means queued, not yet consumed. It never calls `run` or aborts.
- AgentRuntimeCore owns a per-run FIFO with snapshot receipts:
  `queued`, `applying`, `applied`, or `cancelled`. Up to 100 messages per run,
  at most 16,000 characters each. Snapshots do not expose mutable queue entries.
- AgentLoop reads the queue before requests and at response/tool boundaries.
  An active request or tool finishes normally; remaining unstarted tool calls
  get explicit skipped results before new user messages enter the model history.
  Pending approval is declined, never automatically granted by steering.
- Orchestrator persists consumed user messages. Corrections survive loop context
  compaction and are applied before the next model request.
- Finalization closes admission before persistence awaits. Rejected messages stay
  in the UI input. Stop aborts the current run and cancels unconsumed receipts.
  Queues are in memory, are not restored after process shutdown, and never carry
  into another run. Follow-up queues are not implemented.
- The UI fallback without a resident runtime does not support steering.

Run `bash scripts/selftest-agent-tools.sh` for mock-based regression coverage,
including `selftest-agent-steer.mjs`. No real provider requests are needed.

## Boundary rules

- Do not import `ChromeUtils`, `Services`, `IOUtils`, `PathUtils`, XPCOM,
  or browser backends from `AgentRuntimeCore`, `AgentLoop`, `LlmClient`, or
  `LlmTransport`.
- Pass the selected window, workspace, and cancellation signal through tool
  context instead of reading global focus state.
- Keep provider protocol conversion in the LLM protocol stack; keep API
  credentials in `ConfigStore`.
- Keep session persistence in `AgentTurnOrchestrator`/conversation ports, not in the
  state kernel.
- New privileged capabilities must be implemented as backends and registered in
  `Tools.sys.mjs`; they must not be called directly by the decision engine.
- A non-Firefox host can reuse the core by supplying timers, lifecycle hooks, an
  LLM transport, a router, and persistence adapters.

## Extension points

- **New scheduling policy:** extend `AgentTurnOrchestrator` while keeping
  `AgentLoop.runAgentTurn` platform-neutral.
- **New model protocol:** add protocol codecs in `LlmProtocol`; transport stays
  unchanged.
- **Proxy, replay, or offline inference:** inject a different `LlmTransport`.
- **New browser capability:** add a backend, wire it in `Backends.sys.mjs`, and
  declare its public schema in `Tools.sys.mjs`.
- **New host application:** compose `AgentRuntimeCore` with a host adapter
  equivalent to `FirefoxAgentRuntimeHost`.
