# Effective context of Cursor routes

Cursor CLI sends history without a client-side size check. Cursor's agent
harness summarizes what does not fit the window and keeps the current request.
The provider does the same: a rebuilt history goes to Cursor as up to five
earlier user turns (`prepend_user_messages`), never inside the request, and is
not checked against the model's window.

A few routes were measured to behave differently. They keep only the newest
part of their input, well inside the advertised window, and summarize nothing.
On those routes a large rebuilt history would lose its oldest turns without
notice. [`src/effective-context-data.ts`](../src/effective-context-data.ts)
records each such route's measured input limit. Only listed models are checked:

- A normal turn that rebuilds history (another model answered, an unusable
  checkpoint, an interrupted Run) and needs more than 80 % of the measured
  limit fails before opening a Run with a context overflow (HTTP 413, "prompt is
  too long"), so the host compacts.
- The history-import turn of a compaction cannot refuse, since compaction is
  what has to shrink. It keeps the newest messages that fit and puts
  `[N earlier message(s) omitted: over <model>'s measured context]` before them.

## Finding and recording a route

1. **Symptom.** On a turn with a large history, look for any of these:
   - The reply misses early facts or the request itself.
   - `turn_ended.input_tokens` is far below the history's size, or is 0.
   - No `summary_started` arrives in the turn.
   - The checkpoint's `token_details.used_tokens` is far below what was sent,
     inside the model's stated window.

   Routes that work look different: Cursor summarizes in the turn
   (`summary_started`, `summary_archives` in the checkpoint) or accepts the
   whole input past its stated window.
2. **Probe** with an operator credential, live, and keep the results in a
   private run report:
   - Send Runs with the provider's default variant parameters for the model.
   - Control: three short facts as prepended earlier turns, then a question
     about them; all three must be recalled.
   - Sizes: a history of roughly 0.4M, 0.8M and 1.6M characters with facts
     planted at its start, middle and end, sent as five prepended turns with
     the question in the request. Record recall, `input_tokens`,
     `summary_started` and the checkpoint's `used_tokens` / `max_tokens`.
3. **Classify.**
   - Summarizes (archives present), or accepts and recalls: no entry.
   - **Silent cutoff:** `input_tokens` stays the same across sizes and only
     the newest facts are recalled. Record it.
4. **Record** `"<wire model id>": <limit>` in `src/effective-context-data.ts`,
   with the constant cutoff rounded down to the next 1,000. Add a comment with
   the date, the parameters sent and the observed cutoff, a test that exercises
   the entry, and a changelog line.
5. **Recheck** an entry when Cursor changes the model's catalog entry (context
   tier or variants), or when a listed model is reported to summarize. Remove
   the entry once the control and size probes show summaries or full recall.
   Results are per account, so note the account tier in the report.
