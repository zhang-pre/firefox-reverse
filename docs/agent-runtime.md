# Agent Runtime architecture

The Agent runtime is split into a platform-neutral core and Firefox adapters.
Dependency arrows must point from adapters toward the core, never back from the
core into privileged browser APIs.

## Layers

Sources are grouped under `additions/browser/components/agent-sidebar/modules/`:
`runtime/` (including Worker/Director supervision), `llm/`, `providers/`,
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
   state core, turn orchestrator, supervisor, loop, and normalized ports.
4. **AgentTurnOrchestrator** coordinates projection, persistence, usage,
   checkpoints, automatic continuation, and the optional supervised stage-gate
   loop.
5. **AgentSupervisor** builds bounded evidence packets and runs the
   Director. It validates the Director's decision contract and enforces final
   acceptance requirements in code.
6. **AgentLoop** is the Worker decision engine. It receives an LLM client, a tool
   router, messages, limits, and callbacks. It does not know which browser or
   operating system executes a tool.
7. **LlmClient** is the stable facade over LlmProtocol, LlmStreamParser,
   LlmRequestExecutor, and LlmTransport. Fetch, abort controllers, and timers
   are supplied through the transport port.
8. **FirefoxAgentRuntimeHost** adapts Firefox timers, shutdown, ToolRouter,
   backends, transport, and opaque host contexts to the formal ports.
9. **AgentSession** is the thin Firefox entry point. It creates the ports and
   exports the process-lifetime shared runtime used by the sidebar and MCP.
10. **Backends and AgentEvalChild** implement capabilities. These are outside the
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
           -> AgentSupervisor -> Director LlmClient
                                -> final-only run_node/run_python callback
```

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
- Orchestrator persists consumed user messages and updates the Director objective.
  Corrections survive loop context compaction. A steer during Director review
  invalidates its terminal decision and returns control to Worker.
  The Director packet also carries the last four applied corrections verbatim
  (at most 64,000 characters), independently of the shorter objective summary.
- Finalization closes admission before persistence awaits. Rejected messages stay
  in the UI input. Stop aborts the current run and cancels unconsumed receipts.
  Queues are in memory, are not restored after process shutdown, and never carry
  into another run. Follow-up queues are not implemented.
- The UI fallback without a resident runtime does not support steering.

Run `bash scripts/selftest-agent-tools.sh` for mock-based regression coverage,
including `selftest-agent-steer.mjs`. No real provider requests are needed.

## Supervised mode MVP

`supervised` is a third per-thread strategy alongside `auto` and `assist`.
Worker and Director are never run in parallel:

```text
Worker tools and reasoning
  -> stage gate / limit / final candidate
  -> bounded evidence packet
  -> Director strict JSON decision
     -> continue or redirect -> internal instruction -> next Worker segment
     -> ask_user            -> settle and return control to the user
     -> finish              -> code-level final acceptance -> settle
```

Ordinary stage reviews have no tools. At `final_candidate`, Director receives
only `run_node` and `run_python`, with `file` and string-array `args`. It can run
at most three calls per review, sequentially, through the existing Router and
thread-bound workspace/cancellation context. Only explicit `out/*.js`, `.mjs`,
`.cjs`, or `.py` entry files are accepted; inline code and other tools are rejected.
Each execution has a 30-second timeout. Director must not modify deliverables;
it returns failures and requested corrections to Worker in its structured decision.

The actions are `continue`, `redirect`, `finish`, `ask_user`, and `stop`. `finish`
requires at least one fresh successful Director execution, no failed/timed-out/
aborted/truncated execution in this review, a reference to its `director:*`
receipt, and Director's confirmation that the actual business response meets
the objective. Worker history alone cannot satisfy acceptance. Receipts are
retained in the Director UI step and sent back to Worker on continuation.

This MVP is not a process sandbox: executed scripts can themselves access files
and the network. File-only tool arguments limit the interface, not OS permissions.
Exit code 0 does not prove business success; Director interprets the output.
Script stdout is not independently authenticated network evidence. No separate
Verifier role or host-level network attestation is introduced.

Review timing is driven by Worker segment returns, not a phase detector:
`_runSupervised` runs AgentLoop with `assist: true`, so a non-truncated response
without tool calls ends the segment and invokes Director. P1/P2/P4/P6 gates are
prompt guidance only. `inferDirectorTrigger` classifies the returned segment in
priority order: `max_rounds`, `drift`, explicit `candidate_complete`, then legacy
completion phrases; other returns are ordinary stage gates. The phase label is
display metadata, not a scheduler condition.

Automatic repair stops after three consecutive reviews that request continuation
while reporting a blocker (`Director.blocked` or `Worker blocked: true`), rejecting
a final candidate, recovering drift, or receiving no successful Worker tool calls.
A normal intermediate stage with successful tool activity and no reported blocker resets this count.
This is a bounded retry policy, not automatic proof of progress or matching of
root causes. Director sees the count and the last three decisions. It may return
`stop` earlier for an evidenced unresolved constraint, or `ask_user` for missing
input. The overall twelve-review cap remains as a fallback.

On `stop`, `ask_user`, or either cap, Worker makes one report-only LLM request
with no tools, summarizing verified progress, unfinished work, attempted fixes,
failure evidence, deliverables/commands, uncertainties and conditions to resume.
This report is never reviewed again by Director. If generation fails, existing
evidence is preserved in a fallback report. The task is visibly incomplete and
uses the existing `failed` turn status rather than marking acceptance successful.

Evidence packets contain a clipped Worker summary, tool success statistics,
bounded tool results, artifact paths, ledger digest, trigger, phase, and the
previous Director decision. They deliberately exclude full conversation and
unbounded tool output. Every string inside a packet is treated as untrusted data,
so embedded page or tool-output instructions do not override the Director role.

## Boundary rules

- Do not import `ChromeUtils`, `Services`, `IOUtils`, `PathUtils`, XPCOM,
  or browser backends from `AgentRuntimeCore`, `AgentLoop`, `LlmClient`, or
  `LlmTransport`.
- Pass the selected window, workspace, and cancellation signal through tool
  context instead of reading global focus state.
- Keep provider protocol conversion in the LLM protocol stack; keep API
  credentials and Worker/Director profile references in `ConfigStore`.
- Keep session persistence in `AgentTurnOrchestrator`/conversation ports, not in the
  state kernel.
- Director receives only the two restricted final-execution schemas. Supervisor
  validates calls before forwarding them through Orchestrator's execution callback.
  Direction changes and repairs return through the decision contract to Worker.
- New privileged capabilities must be implemented as backends and registered in
  `Tools.sys.mjs`; they must not be called directly by the decision engine.
- A non-Firefox host can reuse the core by supplying timers, lifecycle hooks, an
  LLM transport, a router, and persistence adapters.

## Extension points

- **New scheduling policy:** extend `AgentTurnOrchestrator` while keeping
  `AgentLoop.runAgentTurn` platform-neutral.
- **New review gate or decision field:** extend `AgentSupervisor` and its tests;
  retain the per-review execution budget and final-acceptance guard.
- **New model protocol:** add protocol codecs in `LlmProtocol`; transport stays
  unchanged.
- **Proxy, replay, or offline inference:** inject a different `LlmTransport`.
- **New browser capability:** add a backend, wire it in `Backends.sys.mjs`, and
  declare its public schema in `Tools.sys.mjs`.
- **New host application:** compose `AgentRuntimeCore` with a host adapter
  equivalent to `FirefoxAgentRuntimeHost`.
