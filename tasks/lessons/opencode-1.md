# OpenCode 1.x lessons

[Index](../lessons.md) · [General](opencode.md) · [2.x](opencode-2.md) · [Pricing](pricing.md)

Operator setup: [OpenCode 1.x](../../docs/opencode-1.md).

## Plugin loading and request hooks

- **The 1.18 v2 API is not OpenCode 2.x.** Similar names hid incompatible hook
  signatures and provider schemas. Keep separate entrypoints and check the
  installed declarations (`src/plugin-v2.ts`).
- **v2-only loading loses classic tools.** The 1.18 API has no tool domain;
  image save and web search require the classic plugin alongside it
  (`src/plugin-v2.ts`, `src/plugin.ts`).
- **The root export is a plugin surface.** Classic loaders call exported
  functions as plugins. Keep auxiliary APIs on subpaths and host imports in
  their owning leaf modules (`test/architecture.test.ts`).
- **Mutate the messages array, not its container.** The experimental hook's
  returned object was ignored; request-only clones must replace entries in the
  original array without rewriting stored history (`test/plugin.test.ts`).
- **SessionRetry reads message text, not the verdict.** A usage-limit refusal
  with `isRetryable: false` and `x-should-retry: false` was still sent six
  times because its message said `resource_exhausted`; bare `429`/`500` digits
  (`$1500`, `500k`) match too. Terminal host messages pass through
  `sanitizeHostTerminalMessage`. 1.x also retries every status >= 500, so a
  final `internal`/`unknown` error is reported below 500; Cursor CLI decides
  from the verdict, never the code (`test/errors.test.ts`).

## File tools and planning

- **Patch selection is a host gate, not a provider model rule.** 1.x substitutes
  `apply_patch` for edit/write on eligible GPT ids. Model switches and restricted
  turns require remapping from permitted tools (`test/apply-patch.test.ts`).
- **CRLF edits need native edit semantics.** Cursor sent LF-only whole-file
  replacements after CRLF reads. Normalize targeted old/new text, including
  copied direct-patch context; leave intentional writes unchanged and reject
  unsafe mixed/unterminated direct updates (`test/apply-patch.test.ts`).
- **Reasoning can return as text after a model switch.** A text-only provenance
  comparison mistook our own answer for a foreign provider. Match both emission
  projections (`src/protocol/turn-provenance.ts`).
- **Plan entry can exist without `plan_enter`.** The primary-agent continuation
  and native `plan_exit` review still work. Resolve `Session.plan`, not a config
  directory, and never inject primary turns into helpers
  (`test/switch-mode.test.ts`, `src/host-plan-file.ts`).
- **Read envelopes carry notices outside the file.** Lift the trailing host
  reminder out of `<content>` without losing the 50 KB cap's meaning. The native
  `truncated` flag alone did not stop models treating a page as a complete file
  (`test/read-cap-repro.test.ts`, `test/host-notes.test.ts`).
- **Image-save attachments can break continuation.** Classic OpenCode extracts
  third-party tool media into a user message. A save-tool attachment opened a
  new Run and stranded the pending binary write. Return only the commit result;
  correlate detached images from real reads/MCP results separately
  (`test/generate-image.test.ts`, `test/image-input.test.ts`).

## Shell outcomes and billing

- **The shell environment hook follows approval.** bash/zsh can receive the
  wrapper via startup variables; sh/dash ignore those argv paths and need an
  explicit launcher (`test/shell-timeout.test.ts`).
- **Abort is not successful partial output.** Classic SDK conversion and null
  shell exits hid interruptions. Preserve provenance in the request projection;
  rejection cleanup must also handle paths that skip the after hook
  (`test/classic-tool-results.test.ts`).
- **The cost override is specific to classic OpenCode.** A zero
  `copilot.totalNanoAiu` hid billing here while 2.x still charged token prices.
  Test both formulas rather than extrapolating (`test/billing.test.ts`).
