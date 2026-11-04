# OpenCode 2.x lessons

[Index](../lessons.md) · [General](opencode.md) · [1.x](opencode-1.md)

Operator setup: [OpenCode 2.x](../../docs/opencode-2.md).

## Plugin and daemon lifecycle

- **Background discovery is outside activation readiness.** The first
  authenticated standalone request could select its model before the cold
  catalog existed (#91). OpenCode 2.1.4 session entry points await plugin
  activation, so hold setup through cold discovery and publication with a
  deadline; a usable cache needs no network wait. Throwing from setup disables
  the revision and prevents reconnect/retry, so report discovery failures while
  retaining registrations. Subscribe before discovery, discard superseded
  attempts, and keep uncommitted publication candidates out of later transform
  replays. The readiness change also made optional connection metadata fatal:
  preserve catalog publication when that lookup fails, while keeping required
  Run authentication independent (`test/plugin-opencode2.test.ts`, cold model readiness).
- **Published types outrank early API docs.** Hook arity, domains and the
  `aisdk:` discriminator differed. Check actual usages through the compiled
  host contract (`test/opencode2-conformance.types.ts`).
- **Test a pre-populated SDK.** The generic loader ran first and bypassed our
  per-request credential resolver; empty-SDK fixtures missed it
  (`test/plugin-opencode2.test.ts`).
- **Disposers own registrations, not globals.** Setup runs per location and on
  reload. Disposing an older setup erased a live agent switch and plan directory
  (`setHostAgentModeSwitch`, `setNativePlansDir`). Every setup also observes
  pending shell asks: disposing one must not release another's wrapper (#118).
  Share observer ownership and bounded refusal evidence across complete module
  graphs; a rejection during the reload gap must reach the replacement's result
  projection. Register ownership before starting iteration, since a synchronous
  iterator failure can close the stream before subscription returns
  (`test/plugin-opencode2.test.ts`, pending shell asks across Locations).
- **Process cwd is not session cwd.** A daemon's spawn directory and separately
  loaded modules lost workspace state. Carry the session directory and exact
  session id in request headers; affinity ids can identify a parent instead
  (`test/plugin-opencode2.test.ts`, `test/prompt-history.test.ts`).
- **Share whole relations across module copies.** Running tools were
  process-wide but parent links, activity and prompts were per copy, so a
  child's tool never renewed the parent's Run when the plugin and provider were
  different copies (`session-activity.v1`, `test/activity.test.ts`).
  Conversation bindings are shared but checkpoints are per copy, so a session
  moved to another Location, or back, skipped restore and resumed nothing or
  an older checkpoint. A copy behind the latest snapshot generation restores
  it; when it cannot (failed latest save, missing snapshot, writes that never
  settle) it drops its own checkpoint and seeds host history. A per-copy
  checkpoint outlives an evicted shared record, so "never held a generation"
  does not mean "holds no older checkpoint"; whether another copy wrote the
  latest generation decides. It also outlives an evicted binding: an unbound
  session's default conversation id comes back, so a copy restoring it from
  disk, or finding no snapshot, drops its checkpoint unless it holds the
  latest generation. Tests need a copy that served the session before, and
  one whose record was evicted since, not only one that never did
  (`hydrateConversationState`, `test/host-history-rewrite.test.ts`).
- **`isRetryable: false` does not stop a retry.** 2.x classifies an
  `APICallError` by status and retries 408/409/429/5xx; only `x-should-retry:
  false` overrides it. An unrecognized failure without a status also retries:
  project pre-stream failures from both public generation methods and mark
  spent or side-effecting provider retries terminal, alongside final server
  verdicts. An output-only failure needs `x-should-retry: true` and no status:
  2.x then continues after the shown output (`hostFacingError`,
  `test/errors.test.ts`, `test/run-error-host.test.ts`).
- **A new plugin header does not prove a new SDK.** Pin the intended binary,
  isolate config, use the 2.1.4 `plugins` configuration key and a local wrapper
  directory with an index entry, set the provider entry before daemon start,
  and restart after rebuilding ([local setup](../../docs/opencode-2.md#from-a-local-clone-cursor_opencode2_dev_entry)).

## Catalog and permissions

- **Direct tools require both placement and shape.** Missing `codemode: false`
  hid plugin tools; missing output schemas crashed the host. Todos are an
  opt-in in-memory fallback, not native builtins (`test/todo-tools.test.ts`).
- **MCP server config is not a placement switch.** Changing server `codemode`
  also changed remote discovery. Set tool options through the transform and
  retain explicit server opt-ins; async first-turn gaps need no startup delay
  (`exposeDirectMcpTools`, `test/opencode2-mcp-direct.test.ts`).
- **Catalog filtering is not per-call authorization.** The public ToolContext
  has no `ask`, but the plugin context exposes `permission.assert`. Image save
  once relied on catalog `edit` gating, which leaves path-specific plan denies
  unenforced when the plan-directory exception keeps the tool visible. Assert
  the actual resource with the executing session, agent and source before any
  write; preserve native rejection identity so plain declines end the host step.
  Apply the same rule to optional todos. Keep native web search on its existing
  executor (`test/plugin-opencode2.test.ts`, `test/todo-tools.test.ts`).
- **`execute` is JavaScript, not an OS shell.** Native commands go to
  shell/bash; Task maps to `subagent` only when advertised
  (`test/tools.test.ts`).
- **2.x calls its patch tool `patch`.** Its parser strips CRLF carriage returns;
  native conversions and direct dynamic calls must refuse lossy content before
  mutation (`test/apply-patch.test.ts`).
- **Read truncation has several forms.** The host removes bytes after 50 KB,
  stops after 2,000 lines and shortens individual lines after 2,000 characters.
  Strip the `Read file`/line-number envelope but retain every actual truncation
  notice; an explicitly bounded page alone is not incomplete
  (`test/read-cap-repro.test.ts`).
- **Host prompt changes do not justify reminting.** Agent switches keep the
  sticky conversation; the changed instruction rides after the frozen baseline
  (`test/context-epoch.test.ts`).

## Native results and shell ownership

- **Capture status before AI SDK lowering.** Native errors became plain text;
  preserve typed failure/refusal metadata, including empty errors and restart
  history, without treating error-shaped success text as failure
  (`test/opencode2-tool-results.test.ts`).
- **Shell create runs before permission scanning.** Rewriting the command hid
  what the host approved. Preserve command and basename via an executable
  adapter; retain native `background` ownership and its completion notice
  (`test/shell-timeout.test.ts`).
- **Anonymous creates need narrow attribution.** A global gate stalled every
  shell; use identical-command lanes and the live execution input when another
  hook rewrites it (`test/shell-timeout.test.ts`).
- **No-feedback decline can skip execute.after and stop the turn.** Release
  unstarted reservations from permission/terminal events; keep running jobs.
  Immediate cleanup needs an external observer before the next user message
  ([execution checks](../../docs/execution-self-verify.md)).

## Early steers, Stop and restart

- **Summary preparation is not a history rewrite.** OpenCode 2.1.4 prepares
  failed summaries and unused background precomputes through the compaction
  hook; applying a cached summary skips that hook. Observe the durable ended
  event instead. Deleting the old snapshot alone lets a held Run's shutdown
  save resurrect it. Persist the rebase requirement, serialize it with state
  saves across module graphs, and consume it only when replacing the binding
  (`test/plugin-opencode2.test.ts`, committed foreign compaction outcomes;
  `test/host-history-rewrite.test.ts`, `test/run-error-host.test.ts`).
  Closing the held Run for that rebase dropped the host notes only it carried,
  and a restart lost them too, even without a rewrite: a late tool result
  rebuilds from host history. Save a held Run's own notes in its in-progress
  snapshot and deliver them only to a Run without that checkpoint. Decide
  helper isolation before closing held Runs, or a helper takes the rebase.
  Keep consumed receipts as bounded tombstones: another copy can deliver the
  same event late (#131, `foreign compaction follow-ups`).
- **Inbox admission precedes the model boundary.** A Cursor-side AwaitShell
  could postpone a host steer until the background job finished. Inject eligible
  plain text into the actively pumping Run, with backpressure and admission
  rechecks (`src/host-steer.ts`, `test/early-steer.test.ts`).
- **A switch's host note arrives after `switchAgent` returns.** The plan
  agent enqueues its reminder from an event subscriber; continuing at once let
  the first step start without it, so the host's per-request check wrote a
  second copy and both reached history and Cursor. Wait (bounded) for the
  matching plan-mode reminder before continuing; an unrelated background
  notice or an older reminder for the opposite mode cannot acknowledge it
  (`test/plugin-opencode2.test.ts`). Reject a native handoff when its target
  already equals the observed host agent: a same-mode approval must not cancel
  the Run and inject another turn, including plan/spec aliases.
- **Delivery receipts must survive with the checkpoint.** Restart/retry repeated
  answered copies when only conversation state survived. Hydrate receipts even
  before a no-Run dedup outcome (`test/early-steer.test.ts`).
- **Dedup is scoped to the consumed host boundary.** Tool-result promotions and
  queued follow-ups also need that scope; otherwise a later identical request
  disappears (`steerHostTurn`, `test/early-steer.test.ts`).
- **Filter matched messages, not the whole range.** One attachment neighbor
  defeated dedup or lost media. Preserve unmatched message order, every part and
  exact image bytes (`test/early-steer.test.ts`).
- **A fresh turn may contain several pending requests.** Selecting only the last
  one lost Stop/mixed-inbox messages. Use the same live range for delivery and
  seed-history exclusion; keep mixed tool results on their held Run and send
  unmatched text in order (`liveUserTurn`, `test/early-steer.test.ts`).
- **Stop must reach Cursor and preserve provenance.** A cancelled consumer could
  leave a remote Run generating; terminal checkpoints and partial emission
  ownership govern the next turn (`test/host-interrupt.test.ts`).
- **An unanswered promoted steer can outlive its recoverable Run.** A failed
  recovery kept a checkpoint that lacked the host's promoted message. Rebuild
  from host history when that unanswered steer was promoted or checkpointed;
  a clean finish must settle receipts so the following turn still warm-reuses
  (`test/early-steer.test.ts`).
