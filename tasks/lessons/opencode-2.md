# OpenCode 2.0 lessons

[Index](../lessons.md) · [General](opencode.md) · [1.x](opencode-1.md)

Operator setup: [OpenCode 2.0](../../docs/opencode-2.md).

## Plugin and daemon lifecycle

- **Published types outrank early API docs.** Hook arity, domains and the
  `aisdk:` discriminator differed. Check actual usages through the compiled
  host contract (`test/opencode2-conformance.types.ts`).
- **Test a pre-populated SDK.** The generic loader ran first and bypassed our
  per-request credential resolver; empty-SDK fixtures missed it
  (`test/plugin-opencode2.test.ts`).
- **Disposers own registrations, not globals.** Setup runs per location and on
  reload. Disposing an older setup erased a live agent switch and plan directory
  (`setHostAgentModeSwitch`, `setNativePlansDir`).
- **Process cwd is not session cwd.** A daemon's spawn directory and separately
  loaded modules lost workspace state. Carry the session directory and exact
  session id in request headers; affinity ids can identify a parent instead
  (`test/plugin-opencode2.test.ts`, `test/prompt-history.test.ts`).
- **Share whole relations across module copies.** Running tools were
  process-wide but parent links, activity and prompts were per copy, so a
  child's tool never renewed the parent's Run when the plugin and provider were
  different copies (`session-activity.v1`, `test/activity.test.ts`).
- **`isRetryable: false` does not stop a retry.** 2.0 classifies an
  `APICallError` by status and retries 408/409/429/5xx; only `x-should-retry:
  false` overrides it. An unrecognized failure without a status also retries:
  project pre-stream failures from both public generation methods and mark
  spent or side-effecting provider retries terminal, alongside final server
  verdicts. An output-only failure needs `x-should-retry: true` and no status:
  2.0 then continues after the shown output (`hostFacingError`,
  `test/errors.test.ts`, `test/run-error-host.test.ts`).
- **A permission live test needs explicit `ask` rules.** 2.0.32's default
  `build` agent starts with `* * allow`, so `permission.assert` passed without
  a prompt and looked like a working gate. Scripted `opencode run` also waits
  on an open non-TTY stdin before creating a session; give it `< /dev/null`
  rather than blaming the shared data directory.
- **A new plugin header does not prove a new SDK.** Pin the intended binary,
  isolate config, set the local provider entry before daemon start, and restart
  after rebuilding ([local setup](../../docs/opencode-2.md#from-a-local-clone-cursor_opencode2_dev_entry)).

## Catalog and permissions

- **Direct tools require both placement and shape.** Missing `codemode: false`
  hid plugin tools; missing output schemas crashed the host. Todos are an
  opt-in in-memory fallback, not native builtins (`test/todo-tools.test.ts`).
- **MCP server config is not a placement switch.** Changing server `codemode`
  also changed remote discovery. Set tool options through the transform and
  retain explicit server opt-ins; async first-turn gaps need no startup delay
  (`exposeDirectMcpTools`, `test/opencode2-mcp-direct.test.ts`).
- **Public ToolContext cannot request approval.** A second direct web-search
  path would omit the native prompt. Use the host backend hook; keep image save
  opaque, single-use and contained (`src/opencode2/image-save-tool.ts`).
- **Plugin permission errors differ by kind.** `ctx.permission.assert` rejects a
  deny rule or feedback with a tool error, but a plain decline only ends the
  step if the tool rethrows it unchanged. Rethrowing every refusal raw, as a
  first port did, also dropped Cursor's `permission_denied` for deny rules
  (`test/plugin-opencode2.test.ts`, image save permission domain).
- **`execute` is JavaScript, not an OS shell.** Native commands go to
  shell/bash; Task maps to `subagent` only when advertised
  (`test/tools.test.ts`).
- **2.0 calls its patch tool `patch`.** Its parser strips CRLF carriage returns;
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

- **Inbox admission precedes the model boundary.** A Cursor-side AwaitShell
  could postpone a host steer until the background job finished. Inject eligible
  plain text into the actively pumping Run, with backpressure and admission
  rechecks (`src/host-steer.ts`, `test/early-steer.test.ts`).
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
