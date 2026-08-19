# Lessons

- Account-specific endpoint discovery should fail closed when the authoritative API lookup fails; silently substituting a legacy global endpoint can mask the real issue and route regional accounts to a host known to reject them.
- Telemetry fields on API discovery calls should default to disabled and require an explicit provider config opt-in.
- Keep API base URLs and agent Run host overrides as separate options; sharing one `baseURL` name makes it too easy to send the HTTP/2 Run stream to the API host.
- When a host framework merges provider, model, agent, and variant options into one namespace, generated wire parameters need a dedicated typed payload; never infer them from every key in the merged object.
- If a selectable variant changes static host metadata such as the context window, materialize it as a distinct host model entry; when the host uses config `id` for inheritance, keep the synthetic id and carry the upstream wire id in a dedicated option instead.
- Cache schema invalidation must be resolved before configuration materializes cached data; refreshing the file later does not update an already-built in-memory provider catalog.
- Every server-initiated request channel on a bidirectional RPC must either receive its correlated response or fail the turn explicitly; treating an unfamiliar interaction query as an ignorable event leaves both peers alive but permanently waiting.
- Detect framework lifecycle turns (such as OpenCode compaction) through explicit plugin metadata, not by assuming an empty tool list or `toolChoice:none` uniquely identifies them.
- Compaction seeds must preserve actual tool-result payloads; replacing them with tool-name summaries fabricates completion evidence and can make later turns claim tools ran without executing them.
- When a protocol checkpoint captures turn capabilities, a summary turn may disable tool execution but must still advertise the established catalog so post-compaction turns remain tool-capable.
- An opaque checkpoint also captures the lifecycle agent's system/root state; never reuse a compaction agent checkpoint as the resumed normal agent merely because the tool catalog is present. Rebase the normal agent from the host's compacted prompt and normal system instructions.
- Proto3 default scalar values are omitted from the wire. A missing encoded `uint32` correlation field can validly mean zero; raw safety inspectors must apply protobuf defaults before declaring a live frame malformed.
- Provider-specific tool guidance must be derived from the exact per-turn advertised catalog and omitted from lifecycle prompts; naming unavailable host tools turns a useful fallback into another unexecutable request.
- A protobuf encode/decode round trip against one locally declared schema cannot prove wire compatibility; protocol regressions need independent canonical field fixtures, especially where a reused field number changes wire type. Never register a compatibility alias under the name of a different canonical message, because later reuse can silently select the wrong shape.
- Tool translation requires compatible state and input semantics, not merely similar names. Decline a bridge when it would turn a read/lifecycle action into a replacement write, lose merge state, substitute a search term for a URL, fabricate a structured policy/selection from a coarse boolean or unrelated catalog, or reuse an item identity as a group identity.
- When one held-open stream is resumed across host calls, dispatch each inbound frame to completion before reading the next. Concurrent fan-out can consume past the handoff boundary and make continuation frames impossible to recover.
- Never infer a client response field from a server request field number. Protocol families can deliberately offset request/result oneofs; maintain an explicit mapping and close each exec stream after the typed result.
- A completed tool-display event is evidence that an operation already finished, not authority to execute it again. Only mirror self-contained final UI state; data, interaction answers, side effects, and failures require a request/reply channel.
- Process-global session metadata needs a shared finite lifetime just like checkpoints and blobs. Bound tool catalogs, lifecycle markers, and conversation bindings, and evict their associated opaque state together.
- Advertising a virtual MCP server also commits the provider to its control plane. Answer state/readiness probes from the exact advertised descriptor set before waiting for the eventual tool execution request, but validate each response against its canonical nested schema: MCP state uses full tool definitions even though request-context catalogs use narrower filesystem descriptors.
- An HTTP success status or clean iterator EOF is not an application-level turn boundary for a bidirectional agent protocol. Require the protocol's terminal event, capture connection trailers/GOAWAY, and rebase from host-owned history when a held-open Run disappears.
- A native Task display frame does not execute the subagent. Cursor's correlated exec field #28 must be decoded as `SubagentArgs`, emitted once through OpenCode's `task` tool, and answered with the paired typed `SubagentResult` so the held-open Run can resume.
- Native tool bridges must normalize framework-specific built-in identifiers at the semantic boundary. Cursor's `generalPurpose` maps to OpenCode `general`, while native read-oriented `bugbot` reviews map to `explore`; forwarding those wire names verbatim executes the bridge but fails host validation before spawning anything.
- A native background-process request cannot be represented by merely renaming it to a foreground shell tool. Detach it with every inherited stream redirected, preserve request metadata until the typed spawn result is sent, and reject interactive lifecycle features the host cannot actually service.
- Host-tool timeout prose is transport metadata, not model-visible stdout. Preserve the upstream timeout policy through tool execution, remove the host envelope in the result hook before persistence, and encode the protocol's typed timeout/background outcome on continuation.
- Keep a complete request/result inventory even when only a subset is executable. A raw field id should resolve to its canonical request name, paired result name/id, and local support class; that makes known unsupported capability distinguishable from protocol drift without fabricating a response.
- Cursor's native capability set can exceed the current OpenCode agent's advertised tools. Treat the per-turn host catalog as an execution allowlist for every decoded exec request, not only MCP calls; return an unavailable request through its correlated typed result instead of letting the host synthesize an `invalid` tool call.
- Structured workspace context alone may not prevent invented path prefixes after a conversation rebase. Derive any prompt-level path anchor from the same normalized root used by the structured context, and keep lifecycle prompts such as compaction unchanged.
- User-facing behavior documentation should stay concise and point maintainers to the source and focused tests; internal prompt transport and checkpoint mechanics belong in code unless users need them to operate the feature.
- The package root is an OpenCode plugin entrypoint, not a general public runtime barrel. Keep root runtime exports plugin-safe and publish auxiliary APIs from subpath exports so the classic loader cannot invoke classes or helpers as plugin functions.
- Cursor's streamed edit is a client handshake, not one atomic exec: an existing file follows `edit_tool_call` → `read_args` → `write_args`. For a correlated missing target, answer the prerequisite read as an empty file so creation can continue through the normal write tool instead of teaching the model to fall back to shell.
- A protocol operation's final exec variant can describe client mechanics rather than model intent. Preserve the display call id across a streamed edit, satisfy its private read with complete workspace content rather than a host-capped preview, and translate only the correlated whole-file write back into the host's targeted edit capability; an uncorrelated write must remain a write and external reads must retain host permissions.
- Never flatten host tool results into assistant-authored seed-history prose. Normal conversation rebases should omit stale results; lifecycle flows that need the evidence must mark it as a host observation so the model is not trained to counterfeit a result instead of issuing a tool call.
- A bounded tool result's payload length is not the resource's total length. Preserve the requested range and full-resource metadata before stripping a host-specific envelope; otherwise a correct slice becomes an internally impossible protocol response that teaches the model to distrust the tool.
- Security hardening may manage permissions only on provider-owned paths. An explicit file override authorizes that file location, not chmod of its parent directory; provider-owned temporary directories must also be validated as real, current-user-owned directories before use.
- A network deadline must cover response-body consumption, not only receipt of headers. Clear abort timers in `finally` after the body has been consumed, or a server can acknowledge a request and then hang initialization indefinitely.
- Metadata recovery for capped output must use bounded memory. If an upstream footer omits a full-resource count, scan in fixed chunks rather than buffering the complete resource just to derive metadata.
- A server checkpoint is a recovery boundary, not merely evidence that replay is unsafe. On a transient Run failure, resume the same conversation from the newest checkpoint with the protocol's resume action; only fall back to history replay when no stateful progress occurred.
- Install-tree compatibility wrappers must consume the host identity recorded when they are installed. Isolated provider workers can hide the parent binary and environment, so ignore config-directory guesses for behavioral policy and use the validated install-tree host only as a fallback after stronger live signals.
- When a host tool name collides with a model's native UI-bound capability, prompt wording alone is not a reliable routing boundary. Advertise a collision-safe alias, retain a per-session reverse mapping to the exact original tool, and fail closed when capability discovery is ambiguous.
- A safe alias does not disable the corresponding native capability. When the protocol exposes optional capability flags, advertise unavailable UI-bound capabilities explicitly as false on every context path; rejecting a later approval query leaks avoidable failure narration into the model turn.
- Co-installed application directories are evidence of installation, not process identity. Route host-owned state only from explicit options/environment, live binary/package identity, or the provider's own install path; otherwise use the upstream OpenCode default.
- An interaction approval channel is not a tool bridge when its response cannot carry execution output. For headless compatibility, expose an executable host tool and translate the model request through the correlated exec channel instead of auto-approving a server-side substitute.
- Framework tool ids can be reserved beyond the built-in registry. If filtering happens after plugin tools are merged, a plugin collision is filtered too; register fallbacks under their final collision-safe public id and test the host-visible catalog, not only the raw plugin hook.
- Cursor-native Task subtype names, host agent names, and MiMo work-item tools are separate namespaces. Preserve the raw Cursor subtype until it can be resolved against the current permission-filtered Task/Actor catalog; prefer exact spawnable custom names, use structured enums over broader prose lists, and route MiMo execution through `actor` rather than its `task` tracker.
- A host's "v2 plugin API" and its next-major plugin API can be different, source-incompatible APIs sharing a version-adjacent name. Verify hook signatures, credential value types (Effect vs Promise), and provider schema against the published package for the exact dist-tag users install; when advancing a beta pin, diff declarations and preserve runtime compatibility for simple field renames where practical.
- Documentation is a starting hypothesis, not ground truth, for an unreleased API. Read the shipped `.d.ts` before designing against docs prose: the published surface here contradicted the docs on hook arity, the `aisdk:` package discriminator, and which domains exist.
- A type-conformance test proves nothing unless the build actually typechecks the file. Confirm a guard fails when deliberately broken; `include: ["src"]` silently excluded the entire test tree, so the first version passed vacuously.
- Prefer usage-level type assertions over whole-interface assignability when guarding against a schema-derived API. Branded strings and mutable-vs-readonly drafts make structural identity unachievable, while one assertion per real call site still fails loudly on a breaking change.
- When emulating a removed host hook, confirm the replacement hook actually exposes a writable channel for the value. A mutation to a field the host does not read is indistinguishable from working code at compile time and silently drops the behavior.
- A structured metadata flag is not a message to the model. `truncated: true` was already being sent and models still asserted "highly confident" that partial content was the whole file; only a marker inside the content text changed the answer. Verify a signal reaches the model behaviorally, not just on the wire.
- A stale code comment can misdirect an entire fix. "Most reads arrive via mcp_result" sent the first version of this change to a path live traffic never used; one end-to-end run showed every read going through `read_result`. Confirm which branch real traffic takes before optimizing it.
- Design an A/B fixture so the signal under test is the *only* way to reach the right answer. A self-describing fixture (lines carrying their own index) let the model infer truncation without the notice, hiding a null result until the fixture was made blind.
- A regex that reads control metadata out of a payload will eventually match the payload itself. Anchor footer/marker parsing to its structural position in the envelope, not to a substring search over the whole document — a file that merely quotes the marker otherwise impersonates it.
- Stripping a host envelope must preserve what the envelope *said*, not just the payload. A capped read whose "output capped" footer is removed is indistinguishable from a complete one, so the model rewrites the file from a partial view and destroys the remainder. Re-state the limit through a channel the model cannot echo back into content — a separate result item or a structured truncation field — rather than restoring the raw footer.
- A matching constant on both sides of an integration is not evidence of which side applied it. Two independent 50 KiB budgets looked like one server-side cap; the truncation was in the opposite direction from the symptom, on the read that fed the write. Trace the data path before attributing a boundary.
- An allowlist named for transport metadata will quietly swallow content fields. Before adding a wire field to a decoder, check whether an existing filter already discards it; a schema addition alone changes nothing if the key is dropped downstream.
- A host may substitute one capability for another rather than merely withholding it. When a tool is missing, check whether an equivalent was advertised in its place and translate; key that translation off the advertised set alone, never off a model id or host version, so it stays inert wherever the substitution does not apply.
- Before adding a fallback to a dispatch path, confirm the path is reachable for the inputs in question. A display-mirror bridge that gates on a small variant allowlist will never see the streamed-edit variant it appears to handle, so a fallback there is unreachable code that a passing typecheck cannot distinguish from working code.
- A shared implementation module silently couples every entrypoint to its heaviest import. When one host's package root exports a value another host's does not, keep that value import in a leaf module owned by the host that needs it; a smoke test run inside the repo cannot detect the breakage because the dev dependency always resolves locally. Audit the built dependency graph instead.
- Security scanners classify data flow by shape, not intent. When a high-entropy token is hashed only for an ephemeral memoization key, keep the raw secret out of process-global state and narrowly suppress the password-hash rule with the lifecycle rationale rather than weakening the design to silence the alert.
- Regexes that combine repeated prefixes, lazy wildcards, or anchored alternatives can become polynomial even when normal inputs are short. Parse structural delimiters such as data-URL metadata in explicit linear passes and keep stress fixtures that exercise repeated-prefix and missing-terminator cases.
- Inspect the exact fetched artifact before extending a generated-data pipeline. Cursor's pricing page and aggregate docs expose related model data through separate markdown endpoints, even when the rendered documentation makes them look like one model table.
- A model capability flag is safe to publish only when the provider preserves the matching prompt parts on the wire. Keep live negative values authoritative over docs fallbacks, because account-specific model catalogs can contradict the public table in both directions.
- When a live continuation channel is text-only but a fresh request accepts images, keep continuation frames unchanged and harvest media from prompt history only when opening the next Run. Bound history growth with content-hash deduplication, while allowing recovery rebases to resend because they create a new upstream conversation.
- A host's native capability can be advertised implicitly, with no descriptor and no flag to disable — the client either owns an executor for a request field or it doesn't. Treat any such field as reachable regardless of what this provider chooses to advertise, and give it a total, typed answer on the protocol floor; a request-context flag that merely describes supplied data is not evidence the underlying capability can be turned off.
- A tool-name collision with a host-native capability is not limited to one feature area. When this provider's own advertisement inverts the host's model (every tool exposed, including ones the host already owns natively), the same alias-and-reverse-map remedy applies to each new collision as it's found, not just the one it was first built for.
- A per-turn trace value computed before the encoder is not evidence of what went on the wire. `historyChars` counts a system entry that `buildSeedConversationState` then drops whenever `systemPrompt` is set, so the log reads like a duplicated 69 KB prompt that is never actually sent twice. Read the encode path before reporting a payload defect inferred from arithmetic over trace fields.
- A host can withhold tools from the model without withholding them from itself. oh-my-pi's `tools.xdev` mounts every non-essential tool — all MCP servers included — behind `xd://` device URLs and ships only ~11 entries in `Context.tools`; the devices remain fully executable and are catalogued in the system prompt, so nothing in the provider or bridge is broken and neither can advertise what the host never puts in the tool list. When a model reports that tools are missing, separate "absent from the callable schema" from "absent from the host", and look for a host presentation setting before changing wire code.
- A model's account of its own system prompt is not evidence about the system prompt. Asked directly, the model denied any `xd://` or GitHub content while that same prompt carried 63 device lines and it could execute those devices on request. Verify prompt contents by dumping what the provider actually sends, and verify capability by invoking it.
- A 50 KB read cap can still cause data loss when a model turns the partial result into a whole-file edit; an explicit model-visible warning must be paired with guidance to page before replacing complete contents, and large `TurnEnded` counters need a request-local sanity check even without a visible tool boundary.
- A model-visible partial-read warning is still advisory, but a literal-content guard must match the destructive operation: reject whole-file writes and overwriting Add File patches that echo it, while allowing targeted edits and complete correlated edit transactions so source code can legitimately quote the warning.
- A host-authorized external read can safely establish permission for a provider-internal edit prerequisite, but authorization and data completeness are separate facts: wait for the host's successful result, then read the exact correlated file completely before allowing a whole-file edit transaction to continue.
- A cache snapshot is not frozen merely because it is retained in a map. Recursively freeze the stored base, deduplicate concurrent first builds, and compare encoded overlays, or callers and races can silently change the supposedly byte-stable prompt prefix.
- Persisting an opaque conversation checkpoint alone is not restart recovery: its session binding, content-addressed blobs, stable request-context base, lifecycle tool fallback, and pending compaction rebase must be replaced atomically at the protocol's successful turn boundary.
- Binary-heavy durable state should not pay JSON's base64 expansion merely for inspectability. Measure the real payload: direct protobuf bytes plus whole-record gzip retained schema evolution while reducing this conversation snapshot far more than compacting JSON or protobuf alone.
- A content-addressed restart store cannot safely keep only its root checkpoint, but it also must not append every historical blob forever. Traverse the latest root with the producer's own reachability rules, garbage-collect only after the successful boundary, and fall back to retaining everything when the graph is incomplete or undecodable.
- Protocol fields can become live across client releases. `RequestContextArgs.use_cached` was unused in the earlier CLI, but the 2026.08.11 exec daemon uses it for a baked disk context and overlays current plugin rules/skills/subagents plus MCP tools/options; verify the exact shipped build before treating a field as inert.
- Prompt-cache stability must not freeze capability truth. Keep expensive workspace context stable, but refresh tools/MCP, skills, agents, and plugin metadata each turn; byte-compare the materialized result so unchanged capabilities remain exactly cacheable.
- A conversation-id reset is not necessarily a workspace-context reset. Compaction must discard the old checkpoint/history identity, but transferring the frozen base and prior byte-comparison seed lets unchanged system capabilities retain an identical cache prefix while live overlays still refresh.
- Atomic replacement prevents a torn cache file, not cross-process lost updates when every process rewrites one aggregate from its own stale in-memory map. Partition durable state by its single-writer ownership key (the stable OpenCode session id), retain the rotating Cursor conversation id inside that record, and make stale cleanup revalidate any file moved aside so it cannot erase a concurrent fresh replacement.
- Usage fields named as totals may already contain their cache/reasoning subsets, while repeated downstream step boundaries can still multiply one upstream request. Verify semantics against both the shipped client and multiple live turns: here decreasing continuation counters proved `TurnEnded` is request-local. Emit zero at intermediate boundaries and the complete final snapshot once; never infer cumulative semantics from one monotonically increasing sample.
- When a host uses one AI SDK usage total for both display and compaction, use Cursor checkpoint `tokenDetails.usedTokens`, not aggregate `TurnEnded` input. Keep the current output component, proportionally normalize the input cache partition so every displayed component sums to Cursor's total, and retain exact request counters in provider metadata. With no fresh token details, keep the prior checkpoint explicitly stale; with no known checkpoint, leave occupancy unavailable/zero. Cursor CLI does not promote request usage into context occupancy, and neither should the provider.
- An aggregate cache ratio cannot identify why reuse is low. Log the prior checkpoint occupancy, current category deltas, byte-stable context fingerprints, and agent-step/tool activity alongside raw read/write/uncached counters; explicitly mark per-model-call cache accounting unavailable when the protocol does not provide it.
- A heartbeat backpressure error can be only the first awaited write to expose a backlog created elsewhere. Serialize response-required writes, await each KV drain before reading another request, and label failures with the operation that actually filled the stream. Treat an opaque checkpoint envelope, its reachable blob graph, and a fresh-history seed as separate quantities; only the latter two can inform safe rebase and context diagnostics.
- TypeScript editor diagnostics can use the root `tsconfig.json` even when the
  repository's test typecheck intentionally excludes runtime tests. Keep
  `@types/bun` installed and include `bun` in `compilerOptions.types` so Bun's
  `bun:test` imports resolve in OpenCode's LSP without widening the build's
  source/test inclusion.
- A provider-side argument mapper must preserve alternate host tool shapes
  before normalizing the default shape. OMP's hashline `edit` sends `{input}`;
  rebuilding every edit from OpenCode's `{filePath,oldString,newString}` fields
  silently changed that valid call to `{}`, so OMP reported a misleading missing
  `input` field. Keep the hashline payload intact and strip only its metadata.
- Host-owned paths must be calculated through the path bridge, not hardcoded to
  OpenCode's default. Writing CreatePlan files to `.opencode/plans/` verbatim
  breaks MiMo/Kilo/OMP hosts that use a different project-config dir; route through
  `opencodeProjectConfigDirs` / `hostPlansDir` and keep the body in the host's
  universal plain-markdown shape so non-Cursor models are not confused by Cursor
  YAML frontmatter or `~/.cursor/plans`.
- Do not refuse a Cursor InteractionQuery that OpenCode can satisfy with an
  advertised host tool. SwitchMode (#4) maps onto `plan_enter` / `plan_exit` the
  same way AskQuestion maps onto `question`: hold the query open, emit the host
  tool, and reply `approved{}` / `rejected{reason}` (CLI string on user decline)
  on continuation. Map `plan`/`spec` → `plan_enter` and every other non-empty
  target → `plan_exit` (no exclusions); after approval, inject a CLI-shaped
  `<system_reminder>` for that mode on later Runs. Never invent a `task`/
  subagent spawn for SwitchMode itself — reminders may instruct the model to
  use `task` afterward.
- OpenCode 1.18 `/plugin/v2` has no `tool` domain — `cursor_image_save` and
  `custom_websearch` live only on the classic Hooks plugin. Dual-load classic +
  v2 is required for GenerateImage on 1.18; a v2-only load silently disables it.
  OpenCode 2.0 `/plugin/opencode2` must register `cursor_image_save` itself via
  `ctx.tool.transform` using host-neutral `executeCursorImageSave` (never import
  `image-save-tool.ts`, which pulls classic `@opencode-ai/plugin` `tool()`).
- SwitchMode has two Cursor channels that must stay distinct: InteractionQuery
  #4 is the sync consent gate (`approved{}`/`rejected{reason}`, no async
  variant); display `switch_mode_tool_call` (#25) is the transcript record with
  `SwitchModeResult` (success hardcodes `from_mode_id=""`). Bridging the query
  without inventing a display result is correct — display stays non-replayed.
  OpenCode advertisement is the live gate for *bridging to a host tool*, but
  absence of that tool is not a reason to refuse the switch (see the 2026-08-16
  entry below).
- A provider-recorded mode can become stale when the host completes a native UI
  lifecycle without another SwitchMode query. For the omp bridge, mark the mode
  as bridge-entered when the real `plan_enter` continuation succeeds; native
  approval/exit restores `plan_enter`, which is then a reliable signal to emit
  one Agent handoff and clear the Cursor plan reminder. Do not infer native-plan
  liveness from registration alone: the bridge tool is callable outside plan
  mode too, so CreatePlan staging must require that successful entry marker.

## 2026-08-16 — An approval the model has to volunteer is not a gate

- **A gate that depends on the model choosing to ask is not a gate.** Plan mode
  was entered and the plan file was written, and then the turn simply ended: the
  model never raised SwitchMode back to `agent`, so the approval prompt that
  lives on that path never fired. Nothing was broken by the spec's own terms —
  the spec was wrong. Attach the prompt to the step that actually happens
  (recording the plan), not to a later step the model may skip.
- **Two hosts satisfying "the same" flow can fail in opposite directions.** The
  pi-bridge path asked but reported *both* answers as success, so requesting a
  refinement made Cursor start implementing the plan the user had just declined;
  the native path never asked at all. Fix both by naming one contract — success
  = approved for execution, error = written but not accepted — and making every
  channel report through it, rather than patching each side's symptom.
- **Split "persist" from "execute" when deciding what needs consent.** Writing a
  plan is cheap, reversible, and outside the repository, so it needs no
  approval; starting the work it describes does. That split is what lets the
  write stay unconditional while the gate stays mandatory.
- **An approval prompt is only a gate if the user can see what they are
  approving.** The first version asked "start implementing?" and named a file
  path; the plan itself had never been displayed, because Cursor routes the body
  through the interaction query rather than the text stream. Ask where the
  content already is, or put the content where the user reads — and check which
  surface can actually hold it: OpenCode's question dock renders outside the
  scrollbox with `flexShrink={0}`, so a full plan there pushes the conversation
  off screen, while the assistant message scrolls and persists.
- **An answer parsed by anchor text must be parsed with the exact anchor.** The
  host echoes the prompt verbatim and the answer is sliced relative to it, so a
  prompt built from a different label silently reads as unanswered. Carry the
  literal question that was asked through to the parse, and test the mismatch —
  the failure mode is a prompt that can never be approved.

## 2026-08-16 — A missing host tool is not automatically a refusal

- **Read what the host tool *does* before treating its absence as a dead end.**
  SwitchMode rejected twice in `/tmp/opencode-plan-test.log` because neither
  `plan_enter` nor `plan_exit` was advertised. The bridge was behaving to spec,
  but the spec was wrong: OpenCode's plan tools are not mode flags. Each asks
  the user through the Question service and, on "Yes", injects a synthetic user
  message carrying `agent:"plan"|"build"`, which `createUserMessage` turns into
  a `setAgentModel` primary-agent switch (`tool/plan.ts`, `session/prompt.ts`).
  Of those three effects a provider cannot reach only the last one — so the
  bridge can reproduce the observable contract instead of refusing.
- **Entering a provider-owned mode needs no host tool at all.** The injected
  `<system_reminder>` *is* the contract, exactly as Cursor CLI's own plan mode
  is prompt-enforced. Gate on a host tool only where the host genuinely owns the
  outcome — here, the execution approval, which degrades to `question`.
- **Do not conclude "not implemented" from a filtered grep.** The first pass
  searched `plan_enter` while excluding the very files that define plan mode,
  concluded upstream had no such tool, and missed `plan-enter.txt`, commit
  `fa559b038` disabling `PlanEnterTool`, and the whole synthetic-message
  mechanism. Widen the search and read the git history before declaring absence.
- **Absence is the common case, not the edge case.** OCP only relabels tools the
  host already advertises — it never invents them — and neither the MiMo nor the
  Kilo profile declares a plan role. Emulation is the live path on those hosts,
  so it must be as considered as the native path, not a fallback afterthought.

## 2026-08-16 — CreatePlan Yes must kick off OpenCode, not only ack Cursor

- **Cursor `success` is not a host turn.** After the emulated CreatePlan
  approval, writing `{success, plan_uri}` and flipping the session to `agent`
  only closes the held Run (`finish: stop`). Native `plan_exit` also injects a
  synthetic user message with `agent: "build"` and "Execute the plan" so a new
  OpenCode loop starts. Mirror that second half via `session.promptAsync` from
  the classic plugin (`src/plan-execution-kickoff.ts`); keep failures out of the
  Cursor wire path — approval already succeeded.
- **Register the kickoff where the host client lives.** The language model
  cannot import the OpenCode SDK client; the classic plugin installs the
  handler once, and unit tests stub it. No handler means approval still works
  but the host stays idle — that is the observed production bug.

## 2026-08-16 — Lifecycle SwitchMode must soft-ack, not reject

- **A hard `rejected{reason}` on a tools=0 title turn enters the transcript.**
  The real agentic Run then sees "mode switch rejected" and narrates that
  switches are blocked, even though the next SwitchMode succeeds. Soft-ack
  with `approved{}` and omit `switchMode` so session mode is not mutated —
  same pattern CreatePlan already uses for lifecycle turns.
- **Advertisement ≠ permission still holds.** Re-advertise the full catalog on
  lifecycle turns, refuse execution, and never flip plan mode from them.
- **Soft-ack is not a tool-list change.** Rebuild `dist/` before live OpenCode
  tests; a stale build still hard-rejects while source soft-acks.

## 2026-08-16 — Cold-start zero-tool Runs must wait for the sibling catalog

- **Never freeze `tools=0` into RequestContext when a real catalog is about to
  arrive.** Title/lifecycle Opens often race ahead of the agent Run. Advertising
  empty then the full set changes RequestContext bytes and colds the prompt
  cache (`continuity=cold`, divergent hashes). A timeout is not a fix — the live
  race exceeded 1.6 seconds. A session-keyed lifecycle Run must wait for a sibling
  `rememberToolCatalog`; cancellation is the only escape, never `tools=[]`.
- **Do not invent or filter enabled tools.** Advertisement stays the host's full
  set (or the last remembered one); permission (`allowTools`) stays false on
  zero-tool turns. Soft-ack alone does not fix the cache break.

## 2026-08-19 — Host retry loops key off error *text*, not our flags

- **OpenCode SessionRetry matches substrings in the provider error message**
  (notably `unavailable` and `exhausted`), not `transient` / `replaySafe`.
  After this provider finishes its own Run budget — or suppresses replay as
  unsafe — the host-facing message must not still contain those triggers, or
  OpenCode will keep retrying ("Provider is overloaded") until the process is
  restarted. Keep the real gRPC code on structured fields; sanitize only the
  terminal message text.

## 2026-08-17 — Bridged Cursor interactions are not missing MCP tools

- **The OpenCode tool catalog is not the complete Cursor capability set.**
  CreatePlan is an inbound Cursor `InteractionQuery`, so it is expected to be
  absent from the OpenCode/MCP catalog while still appearing in Cursor's native
  function definitions. Guidance must name this distinction explicitly and tell
  the model to raise CreatePlan normally, not narrate that it is unavailable.
- **Use actual tool APIs, never render tool-call JSON as assistant text.** A
  textual tool request does not execute and confuses the user; after a failed
  tool attempt, retry with the provided tool mechanism rather than another
  protocol representation.

## 2026-08-17 — Compatibility dependency is one-way

- **A provider-neutral bridge is not enough if the provider imports the bridge
  package.** The provider may consume a structural host capability installed on
  `globalThis`, but host detection, package imports, fork environment variables,
  and rotated tool vocabulary belong entirely to the compatibility layer.
- **Move behavior only after parity is pinned at its destination.** Before
  removing fork handling from the provider, prove catalog, call, resume-id,
  result, path, and schema translation in OCP. This keeps architectural cleanup
  from silently deleting working compatibility.
