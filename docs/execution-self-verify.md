# Shell, error, cancellation, and runtime-file self-verification

Run native OpenCode 1 and native OpenCode 2 separately. A pass on one does not establish the other. Additional OCP consumers are separate compatibility runs. This reusable procedure originated with PR #51; it tests the loaded revision, not an assumed historical build. The native-shell redesign remains a separate task in [tasks/todo.md](../tasks/todo.md). File-tool and early-steer checks are in [host acceptance](host-compat-acceptance.md).

## Operator setup — do not paste this section as an agent task

1. Build the intended provider revision with `bun run build`. Verify the actual installed package, entrypoint, and compiled files match that build. Record host version, operating system, provider revision, Cursor model, entrypoint, and installation verification privately.

2. Use a newly created throwaway workspace and a dedicated host configuration. Supply its path and this run's creation record if preparing canaries there before the agent starts. Isolate cache/data using the host's documented options; do not invent environment overrides. Existing credentials may be used through native authentication, but must never enter fixtures or reports. Prepare three permission lanes using the installed host's documented permission schema:
   - **allow:** ordinary scratch operations;
   - **deny:** specific canary read/write/edit/delete/shell operations denied by policy;
   - **ask:** shell launch requires an actual native permission prompt.
   Do not modify a working project's permissions. Provide the agent with the lane and protected canary paths. Configure matching against the actual command presented for approval, including any provider wrapper.
3. Create an evidence directory and a fresh log for each lane. Example, from the operator shell:

   ```sh
   EVIDENCE=$(mktemp -d /tmp/cursor-pr51-evidence-XXXXXX)
   export CURSOR_PROVIDER_DEBUG=1
   export CURSOR_PROVIDER_DEBUG_FILE="$EVIDENCE/provider.log"
   : > "$CURSOR_PROVIDER_DEBUG_FILE"
   ```

   Export these on the process that loads the provider. Restart the complete host/daemon after installation or rebuild; a plugin reload alone is insufficient for OpenCode 2. Once a lane starts, do not rebuild, relink, clear its log, or restart except for the explicit restart test. Preserve each lane's log before starting another. By default, on the first write and hourly thereafter, debug logging compacts files above 50 MiB to roughly the newest 25 MiB in place. With `CURSOR_PROVIDER_DEBUG_LOG_MODE=rotate`, preserve the current file and all numbered archives for the lane. Evidence lost to `size-cap trim` (or `size-cap truncate` in older builds) makes affected checks blocked, not passed. See [the log runbook](./cache-log-runbook.md).
4. Arrange an **observer outside the tested model turn**: the operator's shell/UI or an independent native session observer. It must capture native tool status, permission events, and test-owned filesystem/process observations. For managed shell launches, identify the actual reserved terminal file, `.jobs` index, and job directory from observed runtime paths/owner records. Snapshot before and immediately after rejection/interruption, **before sending another user message**. The tested agent cannot observe this timing after its own turn has stopped. Do not guess the runtime root or inspect unrelated sessions.
5. The operator owns Reject, Reject with feedback, Interrupt, and restart actions. Record the action, case label, and timestamp. A question-tool answer is not a shell permission decision. Do not auto-approve the cases intended to test rejection.
   Native OpenCode 2 ends the model step on Reject **without** feedback ([native permission contract](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/permission.ts#L244-L255)). The provider and this prompt cannot keep that same native turn running. This case requires a subsequent user message to resume after observation; do not promise automatic progression across it.
6. For exact wire assertions, arrange a private decoded-frame capture or a controlled native-host fixture that records the provider's emitted frames. The ordinary debug log records result field, frame count, and output length in the `continuation: wrote …` line of `deliverContinuationResults` (`src/language-model.ts`); those fields do **not** establish a result's inner oneof, abort flag, or reason. Keep live Cursor results and scripted native-host results in separate columns.
7. Storage fault, missing-reservation, malformed-error, and independent-module-copy cases require an isolated operator-controlled fixture. Supply it only when it traverses the loaded provider and real native host lifecycle. Do not fill the machine's disk, change global permissions, edit production metadata, or let the agent patch the provider to manufacture a pass. If unavailable, those checks remain blocked and the final report must state the coverage gap.

Paste the Agent prompt below into the selected Cursor session. Supply:

```text
Host/version: <native OpenCode version>
Provider revision and loaded-entrypoint proof: <operator record>
Lane: <allow | deny | ask | restart | controlled fixture>
Scratch workspace: <new operator-created workspace and creation record | agent creates it>
Debug log: <this lane's private log path>
Evidence directory: <private evidence path>
Observer: <available | unavailable>
Protected canaries and configured permissions: <operator record>
Controlled fixtures and resource budget: <available cases | unavailable>
Execute the Agent prompt in docs/execution-self-verify.md for this lane.
```

## Agent prompt — copy/paste or ask the agent to execute this section

Perform an adversarial live self-check of the loaded provider's shell execution, native tool-error preservation, cancellation cleanup, history recovery, and runtime-file behavior. Read this entire Agent prompt before starting; finish any truncated read. Execute only the configured lane, retain a checklist, and resume at the next unfinished case after human intervention. Do not implement fixes, edit source checkouts, change permissions, commit, or push.

When an ordinary question or feedback-bearing tool rejection returns, process its result and execute the next unfinished case; do not ask for a separate `continue`. Group necessary setup questions at the beginning. Run deliberate no-feedback rejection and interruption cases last: the native host may end those turns, and this prompt cannot restart them. Save the next unfinished step before each such case. Do not silently substitute a feedback-bearing rejection for the no-feedback case.

### Make every required user action explicit

Before opening an interactive tool, starting a command the user must interrupt, ending a turn for the baseline check, or requesting a restart, emit a short **visible assistant message**. Do not leave these instructions only in reasoning, a checklist file, or the tool arguments. Show one upcoming action at a time using this format, with actual case labels and copyable text rather than unresolved placeholders:

```text
USER ACTION — <case label>
Do now: <exact choice/action, including any feedback text and when to act>
Expected next: <continues automatically | turn stops | host restarts>
Before resuming: <required observer check, or "nothing">
Resume: <"No message needed" or the exact message to send in this same chat>
```

Use the following instructions for the matching case. These are templates to fill in and emit **before** the action; do not ask the user to interpret the full test matrix:

- **Ordinary question:** say which question to answer in the native question UI. State that the test should continue automatically and no separate message is needed. If it unexpectedly stops, give the fallback `Resume PR51 after <case>; the question was answered but the turn stopped. Verify the outcome, then continue the next unfinished case.` Retain the unexpected stop in the report.
- **Reject without feedback:** say `Choose Reject for the upcoming shell permission request. Leave feedback empty; do not approve it.` State that the turn will stop. Tell the observer to capture the marker and reservation/index/job state before any new user message. Give the exact resume message `Resume PR51 after <case>; I rejected without feedback. Verify the rejection and available cleanup evidence, then continue the next unfinished case without retrying the rejected command.` If no observer was supplied, state that immediate cleanup will remain unverified; do not imply the user must invent a snapshot.
- **Reject with feedback:** identify the native action that accepts rejection feedback and supply the exact text `Do not execute case <case>`. Explicitly say that choosing Reject with an empty feedback field exercises a different case. State that the test should continue automatically after feedback is returned. Also give the fallback `Resume PR51 after <case>; the rejection stopped the turn. Check whether my feedback was recorded, then continue the next unfinished case without retrying the command.` If the current UI's feedback action is unknown or unavailable, say so and mark this case blocked instead of inventing a button or keyboard shortcut.
- **Interrupt:** say which native Interrupt/Cancel action to use and exactly when: while permission is pending, or after the named progress marker appears and before handoff. State that the turn will stop. Specify the observer's cleanup/process checks and any wait until the delayed side-effect deadline. Give `Resume PR51 after <case>; I interrupted it. Verify partial output, side effects, and cleanup evidence, then continue the next unfinished case without rerunning the interrupted command.`
- **Warm baseline:** state `This check intentionally needs a new user message; answering a question is not sufficient.` End the turn with the exact baseline continuation message from section 1 ready to copy. Do not merely say "waiting".
- **Restart recovery:** tell the user to preserve this lane's evidence, restart the complete native host with the same provider build, and reopen this same chat. Give the exact classification message from section 4. State that another message is required after restart.

For parallel permission cases, name every affected case and explain whether the host's Reject action will reject the whole pending batch. If that behavior is unknown, state the uncertainty before the user chooses; do not present an unverified batch scope as fact.

After each user action or resume message, first inspect the native result and available evidence. Briefly state the observed outcome and what happens next. Resume the next unfinished case; never replay the rejected/interrupted payload. If the user sends only `continue`, use the saved case/checklist and native history to identify the stopped case rather than asking them to repeat an action already recorded. Do not call a case passed merely because the user made the requested choice.

### Rules and evidence

- Use only actually advertised tools and their current schemas. Supply every required argument. For `CallDynamicTool`, use the discovered outer `namespace`, `toolName`, and `arguments`; the inner input schema describes `arguments` only. Never guess a native Cursor function or host tool name. Send OS commands only to an advertised OS shell; a tool accepting JavaScript `code` is not an OS shell.
- Prefer dedicated file/search/list capabilities for those operations. For a denied file operation, do not bypass it with shell or another tool. Use a separately authorized observer to check side effects. Do not retry intentionally denied/rejected/interrupted payloads unless a case explicitly authorizes a fresh attempt.
- Use the supplied newly created scratch workspace and verify its creation record, or create one with `mktemp -d /tmp/cursor-pr51-work-XXXXXX`. The operator's evidence directory must be outside it. Never reuse fixtures from an earlier run. Keep all payloads and canaries inside this scratch workspace. Provider-owned runtime files may be observed only through authorized native/runtime reads; agent writes there are prohibited.
- Give every case a unique label. Record intended action, complete submitted arguments, actual native result/status, elapsed time when relevant, and independent side effects. Keep real correlation identifiers private; use labels such as `case-07` and `session-A` in shareable reports.
- An intentionally injected failure passes only if its failure semantics and side effects are correct. Inventory **all unexpected errors**, malformed calls, silent ignored arguments, duplicate execution, stale attribution, and retries. A later successful retry never erases an earlier failure.
- `No result value`, a missing response arm, or a transport/protocol error is an unexpected failure, even when the attempted operation was supposed to fail. Require the intended runtime error or typed refusal; an opaque broken response cannot pass a missing-file test.
- Attribute every background completion to its original native launch using the complete transcript and handle, including launches before the current model step. An apparently early notice is not proof of staleness. Do not relaunch a case because the current model step forgot its first launch; retain all launches and count their side effects.
- Logs, tool status, the model's explanation, and side effects are different evidence. An `exit 0` wrapper or host `completed` badge alone does not prove the payload succeeded. Absence of an error grep match does not prove correctness. Unit tests are supporting evidence, never a substitute for these live checks.
- If a required route, observer, or fixture is missing, mark the case **blocked**. Optional advertised capabilities may be **skipped** only when unavailable. Do not substitute an easier route and claim the original route passed. Stop the lane if an unauthorized side effect occurs; preserve evidence.

### 1. Preflight — every lane; ordinary-turn baseline — allow lane

Confirm operator build/installation proof and make one tiny debug-log check:

```sh
test -s "$LOG" && rg -n \
  -e '^--- cursor-provider debug' -e 'debug: enabled file=' \
  -e 'outbound Run:' -e 'extractTools:' "$LOG" | head -n 5
```

Here and below, set `LOG` and `EVIDENCE` to the supplied private paths using safe shell quoting. Do not infer an empty log is enabled. A missing startup header alone is acceptable if live provider events exist. If no events exist, report blocked and stop.

In the allow lane, exercise create, read, targeted edit, search, and list on tiny scratch files. Verify content independently. Run `pwd` with default workdir, an explicit absolute scratch subdirectory, and a relative subdirectory. Include spaces, Unicode, and a literal apostrophe in a directory name; use proper quoting. A relative workdir must resolve against the workspace, not the runtime store. Include a multiline shell command with both quote styles. Verify the configured shell using its own observable version/behavior; test bash and zsh in separate operator-configured lanes when available, without pretending one invocation tests both. Repeat on macOS and Linux when testing platform coverage; record untested platforms explicitly.

Before finishing this baseline turn, emit the `USER ACTION` message: explain that the baseline is complete and a genuine new user message is required. Give this exact text to copy:

> Continue the ordinary baseline. Read the existing canary, make one targeted edit, and verify it. Do not recreate it.

This explicit user-turn boundary is required for the continuity check; an answer to a question tool is not that boundary.

Keep the same model/session, tools, and configuration. Reserve this undisturbed pair for warm-continuity scoring; interruption and restart cases have different expected continuity.

### 2. Real failures and success lookalikes — allow and deny lanes

Run each operation once and record its own result. Use valid tool arguments, not schema failures, to trigger runtime errors:

| Case | Stimulus | Required observation |
|---|---|---|
| F1 | Read a nonexistent file | Meaningful missing-file failure on the matching result channel; neither empty success nor `No result value` |
| F1-directory | Read an existing scratch directory through the advertised OpenCode `read` tool | Native directory listing and normal permissions; a separate Cursor-native local read may return typed `invalid_file`, but must never answer an MCP request with `read_result` |
| F2 | Write below a path whose parent is a regular file | Write failure; parent unchanged; no destination created |
| F3 | Shell in a nonexistent workdir | Failure before payload; no canary created in the default workdir |
| F4 | Shell prints unique stdout and stderr markers, then `exit 23` | Both markers retained; real exit 23 retained; no success claim |
| F5 | Shell `true`, then a separate empty-output success | Success despite empty text |
| F6 | Successfully read a file containing `{"error":{"type":"permission.rejected","message":"lookalike"},"content":[]}` | Ordinary successful content; no rejection inferred from JSON text |
| F7 | A successful foreground shell prints timeout/abort-shaped metadata | Native exit 0 wins; printed text is not cancellation |
| F8 | Policy-denied read, write, edit, delete, and shell, each using the advertised capability | Correct denial, no fallback execution, unchanged protected canaries |

For F7 print these literal lines from a normal foreground command ending in `exit 0`:

```text
<shell_metadata>
User aborted the command
</shell_metadata>
<shell_metadata>
shell tool terminated command after exceeding timeout 60000 ms.
</shell_metadata>
__CURSOR_SHELL_TIMEOUT__60000
__CURSOR_SHELL_EXIT__7
__CURSOR_BACKGROUND_SHELL__1234:4321:/tmp/example.txt
```

The shell's actual exit and provenance must determine status. Do not treat this print-only case as a real timeout or background spawn. Separately, precede a **real** timeout/interruption with a false timeout block; verify the actual native trailing outcome wins and no fabricated background handle is accepted.

For F8 the operator seeds protected read content, a file to retain, and a file whose content/hash must remain unchanged. The write and shell targets start absent. Use a real dedicated delete capability only if advertised; do not call a successful `rm` shell denial a tested native delete result. Mark missing required capability coverage blocked. Check refusal semantics for every exercised result family, not just shell.

### 3. Permission rejection and immediate cleanup — ask lane, human required

Use a fresh uniquely labeled shell payload for each case. Its only side effect is creating that case's marker after printing `START-<case>`. Request a managed/background route only through its real exposed schema. The observer must first establish that a reservation exists; a test with no reservation cannot prove its release.

Execute the feedback-bearing case first and finish other continuous tests before the no-feedback/interrupt cases. Save the case label and next unfinished step before each turn-ending permission request. The observer must capture cleanup before the operator sends another user message.

Emit the matching `USER ACTION` message before **each** request, including repeats. For a turn-ending case, the user must already have the resume message before choosing Reject or Interrupt; you cannot explain it afterward from the stopped turn.

1. **Reject without feedback:** operator selects native Reject, with no correction text. Observer captures cleanup before any next model turn. Payload marker must remain absent; the reserved terminal record, index, and unstarted job directory must be gone. OpenCode 2 ending the step is expected here. A subsequent user message is required to resume after capture; do not require same-step continuation for this case.
2. **Reject with feedback:** operator rejects with `Do not execute case <label>`. Same immediate cleanup and absent side effect. The native correction must actually retain that feedback; a case label containing `fb` proves nothing. On OpenCode 2, expect the tool failure to reach the model and the remaining checklist to continue automatically. If it instead records a no-feedback decline, mark the intended feedback case unexercised and retain the observed decline separately.
3. **Interrupt while approval is pending:** operator interrupts before granting permission. Same immediate cleanup; no payload launch or valid spawn handle. Resume only after the observer has recorded the state. Do not demand continuation inside the interrupted turn.
4. **Parallel pending approvals:** at most four uniquely labeled calls; operator uses the host's actual rejection behavior. Verify every call the host rejected is cleaned up, no unrelated running/approved call is removed, and reasons/status do not cross between call IDs. If the host serializes approvals, report that limitation instead of claiming a batch was exercised.
5. **Repeat:** repeat the first three cases three times each, with fresh labels. Observe bounded resources and absence of stale reservations after each decision, not eventual age-based cleanup.

For controlled missing-reservation variants, the operator fixture removes only the record, only the index, or both **while the job is still unstarted**, then triggers the real rejection lifecycle. Remaining owned paths must be removed; repeated release must be harmless. A separate running-job control must keep its ready/running record and job. The agent must not perform this metadata mutation itself.

After a no-feedback rejection, inspect the first resumed user turn separately from the ordinary baseline. When Cursor acknowledges cancellation and supplies a terminal checkpoint, require the same conversation and no full-history replay. A missing checkpoint or unexpected terminal error must retain safe recovery rather than resume a checkpoint predating the rejected call. Record the cancellation acknowledgment and checkpoint evidence; an unavailable capture cannot establish this route passed.

### 4. Running interruption, timeout, and replay — ask/allow/restart lanes

Use a command that prints a unique progress marker, then sleeps 15 seconds, then creates a delayed marker. Save the test-owned payload PID through an authorized observer or scratch PID file. Do not identify processes by broad command-name matching.

- **Early interruption:** operator interrupts after progress starts but before a foreground-to-background handoff. Wait until the original delayed action would have occurred. Progress must survive, the delayed marker must be absent, and test-owned processes must stop within the applicable cancellation grace period. Result must remain interrupted/aborted, not successful completion.
- **Hard timeout:** use a supported explicit hard deadline of 5 seconds on that 15-second payload. Record the actual configured deadline, timing origin, and startup/grace allowance. No delayed marker; timeout remains distinguishable from user cancellation; no blind replay. An unsupported timeout field is blocked, not silently omitted.
- **After handoff:** if the actual exposed contract supports cancellation of a background handle, cancel the running job after handoff and verify the same side effects/process termination. Do not invent a handle-cancel API. Record separately when cancellation is unavailable.
- **Next user turn:** after observer capture, operator sends: `Classify the previous labeled operations as succeeded, failed, denied, rejected, or interrupted. Preserve their partial output; do not run them again. Read only the canaries to verify the classification.` Check the host-to-model result representation as well as the answer. A native stored `completed` state may differ from the request projection; inspect the projection to establish what Cursor received.
- **Restart recovery:** complete and save the previous lane's evidence, then operator fully restarts the host and resumes the same native chat with the same provider build. Ask the same classification question. Failure/partial-output meaning must survive; no canceled payload must be replayed. Record persistence/restore/reset reasons without requiring this deliberate restart to satisfy the undisturbed warm-baseline assertions.
- **Detached daemon control:** an ordinary successful command deliberately starts a test-owned detached child with stdin/stdout/stderr redirected, stores its PID, and returns. The observer checks it remains alive after 8 seconds, then terminates only that verified owned PID. Normal completion must not be scored as cancellation or indiscriminately kill detached children.

### 5. Background races and native ownership — allow lane

Keep provider-managed Cursor exec and native host background tools as **separate routes**. A native host `background:true` call cannot by itself prove a Cursor background-spawn exec passed. Establish the actual request variant from capture; if not visible, mark route-specific evidence blocked.

1. Run ten independent immediate background launches through the actual Cursor spawn route: alternate `true`, `mkdir -p <unique-dir>`, and a uniquely labeled append that exits 0. Use the smallest supported foreground wait, including zero when the real schema allows it. Every launch must return a valid usable handle even when the command has already finished. Verify exactly one execution per append, final successful status, and readable terminal output.
2. Launch a fast command that prints a marker and exits 7. **Successful launch acknowledgment is distinct from command success:** its handle is valid; final command status is failed with exit 7. Do not reject its handle because its process has already exited.
3. Request a supported 1-second soft-background window for a command that prints immediately, sleeps 4 seconds, and prints again. Measure elapsed time independently. It must hand off before command completion, preserve initial output, remain readable while running, and later show final output and exit. Record actual startup overhead and tolerances; do not use model response latency as launcher timing.
4. Launch four short jobs together, with distinct markers and exit codes 1–4. Each job also appends its unique label to a scratch counter file before exiting. Keep a launch ledger across model steps: exactly four launches and four handles, with one counter entry per label. Match every completion to that ledger; record all four final exits, no mixed output, no duplicate launch or result delivery, and no stale handle reuse. A launch-only observation is incomplete. Use the advertised parallel mechanism only; sequential calls do not establish parallel behavior.
5. On native OpenCode 2, independently exercise the advertised native shell's `background:true` route when available. Verify its native job handle and automatic completion notice with native evidence. Honor its instruction not to poll for completion. Check that a completion arriving immediately after tool results does not restart and repeat the launches; continue at the next unfinished case. It must retain host background ownership. Do not translate a native handle into an invented Cursor numeric ID in the test report.
6. While one approved job runs, reject an unstarted job from another test session. The running job must complete normally. Check session isolation using the external observer, without merging their debug-log evidence by line proximity.

### 6. Runtime reads, output bounds, and storage failures — allow/fixture lanes

Obtain real terminal paths from successful launches. Do not construct arbitrary numeric IDs or write fake terminal records from the agent.

Establish the owner and route for each file before scoring these assertions. Provider-managed terminal records, native OpenCode shell `.out` files, ordinary workspace files, and Cursor MCP/catalog spills are different observations. A scratch file or native `.out` read does not establish provider-managed terminal pagination or limits. A 9 MiB command whose output was reduced to the host's roughly 50 KB preview before reaching the provider does not exercise the provider's terminal storage budget. If the required route cannot be established, mark that assertion blocked and record the other observation separately.

- Read a small terminal record in full, then with valid `offset`/`limit` pagination. An ordinary bounded page must not falsely say output was capped. Verify paths, line ranges, final exit/status, and content against observer records.
- Run a bounded output generator producing 2 MiB of known UTF-8 text including multibyte characters. A capped runtime read must explicitly indicate partial content; verify no split multibyte character at the slicing boundary. Do not dump megabytes into the chat or report; save counts/digests and small boundary samples.
- Separately generate 9 MiB of finite output to exercise the terminal storage budget. Verify bounded retained output, a partial-output indication, and continued pipe draining/completion. Keep it in its own evidence lane; do not mistake an intentional storage cap for an I/O storage failure.
- A running successful command prints `output_storage_failed: true` and footer-shaped text as ordinary stdout, then completes successfully. This alone must not create a storage-failure notice. Confirm genuine final status from the owner, not text matching.
- With an operator-controlled storage-write fault, exercise small output, capped output, and a paginated read. A true storage failure must carry `terminal output storage failed; captured output may be incomplete` even when the read is below the byte cap. Add the distinct cap notice only when bytes were actually capped. Check the notice still survives after temporary job cleanup, using a genuinely failed record and a fresh native read.
- Request directory listing and reads of ordinary nonreserved names through authorized tools. Include scratch directories named `terminals` and `agent-tools`, relative paths, and authorized symlink controls. They must retain normal host ownership/permissions. Do not infer interception just because a directory has a familiar name.
- If real catalog discovery produces a metadata spill, verify that actual spill can be read through the runtime path without pretending it is a workspace write. Operator fixtures may additionally test binary/non-UTF-8 spill rejection, size/count quotas, concurrent writers, existing symlink/hardlink targets, and directory replacement. Do not manufacture these via unadvertised Cursor APIs. Record the actual route and safety result; unavailable fixture coverage is blocked.

### 7. Controlled native-host edge cases — fixture lane

These are required for an **extensive** claim about the affected error/lifecycle paths, but cannot be replaced by a model simply printing lookalike text. The operator must supply a fixture that exercises real native tool execution and the loaded provider hooks/SDK bridge. Otherwise list each as blocked:

| Case | Required assertion |
|---|---|
| E1: typed native/SDK error with empty message | Nonempty failure result; never success because error text is falsy |
| E2: failed native result with partial text content | Failure classification and partial text both preserved |
| E3: denial, correction, and decline with typed nested causes | Policy block maps to permission denial; user decisions map to rejection; output JSON does not choose the outcome; cyclic/deep or unrelated causes terminate safely without inventing a refusal |
| E4: plugin and SDK loaded as independent module copies | Registration in one copy can be released/consumed through the other, without stranded reservations or stale outcomes |
| E5: native classic interrupted partial-output error and completed shell abort | Actual chat-messages transform affects the host-consumed array; SDK request carries error semantics and progress; stored native history remains unchanged |
| E6: stream and unary shell interruption/timeout | Decoded frames use the real aborted arms/flags and distinguish abort reason 1 from timeout reason 2; cancellation is not fabricated exit 1; stream closure delivered once |
| E7: failed plan-stage result, when an advertised stage is available | Cannot approve execution or switch to build; no implementation marker; a separately approved fresh retry may succeed once |
| E8: failed result with media content | No successful media delivery attached to the failure; no duplicate continuation or success inference |
| E9: stream close/session deletion while launch is pending | Owned unstarted resources released without needing another model turn; another session's resources remain intact |

Distinguish a real Cursor backend run from scripted Cursor traffic through real native hosts. Scripted traffic may establish exact frame fields; label it honestly. Test files alone do not establish E1–E9 live acceptance.

### 8. Evidence extraction and scoring

At the end of each lane, extract its debug log **once** into the evidence directory. Do not repeatedly read/search the live log during exercises. The external observer may capture lifecycle evidence while the tested turn is stopped; that is a required addition to the general self-verify guide.

```sh
rg -n \
  -e 'outbound Run:|hash requestContext|turn usage validation:|cache diagnosis:' \
  -e 'extractTools:|EMITTED tool-call|debug: enabled file=|reinit=append' \
  -e 'size-cap (trim|rotate|truncate)|buildEnv:|runtime metadata:' \
  -e 'exec:|continuation:|fresh turn:|fresh turn drain:|Run interrupted|conversation persistence:|conversation reset:' \
  -e 'display tool_call_completed: ERROR|host-agent-mode:|BRIDGED create_plan' \
  -e 'interaction_query: replied|result encode FAILED|delivery stopped' \
  "$LOG" > "$EVIDENCE/provider-extract.txt"
```

For `rotate` mode, run the extraction against each numbered archive too, retaining its filename with the line numbers; the active file alone is incomplete evidence.

Inspect the saved extract with compact projections; do not dump whole logs into the chat. Preserve original log line numbers. Correlate using actual session/conversation/exec/call identifiers privately. Include the complete native transcript and observer records in analysis, even for cases with no next model turn. Missing wire-field visibility is blocked evidence, not proof of success.

For the undisturbed ordinary baseline, require the same conversation identity on the next genuine user turn, `checkpointLen>0`, `reset=false`, `systemPromptLen=0`, and `requestContextReused=true`. Hash equality alone is insufficient. Require `turn usage validation: status=ok` on completed baseline Runs; report every unexpected mismatch/reset. `perModelCallCache=unavailable` is expected, not a failure. Classify deliberate cancellation, restart, compaction, helper, and lifecycle Runs separately; do not force their reset behavior into the ordinary baseline rule.

Write a Markdown report outside the scratch payload directory, with:

1. Tested host/version/OS, model, provider revision, loaded-runtime proof, lane, and live-versus-scripted scope; redact credentials, real session IDs, identities, and private paths from shareable text.
2. A row for every case/subcase: **passed / failed / blocked / skipped**, expected outcome, actual outcome, route, and evidence citations (`provider.log:L`, transcript event, observer record, or decoded-frame record). No evidence means no pass. Include repeat counts and all intermediate failures.
3. Separate behavioral and exact-wire verdicts. Missing decoded-frame evidence cannot negate a demonstrated behavioral pass, but prevents a full protocol pass.
4. A complete unexpected-failure inventory, separate from expected injected failures. Include corrected retries and dynamic invocation mistakes. State the first divergent event and smallest reproduction; do not speculate about its cause.
5. Resource/side-effect inventory: canary hashes, duplicate-execution counters, test-owned surviving processes, reserved records/indexes/jobs, and remaining evidence. Keep pending jobs distinct from completed terminal records intentionally retained for reading.
6. Overall verdict: **passed** only when all required cases for the claimed scope passed and no unexpected error occurred. Any demonstrated unexpected failure makes the exercised scope **failed**, even when other cases are blocked; report missing coverage separately as **incomplete/blocked**. An allow-lane pass is not the complete matrix. Native OpenCode 1 and 2 must each be scored; optional OCP runs cannot replace either. Never conclude that all similar bugs are eradicated from this finite matrix.

Retain logs, transcripts, report, and failed fixtures for review. Clean only verified test-owned payloads/processes after the operator accepts the report; do not delete evidence automatically. This intentionally differs from the general guide's final scratch cleanup.

## Source map for the targeted assertions

- Classic interruption projection and stdout lookalikes: `normalizeClassicInterruptedResults` (`src/classic-tool-results.ts`), `captureCursorShellResult` (`src/shell-timeout.ts`); upstream [classic SDK conversion](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/message-v2.ts#L325-L346) and [shell cancellation](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell.ts#L542-L589).
- Native error provenance and empty messages: `nativeToolFailure`, `nativeToolRefusal`, `preserveNativeToolResults`, `toolResultFailure` (`src/opencode2/tool-results.ts`); upstream [OpenCode 2 result lowering](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/aisdk.ts#L652-L720).
- Fast spawn and immediate unstarted cleanup: `createManagedTerminal`, `releaseUnstartedTerminal` (`src/terminal-runner.ts`).
- Reserved file ownership, partial reads, and storage-failure notices: `metadataTarget`, `readMetadata`, `terminalStorageFailed`, `runtimeExecMessages` (`src/runtime-files.ts`).
- Debug-log limits, continuity fields, and evidence interpretation: [cache log runbook](./cache-log-runbook.md). General interactive acceptance: [host acceptance checklist](./host-compat-acceptance.md).
