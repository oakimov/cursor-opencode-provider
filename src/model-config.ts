import {
  CURSOR_VARIANT_PARAMETERS_KEY,
  CURSOR_WIRE_MODEL_ID_KEY,
  findDefaultVariant,
  isEffortParameter,
  isEnabledReasoningValue,
  parseCursorContextLimit,
  variantsSupportReasoning,
  type ModelInfo,
  type ModelVariant,
} from "./models.js"
import { applyCursorModelCost, hasCursorFastPricing } from "./pricing.js"
import { cursorModelReadsImages, getDocumentedCursorModelContext } from "./model-metadata.js"

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
 *   • Zero-width / BOM characters Cursor sometimes embeds in Fast suffixes.
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
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[()<>&"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "default"
  )
}

function baseName(mi: ModelInfo): string {
  return safeLabel(mi.displayName ?? mi.id)
}

/**
 * Effort values Cursor publishes, low → high. Disabled values (`off`, `false`)
 * rank with `none`; unknown values sort last.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

function effortRank(params: ModelVariant["parameterValues"]): number {
  const raw = params.find((p) => isEffortParameter(p.id))?.value
  if (raw === undefined) return -1
  if (!isEnabledReasoningValue(raw)) return 0
  const index = (EFFORT_ORDER as readonly string[]).indexOf(raw.trim().toLowerCase())
  return index < 0 ? EFFORT_ORDER.length : index
}

function paramMap(params: ModelVariant["parameterValues"]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of params) out[p.id] = p.value
  return out
}

/** OpenCode's persisted "no explicit variant" sentinel (1.x and 2.x). */
const RESERVED_VARIANT_KEY = "default"

/** Drop a leading model-name prefix from a sanitized variant label. */
function stripModelPrefix(label: string, prefix: string): string | null {
  if (label === prefix) return ""
  if (prefix.length > 0 && label.startsWith(`${prefix} `)) return label.slice(prefix.length + 1)
  return null
}

/**
 * OpenCode variant keys are the delta after the catalog model name — e.g.
 * "Extra High", "No Thinking Low", "High Fast" — not Cursor's full
 * "<model> <delta>" display string. Fast and dedicated context-tier entries
 * also drop their redundant "Fast" / tier ("500k", "1M") tokens. The entry's
 * own flags decide that, never its name: a Cursor model can be named "… Fast".
 * Order: No Thinking before Thinking, then effort low→high, non-Fast before
 * Fast, preserving the first-seen context-tier blocks.
 */
function modelInfoVariants(
  mi: ModelInfo,
  variants: ModelVariant[],
  entry: { name: string; fast: boolean; contextTier: ContextTier },
): Record<string, Record<string, unknown>> | undefined {
  if (variants.length === 0) return undefined
  const entries: Record<string, Record<string, unknown>> = {}
  const usedKeys = new Set<string>()
  const modelBase = baseName(mi)
  const entryName = safeLabel(entry.name)
  const fastEntry = entry.fast
  const redundant = new Set<string>()
  if (fastEntry) redundant.add("fast")
  if (entry.contextTier === "long") redundant.add("1m")
  else if (typeof entry.contextTier === "number") redundant.add(contextSuffix(entry.contextTier))
  const contextOrder: Array<string | undefined> = []

  const labeled = variants.map((v) => {
    const params = paramMap(v.parameterValues)
    const full = safeLabel(v.displayName || v.key || "default")
    let label = stripModelPrefix(full, entryName) ?? stripModelPrefix(full, modelBase) ?? full
    if (redundant.size > 0) {
      label = label.split(" ").filter((word) => !redundant.has(word.toLowerCase())).join(" ")
    }
    // Cursor puts "No Thinking" after the effort; OpenCode shows it first.
    if (/(?:^| )No Thinking(?: |$)/.test(label)) {
      label = `No Thinking ${label.replace(/(?:^| )No Thinking(?: |$)/g, " ")}`
        .replace(/\s+/g, " ")
        .trim()
    }
    const flags = [
      params.thinking === "true" ? "Thinking" : "",
      !fastEntry && params.fast === "true" ? "Fast" : "",
    ].filter(Boolean).join(" ")
    // Both OpenCode majors reserve the variant id "default" for "no variant
    // override", so a variant keyed "default" would never apply its params.
    if (!label || label === RESERVED_VARIANT_KEY) label = flags || "Standard"

    let key = label
    if (usedKeys.has(key)) {
      key = [label, flags, params.context].filter(Boolean).join(" ")
    }
    let n = 2
    while (usedKeys.has(key)) key = `${label} ${n++}`
    usedKeys.add(key)
    if (!contextOrder.includes(params.context)) contextOrder.push(params.context)
    return { key, variant: v, params }
  })

  labeled.sort((a, b) => {
    const think = Number(a.params.thinking === "true") - Number(b.params.thinking === "true")
    if (think !== 0) return think
    const ctx = contextOrder.indexOf(a.params.context) - contextOrder.indexOf(b.params.context)
    if (ctx !== 0) return ctx
    const effort = effortRank(a.variant.parameterValues) - effortRank(b.variant.parameterValues)
    if (effort !== 0) return effort
    return Number(a.params.fast === "true") - Number(b.params.fast === "true")
  })

  for (const { key, variant } of labeled) {
    entries[key] = {
      [CURSOR_VARIANT_PARAMETERS_KEY]: variant.parameterValues.map((p) => ({ ...p })),
    }
  }
  return entries
}

function isLongContextVariant(v: ModelVariant): boolean {
  return v.parameterValues.some(
    (p) => p.id === "context" && parseCursorContextLimit(p.value) === 1_000_000,
  )
}

function isFastVariant(v: ModelVariant): boolean {
  return v.parameterValues.some((p) => p.id === "fast" && p.value === "true")
}

type ContextTier = "base" | "long" | number

function variantContext(v: ModelVariant): number | undefined {
  return parseCursorContextLimit(v.parameterValues.find((p) => p.id === "context")?.value)
}

function isSeparateContext(mi: ModelInfo, v: ModelVariant): boolean {
  const context = variantContext(v)
  return isLongContextVariant(v) ||
    (v.isMaxMode === true && context !== undefined && context !== mi.maxContext)
}

/** `1m`, `500k`, `272k` — the tier token shared by catalog ids and variant ids. */
export function contextSuffix(context: number): string {
  return context % 1_000_000 === 0 ? `${context / 1_000_000}m` : `${context / 1_000}k`
}

function variantsForTier(mi: ModelInfo, tier: ContextTier): ModelVariant[] {
  return mi.variants.filter((v) => tier === "base"
    ? !isSeparateContext(mi, v)
    : tier === "long"
      ? isLongContextVariant(v)
      : isSeparateContext(mi, v) && variantContext(v) === tier)
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

/**
 * models.dev-style family for a Cursor model id: the id without its version
 * segments and context/speed suffixes (`claude-haiku-4-5` → `claude-haiku`,
 * `gemini-3.8-flash` → `gemini-flash`, `gpt-5.6-luna` → `gpt-luna`).
 * Kimi keeps its major generation (`kimi-k2.7-code` → `kimi-k2`). OpenCode
 * picks its small title model by family and falls back to the session model when
 * no entry has one. Cursor Auto (`default`) is not a model family.
 */
export function cursorModelFamily(id: string): string | undefined {
  if (id === "default") return undefined
  const base = id.replace(/(?:-(?:1m|fast))+$/, "")
  const kimi = /^kimi-(k\d+)(?:[.p]\d+)*(?:-code(?:-highspeed)?)?$/.exec(base)
  if (kimi) return `kimi-${kimi[1]}`
  const family = base
    .split("-")
    .filter((part) => !/^\d+(?:[.p]\d+)*$/.test(part))
    .join("-")
  return family || undefined
}

export function modelInfoToConfig(
  mi: ModelInfo,
  options: {
    thinkingSuffix?: boolean
    contextTier?: ContextTier
    variants?: ModelVariant[]
    /**
     * Variants this entry publishes. Defaults to `variants`; `modelsToConfig`
     * passes the speed group's advertised slice so a tier entry's `reasoning`
     * reflects only the choices it actually offers.
     */
    advertisedVariants?: ModelVariant[]
    fast?: boolean
  } = {},
) {
  const contextTier = options.contextTier ?? "base"
  const variants = options.variants ?? variantsForTier(mi, contextTier)
  let name = baseName(mi)
  if (options.thinkingSuffix) name += " Thinking"
  if (options.fast) name += " Fast"
  if (contextTier === "long") name += " 1M"
  if (typeof contextTier === "number") name += ` ${contextSuffix(contextTier).toUpperCase()}`
  // OpenCode's context limit is static per model entry, while Cursor's context
  // tier is a variant parameter. Long-context choices are therefore emitted as
  // separate OpenCode entries by modelsToConfig.
  const documentedContext = getDocumentedCursorModelContext(mi.id)
  // Cursor Auto (`default`) has no static maxContext on the model list, but
  // live checkpoints report 256k for the base tier — the previous 200k
  // fallback made the host context meter disagree with Cursor.
  const fallbackContext = mi.id === "default" ? 256_000 : 200_000
  const context = typeof contextTier === "number"
    ? contextTier
    : contextTier === "long"
      ? (variants.some(isLongContextVariant) ? 1_000_000
        : (mi.maxContextForMaxMode ?? documentedContext?.maxContextForMaxMode ?? 1_000_000))
      : (mi.maxContext ?? documentedContext?.maxContext ?? fallbackContext)
  // OpenCode's overflow/compaction/UI use limit.context; generation and
  // thinking budgets use limit.output. models.dev 1M peers advertise
  // 64k–128k output — a tiny cap makes long-context sessions feel broken
  // even when the 1M input window is correct.
  const output = contextTier === "long" ? 128_000 : 32_000
  const readsImages = cursorModelReadsImages(mi.id)
  const config: Record<string, any> = {
    name,
    attachment: readsImages,
    reasoning: Boolean(mi.supportsThinking || variantsSupportReasoning(options.advertisedVariants ?? variants)),
    tool_call: mi.supportsAgent ?? true,
    temperature: false,
    modalities: {
      input: readsImages ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    limit: {
      context,
      output,
    },
  }
  // Optional cache metadata may supply a family; the live AvailableModels
  // schema has no family field. Empty metadata must not block derivation.
  const reported = typeof mi.family === "string" ? mi.family.trim() : ""
  const family = reported || cursorModelFamily(mi.id)
  if (family) config.family = family
  const variantConfig = modelInfoVariants(mi, variants, {
    name,
    fast: options.fast ?? false,
    contextTier,
  })
  if (variantConfig) config.variants = variantConfig
  if (contextTier !== "base" || options.fast) {
    const defaultVariant = findDefaultVariant(mi, variants, contextTier !== "base") ?? variants[0]
    if (defaultVariant) {
      config.options = {
        [CURSOR_WIRE_MODEL_ID_KEY]: mi.id,
        [CURSOR_VARIANT_PARAMETERS_KEY]: defaultVariant.parameterValues.map((p) => ({ ...p })),
      }
    }
  }
  return config
}

type CatalogSpeedGroup = {
  fast: boolean
  variants: ModelVariant[]
}

function speedGroups(variants: ModelVariant[], splitFast: boolean): CatalogSpeedGroup[] {
  if (!splitFast) return variants.length > 0 ? [{ fast: false, variants }] : []
  const slow = variants.filter((variant) => !isFastVariant(variant))
  const fast = variants.filter((variant) => isFastVariant(variant))
  const groups: CatalogSpeedGroup[] = []
  if (slow.length > 0) groups.push({ fast: false, variants: slow })
  if (fast.length > 0) groups.push({ fast: true, variants: fast })
  return groups
}

function uniqueCatalogId(usedIds: Set<string>, modelId: string, suffix: string): string {
  let id = `${modelId}${suffix}`
  if (!usedIds.has(id)) {
    usedIds.add(id)
    return id
  }
  let n = 2
  while (true) {
    const candidate = suffix !== "-fast" && suffix.endsWith("-fast")
      ? `${modelId}${suffix.slice(0, -5)}-${n}-fast`
      : `${modelId}${suffix}-${n}`
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate)
      return candidate
    }
    n++
  }
}

export function modelsToConfig(models: ModelInfo[]): Record<string, any> {
  const ambiguous = thinkingSuffixBaseNames(models)
  const out: Record<string, any> = {}
  const usedIds = new Set(models.map((m) => m.id))
  for (const m of models) {
    const thinkingSuffix = !!m.supportsThinking && ambiguous.has(baseName(m))
    const splitFast = hasCursorFastPricing(m.id)
    const groups: Array<{
      contextTier: ContextTier
      fast: boolean
      variants: ModelVariant[]
      advertisedVariants: ModelVariant[]
      suffix: string
    }> = []
    const extraContexts = new Set(m.variants
      .filter((v) => isSeparateContext(m, v) && !isLongContextVariant(v))
      .map(variantContext)
      .filter((context): context is number => context !== undefined))
    const tiers: ContextTier[] = ["base", "long", ...extraContexts]
    for (const contextTier of tiers) {
      const tierSuffix = contextTier === "base" ? ""
        : contextTier === "long" ? "-1m" : `-${contextSuffix(contextTier)}`
      const suffixFor = (fast: boolean) => `${tierSuffix}${fast ? "-fast" : ""}`
      const tierVariants = new Set(variantsForTier(m, contextTier))
      // Base/Fast ids and labels are persisted by the host. Keep their pre-split
      // non-1M variants available while dedicated entries supply accurate limits.
      const advertised = contextTier === "base"
        ? m.variants.filter((variant) => !isLongContextVariant(variant))
        : [...tierVariants]
      for (const group of speedGroups(advertised, splitFast)) {
        const tierGroup = group.variants.filter((variant) => tierVariants.has(variant))
        groups.push({
          contextTier,
          fast: group.fast,
          variants: tierGroup.length > 0 ? tierGroup : group.variants,
          advertisedVariants: group.variants,
          suffix: suffixFor(group.fast),
        })
      }
    }
    if (groups.length === 0) {
      out[m.id] = applyCursorModelCost(
        m.id,
        modelInfoToConfig(m, { thinkingSuffix, contextTier: "base" }),
      )
      continue
    }

    const primaryIndex = groups.findIndex((group) => group.suffix === "")
    const primary = primaryIndex >= 0 ? primaryIndex : 0
    for (const [index, group] of groups.entries()) {
      const catalogId = index === primary
        ? m.id
        : uniqueCatalogId(usedIds, m.id, group.suffix || "-fast")
      const pricingId = group.fast ? `${m.id}-fast` : (group.contextTier === "long" ? `${m.id}-1m` : m.id)
      const config = modelInfoToConfig(m, {
        thinkingSuffix,
        contextTier: group.contextTier,
        variants: group.variants,
        advertisedVariants: group.advertisedVariants,
        fast: group.fast,
      })
      config.variants = modelInfoVariants(m, group.advertisedVariants, {
        name: config.name,
        fast: group.fast,
        contextTier: group.contextTier,
      })
      out[catalogId] = applyCursorModelCost(pricingId, config)
    }
  }
  return out
}
