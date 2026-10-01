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
- whether a system prompt was seeded or the checkpoint was used instead;
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
| `continuity=cold` | No checkpoint was supplied. Zero or low cache read is expected. |
| `continuity=checkpoint-without-token-details` | A checkpoint was supplied, but it lacked a decodable prior token snapshot. Transport continuity may exist, but prior-context coverage cannot be computed. |

Also inspect the outbound flags:

- `reset=false`, `resume=false`, and `checkpointLen>0` describe an ordinary
  checkpoint continuation.
- `reset=true` or a `conversation reset:` line explains a new Cursor identity.
- `resume=true` follows an interrupted Run and reuses the latest eligible
  checkpoint.
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

At provider startup, `conversation persistence: restored` confirms that the
session binding, checkpoint, reachable blobs, and frozen context were hydrated.
`missing`, `invalid`, `expired`, or restore failure means the next Run may be
cold even though OpenCode still has its own chat history.

### 2. Check prefix stability

| Field | Interpretation |
|---|---|
| `requestContext=reused` | The fully materialized RequestContext protobuf bytes matched the prior value and the exact object was reused. |
| `requestContext=built` | A new materialized value was used. This is expected on the first Run; on a warm ordinary turn, compare hashes and capability changes. |
| `requestContextHash` | First 16 hex characters of the encoded RequestContext SHA-256. Equal hashes are strong byte-identity evidence. The full hash appears on `hash requestContext sha256=…`. |
| `systemPromptHash` | Hash of the current candidate system prompt. Equal hashes show prompt construction was stable. |
| `systemPromptSent=false` | A checkpoint was sent, so this Run did not seed the system prompt again. The hash is diagnostic only in this case. |
| `systemPromptSent=true` | This was a seeded/rebased Run and the system prompt was placed in the new conversation state. |

The checkpoint hash is expected to change as the conversation changes. Do not
use checkpoint-hash equality as the definition of prompt-cache reuse.

Capabilities are deliberately live. Enabling/disabling tools, MCP servers,
skills, agents, or plugins may produce `requestContext=built`, a new hash, and
category changes. That is correct; cache stability must not freeze capability
truth.

### 3. Validate the totals sent to OpenCode

Every completed Run emits `turn usage validation:`. Begin with `status`:

- `status=ok` means the AI SDK input/output partitions sum correctly, the total
  sent to OpenCode matches Cursor's checkpoint total when available, and the
  category breakdown is internally consistent.
- `status=mismatch` is a provider accounting bug **for the usage that was
  sent**. Occupancy finishes (tool-call and TurnEnded/stop) validate against
  occupancy-shaped counters (`output=1`, `cacheRead=prior`); aggregate
  TurnEnded request ratios live on `finish:` / `cache diagnosis:` and are not
  required to equal the occupancy prefix ratio. Preserve the complete line and
  the preceding checkpoint/TurnEnded lines before changing cache behavior.

Important fields:

| Field | Meaning |
|---|---|
| `source=checkpoint-current-run` | Current Run supplied fresh `tokenDetails`; preferred. |
| `source=checkpoint-previous-turn` | No fresh details arrived, so the last snapshot is retained and marked stale in provider metadata. |
| `source=occupancy-checkpoint-current-run` | Tool-call finish published the current Run's occupancy snapshot (display-only, `$0`). |
| `source=occupancy-checkpoint-previous-turn` | Tool-call finish published the prior checkpoint occupancy because this Run has not yet received token details. |
| `source=intermediate-zero` | Tool-call finish with no known checkpoint occupancy. Standard usage remains zero. |
| `source=unavailable` | No checkpoint has ever supplied token details. Standard usage remains zero rather than pretending aggregate TurnEnded usage is context occupancy. |
| `cursor=used/max(percent)` | Cursor's authoritative context occupancy. |
| `rawTotal` | Aggregate `TurnEnded` input + output. This is request work, not necessarily current context occupancy. |
| `sentTotal` | AI SDK input + output sent to OpenCode. With token details, this must equal Cursor `usedTokens`. |
| `rawCachedRatio` | For occupancy validation counters: `(prior usedTokens) / usedTokens`. TurnEnded request cache ratios are on `finish:` / cache diagnosis, not this field. |
| `sentCachedRatio` | Occupancy `cacheRead` / sent input. Should match `rawCachedRatio` when validation uses occupancy-shaped counters. |
| `breakdownMatch` | Whether Cursor's category totals agree with `usedTokens`. |

`finish:` is a compact duplicate of the final AI SDK and raw counters. Tool-call
boundaries should show `source=occupancy-checkpoint-*` when a snapshot exists
(or `intermediate-zero` with no snapshot); the final `TurnEnded` should settle
the billed occupancy exactly once. On occupancy finishes, `rawCacheRead` /
`occupancyPrefixCache` are the prior-turn checkpoint prefix estimate — not
Cursor's TurnEnded `cache_read` (that only appears on `reason=stop`).

### 4. Interpret the cache diagnosis

The raw partition obeys:

```text
rawInput = rawCacheRead + rawCacheWrite + rawUncached
rawReadRatio = rawCacheRead / rawInput
rawWriteRatio = rawCacheWrite / rawInput
```

Captured Cursor Runs commonly report `rawCacheWrite=0`. This is an upstream
value, not evidence that the provider dropped writes.

| Field | Interpretation |
|---|---|
| `priorContext` | Cursor `usedTokens` decoded from the checkpoint supplied at Run start. |
| `currentContext` | Latest known checkpoint `usedTokens` at Run end. |
| `contextDelta` | Current minus prior occupancy. Negative values are possible after summarization/compaction; positive values include new user/tool/output context. |
| `rawReadVsPriorContext` | Aggregate cache-read tokens divided by prior context. This asks how much read credit Cursor reported relative to the reusable starting context. It is not a bounded percentage and can exceed 100% when several internal calls reuse the prefix. |
| `sameSizedCategoryTokens` | Sum of current categories whose token count exactly matches the prior checkpoint. This compares sizes only, not content identity. |
| `categoryDelta` | Per-category token-count change (`current - prior`); `new`/`removed` indicate category appearance/disappearance. |
| `toolsCategoryChurn` | `none`, `upstream-stable-overlay` (tools tokens moved while RequestContext overlay bytes were reused), or `client-overlay-changed` (tools moved and RequestContext was rebuilt). See `createPlanInTurn` / `switchModeInTurn` for the common in-turn trigger. |
| `checkpointUpdates` | All non-empty checkpoints seen during this held Run. |
| `tokenDetailUpdates` | Those checkpoints that included decodable token details. Zero explains a stale `checkpoint-previous-turn` source. |
| `pumpPasses` | Number of OpenCode stream pulls over the held Run. More than one is normal when tools were executed. |
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

### One-time upstream tools expansion (CreatePlan and friends)

- `toolsCategoryChurn=upstream-stable-overlay` with `requestContext=reused` and
  an unchanged RequestContext hash, plus `createPlanInTurn=true` (or
  `switchModeInTurn=true`) on the same diagnosis line;
- checkpoint `tools` steps up by ~630–640 tokens once (e.g. 7774→8407) and then
  stays flat on following turns;
- the next ordinary turn recovers to a high `rawReadRatio` with `tools+0`.

This is Cursor's backend filing first-use native call/result content (CreatePlan
call envelope plus its fixed result boilerplate) under the `tools` category. It
is one-time per conversation — a second plan in the same conversation adds +0 —
and it also fires on some non-CreatePlan server-side prompt rebuilds, so the
CreatePlan tag confirms the common case but its absence does not rule this out.
Our overlay bytes stay identical throughout; there is no client prefix rebuild
to fix. Do not remint to escape it (strictly worse than one cold turn).

Cost policy: the crater costs ~94% of current context at full price, once per
planning conversation. Prefer recording the first plan early (small context)
and refining afterward — follow-up plans are free — over deferring planning
until investigation is complete. At very large contexts, compact first and plan
on the fresh small prefix.

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
