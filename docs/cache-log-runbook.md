# Cache and token log runbook

Use this runbook when diagnosing prompt caching, context totals, conversation
continuity, restart recovery, or compaction in a live OpenCode session using the
Cursor provider. It describes the provider's debug log, not OpenCode's own
application log.

## What the log can and cannot prove

Cursor sends one set of cache counters in `TurnEnded` for the complete held-open
agent Run. A Run may span several OpenCode `doStream` calls and tool executions.
Cursor does **not** expose cache-read/cache-write counters for each internal model
call. Other providers often report one request at a time, so their displayed
cache percentage is not necessarily comparable to Cursor's aggregate percentage.

The log can prove:

- whether the Run started from a prior Cursor checkpoint;
- whether the Cursor conversation and stable conversation group survived;
- whether the encoded RequestContext stayed byte-identical;
- whether a Run started a new system context (seed/rebase) or resumed the checkpoint;
- Cursor's exact aggregate input, output, cache-read, and cache-write counters;
- Cursor's checkpoint-derived context total and category breakdown;
- how many checkpoint, protocol-step, tool, and exec events occurred;
- whether the usage sent to OpenCode is internally consistent.

The log cannot prove which internal model call missed the cache or how Cursor's
backend selected its cache boundary. `perModelCallCache=unavailable` is
intentional. Do not infer per-call accounting from protocol-step counts.

## Capture a clean reproduction

Build before launching a local `file://` installation, then set debug variables
on the process that starts OpenCode:

```bash
bun run build
CURSOR_PROVIDER_DEBUG=1 \
CURSOR_PROVIDER_DEBUG_FILE=/tmp/cursor-cache.log \
opencode
```

For a desktop/service launch, export the variables in that process's environment
before startup. The provider announces the active path as
`[cursor-provider] CURSOR_PROVIDER_DEBUG logging to …`. A fresh empty file gets
a process header on first init. Re-init in the same override path (module
reload, second isolate) **appends** another header (`reinit=append`) instead of
wiping earlier lines. Independently, once the file reaches 10 MiB the next
`trace` call truncates it and writes `debug: size-cap truncate` so growth stays
bounded. Truncate the override path yourself before a clean run; save a copy
before comparing two host processes.

For OpenCode 2, a plugin reload can append a new header without replacing the
daemon's cached SDK or language model. Fully restart the daemon after a rebuild.
For the current cost-reporting implementation, every finish logs `billing:
step=` with delivery status and confirmed, billed and unconfirmed estimated
session costs. New plugin headers without these records do not validate the
rebuilt billing implementation.

Record these facts with every reproduction:

- OpenCode session id (`ses_…`);
- selected Cursor model and variant;
- whether OpenCode or only the provider was restarted;
- whether automatic or manual compaction occurred;
- the exact user turns that delimit the observation;
- the debug log path and its process-id header.

Debug logs contain no auth token by design, but may include local paths, tool
names, model ids, session ids, and content hashes. Treat them as private
diagnostic artifacts.

## Extract the useful lines

Start with a timeline rather than reading every transport frame:

```bash
rg 'conversation persistence:|conversation reset:|outbound Run:|hash (systemPrompt|requestContext|checkpoint)|checkpoint: stored|turn_ended raw wire fields:|finish: reason=|turn usage validation:|cache diagnosis:|Run interrupted|resuming .* checkpoint|rebasing fresh Run' /tmp/cursor-cache.log
```

For cache-only summaries:

```bash
rg 'cache diagnosis:' /tmp/cursor-cache.log
```

For one OpenCode session, use the `sessionKey` included on each cache-diagnosis
line. Do not correlate concurrent sessions merely by line proximity:

```bash
rg 'cache diagnosis: sessionKey=ses_EXAMPLE(?: |$)' /tmp/cursor-cache.log
```

Server-side dynamic invocation failures can occur before a client execution
request or even a display start. Include `display tool_call_completed: ERROR`
when reviewing tool reliability. Its `error` contains the MCP error title and
detail. A missing `namespace` / `toolName` is a dynamic-call wrapper failure,
not proof that the underlying file/search tool rejected valid arguments.
Keep the failure after a successful retry; do not invent a host execution for it.

## Read one completed Run in this order

### 1. Establish identity and continuity

Find the `outbound Run:` line and the matching `cache diagnosis:` line. The
latter repeats the important scope keys so interleaved sessions remain safe to
analyze:

| Field | Meaning |
|---|---|
| `sessionKey` | Stable OpenCode session id. Use this to select the user's chat. |
| `conversationId` | Cursor conversation carrying the checkpoint. It should stay stable across ordinary turns and provider restarts. It rotates for compaction/rebase. |
| `conversationGroupId` | Stable group derived from the OpenCode session. It should survive Cursor conversation-id rotation. |
| `model` | Cursor wire model used for this Run. Compare cache ratios only within the same model/tier. |
| `continuity=warm` | A checkpoint with prior token details was supplied to this Run. This is the normal cacheable continuation case. |
| `continuity=cold` | No checkpoint was supplied. `coldReason` says why: a `conversation reset:` reason (`interrupted-run`, `foreign-history:…`, `checkpoint-unusable`, …), `ephemeral` (title/lifecycle Run), or `no-checkpoint` (first turn, or no restart snapshot). A rebuilt conversation still reads the cached system/tools/rules prefix; a cold Run with `rawCacheRead=0` on a large prefix deserves a look. |
| `continuity=checkpoint-without-token-details` | A checkpoint was supplied, but it lacked a decodable prior token snapshot. Transport continuity may exist, but prior-context coverage cannot be computed. |

Also inspect the outbound flags:

- `reset=false`, `resume=false`, and `checkpointLen>0` describe an ordinary
  checkpoint continuation.
- `reset=true` or a `conversation reset:` line explains a new Cursor identity.
- `resume=true` follows an interrupted Run and reuses the latest eligible
  checkpoint.
- `continuation: … interrupted trailing tool result(s) […] heldRun=<reason>`
  means a tool result arrived after its held Run had closed; `heldRun` names
  why (`hard-cap-expired`, `remote-error`, `missing-process-local-state` after
  a restart, …). The turn is rebuilt from host history (`interrupted-run`). A
  permission or question prompt keeps the Run's lease alive, so
  `hard-cap-expired` means ten minutes without any host activity.
- `context warning: Cursor counted rules=0 although this Run sent the …
  system-instructions rule` means the host system context (AGENTS.md, skills,
  subagents) is probably missing from the model's prompt. Compare the Run's
  `checkpoint: stored … categories=` with the conversation's earlier ones and
  check that nothing wrote `root_prompt_messages_json`.
- `compaction=true` and the subsequent `post-compaction-rebase` intentionally
  rotate Cursor conversation ids.
- `conversation reset: reason=foreign-history:foreign-assistant` means the
  host's latest assistant turn was not produced by this provider (another
  provider or a local model answered), so the Run reseeds the full history with
  every tool result. Expect one cold turn per return to Cursor. A direct switch
  between Cursor models resumes the same conversation and never resets.
- `conversation reset: reason=checkpoint-unusable` follows a `checkpoint
  unusable:` trace: Cursor asked for a blob hash this client does not hold and
  the resumed Run failed before any non-control frame, so it reseeds instead of
  surfacing a retry-unsafe error. `found=false echoed=true` KV reads are inline
  content echoed back and are normal; only `found=false echoed=false` is a miss.
- `agent-change` and `system-prompt-change` remints are **removed**. Agent /
  system-prompt identity is diagnostics only; sticky conversations stay held
  (CLI keeps the same agentId across mode flips).

On demand, `conversation persistence: restored` confirms that the
session binding, checkpoint, reachable blobs, and frozen context were hydrated.
`missing`, `invalid`, `expired`, or restore failure means the next Run may be
cold even though OpenCode still has its own chat history.

The first resumed normal Run preserves the persisted system-instructions rule
and reasserts current host instructions on the user-turn tail. The last source
snapshot is not persisted: even if live instructions match the original rule,
the checkpoint may contain a later instruction change. Subsequent Runs admit
only new source changes ([`admitContextEpoch`](../src/context/epoch.ts), [`test/context-epoch.test.ts`](../test/context-epoch.test.ts)).

### 2. Check prefix stability

| Field | Interpretation |
|---|---|
| `requestContext=reused` | The fully materialized RequestContext protobuf bytes matched the prior value and the exact object was reused. |
| `requestContext=built` | A new materialized value was used. This is expected on the first Run; on a warm ordinary turn, compare hashes and capability changes. |
| `requestContextHash` | First 16 hex characters of the encoded RequestContext SHA-256. Equal hashes are strong byte-identity evidence. The full hash appears on `hash requestContext sha256=…`. |
| `systemPromptHash` | Hash of the current candidate system prompt. Equal hashes show prompt construction was stable. |
| `systemPromptSent=false` | A checkpoint was sent, so this Run started no new system context; the frozen system-instructions rule from the conversation's first Run went out unchanged. The hash is diagnostic only in this case. |
| `systemPromptSent=true` | This was a seeded/rebased Run: its system context became the new conversation's frozen system-instructions rule in RequestContext (never a seeded `system` message). |

The checkpoint hash is expected to change as the conversation changes. Do not
use checkpoint-hash equality as the definition of prompt-cache reuse.

Capabilities are rediscovered, but a nonempty epoch catalog retains existing
names/descriptors and appends new names. A permission shrink alone does not
rewrite the advertised prefix; execution still uses the current permitted set.
New capabilities or a new epoch may change the materialized bytes. Host-empty
lifecycle calls instead advertise empty tools on their own conversation. See
[`resolveTurnToolState`](../src/language-model.ts).

### 3. Validate the totals sent to OpenCode

Every completed Run emits `turn usage validation:`. Begin with `status`:

- `status=ok` means the AI SDK input/output partitions sum correctly, the total
  sent to OpenCode matches the accepted checkpoint total when available, and the
  category breakdown is internally consistent when present. A self-consistent
  older breakdown is marked `breakdownMatch=stale`; it is not current category
  evidence and is omitted from display metadata and cache comparisons.
- `status=mismatch` means a usage partition/total check failed or Cursor's
  category sum disagreed with its own breakdown total. Inspect the individual
  checks before attributing it to provider accounting. Occupancy finishes
  (tool-call and TurnEnded/stop) validate against
  occupancy-shaped counters (reported output plus the shaped input/cache split); aggregate
  TurnEnded request ratios live on `finish:` / `cache diagnosis:` and are not
  required to equal the occupancy prefix ratio. Preserve the complete line and
  the preceding checkpoint/TurnEnded lines before changing cache behavior.

Important fields:

| Field | Meaning |
|---|---|
| `source=checkpoint-current-run` | Current Run supplied fresh `tokenDetails`; preferred. |
| `source=checkpoint-previous-turn` | No fresh details arrived, so the last snapshot is retained and marked stale in provider metadata. |
| `source=checkpoint-held-spike` | A conversation-only count jump needs confirmation. Host usage retains the accepted snapshot, marked stale; context metadata exposes the pending `rawUsedTokens`. See the [selection policy](checkpoint-occupancy.md). |
| `source=occupancy-checkpoint-current-run` | Tool-call finish published the current Run's occupancy snapshot, billed as a one-call estimate (see `billing:` below). |
| `source=occupancy-checkpoint-previous-turn` | Tool-call finish published the prior checkpoint occupancy because this Run has not yet received token details. |
| `source=intermediate-zero` | Tool-call finish with no known checkpoint occupancy. Standard usage remains zero. |
| `source=unavailable` | No checkpoint has ever supplied token details. Standard usage remains zero rather than pretending aggregate TurnEnded usage is context occupancy. |
| `cursor=used/max(percent)` | The accepted checkpoint measurement used for host context accounting; a held spike uses the earlier stale measurement. |
| `occupancyTotal` | Occupancy-shaped validation counters: exactly `usedTokens`, split into reported output and the remaining input (both zero for an empty snapshot). Every finish with token details validates against these; disagreement with `sentTotal` is a mismatch. |
| `rawTotal` | Only on a finish without token details: aggregate `TurnEnded` input + output, request work rather than context occupancy. |
| `sentTotal` | AI SDK input + output sent to OpenCode. With token details, this must equal the accepted `usedTokens`, which can differ from the pending raw reading. |
| `occupancyCachedRatio` | Shaped cached input divided by `usedTokens - reported output`, bounded to the available input. TurnEnded request cache ratios are on `finish:` / cache diagnosis, never here. (`rawCachedRatio` appears instead only beside `rawTotal`.) |
| `sentCachedRatio` | Occupancy (`cacheRead` + `cacheWrite`) / sent input. Should match `occupancyCachedRatio`. |
| `breakdownMatch` | `true`: category sum and breakdown total match current occupancy/limit. `stale`: self-consistent breakdown with a different occupancy or limit. `false`: category sum disagrees with breakdown total. `unavailable`: no breakdown. |

`finish:` is a compact duplicate of the usage sent to OpenCode (`v3*`) and of
the counters behind it, labelled by where they come from:

- `raw*` (only with `reason=stop`): Cursor's `TurnEnded` counters for the whole
  held Run, plus `occupancyPrefixCache` (the prior turn's context).
- `occupancy*` (tool-call boundaries with a snapshot,
  `source=occupancy-checkpoint-*`): `occupancyIn` is current `usedTokens - reported output` (zero for an empty snapshot),
  `occupancyCacheRead` / `occupancyCacheWrite` the split the step was billed
  with, adjusted from the previous step's cached context to carry output at its
  output rate (see `billing:`).
- `est*` (`source=intermediate-zero`, before any checkpoint with token
  details): the provider's char/4 estimate. Usage sent is zero.

The final `TurnEnded` attempts to settle the catalog-priced balance once. Two
tool-call finishes with the same `v3In` are two steps with no checkpoint between
them: occupancy is replaced, while each delivered step can add an estimated cost.

For a held spike, `checkpoint: stored` still prints the raw count/categories,
followed by `acceptedContext` and `source=checkpoint-held-spike`. Finish usage,
validation, billing tiers and the next cached-prefix estimate use the accepted
count. This confirmation policy can delay genuine unexplained growth by one
independent reading; it is not an exact reconstruction of hidden model calls.

Every attempted finish is followed by a `billing:` line. `delivered=false`
means the consumer rejected the finish and neither its charge nor its cached
prefix was recorded:

| Field | Meaning |
|---|---|
| `step=estimate` | A tool-call step billed as one model call: the previous step's context as cache read, the rest new input. |
| `step=turn-end` | The turn's last step, billed what is outstanding after `billing: turn real=…` added the catalog-priced aggregate cost. |
| `stepUsd` | What this step bills on both hosts (OpenCode 2 from its tokens, OpenCode 1.x from `copilot.totalNanoAiu`). |
| `sessionRealUsd` / `sessionBilledUsd` | Confirmed catalog-priced cost and accepted host charges for the OpenCode session (in memory, since provider start). |
| `sessionEstimatedUsd` | Unconfirmed charges owned by Runs that have not supplied terminal counters. Only the matching Run's counters replace its estimates; interrupted Runs do not create credits against later Runs. |
| `stepOutput` | Output accepted by this finish: a characters / 4 estimate on tool steps, or outstanding measured output at turn-end, bounded to occupancy with a one-token display minimum. Reasoning is estimated separately and reconciled within its owning Run. |
| `sessionRealOutput` / `sessionReportedOutput` | Cursor's measured output and output accepted by host finishes. Estimates or the display minimum can make reported output higher; that surplus never reduces a later Run's output. |
| `delivered` | Whether the stream consumer accepted the finish; ledger totals contain accepted finishes only. |
| `pricing=unpriced` | No published rate (`default`/Auto): nothing is billed. |

The outstanding balance is `sessionRealUsd + sessionEstimatedUsd -
sessionBilledUsd`, including rounding and the minimum/maximum charge the
snapshot can carry; it may persist across turns.

Output reconciliation is separate from cost settlement. Only a Run's own
delivered estimates are subtracted from its counters. Measured output that no
accepted finish could carry waits for a later turn-end. Already delivered
overestimates cannot be retracted. Reasoning that no remaining output can carry
is not attributed to later Runs, and the reported totals still describe only
what was actually delivered. Output balances share the cost ledger's process
lifetime and bounded session retention. Per-step output and tok/s remain
approximate; `*Raw` retains Cursor's exact Run counters.

The ledger's `real` label refers to counters priced at catalog rates, not a
reported invoice amount. Aggregate counters cannot identify per-call pricing
tiers after internal compaction or a tier crossing. Standard cache tokens are
synthetic for host pricing; use `raw*` for measured request counters.

### 4. Interpret the cache diagnosis

The raw partition obeys:

```text
rawInput = rawCacheRead + rawCacheWrite + rawUncached
rawReadRatio = rawCacheRead / rawInput
rawWriteRatio = rawCacheWrite / rawInput
```

Captured Cursor Runs commonly report `rawCacheWrite=0`. This is an upstream
value, not evidence that the provider dropped writes: the provider decodes
`TurnEnded` field 4 (`turn_ended raw wire fields: … f4:wt0=`), and some models
report it (gpt-5.6-luna sent `f4=8201` on a cold call). Where writes are 0,
`rawUncached` remains the arithmetic remainder of the
reported aggregate input. It is not a measurement of new context: repeated
internal model calls can process uncached text more than once.

| Field | Interpretation |
|---|---|
| `priorContext` | Cursor `usedTokens` decoded from the checkpoint supplied at Run start. For a checkpoint reporting `usedTokens=0` after a cancelled plan handoff, usage retains the conversation's last measured occupancy, saved separately in the restart snapshot. The Run still sends the original checkpoint bytes. |
| `turnEnded=unavailable` | The Run ended without TurnEnded, so every `raw*` field reads `unavailable` and `rawReadVsPriorContext=n/a`. Continuity and context fields still describe the Run. A plan-handoff cancellation is the common case. |
| `currentContext` | Latest known checkpoint `usedTokens` at Run end. |
| `contextDelta` | Current minus prior occupancy. Negative values are possible after summarization/compaction; positive values include new user/tool/output context. |
| `rawReadVsPriorContext` | Aggregate cache-read tokens divided by prior context (`3.00x`). Values above one can reflect repeated prefix reads within a Run. Neither this multiple nor `pumpPasses` establishes the number of internal model calls or a per-call hit rate. |
| `sameSizedCategoryTokens` | Sum of current categories whose token count exactly matches the prior checkpoint. This compares sizes only, not content identity. |
| `categoryDelta` | Per-category token-count change (`current - prior`); `new`/`removed` indicate category appearance/disappearance. |
| `toolsCategoryChurn` | `none`, `upstream-stable-overlay` (tools tokens moved while RequestContext overlay bytes were reused), or `client-overlay-changed` (tools moved and RequestContext was rebuilt). See `createPlanInTurn` / `switchModeInTurn` for the common in-turn trigger; the turn after leaving plan mode moves it back without either flag. |
| `checkpointUpdates` | All non-empty checkpoints seen during this held Run. |
| `tokenDetailUpdates` | Those checkpoints that included decodable token details. Zero explains a stale `checkpoint-previous-turn` source. |
| `pumpPasses` | Number of provider pump invocations over the held Run. More than one is normal across tool continuations; it is not a model-call count. |
| `steps=started/completed` | Cursor protocol step events. Useful activity evidence, but **not** a proven model-call count. |
| `displayToolCalls` | Cursor display tool-start events. |
| `execRequests` | Cursor exec/control requests, including provider-handled probes and host-tool requests. |
| `perModelCallCache=unavailable` | Cursor did not expose a per-call cache split. This must remain unavailable unless the wire protocol supplies it. |

Each `checkpoint: stored` line includes `context=used/max` and a compact
`categories={...}` object. Read these in timestamp order to locate the step where
context composition changed. Category names come from Cursor and can evolve.

## Recognize common patterns

### Healthy warm continuation

- same `sessionKey`, `conversationId`, `conversationGroupId`, and model;
- `continuity=warm`;
- `systemPromptSent=false`;
- `requestContext=reused` with the same hash;
- fresh token details and `status=ok`;
- non-zero cache read.

The cache percentage can still be lower than another provider because Cursor's
line aggregates the entire agent Run.

### Stable client prefix, low upstream reuse

- warm continuity and unchanged conversation identity;
- unchanged RequestContext/system-prompt hashes;
- no reset, rebase, model/tier change, or capability delta;
- low `rawReadRatio` and low `rawReadVsPriorContext`.

This is the strongest evidence that the provider kept its observable prefix
stable but Cursor's backend reported little reuse. The log cannot identify the
backend cache key or the internal call that missed.

Also check for `superseded-by-new-run` with `pending>0` immediately before the
bad warm Run. Mid-exec supersede (host fresh turn while a real tool was still
outstanding) historically cratered cache even with a reused conversation_id.
`preparePriorSessionForFreshTurn` should cancel those execs and drain
`turn_ended` first; look for `fresh turn: cancelled N pending exec(s)` and
`drain outcome=turn-ended` rather than a bare supersede warning.

### Plan-mode tools expansion (CreatePlan and friends)

- `toolsCategoryChurn=upstream-stable-overlay` with `requestContext=reused` and
  an unchanged RequestContext hash, plus `createPlanInTurn=true` (or
  `switchModeInTurn=true`) on the same diagnosis line;
- checkpoint `tools` steps up by roughly 590–640 tokens on that turn and stays
  there while the conversation remains in plan mode;
- the first turn after the session leaves plan mode shows the same amount back
  (`tools` −N, again `upstream-stable-overlay`, with neither interaction flag)
  and still reads most of its input from cache;
- later ordinary turns show `tools+0`.
- A CreatePlan/SwitchMode turn with TurnEnded `cache_read=0` is tagged
  `turnEndedCacheRead=zero-interaction` and `cacheReuseEvidence=unavailable`.
  Checkpoint occupancy measures context size; it cannot establish a cache hit
  or prove that upstream omitted a counter. Keep the zero counter as reported
  and assess subsequent turns independently.

This pattern is consistent with upstream prompt expansion while the client
keeps its overlay stable. The category shift and interaction tag do not prove
which backend content changed, whether it recurs on every plan entry, or
which internal call missed the cache. Preserve the measured zero counter,
compare later turns, and do not remint a healthy conversation to chase a ratio.
There is no general promise that repeated plans are free or that a fixed
percentage of a plan turn is billed uncached.

### Plan handoff cancellation

- An approved SwitchMode, or a plan approval that changes the host's primary
  agent, cancels its Run: `host-agent-mode: cancelling Run for plan handoff`,
  then `connect error: code=canceled` and `Run cancellation acknowledged`.
- Cursor sends no TurnEnded. That Run's `cache diagnosis:` line carries
  `turnEnded=unavailable`. It has no measured cache ratio, and a missing ratio
  is not a miss.
- The cancellation's last checkpoint reports `context=0/…` and
  `categories=unavailable`. The next Run sends it unchanged and keeps the prior
  occupancy of the last measured checkpoint.
- Pair each `outbound Run:` with the first diagnosis after it for the same
  session. The diagnosis just before it closes the previous Run.

### Client-side context changed

- `requestContext=built` and hash changed on a warm ordinary turn;
- category deltas in tools, rules, skills, MCP, or subagents;
- a model/tier change, or newly enabled capability.

Confirm whether the change was intentional. If not, diff the context-discovery
inputs before changing token accounting.

### Aggregate multi-step dilution

- multiple `pumpPasses`, protocol steps, tools, or exec requests;
- raw input substantially larger than prior/current context;
- cache reads are non-zero but `rawReadRatio` looks lower than a simple
  single-request provider.

Treat this as aggregate Run behavior. Do not divide by `steps` to invent a
per-call ratio.

### Expected cold turn

- `continuity=cold` and `systemPromptSent=true`;
- first chat turn, missing/expired restart snapshot, explicit reset, recovery
  rebase, compaction, post-compaction rebase, foreign-history reseed, or
  checkpoint-unusable reseed.

Low or zero cache read does not diagnose a regression here. For compaction,
verify that `conversationGroupId` remains stable and that unchanged
RequestContext hashes survive the rotations where applicable.

### Slow first turn

- `git: discovery elapsedMs=… statusMs=… statusComplete=…` times workspace
  discovery; `git status` dominates on large repositories.
- `git: \`status --porcelain -b\` timed out after 5000ms` means the Run was
  sent `git_status_info_complete: false` and an empty status.
- `workspace facts: reused ageMs=…` shows a second build within 30 s (the
  title request and its turn) reusing the first discovery.

### Stale context snapshot

- `source=checkpoint-previous-turn`;
- `checkpointUpdates=0` or `tokenDetailUpdates=0`;
- prior and current context totals are equal.

OpenCode receives the explicitly stale last-known total. Use TurnEnded only for
raw request/cache diagnostics; never promote it to context occupancy.

## Compare several turns correctly

For a selected session, report both:

- weighted cache-read ratio: `sum(rawCacheRead) / sum(rawInput)`;
- arithmetic mean of per-Run `rawReadRatio`, if useful, clearly labeled as an
  unweighted mean.

Use the weighted ratio for overall token effectiveness. A mean gives a tiny Run
the same influence as a very large Run.

This `awk` command computes both from already-filtered cache-diagnosis lines:

```bash
rg 'cache diagnosis: sessionKey=ses_EXAMPLE(?: |$)' /tmp/cursor-cache.log |
awk '
  {
    input = read = ratio = 0
    for (i = 1; i <= NF; i++) {
      split($i, pair, "=")
      if (pair[1] == "rawInput") input = pair[2] + 0
      if (pair[1] == "rawCacheRead") read = pair[2] + 0
      if (pair[1] == "rawReadRatio") ratio = pair[2] + 0
    }
    totalInput += input
    totalRead += read
    ratioSum += ratio
    turns += 1
  }
  END {
    printf "turns=%d weightedReadRatio=%.1f%% meanRunRatio=%.1f%%\n", \
      turns, totalInput ? 100 * totalRead / totalInput : 0, \
      turns ? ratioSum / turns : 0
  }
'
```

Do not mix cold/compaction Runs into a warm-cache comparison without labeling
them. Do not compare different models or context tiers as if they shared one
cache policy.

## Handoff checklist

Another agent/session should be able to continue from a short report containing:

1. Log path, PID header, time range, OpenCode session id, and model/tier.
2. Whether provider/OpenCode restarts or compactions occurred.
3. Conversation-id sequence and stable conversation-group id.
4. Per-Run continuity, context source, raw input/read/write/uncached, and both
   cache ratios.
5. RequestContext/system-prompt hash changes and whether the prompt was sent.
6. Prior/current context totals and material category deltas.
7. Checkpoint/token-detail updates plus step/tool/exec activity.
8. Weighted cache-read ratio for warm Runs, with cold Runs counted separately.
9. Any `status=mismatch`, interruption, rebase, persistence failure, or missing
   TurnEnded line quoted verbatim.
10. A conclusion limited to the evidence: client prefix changed, client prefix
    stayed stable but upstream reuse was low, aggregate multi-step behavior, or
    insufficient protocol data.

Keep the raw log until the diagnosis is closed; summary percentages alone are
not enough to distinguish these cases.
