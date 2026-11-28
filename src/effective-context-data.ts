/**
 * Measured input-token limits of Cursor model routes that silently drop older
 * history well inside their advertised window, without summarizing it.
 *
 * Cursor CLI has no client-side context check: it sends, and Cursor's agent
 * harness summarizes what does not fit. That holds for most routes. A route
 * listed here was measured to cut its input at a fixed size instead, so a seed
 * that size would lose its oldest turns without notice; the provider checks
 * seeds against this limit only for these routes. Models not listed get no
 * check. Hand-recorded: add or remove an entry only with live evidence, by the
 * methodology in `docs/effective-context.md`.
 */
export const CURSOR_EFFECTIVE_CONTEXT: Readonly<Record<string, number>> = {
  // 2026-11-28: a hard cut at 56,181 input tokens with 0.8M- and 1.6M-character
  // histories, with and without the default variant (`reasoning=medium`); stated
  // window 272k; no summary; only the newest prepended turns reached the model.
  "gpt-5.4-mini": 56_000,
}

/** Share of a measured limit a seed may fill, leaving room for the request and reply. */
export const MEASURED_CONTEXT_SHARE = 0.8
