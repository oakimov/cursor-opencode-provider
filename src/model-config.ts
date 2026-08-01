import {
  CURSOR_VARIANT_PARAMETERS_KEY,
  CURSOR_WIRE_MODEL_ID_KEY,
  parseCursorContextLimit,
  type ModelInfo,
  type ModelVariant,
} from "./models.js"

/**
 * Cursor `ModelInfo` → OpenCode model-config mapping.
 *
 * Host-neutral on purpose: both the classic/1.18 plugins and the OpenCode 2.0
 * plugin derive their catalogs from here, so model naming, thinking suffixes,
 * and long-context tiering stay identical across every surface. Do not import
 * a host plugin API into this module.
 */

/**
 * Strip characters and markup that break rendering in the OpenCode TUI/GUI from
 * a model or variant display name:
 *   • HTML tags (e.g. `<span style="…">Medium</span>`) — the IDE colours variant
 *     suffixes with a CSS var that doesn't exist in OpenCode, so the raw markup
 *     would show as literal text. We drop the tags and keep the inner text
 *     ("Medium").
 *   • HTML/markup chars (`< > & " ' \``), parentheses.
 *   • Tabs/newlines collapse to single spaces.
 * Dots and unicode letters are preserved so names stay readable.
 * Fixes https://github.com/oakimov/cursor-opencode-provider/issues/2.
 */
function stripMarkupTags(value: string): string {
  const chunks: string[] = []
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor)
    if (start === -1) {
      chunks.push(value.slice(cursor))
      break
    }
    chunks.push(value.slice(cursor, start))
    const end = value.indexOf(">", start + 1)
    if (end === -1) {
      chunks.push(value.slice(start))
      break
    }
    cursor = end + 1
  }
  return chunks.join("")
}

function safeLabel(value: string): string {
  return (
    stripMarkupTags(value)
      .replace(/[()<>&"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "default"
  )
}

function baseName(mi: ModelInfo): string {
  return safeLabel(mi.displayName ?? mi.id)
}

function modelInfoVariants(
  mi: ModelInfo,
  variants: ModelVariant[],
): Record<string, Record<string, unknown>> | undefined {
  if (variants.length === 0) return undefined
  const entries: Record<string, Record<string, unknown>> = {}
  const usedKeys = new Set<string>()
  const baseName = safeLabel(mi.displayName ?? mi.id)

  // Each variant's key is `safeLabel(displayName)` (the IDE's own label, e.g.
  // "Opus 4.8 1M High Fast Thinking") so the picker matches what the user
  // sees in Cursor. Two variants can sanitize to the same name when the IDE
  // wraps a differentiator in `<span>…</span>` (e.g. Composer's "Fast"
  // suffix collapses to the bare model name after stripping). To guarantee
  // every variant stays pickable:
  //   1. If the sanitized displayName matches the model name itself, suffix
  //      it with distinguishing params (or "default") so it never collides
  //      with the model entry in the variant panel.
  //   2. If two variants still collide, tag the later one with its params.
  // Suffixes must stay free of `()` / markup chars — same constraint as
  // safeLabel (issue #2); use spaced tokens, not parenthetical tags.
  const tagDims = (p: { id: string; value: string }[]): string => {
    const labels: string[] = []
    for (const d of p) {
      if (d.id === "fast" && d.value === "true") labels.push("Fast")
      else if (d.id === "thinking" && d.value === "true") labels.push("Thinking")
      else if (d.id === "context") labels.push(d.value)
    }
    if (labels.length > 0) return ` ${labels.join(" ")}`
    // No params at all — still disambiguate from the model name itself.
    if (p.length === 0) return ""
    return " default"
  }

  for (const v of variants) {
    const sanitized = safeLabel(v.displayName || v.key || "default")
    let key = sanitized
    // Never let a variant key equal the model name — that would make the
    // variant entry indistinguishable from the model entry in pickers that
    // collapse them.
    if (key === baseName && !usedKeys.has(key)) {
      key = `${baseName}${tagDims(v.parameterValues)}` || `${baseName} default`
    } else if (usedKeys.has(key)) {
      key = `${sanitized}${tagDims(v.parameterValues)}`
    }
    let n = 2
    while (usedKeys.has(key)) key = `${sanitized}${tagDims(v.parameterValues)} ${n++}`
    usedKeys.add(key)

    entries[key] = {
      [CURSOR_VARIANT_PARAMETERS_KEY]: v.parameterValues.map((p) => ({ ...p })),
    }
  }
  return entries
}

function isLongContextVariant(v: ModelVariant): boolean {
  return v.parameterValues.some(
    (p) => p.id === "context" && parseCursorContextLimit(p.value) === 1_000_000,
  )
}

function variantsForTier(mi: ModelInfo, tier: "base" | "long"): ModelVariant[] {
  return mi.variants.filter((v) => isLongContextVariant(v) === (tier === "long"))
}

/**
 * Display names shared by both a thinking and a non-thinking model. A thinking
 * model with such a name needs a "Thinking" tag to disambiguate it from its
 * non-thinking twin (Cursor's Claude/Fable/Sonnet families). Models whose names
 * are already unique — including Cursor's GPT family, where the reasoning tier
 * ("None"/"Low"/"High"…) is baked into the name — are excluded, so they aren't
 * tagged redundantly.
 */
export function thinkingSuffixBaseNames(models: ModelInfo[]): Set<string> {
  const flags = new Map<string, { hasThinking: boolean; hasNonThinking: boolean }>()
  for (const m of models) {
    const base = baseName(m)
    const entry = flags.get(base) ?? { hasThinking: false, hasNonThinking: false }
    if (m.supportsThinking) entry.hasThinking = true
    else entry.hasNonThinking = true
    flags.set(base, entry)
  }
  const ambiguous = new Set<string>()
  for (const [base, f] of flags) if (f.hasThinking && f.hasNonThinking) ambiguous.add(base)
  return ambiguous
}

export function modelInfoToConfig(
  mi: ModelInfo,
  options: { thinkingSuffix?: boolean; contextTier?: "base" | "long" } = {},
) {
  const contextTier = options.contextTier ?? "base"
  const variants = variantsForTier(mi, contextTier)
  let name = baseName(mi)
  if (options.thinkingSuffix) name += " Thinking"
  if (contextTier === "long") name += " 1M"
  // OpenCode's context limit is static per model entry, while Cursor's context
  // tier is a variant parameter. Long-context choices are therefore emitted as
  // separate OpenCode entries by modelsToConfig.
  const context = contextTier === "long"
    ? (mi.maxContextForMaxMode ?? 1_000_000)
    : (mi.maxContext ?? 200_000)
  // OpenCode's overflow/compaction/UI use limit.context; generation and
  // thinking budgets use limit.output. models.dev 1M peers advertise
  // 64k–128k output — a tiny cap makes long-context sessions feel broken
  // even when the 1M input window is correct.
  const output = contextTier === "long" ? 128_000 : 32_000
  const config: Record<string, any> = {
    name,
    reasoning: mi.supportsThinking ?? false,
    tool_call: mi.supportsAgent ?? true,
    temperature: false,
    limit: {
      context,
      output,
    },
  }
  const variantConfig = modelInfoVariants(mi, variants)
  if (variantConfig) config.variants = variantConfig
  if (contextTier === "long") {
    const defaultVariant = variants.find((v) => v.isDefaultMax) ?? variants[0]
    if (defaultVariant) {
      config.options = {
        [CURSOR_WIRE_MODEL_ID_KEY]: mi.id,
        [CURSOR_VARIANT_PARAMETERS_KEY]: defaultVariant.parameterValues.map((p) => ({ ...p })),
      }
    }
  }
  return config
}

export function modelsToConfig(models: ModelInfo[]): Record<string, any> {
  const ambiguous = thinkingSuffixBaseNames(models)
  const out: Record<string, any> = {}
  const usedIds = new Set(models.map((m) => m.id))
  for (const m of models) {
    const thinkingSuffix = !!m.supportsThinking && ambiguous.has(baseName(m))
    const baseVariants = variantsForTier(m, "base")
    const longVariants = variantsForTier(m, "long")

    if (baseVariants.length > 0 || longVariants.length === 0) {
      out[m.id] = modelInfoToConfig(m, { thinkingSuffix, contextTier: "base" })
    }
    if (longVariants.length === 0) continue

    if (baseVariants.length === 0) {
      out[m.id] = modelInfoToConfig(m, { thinkingSuffix, contextTier: "long" })
      continue
    }

    let longId = `${m.id}-1m`
    let suffix = 2
    while (usedIds.has(longId)) longId = `${m.id}-1m-${suffix++}`
    usedIds.add(longId)
    out[longId] = modelInfoToConfig(m, { thinkingSuffix, contextTier: "long" })
  }
  return out
}
