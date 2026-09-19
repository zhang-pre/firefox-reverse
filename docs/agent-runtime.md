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
  -> P2 checkpoint / final candidate (optional explicit route help or blocker)
  -> bounded evidence packet
  -> Director strict JSON decision
     -> continue or redirect -> internal instruction -> next Worker segment
     -> ask_user            -> settle and return control to the user
     -> finish              -> code-level final acceptance -> settle
     -> review_error        -> preserve artifacts, pause; no Worker repair
Worker ordinary segment limit -> resume Worker directly, no Director
```

DISCOVERY reviews expose only `evidence_read` (at most two reads per review),
which resolves runtime-generated evidence IDs to captured tool arguments and
results from this run. It accepts neither arbitrary paths nor new execution.
Each read is paginated at 6,000 characters. Failed, truncated, and write-only
receipts cannot alone authorize P2. Read receipts and the structured P2 assessment
are retained in the Director UI. Other intermediate reviews have no tools.
At `final_candidate` after P2 approval, Director receives
only `run_node` and `run_python`, with `file` and string-array `args`. It can run
at most three calls per review, sequentially, through the existing Router and
thread-bound workspace/cancellation context. Only explicit `out/*.js`, `.mjs`,
`.cjs`, or `.py` entry files are accepted; inline code and other tools are rejected.
Each execution has a 30-second timeout. Director must not modify deliverables;
it returns failures and requested corrections to Worker in its structured decision.

Model decisions are `continue`, `redirect`, `finish`, `ask_user`, and `stop`.
Runtime additionally produces `review_error` for review service failures. `finish`
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

Runtime scheduling starts each supervised run in DISCOVERY. Worker submits
`stage_checkpoint` with phase P2, ROUTE_CHANGE, or P6, candidate, evidenceRefs,
verified/unverified claims, and proposedNextStep. A valid checkpoint immediately
yields to Director; remaining calls in the same batch receive skipped replies
without execution. DISCOVERY exposes P2_PENDING and permits at most 30 actual
Router dispatches before mandatory review, accumulated across ordinary segments.
At budget exhaustion Runtime supplies a P2 checkpoint selecting captured evidence;
Director may approve after reading evidence, or grant another 30-call discovery
window when evidence is insufficient. This guarantees timely review, not automatic
semantic detection of P2. Approval exposes P2_APPROVED and restores 90 dispatches
per segment; ordinary budget returns then resume Worker without Director. Earlier
no-tool, max_rounds and drift returns preserve messages and the pending counter.
Explicit ROUTE_CHANGE requests and reported blockers may also request
Director help. Repeated P2 checkpoints after approval do not cause re-review.
Twelve consecutive unreviewed segments or three empty segments stop with a
report-only Worker summary, preventing unlimited automatic continuation.
The common reverse Skill contains only a P2 insertion marker. SkillBackend injects
mode/state-specific policy before pagination, beside P2, without mutating its cached
methodology. Ordinary modes receive no supervision policy. The policy is also
returned as metadata so result folding cannot hide the active state. Runtime's
current system instruction takes precedence over older Skill reads in history.

DISCOVERY cannot advance to IMPLEMENTATION unless a P2 checkpoint is present,
Director actually reads selected evidence, and its continue/redirect decision
requests IMPLEMENTATION with all five P2 assessment fields: entry, inputs,
outputScope, stateAndEncoding, and limitations. Referenced receipts must be
selected by the checkpoint and successfully read as reviewable evidence.
Summary-only approval and premature finish are rejected. Only an implementation
final candidate opens ACCEPTANCE and the existing final execution tools. P2
approves a candidate entry and route, not a complete independent implementation.
For a final candidate that missed P2, Runtime selects existing evidence for a
late P2 review. After a valid P2 decision, the same Director conversation moves
to ACCEPTANCE and enables execution; Worker is not sent back to repeat exploration.
Director
can redirect to DISCOVERY, requiring renewed P2 approval. User steering restarts
discovery and the evidence collection, so stale approvals do not govern new work.

These are runtime handoff and acceptance guards, not a semantic tool firewall:
general-purpose Worker tools can still execute implementation-like code during
exploration. P2 correctness remains a Director judgment; captured stdout is not
authenticated independent evidence. Step one adds no p2_compare/browser replay
capability. A textual phase label alone still cannot transition runtime state.

Automatic repair stops after three consecutive reviews that request continuation
while reporting a blocker (`Director.blocked` or `Worker blocked: true`), rejecting
a final candidate or P2 checkpoint, recovering drift, or receiving no successful Worker tool calls.
A normal intermediate stage with successful tool activity and no reported blocker resets this count.
This is a bounded retry policy, not automatic proof of progress or matching of
root causes. Director sees the count and the last three decisions. It may return
`stop` earlier for an evidenced unresolved constraint, or `ask_user` for missing
input. The overall twelve-review cap remains as a fallback.
Budget-only continuations without a reported blocker neither increment nor reset the
consecutive failure counter. Checkpoint acknowledgements do not count as successful
exploration. Repeatedly rejected P2 checkpoints stop after three reviews.

On `stop`, `ask_user`, or either cap, Worker makes one report-only LLM request
with no tools, summarizing verified progress, unfinished work, attempted fixes,
failure evidence, deliverables/commands, uncertainties and conditions to resume.
This report is never reviewed again by Director. If generation fails, existing
evidence is preserved in a fallback report. The task is visibly incomplete and
uses the existing `failed` turn status rather than marking acceptance successful.

Review protocol failures are not artifact rejections. Director starts with a
bounded P2 contract check: every approval reference must be selected and actually
read as reviewable in this review. Missing, unread and ineligible IDs are reported
explicitly, and contradictory approval wording is replaced by Runtime's rejection.
A single P2 contract correction is allowed within the same review, independently
of truncation/JSON recovery, reusing existing evidence receipts and read budgets.
Director must either justify approval using eligible evidence or return a genuine
discovery supplement request; persistent contract failure pauses as review_error,
without asking Worker to resubmit an identical checkpoint. Director starts with a
4,096-token response budget, with at most one format/truncation recovery on the
same evidence. Truncation raises the retry budget to 8,192; truncated tool calls
are not executed. Persistent invalid output, request failure, or exhausted review
interaction budget produces review_error: preserve results and pause with failed
status, without Worker repair or a paid summary call. UI retains bounded response
previews, finishReason, content/reasoning lengths, usage, evidence reads and execution
receipts for diagnosis. No automatic approval is granted on review failure.

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
- Director receives the bounded evidence-read schema in DISCOVERY or the two
  restricted final-execution schemas in ACCEPTANCE. Supervisor
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
