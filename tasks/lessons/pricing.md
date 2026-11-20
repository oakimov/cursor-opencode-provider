# Pricing lessons

[Index](../lessons.md) · [General](opencode.md) · [1.x](opencode-1.md) · [2.x](opencode-2.md)

The generator is `scripts/generate-cursor-pricing.ts`. Guards are
`test/pricing.test.ts` and `test/selectable-pricing.test.ts`.

## Source order

- **Read Cursor before the provider, and never invent a Fast rate from the standard row.**
  The price for a selectable model comes from, in order:
  1. the row in [models-and-pricing.md](https://cursor.com/docs/models-and-pricing.md);
  2. the Cursor model page, `https://cursor.com/docs/models/<slug>`, and only for a
     selectable model or variant that has no row there;
  3. the provider's official pricing page, and only for a model or variant that
     still has no price on Cursor.
  A markdown row wins when the page disagrees. A note alone supplies no rate.
  Auto remains unpriced. The provider page exists
  because Cursor bills third-party models at API list price and sometimes
  publishes no number of its own for a variant. Copying the standard row into
  `<id>-fast` is not a source. An added US data residency column once hid the
  long-context surcharge: read Notes by header, and test a row whose note
  changes the rates (`test/pricing.test.ts`).

## Cursor bills third-party models at the provider API list price

- **The list price is Cursor's stated rule, and the Fast rows Cursor does publish match it.**
  [models-and-pricing.md](https://cursor.com/docs/models-and-pricing.md) says
  third-party models "aren't included; on Premium and above you can use them at
  API list price", and that Claude, GPT, and Gemini "are available in Cursor at
  the model's API list price". Every Fast row Cursor publishes matches that
  provider list price (read 20 Nov 2026):
  - Claude Opus 5.5 Fast is $8 input and $40 output, Anthropic Fast mode for
    Opus 5.5. Cache read is 0.05× ($0.40) and the 5-minute cache write is
    1.25× ($10), which is the published Cursor row.
  - Claude Opus 5 Fast and Claude Opus 4.8 Fast are $10 input and $50 output,
    Anthropic Fast mode for Opus 5 / Opus 4.8. Cache read is the "all other
    models" 0.1× ($1) and the 5-minute cache write is 1.25× ($12.50).
  - GPT-5 Fast is $2.50 input, $0.25 cached input, and $20 output, the OpenAI
    Fast tier for the deprecated `gpt-5` row.
  - GPT-5.4 Fast ($5 / $0.50 cached / $30) and GPT-5.6 Sol Fast
    ($8 / $0.80 cached / $10 cache write / $40) match the same OpenAI Fast
    tier. Cursor's page states the GPT-5.4 factor as "2× the standard price";
    that is a Cursor-stated price and stays on the Cursor page.
  Composer, Grok, and other Cursor-owned models have no provider page. A Fast
  gap on one of those fails generation. The standard rate is not a substitute.
  CodexBar (`github.com/steipete/CodexBar`) is not a pricing source: it reads
  per-event cents from Cursor's usage API and has no price table for these ids.

## Fast mode

- **Anthropic Fast mode is a published input and output, with cache multipliers on top.**
  [Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing)
  says "Fast mode pricing applies across the full context window, including
  requests over 200k input tokens." The Fast table (20 Nov 2026) lists Claude
  Fable 5.2 at "$16 USD / MTok" input and "$80 USD / MTok" output. "Prompt
  caching multipliers apply on top of fast mode pricing." The 5-minute cache
  write is "1.25x base input price" ($20). The 1-hour write is 2×; Cursor's
  Claude `cache_write` is the 5-minute factor, so the generator uses 1.25×.
  Cache read is not the dollar in the cache-hit table. That table's
  "$0.20 USD" beside "Claude Fable 5.2 and Claude Mythos 5.2 0.025x" is
  0.025× the standard $8 input. Apply the multiplier to the Fast input:
  0.025×$16 = $0.40. The base model table's "$8 / MTok $40 / MTok" is the
  standard row and must not be read as the Fast row. Because Fast mode covers
  the full window, `claude-fable-5-2-fast` has no second tier;
  `claude-fable-5-2-1m-fast` uses that same flat rate.
- **OpenAI Fast is the Fast tier, not Standard, Batch, Flex, or Ultrafast.**
  [OpenAI pricing](https://developers.openai.com/api/docs/pricing) puts token
  prices in Astro island props, not in the visible cell order. A text-token
  row of three numbers is input, cached input, output. A row of four is input,
  cached input, 30-minute cache write, output. The rendered table shows output
  before the cache columns. Cursor's OpenAI `cache_write` is the 30-minute
  write; the 12-hour write is input×2.5 and is not in the props. On 20 Nov
  2026 the Fast tier lists `gpt-5.2` at $3.50 / $0.35 cached / $28 output, and
  the Fast grouped table (headings Category, Model, Input, Output, Cached
  input) lists `gpt-5.3-codex` at input $3.50, output $28, cached input $0.35.
  The page marks `gpt-5.3-codex` deprecated and still lists that Fast tier;
  the price is the one in the Fast table. The Standard tier's $1.75 / $0.175 /
  $14 is the base row already published by Cursor. The nearest short label
  `Standard`, `Batch`, `Flex`, `Fast`, or `Ultrafast` selects the grouped
  table. `Ultrafast` is not Fast.
- **A Cursor-stated Fast factor is still a Cursor price.** "Nx the standard
  price", in a sentence that says "fast mode" or "fast is", scales every
  component of the standard row. GPT-5.4 Fast is that rule. A page that names
  Fast mode and states no rate is not filled from the standard row; the
  provider page is tried, and generation fails if that page has no price
  either. "Above 100k … 5x the standard rates" on Haiku is long context. It
  does not name Fast mode, and it must not create `claude-haiku-5-5-fast`.

## Long context

- **A same-rate sentence is the long-context price.** "No long-context
  multiplier" or "the same rates" means the published row is the price above
  the threshold the page names. Opus, Sonnet, and Muse pages state that the
  published rate continues. That is a Cursor-stated price.
- **Max context 1M beside one rate covers the whole window.** Claude Fable 5,
  5.1, and 5.2, and Gemini 4 Argon, Carbon, Hydrogen, and Neon, list
  "Context window Nk. Max context 1M" with a single rate. The generator sets
  `longCoveredByBase` and does not add a second tier. This rule stays even
  when a Fast variant of the same model is priced from the provider page.
  Gemini 4 "Speed Fast" is a capability label, not a Fast variant.

- **Check standard and Fast long-context coverage independently.** A tier on
  the standard entry cannot supply a Fast tier. A model can also change rates
  inside a single advertised window. Gemini 3.1 Pro serves a 1M context without
  a separate variant, and Cursor's page states a surcharge above 200k without
  listing the numbers. The generator keeps Cursor's base row and reads the
  paid Standard tier from [Google's pricing page](https://aistudio.google.com/docs/pricing#gemini-3.1-pro-preview).
  It checks that the base rates agree before using the long-context rate.

## Auto

- **Do not assign a flat rate to Auto.** Cursor's current pricing documentation
  distinguishes Cost, Balance, and Intelligence. Balance and Intelligence
  bill at the routed rate, so the historical forum rates for classic Auto
  cannot price the shared `default` entry.
  [Cursor pricing](https://cursor.com/docs/models-and-pricing.md#auto-modes)

## The standard-rate Fast fallback

- **Using the standard rate for a Fast variant Cursor does not price undercharged by half.**
  The generator used to copy the standard row when the Cursor page did not
  name Fast mode. That billed GPT-5.2 Fast and GPT-5.3 Codex Fast at
  $1.75 / $0.175 / $14 instead of the OpenAI Fast tier $3.50 / $0.35 / $28,
  and Claude Fable 5.2 Fast at $8 / $10 / $0.20 / $40 instead of $16 / $20 /
  $0.40 / $80. Each component is half the provider Fast price. Because no
  `<id>-fast` cost was stored, `hasCursorFastPricing` stayed false and
  OpenCode kept Fast on the base entry (`src/model-config.ts`,
  `src/billing.ts`). The catalog now splits those three Fast variants onto
  the provider list price (`test/models.test.ts`,
  `test/selectable-pricing.test.ts`).

## Offline generation and the version-bump gate

- **Offline generation fails closed.** `--from-file` together with
  `--context-from-file` makes no network request. A Cursor gap page must be
  `<model-id>.html` in `--pages-from-dir`. A Fast price still missing after
  that page must be `<provider>.html` (`anthropic.html`, `openai.html`) in
  `--provider-pages-from-dir`. Gemini 3.1 Pro's long-context tier uses
  `google.md` in the same directory. A missing file throws "Refusing to fetch" and
  names the URL. An unknown `.html` name fails. A required Cursor page with
  no pricing table fails before any provider page is read and before
  `src/pricing-data.ts` is written. Tests must not fetch Cursor or read
  operator credentials (`test/network-guard.ts`). The saved pages are
  `test/fixtures/pricing-offline/pages` and
  `test/fixtures/pricing-offline/providers`. The generated module records the
  public source URLs so an offline run cannot embed machine-specific paths.
- **Refreshing prices is a manual step before a version bump.** Run live
  `bun run generate:pricing`, resolve every unmapped display name, run
  `bun run check:pricing`, run `bun run generate:images`, and finalize the
  changelog before editing the package version or creating a `v*` tag. The
  steps are the [release gate](../../AGENTS.md#hard-stop--release--version-bump--tag-gate-non-optional).
  There is no scheduled pricing job. A pricing change does not bump the
  version by itself. The v0.6.4 failure forced a retag when this gate was
  skipped.
