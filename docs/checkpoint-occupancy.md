# Checkpoint occupancy confirmation

This design follows [#139](https://github.com/oakimov/cursor-opencode-provider/issues/139)
and builds on [#144](https://github.com/oakimov/cursor-opencode-provider/pull/144).
Output accounting and the host's context measurement share the same usage
partition. A checkpoint count must therefore be selected before shaping usage,
choosing a pricing tier or retaining the next step's cached prefix.

## Problem and evidence

The issue reports isolated doubled checkpoint totals while only the conversation
category changes. OpenCode can compact from one such host usage reading.
Redistributing input and output does not change that total. The public host
hooks provide no independent compaction measurement or veto.

The decoded token fields do not provide a count of model calls per interval.
Inferring a divisor from a large reading would also risk hiding actual prompt
growth. This design uses a confirmation policy, not a claim that the provider
can reconstruct exact context size from aggregate counters.

## Selection policy

Keep Cursor's complete checkpoint byte-for-byte. Separately retain the last
accepted positive token-details field, as the existing restart snapshot already
does for zero-token terminal checkpoints.

A reading needs confirmation only when all of these checks hold:

- Both readings have a complete, consistent category breakdown and the same
  positive context limit. Category ids are unique and their token sum matches
  the checkpoint total.
- Both have a positive conversation character count. Every other category is
  unchanged, including its token and character counts.
- Total usage rises by at least 75%, conversation characters stay within 80–125%
  of the accepted reading, and conversation tokens per character rise by at
  least 50%.

These thresholds identify an unexplained jump, not proof of multiple calls.
Retain the previous accepted measurement and mark it stale, with
`source: "checkpoint-held-spike"` and `rawUsedTokens` identifying the current
unconfirmed reading. Do not divide the raw total or synthesize category counts.

An identical token-details update in the same observation is a duplicate, even
if other checkpoint bytes changed. It cannot confirm the jump. An inbound
step-start or a different Run advances the observation; the same high reading
can then confirm sustained growth. Resuming a host tool pump alone does not
advance it, because a queued duplicate can predate the result. A normal reading replaces
the retained measurement immediately. A distinct, compatible high reading
confirms sustained growth and is accepted. Missing or inconsistent evidence,
changed static categories, changed limits, or substantial character growth uses
the raw reading directly. A zero-token cancellation does not confirm a
candidate. Its saved accepted measurement and pending decision survive restart;
incoming zero-token finishes retain their existing behavior. Known model or
media changes bypass confirmation for the next positive reading only; a
zero-token checkpoint, or one without token details, carries that reset forward
on the conversation, so a Run resumed after a dropped connection still applies it. Media counts from the first
measured checkpoint that arrives after the prompt or tool result carrying it,
once Cursor has completed every delivered result. A checkpoint queued while the
tool ran cannot hold the image and does not consume the reset.
For prompt images, the receipt boundary is captured before opening the Run;
checkpoints received while its request waits for upload drain remain eligible.

## State and integration

Selection belongs to the conversation checkpoint store, shared by the pump,
terminal drain and Run startup. The raw checkpoint remains the retry/resume
state. The separately persisted accepted token field remains the host usage
measurement. Hydration restores that field before considering the raw saved
checkpoint, so an unconfirmed terminal spike is not promoted by restart.
Private cache field 21 retains the pending reading, its observation boundary
and model identity, including when the raw terminal checkpoint reports zero.

The selected measurement drives standard AI SDK usage, context metadata,
billing tiers and cached-prefix estimates on both OpenCode majors. Raw
TurnEnded counters and checkpoint logs remain unchanged. A held measurement's
category breakdown describes the older accepted snapshot and is marked stale.

## Limits and validation

This is a bounded confirmation delay. A genuine jump with unchanged character
evidence can be reported one independent reading late; provider overflow
rejections still reach the host normally. A first checkpoint, absent character
counts or inconsistent breakdown cannot be corrected by this policy. Sustained
inflation is outside its isolated-spike guarantee.

Regressions cover the issue's reported total sequences with explicit synthetic
category evidence, duplicate updates, genuine large character growth, sustained
high readings, malformed evidence, zero-token cancellation, terminal drains,
restart/hydration and model/context resets. Both hosts' usage and pricing sums
must agree with the selected total, and retry checkpoint bytes and frozen
RequestContext must stay unchanged. Live evidence and fixture checks are
reported separately in private run records.

Implementation: [selection policy](../src/checkpoint-occupancy.ts),
[checkpoint store](../src/protocol/checkpoint.ts),
[restart integration](../src/protocol/conversation-state.ts),
[cache encoding](../src/protocol/conversation-persistence.ts), and
[Run integration tests](../test/checkpoint-occupancy-run.test.ts).
