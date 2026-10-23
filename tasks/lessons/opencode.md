# OpenCode general lessons

[Index](../lessons.md) · [1.x](opencode-1.md) · [2.0](opencode-2.md)

These are failure lessons shared by both hosts, not a replacement for
[AGENTS.md](../../AGENTS.md). Host-specific details live in the linked files.

## Investigation and evidence

- **Trace the whole path.** PR #34's image review missed another delivery route;
  filtered plan searches missed the defining files. Read callers, intent and
  history before declaring a gap.
- **Verify the active branch and loaded build.** Partial-read work targeted MCP
  while live traffic used native reads; a stale SDK survived plugin reload.
  Record the exact binary, entrypoint, rebuilt files and host log.
- **Measure behavior, not presence.** A truncation flag reached the wire but was
  ignored. Use an A/B fixture that cannot reveal the answer independently;
  model claims about its prompt are not evidence.
- **Inspect the encoded payload.** A pre-encoder counter included a dropped
  history entry. Matching limits on two layers also misattributed truncation;
  follow the data before blaming a boundary.
- **Separate advertisement from execution and live tests from fixtures.** A
  hidden tool can remain executable. Unit success, a host badge or absence of
  error text does not prove the payload or permissions worked.
- **Observe races while active.** Completed-file checks missed transient growth;
  a shell trace disproved a lost-TERM diagnosis. Stress the producer and inspect
  its actual wait/state transitions (`test/terminal-runner.test.ts`).

## Boundaries and tool contracts

- **Moving compatibility code requires proving its replacement.** A neutral
  bridge import still coupled the provider to OCP. Keep fork detection and
  schemas in OCP, with catalog/call/result/path parity there
  (`test/architecture.test.ts`).
- **Use native defaults beneath structural overrides.** A bridge-only plan
  path broke standalone OpenCode. Installation directories do not identify the
  running host (`src/context/paths.ts`, `src/host-plan-file.ts`).
- **Preserve semantics, not names.** Similar tools can differ in merge behavior,
  required fields or execution language. Normalize before validation; a file
  tool once accepted a shell command and silently returned a listing
  (`test/tools.test.ts`). Rebuilt file-tool arguments must still carry
  `command`, or the misplaced-shell refusal never sees it and the model is told
  only that `pattern` is missing (`mapCursorArgsToOpencode`).
- **Translate from permitted capabilities.** Patch substitution and Task routing
  failed when fixed tool names outlived a model/catalog change. Read the current
  turn, preserving native operations when permitted (`remapEditToolsForCatalog`,
  `remapNativeSubagentForCatalog`, `test/apply-patch.test.ts`).
- **Display completion is not execution authority.** Replaying a completed UI
  record duplicates effects without returning its result to Cursor. Mirror only
  final todo/plan state; Task executes through #28, using its correlated display
  title (`test/tool-call-bridge.test.ts`). Match attachment paths as well as the
  Task id before answering prerequisite reads, ahead of runtime-file interception:
  either reader otherwise consumes the Task title. Keep exact filenames and
  quote paths in the child prompt; trimming broke live attachment reads on both
  majors. A failed stat must not become a successful placeholder
  ([#82](https://github.com/oakimov/cursor-opencode-provider/issues/82),
  `test/task-attachments.test.ts`).
- **Aliases need execution mappings and capability flags.** Wording alone did
  not prevent native web/resource collisions. Unknown underscore names are not
  MCP server ids (`resolveToolServerIdentity`, `test/tools.test.ts`).
- **Dynamic discovery must include invocation identity.** The inner schema hid
  required outer `namespace`/`toolName`; server-side wrapper failures may appear
  only in display completion (`test/dynamic-catalog.test.ts`).
- **Read argument keys from the advertised schema.** Passing 1.x skill `name`
  to 2.0's `id` (or vice versa) was stripped to an empty object (`skillArgKey`,
  `test/tools.test.ts`).
- **Virtual MCP servers need a control plane.** Answer state probes from the
  same descriptors, validate nested inputs, and echo the requested path when
  discovery spills to a file (`test/runtime-files-pump.test.ts`).
- **Replace-all input is destructive.** A permissive normalizer turned malformed
  todos into deletion. Expand merge updates against the observed list or refuse;
  that small in-memory list intentionally resets on restart
  (`test/todo-tools.test.ts`, `test/tool-call-bridge.test.ts`).

## Protocol and recovery

- **Use independent wire evidence.** The extracted proto lagged live frame
  members, request/result field numbers differ, and local round trips hid schema
  errors. Consult the shipped descriptors and canonical fixtures
  (`src/protocol/exec-variants.ts`, `test/exec-variants.test.ts`). Recognizing a
  member does not make it control traffic: `user_message_appended` after context
  injection changes conversation state and must retain its replay barrier
  (`test/replay-safety.test.ts`, `test/run-interruption.test.ts`).
- **Apply protobuf defaults deliberately.** Omitted scalars may mean zero;
  omission assertions need sparse decoding. Fragmented varints also need a
  streaming prefix parser (`test/conversation-maintenance.test.ts`).
- **Every inbound request needs a typed answer.** Ignoring an interaction
  deadlocked both peers. Known unsupported variants need a correlated refusal;
  unknown fields remain protocol drift (`test/interactions.test.ts`).
- **AskQuestion is not an exec request.** Refusing its interaction made the model
  narrate unavailability while host `question` remained unused. Preserve CLI
  catch-all/freeform mapping; async completion must echo the original argument
  bytes, while synchronous questions wait for the host (`test/ask-question.test.ts`).
- **HTTP 200 and EOF are not completion.** Require Cursor's terminal event and
  retain trailer/GOAWAY evidence (`test/run-interruption.test.ts`).
- **Keep one iterator and dispatch serially.** Concurrent reads crossed handoff
  boundaries; a timed-out read still owned its promise. Drains must read past
  display completion until a genuine wait or terminal boundary
  (`test/parallel-pump.test.ts`).
- **A held Run is still a live stream.** Nothing read it while host tools ran,
  so a KV write waited for the tool and an abort arrived after the late result.
  Stopping at the first other frame was not enough: Cursor sends
  `tool_requests_listed` or a checkpoint right after a step, ahead of its KV
  writes. Handle KV and aborts at once and queue the rest in order
  (`readHeldRun`, `test/held-run-reader.test.ts`). A queued frame is not
  necessarily reached by the next pump: one that ends its step on a queued
  exec leaves that exec's abort behind it, so re-check the queue whenever the
  Run is held again (`test/held-run-run.test.ts`).
- **Backpressure belongs to every response-required write.** KV replies filled
  the stream before a heartbeat exposed it; serialize and label every write,
  with no replay after ambiguous delivery. A five-second drain timer capped a
  healthy upload because drain waits for the whole message. Terminal settlement
  must also handle response-end without close, after the idle watchdog stops
  (`test/stream-write.test.ts`, `test/write-drain.test.ts`).
- **Cancellation needs an owner before registration.** Transport-only tests
  missed initial/replacement uploads, continuation delivery and a blocked pump
  reply. Cover each through `doStream`, including an already-aborted signal;
  pass the current step's signal and detach temporary listeners before the
  ordinary tool-step abort (`test/write-drain.test.ts`). A pump listener that
  reset the Run on every abort also pre-empted the OpenCode 1.x Stop, which
  aborts before the AI SDK cancels the stream, so Cursor never got
  `cancel_action`; reset only a write blocked on drain, and test Stop in the
  host's own order (`test/interrupt-restart.test.ts`).
- **Rejecting a drain does not release its resources.** Plain stream close left
  buffered bytes live; `end()` then made `destroy()` skip its reset. CANCEL must
  close the actual stream so its session ref is released. Test child-process
  exit with idle and blocked requests, including end then destroy
  (`test/session-exit.test.ts`, `test/node-http2-drain.mjs`).
  That CANCEL also fires `aborted` on Node and Bun while the request side is
  open, so every ordinary turn-end close logged "aborted by remote" and sent a
  self-verify run chasing a nonexistent server reset. Bun 1.3 (OpenCode 2.0's
  runtime) also emits `error` for it while the response is open; a test run on
  a newer Bun missed that. Stream events do not say who closed; check the
  local-close flag, and run transport checks on the host's runtime too
  (`test/run-close-trace.test.ts`).
- **The shared session can reject an otherwise valid Run.** Unsent sibling DATA
  exceeded the runtime's default 10 MB memory accounting and refused new Runs
  with `ENHANCE_YOUR_CALM`; Node could also reject one large upload. Verify the
  higher limit on both connection paths and runtimes, beside sibling backlogs
  and through a slow relay (`test/run-session-memory.test.ts`,
  `test/node-http2-session-memory.mjs`).
- **A checkpoint is not permission to replay side effects.** Resume the newest
  eligible checkpoint only behind the replay barrier; a late tool result needs
  history recovery because `resume_action` re-requests that tool
  (`pumpWithRecovery`, `test/parallel-pump.test.ts`).
- **A replay the provider must refuse can still be the host's to retry.**
  Making every suppressed replay final ended a turn whose Run dropped after
  only reasoning; its request reached Cursor only with the next message
  ([#100](https://github.com/oakimov/cursor-opencode-provider/issues/100)).
  Cursor CLI resends the action, resumes the turn's latest checkpoint, and stops
  after two resumes without a new one. Match its 30 s inbound-silence default;
  outbound client heartbeats cannot extend it. The transport's 120 s read-idle
  watchdog is a separate backstop (`test/run-liveness.test.ts`).
  Classify the constructed error, not only the signature table: CLI marks a
  stream ending without `turnEnded` as transport, so it receives ten retries,
  even though a different early-close signature uses the server category
  (`test/run-error-host.test.ts`, `test/retry-budget.test.ts`).
  Its separate 10-transport / 3-server retry budgets belong to the user turn,
  not one provider call: an output-only
  failure handed to an older host with unbounded retries otherwise restarts the
  allowance forever. Share counts across module copies and host tool steps;
  distinguish partial assistant output and host reminders from a new user turn.
  Test the canonical host projection: OpenCode 2's interruption notice is plain
  user text, not a `<system-reminder>`, and otherwise reset the budget on every
  continuation (`test/run-error-host.test.ts`). Admit it only after a requested
  host retry, retaining its full prompt key across tool steps; a later literal
  user request with that text still needs a new budget. Normalize recognized
  trailing host-note parts in every user message for identity only: plugins
  append them to the initial request too, without persisting them in history.
  Keep actual request content and attachment/new-request boundaries intact.
  An unfinished partial-tool row has no execution authority; close it as
  unfinished and classify it as output only. Started tool lifecycles, execs and
  unknown frames still forbid that host retry (`test/run-interruption.test.ts`).
  Immediately after completed host results, history recovery needs every observed
  exec's result, no new output, and no opaque interaction or unknown frame.
  Its first tests sent execs without the `tool_call_started` Cursor sends before
  each one, so the lifecycle barrier blocked every live rebuild
  ([#112](https://github.com/oakimov/cursor-opencode-provider/issues/112)).
  Correlate lifecycle frames with execs by call id: only a call no host exec
  claimed, or an unknown completion, blocks the rebuild (`announcedCallsClaimed`).
  Include unary `shell_args` and validate the lifecycle envelope from wire bytes:
  decoded duplicate or unknown fields otherwise authorize a malformed completion
  ([#114](https://github.com/oakimov/cursor-opencode-provider/pull/114),
  `test/replay-safety.test.ts`, `test/run-error-host.test.ts`).
  Seed all completed tool steps; retaining only the last result loses earlier work,
  and that full seed needs the same context-fit check as a foreign-history rebase.
  An `APICallError` 413 is already host-shaped: wrapping it as a setup failure made
  OpenCode retry instead of compacting
  ([#113](https://github.com/oakimov/cursor-opencode-provider/issues/113)). Never use the stale
  checkpoint for that recovery. A later tool result must not erase an earlier
  uncheckpointed follow-up's barrier: that follow-up may be absent from the
  host prompt. Only a newer eligible checkpoint clears the revocation.
  Capture result cutoffs at each actual serialized write, before its drain;
  after-drain timestamps rejected valid checkpoints, while a cutoff before the
  queue admitted checkpoints predating the completed result. Retain every
  exec's owning session across resumes: bare stream-local ids both collide and
  lose earlier completed results (`test/run-error-host.test.ts`, `test/session.test.ts`).
  Reject an unsafe replacement upload before consulting the preceding Run's
  checkpoint: that checkpoint says nothing about work the replacement may have
  started. Failed drains must also project as terminal to both hosts, including
  during credential renewal and endless mode (`test/run-interruption.test.ts`).
  Endless mode bypasses counts only, preserving replay guards and CLI's 180 s
  consecutive-stall retry window (`src/retry-budget.ts`,
  `test/retry-budget.test.ts`, `test/run-error-host.test.ts`).
  Record every barrier, not the first:
  text before a stateful frame must not read as output-only. Keep stateful
  barriers on the Run across tool-step pumps, and retain checkpoints before
  credential renewal as well as transient recovery; otherwise a completed
  command becomes host-retryable or a renewed attempt forgets its saved state.
  Result delivery and follow-up user actions invalidate older checkpoints;
  compare frame arrival order so a queued pre-result checkpoint cannot become
  eligible just because the pump reads it after delivery. Capture a follow-up's
  arrival cutoff before opening its replacement Run: its checkpoint can arrive
  before the old stream finishes draining. An inherited tool barrier still
  permits one credential renewal on an untouched resume with an eligible
  checkpoint; new output or stateful activity must prevent it
  (`AttemptReplaySafety`, `test/parallel-pump.test.ts`,
  `test/run-interruption.test.ts`, `test/run-error-host.test.ts`).
- **A helper must not take over its parent.** A smaller catalog was mistaken for
  a helper despite carrying the parent's pending result. Reconcile that result
  first; isolate genuine helpers (`test/fresh-turn-drain.test.ts`). An empty
  catalog is a helper too: OpenCode 2's tool-less call during a running shell
  cancelled the parent Run (`test/lifecycle-isolation-run.test.ts`).
- **Drain before replacing a held Run.** Cancellation preserves warmth only with
  a valid terminal acknowledgement and fresh checkpoint. An incomplete drain
  must rebuild without losing the new request (`test/host-interrupt.test.ts`).
- **Ownership can change during an await.** Recheck the pending exec after each
  write; serialize continuations and release cleanup only for its pump owner
  (`test/session.test.ts`, `test/run-interruption.test.ts`).
- **Notes and media are not fresh user turns.** Misclassification superseded a
  held Run or fabricated a plan refusal. Preserve tool results, attribute only
  uniquely owned media, and keep ambiguous attachments in history
  (`test/host-notes-run.test.ts`, `test/image-input.test.ts`).
- **Injection needs acknowledgement and ordered fallback.** A written note is
  not necessarily consumed. Retry/defer it with its owning turn; an action may
  remove only the batches it captured (`test/host-notes.test.ts`).
- **Every provider-minted tool-call id must stay recognizable.** Early-row ids
  routed only through a live-Run table were dropped once the Run closed, so the
  completed edit never reached Cursor. Keep routes like tombstones and parse the
  id after a restart (`parseEarlyRowToolCallId`, `test/early-tool-rows.test.ts`).
- **Carry a lost request only where history cannot.** A Run without a checkpoint
  seeds host history, which already holds it; prepending as well sent it twice.
  A failed Run reached no save, so a restart lost the record. Storing the
  combined text re-prepended it on every failed host retry, stacking OpenCode
  2's identical interruption note ten times. Deduplicating any carried part
  then swallowed a deliberate repeat (red, blue, red); only a repeat of the
  previous attempt's own text is a retry (`carryLostRequest`,
  `test/lost-request-run.test.ts`).
- **Predict the tool the remap will produce.** An announced edit on a new file
  becomes `write`; predicting `edit` showed a failed row beside every created
  file. An empty file has no text to replace, so it stays `write` too. A
  prediction also needs the exec's first step: an edit of a file outside the
  workspace sends its private read to OpenCode's `read`, which closed the row
  as a failed edit on 193 of 530 edits in a day (#106). Decide both from one
  predicate. Content-dependent remaps stay unpredictable: a rewrite with
  unchanged content stays a `write`. OpenCode 2 rejects a renamed call and
  both hosts reject an identical `edit`, so such a row completes as a hand-off
  naming the real call, never as a failure (`hostToolForCursorEdit`,
  `cursorEditReadReachesHost`, `earlyRowHandoff`, `test/early-tool-rows.test.ts`).
- **Silence of model text is not inactivity.** A large tool input arrived as
  heartbeats/token counts for minutes; renew semantic liveness on every inbound
  frame. Pending real execs also need the CLI's three-second client heartbeats,
  stopping on abort/result delivery. Running host tools and open prompts renew
  held leases through descendant activity; a four-hour running-tool ceiling
  must never shorten an existing lease (`test/run-liveness.test.ts`,
  `test/activity.test.ts`, `test/session.test.ts`).

## Planning and file mutations

- **Gate the unavoidable transition and stop on refusal.** The model wrote a
  plan and stopped without volunteering SwitchMode. Attach approval to
  CreatePlan. A No answer is ordinary question data in native OpenCode, so a
  failed CreatePlan reply alone let the model continue its self-test. Cancel
  and drain the owning Run after No or dismissal; suppress late output,
  refuse every new exec before runtime metadata handling, and require a fresh
  user message. Typed freeform feedback is not refusal: continue the same turn
  in plan mode and return that text on the CreatePlan error reply so the model
  can revise (`createPlanApprovalOutcome`). Only remaining questions delimit
  prose answers: matching the current question inside feedback truncated it
  to Yes and approved execution. Single-choice review JSON must have exactly
  one string in its one answer row; filtering invalid cells or joining
  conflicting answers can turn malformed data into approval or refinement.
  A No/dismissal also wins over later approvals in the same result batch;
  clamping only the next pump left a queued build handoff alive. Keep the
  existing `emulated approval=` log marker and append the richer outcome so
  self-test extraction remains usable (`test/create-plan.test.ts`,
  `test/ask-question.test.ts`). Keep the plan agent and already
  authorized background jobs; carry host notes delivered beside a declined
  answer to the next user turn instead of injecting them into the cancelled
  Run. Self-verification must score post-refusal tool calls as failure, even
  when implementation itself did not start (`test/create-plan.test.ts`).
- **Show the plan before asking.** Putting the full plan in the question dock
  hid the conversation. Render it in the assistant transcript and match the
  exact prompt echoed by the answer (`test/create-plan.test.ts`).
- **Approval must reach the host's next turn.** Flipping only Cursor mode did
  not start implementation. Queue the native switch after successful delivery
  and a terminal Run; serialize callbacks so an older one cannot erase a newer
  request. An emulated CreatePlan approval kept pumping under the plan agent
  and asked again before reaching that boundary. Cancel the old Run just as
  for plan entry, drain its terminal acknowledgment, and refuse late host
  calls before starting build (`test/switch-mode.test.ts`,
  `test/create-plan.test.ts`). A failed apply keeps the request but drops its
  owner; an owner check that matched any Run then cancelled every later Run
  before it streamed. Only the Run that queued a handoff owns it.
- **A read-only mode is not "leaving plan".** Five copies of "plan/spec, else
  build" sent Cursor's Ask targets to the build agent and refused them under a
  session edit deny. Cursor CLI maps `chat`/`ask`/`search` to Ask. Mode ids,
  their role, wire mode and reminder, and the host plan-agent name live only in
  `src/protocol/cursor-mode.ts`; `followHostPlanAgent` is the one follower on
  both generations. Keep the current agent for read-only modes, including on
  the next plan-agent step (`test/switch-mode.test.ts`).
- **Native execution does not imply a top-level function.** After a successful
  SwitchMode lookup, PR #111 still insisted on a direct call and prohibited
  CallDynamicTool. The captured Run advertised dynamic invocation, never raised
  a switch interaction, and reported planning and images unavailable. Follow
  the supplied route; discovery does not install a function. String assertions
  had enforced the wrong contract; require an actual invocation, interaction,
  handoff and displayed plan (`buildOpenCodeInteractionGuidance`,
  `test/prompt-history.test.ts`, `docs/host-compat-acceptance.md`).
- **A session edit deny outlasts plan approval.** The last session `edit` rule
  on `*` is read from the session payload on both entrypoints. CreatePlan still
  writes and shows the plan, then returns the not-approved error and does not
  ask or switch agents. That immediate hold must arm the same cancellation and
  terminal drain as a declined bridged review: a failed wire reply alone let
  a subsequent shell exec write a file. Set the turn-ending state only after
  reply delivery; refuse later calls in the step immediately, finish any
  already-emitted parallel host tool call before sending `cancel_action`, and
  gate direct `plan_exit` / `cursor_plan_stage` execs the same way
  (`test/create-plan.test.ts`). A plan-path allow does not clear `*`. A plan-agent
  catalog that merely omits edit still asks (`sessionRulesDenyEdits`,
  `resolveCreatePlanBridge`, `test/session-edits.test.ts`,
  `test/create-plan.test.ts`, `test/plugin.test.ts`,
  `test/plugin-opencode2.test.ts`). Read native 1.x `permission` rules as well
  as 2.0 `permissions`; retry before evaluating and reuse that payload for the
  plan path. A failed lookup is not an empty ruleset: carry unknown evidence
  to CreatePlan and implementing SwitchMode instead of aborting ordinary
  requests. Recheck pending approvals too, and clear the unavailable marker
  when a later lookup succeeds. Lifted rules must clear a previous request's
  deny marker. A saved denied plan is still a
  stateful replay barrier and must revoke any earlier checkpoint in the turn
  (`test/create-plan.test.ts`). Carry explicit deny
  and no-deny guidance chronologically, including on held continuations:
  merely clearing a boolean leaves an old checkpoint reminder authoritative
  (`test/host-notes-run.test.ts`). Send no-deny guidance only when it replaces
  a deny Cursor may hold: stating it on every request injected it after each
  tool step of a session that never had a deny (`sessionEditsGuidance`).
  Persist whether a deny was ever sent: treating every restart as unknown
  history repeated the no-deny note on each conversation. Compaction cannot
  approve a plan, so its 2.0 session read stays best effort and must not abort
  the compaction (`test/plugin-opencode2.test.ts`). Place current permission guidance after all
  carried notes too, even when this process already recorded no deny: queued
  or unacknowledged injections can restore an older deny. Record suppression
  state only after writing a real delivery, never on a skipped duplicate or
  failed upload; bound the remembered states. Retain unrelated notes and the
  frozen baseline (`test/host-notes-run.test.ts`, `test/session-edits.test.ts`).
- **Lifecycle interactions must not mutate state.** Hard SwitchMode rejection
  polluted the real turn; soft-ack it without changing mode. Do not let a title
  turn write a plan (`test/switch-mode.test.ts`).
- **Tool-less narration can pollute the answer.** Give explicit context-only
  guidance and suppress narration before a refused call; otherwise it becomes
  the session title (`test/prompt-history.test.ts`).
- **A private edit read needs complete content.** Cursor's streamed edit is a
  read/whole-file-write handshake; a capped preview corrupted its replacement.
  Preserve correlation and edit intent, including edit-only turns and missing
  targets; all existing-file reads need exact host authorization first
  (`test/parallel-pump.test.ts`, `test/apply-patch.test.ts`).
- **Test bytes after the actual patch parser.** Stripping an empty payload line
  lost blank lines; endings differed by major and by direct/native route.
  Explicit replacement writes must stay distinct from targeted edits
  (`test/apply-patch.test.ts`; host-specific lessons below).
- **Envelope stripping must retain incompleteness.** `[Partial read: …]` changed
  behavior where a boolean did not. Parse markers by position; block destructive
  marker echoes, allow source quoting them in targeted edits, and do not label
  ordinary pagination truncated (`test/read-cap-repro.test.ts`).
- **Content fields are not transport metadata.** Filtering `file_bytes` or
  `encoding_hint` removed legitimate content. GenerateImage's display data is a
  preview; only its binary write exec commits bytes. Some remote generations
  omit the approval query entirely, so the save tool's edit gate and containment
  remain essential. Re-resolve the exact target after the permission wait, and
  reject dangling symlinks and write with `O_NOFOLLOW`:
  a directory or target swapped to a symlink during approval otherwise redirects the
  authorized write, even to another path within an allowed root. Default
  project assets intentionally stay outside the git worktree (`test/generate-image.test.ts`, `src/image-save.ts`).

## Context, caching and accounting

- **Freeze bytes, not just a map entry.** Concurrent builds mutated the prefix;
  recursively freeze, deduplicate first builds and compare encoded bytes
  (`test/frozen-request-context.test.ts`).
- **Hold an epoch without freezing capability truth.** Equal name sets retain
  descriptors/order; new names append. Permission is independently current.
  Compaction rotates state but transfers workspace context
  (`test/context-epoch.test.ts`, `test/prompt-history.test.ts`).
- **Do not seed Cursor's rendered root prompt.** Client entries suppressed rules
  and subagents. Rebuilt history belongs in the user transcript; host instructions
  need the typed `global` rule, not a seeded system message, untyped rule or
  `system_prompt_override`. Checkpoint category drops expose lost context
  (`test/prompt-history.test.ts`, `src/context/build.ts`).
- **Host instructions are host-owned.** Skill changes arrive through host
  updates, not per-turn relevance guesses. Restart tests must check the latest
  effective instruction, not merely the first frozen rule
  (`test/context-epoch.test.ts`).
- **Instructions need an instruction carrier.** Models refused host rules buried
  in tool output; `system_context` injection was rejected as unallowlisted.
  Use `user_context`, unwrap host updates and retain delivery acknowledgements.
  Queued/rejected/unacknowledged notes follow recovery or the next user turn;
  do not reinject results already delivered or notes already in seeded history.
  Reserve hook context for notices about one result
  (`test/host-notes-run.test.ts`, `test/host-notes.test.ts`).
- **Empty tools are not compaction evidence.** Waiting for a sibling catalog
  stalled standalone titles. Tool-less Runs advertise empty tools; explicit
  compaction metadata controls reset (`resolveTurnToolState`).
- **Ground paths and tool observations explicitly.** Structured workspace facts
  alone did not prevent invented prefixes; flattening tool output into assistant
  prose taught fake execution (`test/prompt-history.test.ts`). Ground only
  structured path results: rewriting shell stdout prefixed branch names,
  shebangs and assignments and misplaced paths printed after a `cd`
  ([#96](https://github.com/oakimov/cursor-opencode-provider/issues/96)).
  Check the host projections before the encoder too: secondary display cleanup
  must respect the captured native exit, and failed shell streams must retain
  partial stdout (`test/plugin.test.ts`, `test/plugin-opencode2.test.ts`,
  `test/continuation-session.test.ts`). A failed host tool's single text is
  both `output` and `error`; sending both put it in stdout and stderr
  ([#101](https://github.com/oakimov/cursor-opencode-provider/issues/101)).
  Deduplicate against the effective error, including a shell-hook failure when
  the SDK retains only text; keep distinct partial output on stdout
  (`test/continuation-session.test.ts`).
  Like Cursor CLI, stdout is only what the command printed. Private wrapper
  cleanup removes exactly the launcher's separator, preserving spaces, CRLF,
  blank lines and literal placeholders (`test/shell-timeout.test.ts`).
- **Keep occupancy, work and money separate.** Hosts replace message tokens but
  add step costs; Run-wide generation inflated tok/s. Use checkpoint occupancy,
  retain stale markers, and keep raw counters distinct from synthetic billing
  partitions (`test/usage-from-turn-ended.test.ts`).
- **Book charges only after accepted delivery.** Cancelled estimates must not
  credit another Run. Aggregate counters cannot prove per-call tiers; compare
  both hosts' pricing formulas (`test/billing.test.ts`).
- **Diagnostics need the same bounds as usage.** Unclamped prefixes and a
  double-counted footer token created false validations. An aggregate cache
  ratio cannot locate a miss; compare identities, hashes and categories, and
  preserve zero counters ([runbook](../../docs/cache-log-runbook.md)).
  A plan-handoff cancel ends its Run without TurnEnded, so it logged no
  diagnosis, and a self-verify run blamed its warm Run on the previous Run's
  `coldReason`. Its final checkpoint reports `used_tokens=0`; the next Run
  decoded that as prior occupancy and showed no cached prefix. Emit the
  diagnosis with counters unavailable, and treat a zero-token checkpoint as
  missing occupancy. Persist the last measured token field separately from
  the zero-token resume checkpoint: an in-memory fallback alone loses the
  cached prefix after restart. Preserve the original Run state bytes and
  discard the fallback with its conversation (`test/switch-mode.test.ts`,
  `test/checkpoint-occupancy-run.test.ts`, `test/conversation-persistence.test.ts`).

## Persistence and process lifetime

- **A restart snapshot is more than a checkpoint.** Bindings, reachable blobs,
  context, provenance, deferred notes and steer receipts must agree. Preserve
  all blobs if reachability is uncertain (`test/conversation-persistence.test.ts`).
- **Atomic replacement does not prevent lost writers.** Partition by host
  session; gzip protobuf bytes rather than base64 JSON. Revalidate cleanup
  candidates, expire loaded sessions too, and avoid decoded snapshot duplicates
  (`test/conversation-maintenance.test.ts`).
- **Bound indexes without discarding warm state.** Soft binding eviction must
  retain checkpoint/blobs/context and allow disk hydration; a process cap must
  not close pumping or pending Runs (`test/session.test.ts`).
- **Exercise Node and Bun filesystem edges.** Descriptor ownership, disappearing
  directory entries and either-side rename failures differ
  (`test/conversation-maintenance.test.ts`).
- **Shared state needs a real second module graph.** Query-string imports did
  not duplicate dependencies under Bun. Assert distinct exports; global records
  must be plain data (`test/process-shared.test.ts`).

## Shell supervision

- **Read native execution before emulating it.** Both hosts own shell choice,
  permission and process-group cancellation. Preserve native background support;
  the remaining redesign is tracked in [todo](../todo.md).
- **Use clocks and retain real outcomes.** Poll counts exceeded promised
  deadlines; stdout markers impersonated timeout/exit records. Pick the owning
  outcome across marker types (`test/shell-timeout.test.ts`).
- **Test every supported shell.** dash rejected bash-shaped `kill` syntax;
  macOS sh hid the problem. Disown lost exit status, and trapped bash `wait`
  could block after reaping a child (`test/terminal-runner.test.ts`).
- **Force signal gaps.** A child inherited traps before exec; a cancel arrived
  before `$!`. Latch cancellation, use marker-before-signal coordination and
  one-way stop state; instrumentation must not hide the race.
- **Missing completion does not mean unstarted.** Startup and cleanup need one
  atomic claim; repeated release may remove only truly unstarted jobs
  (`releaseUnstartedTerminal`).
- **Detached helpers need bounded owner-death cleanup.** A FIFO detects even
  SIGKILL; descendants can hold output open forever. Disarm on success so an
  explicitly detached daemon survives (`test/terminal-runner.test.ts`).
- **A PID is not ownership.** Keep the group leader alive through drain and
  verify identity before signalling either a child group or its supervisor.
- **Prove streaming and bounds while running.** BSD head/dd buffered output;
  command text in the record header faked early delivery. Drain excess bytes
  after the storage cap (`test/terminal-runner.test.ts`).
- **Read the real tail and provenance.** Long headers hid terminal footers;
  payload text resembled storage-failure records. Teardown collector exit must
  not replace native cancellation (`test/runtime-files.test.ts`).
- **Spawn success differs from payload success.** An already-finished fast
  command still needs a valid handle and its actual final exit.

## Auth, models and delivery process

- **Use the client with the actual credential flow.** CLI inspection missed IDE
  browser renewal; HTTP 200 with `shouldLogout` was rejection. `/oauth/token`
  returns no refresh token, so store its access token in both session slots.
  The IDE's 1272-hour renewal threshold applies to browser sessions; raw keys
  use their own exchange and never stand in for that refresh. An idle expired
  session requires login again (`src/auth.ts`, `test/auth-renewal.test.ts`).
  Cursor's final error details precede the Connect login code; reading
  `unauthenticated` first reopened final usage refusals with a renewed token
  (`test/run-interruption.test.ts`).
- **Keep secrets out of serializable SDK options.** OpenCode exposes provider
  options. Resolve credentials on demand, persist only unchanged credentials,
  and hash secrets only for private lookup keys (`test/plugin.test.ts`).
- **Discovery failures need explicit outcomes.** Silent legacy-host fallback
  misrouted regional accounts; deadlines must include body reads, and telemetry
  remains opt-in (`test/agent-url.test.ts`).
- **Harden only owned paths.** A file override does not authorize chmod of its
  parent. Validate temporary directories; parse hostile delimiters in linear
  passes (`test/debug.test.ts`, `test/read-cap-repro.test.ts`).
- **Model metadata has separate owners.** Keep wire parameters isolated; make
  metadata-changing variants separate catalog entries. Invalidate cache schema
  before config consumes it; live negative capabilities outrank docs
  (`test/model-metadata.test.ts`). PRs #84/#86/#95 showed that tier selection
  must precede speed preference, defaults must survive catalog partitioning,
  and unmatched hints must not rewrite an advertised tuple. Exercise marked
  non-1M tiers and duplicate ids (`test/model-selection-review.test.ts`,
  `test/model-effort-review.test.ts`, `test/model-selection-run.test.ts`).
  Collapsing an absent max marker to false also disabled the 1M fallback;
  preserve absence through discovery and cache, test explicit false separately,
  and invalidate caches that already erased the distinction (`test/models.test.ts`).
  A max marker is not a context size: Opus 300k Fast is marked, so budgets come
  from the resolved `context` parameter (`test/turn-provenance.test.ts`). Effort
  ties break toward the tier default, as Cursor CLI does, or a hint silently
  dropped Claude thinking (`test/model-effort-review.test.ts`).
  Context-tier splits must retain persisted base/Fast variant ids and collision
  labels, including a Fast entry whose variants all move to another tier. Keep
  legacy selections usable with their old static budget; dedicated entries
  provide the larger budget (`test/model-selection-review.test.ts`,
  `test/model-selection-run.test.ts`).
- **Inspect generator inputs before changing mappings.** Pricing and model
  metadata came from distinct markdown endpoints. Run the live pricing gate
  before a bump; the v0.6.4 failure forced a retag ([release gate](../../AGENTS.md#hard-stop--release--version-bump--tag-gate-non-optional)).
- **Make tests capable of failing.** Type guards once sat outside tsc's include;
  root ignored permission fixtures. Use real usages, deterministic faults and
  independent host/frame evidence (`test/workspace-facts.test.ts`).
- **Publication checks must stop publication.** A failed history scan did not
  stop later pushes in the same shell sequence. Require successful exit before
  publishing, and scan commit bodies and coauthor trailers as well as author /
  committer identities. A clean file diff alone does not establish privacy.
- **Coverage must be measured on the commit it is reported for.** On a pull
  request, checkout tests the merge with main while codecov-action files the
  report under the PR head. Once main changed `src/language-model.ts`, PR #107's
  patch showed 4 missing lines that were main's uncovered branch at the same
  line numbers; the PR's own lines were all hit. The required job keeps testing
  the merge; a separate PR job measures coverage on the head
  (`.github/workflows/ci.yml`).
- **Isolate fixture state.** Capture teardown paths before awaiting; restore
  host-agent callbacks and cache overrides. One leaked cache root broke later
  plugin tests (`test/host-interrupt.test.ts`).
- **A removed temp dir can come back.** Tests left about 200 TMPDIR entries per
  run ([#102](https://github.com/oakimov/cursor-opencode-provider/issues/102)):
  cutting the whole project-folder path put it outside a long cache root;
  background spawns kept their logs and children; a stop's save and terminal
  supervisors wrote after the `finally`/`afterEach` removal; a held Run's save
  landed after its test removed the dir. On Linux only, three tests left
  `createCursor({ cacheDir })`'s process-wide cache root set, so later files
  wrote into their removed dirs and failed tests that expected the default
  root. Wait for the writers, restore the root, then remove; `test/preload.ts`
  fails any run that leaves an entry and lists its files. Killing only a
  background shell's marker PID leaves compound-command descendants alive;
  stop its tree and await exit (`test/background-spawn.test.ts`). A failed
  process listing or a writer surviving termination must fail cleanup, not
  silently permit removal (`test/process-cleanup.test.ts`). Test log content
  separately from its path-bearing diagnostic header (`test/debug.test.ts`).
- **Match CI environments.** Narrow PATH fixtures omitted mkdir; Linux shell
  tests need an init reaper. Strip temporary module copies from coverage and
  include Bun editor types (`scripts/strip-copied-coverage.ts`).
- **Keep one current policy across docs and prompts.** A rebase can add review
  rules; reviewer patches still need whole-path validation. Changelog fixes
  compare with the release, not an intermediate PR state. A versioned heading
  or package version bump does not establish publication. Verify release status
  and keep entries in the maintainer-designated upcoming release. Concurrent changelog
  insertions can conflict despite independent code; compare the union of entries
  after each dependency merge. Keep AGENTS.md to
  current invariants and source pointers; merge incident rationale here or in
  the owning host lesson instead of growing implementation transcripts.
  Acceptance checklists stay reusable; dated counts and logs stay in run reports.
