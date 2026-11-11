import { pathToFileURL } from "node:url"
import { CURSOR_PROVIDER_ID } from "../shared.js"
import {
  CURSOR_VARIANT_PARAMETERS_KEY,
  CURSOR_WIRE_MODEL_ID_KEY,
  isEffortParameter,
  normalizeModelParameterValues,
  parseCursorContextLimit,
  type ModelInfo,
  type ModelParameterValue,
} from "../models.js"
import { contextSuffix, modelsToConfig } from "../model-config.js"
import { toOpenCode2Costs, type OpenCode2ModelCost, type OpenCodeModelCost } from "../pricing.js"
import type { ConnectionInfo, ModelVariantInfo, ProviderEditor } from "./types.js"

/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for the classic plugin's `config` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT reimplemented
 * here: we run the shared `modelsToConfig` and translate its output into the 2.0
 * `Model.Info` shape, so every surface exposes an identical model list.
 */

/** Integration id owning Cursor credentials. Matches the provider id. */
export const CURSOR_INTEGRATION_ID = CURSOR_PROVIDER_ID

/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. The suffix is this package's npm name so the host's built-in
 * fallback can still resolve it if our own hook is ever bypassed — that
 * fallback runs `npm.add(pkg)` against the *published* registry into
 * `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring any local
 * `file://` plugin path this process was loaded from.
 *
 * `CURSOR_OPENCODE2_DEV_ENTRY` overrides the suffix with an `aisdk:file://…`
 * spec instead, pointed at a local built entry file (e.g. `dist/index.js`,
 * which exports `createCursor`). The host's fallback recognizes `file://`
 * specs and imports them directly, skipping `npm.add` — the only way to
 * exercise a local build through that fallback path short of publishing.
 * Unset in production; only meant for local `opencode2 run` testing.
 */
export const CURSOR_AISDK_PACKAGE = process.env.CURSOR_OPENCODE2_DEV_ENTRY
  ? `aisdk:${pathToFileURL(process.env.CURSOR_OPENCODE2_DEV_ENTRY).href}`
  : "aisdk:cursor-opencode-provider"

/**
 * Plain-object `Model.Info` equivalent used by `ctx.provider.transform`.
 */
export type CatalogModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
  }
  limit: {
    context: number
    output: number
  }
  variants: ModelVariantInfo[]
  status: "active"
  enabled: true
  time: { released: number }
  cost: OpenCode2ModelCost[]
  settings?: Record<string, unknown>
}

/**
 * Context token for a short variant id. Only an entry that spans tiers needs
 * one: the bare id is the base tier (the implicit tier when any variant omits
 * `context`, else the smallest advertised one). A single-tier entry names its
 * tier in the catalog id (`-500k`, `-1m`) and adds no token here.
 */
function contextTierToken(
  context: number | undefined,
  baseContext: number | undefined,
  spansTiers: boolean,
): string {
  if (!spansTiers || context === undefined || context === baseContext) return ""
  return `-${contextSuffix(context)}`
}

/**
 * Short, lowercase variant ids (`high`, `max`, `high-fast`) that OpenCode 2
 * users type as `model#variant`, next to Cursor's display-label ids (`High`,
 * `Max`, `High Fast`).
 *
 * OpenCode 2 matches a variant id exactly, and Cursor's display deltas are
 * capitalized, so `cursor/deepseek-v41-flash-1017#max` misses `Max` and fails
 * the prompt with `VariantUnavailableError`. Other 2.x providers expose the
 * lowercase effort names, which is what this adds.
 *
 * Unambiguous ids only. The id is the effort value with a context tier
 * (`-1m`, `-500k`) and/or a speed (`-fast`) suffix, and it is published only
 * when exactly one variant in the entry maps to it. A model that lists both
 * `No Thinking High` and `High` gets no bare `high`: one id cannot pick
 * between two tuples, and silently binding one would change the request.
 *
 * Both ids stay in `model.variants`, so a picker shows `High` and `high` for
 * the same choice. Replacing the display ids instead would break every saved
 * 2.x pick, as #176 did for the pre-delta keys.
 */
function variantInfosWithShortEffortIds(
  entries: Array<[string, Record<string, unknown>]>,
): ModelVariantInfo[] {
  const variants: ModelVariantInfo[] = entries.map(([id, settings]) => ({
    id,
    settings: { ...settings },
  }))
  const parameters = entries.map(([, settings]) => {
    const parsed = normalizeModelParameterValues(settings[CURSOR_VARIANT_PARAMETERS_KEY])
    return parsed ?? []
  })
  const contextOf = (params: ModelParameterValue[]) => parseCursorContextLimit(
    params.find((parameter) => parameter.id === "context")?.value,
  )
  const isFast = (params: ModelParameterValue[]) =>
    params.find((parameter) => parameter.id === "fast")?.value === "true"
  // A tier/speed suffix only disambiguates something the entry actually mixes.
  const contexts = parameters.map(contextOf)
  const tiers = new Set(contexts)
  const hasFast = parameters.some(isFast)
  const hasNonFast = parameters.some((params) => !isFast(params))
  // The bare id belongs to the base tier; only the other tiers are suffixed.
  // An entry with one tier needs no token at all — its catalog id (`-500k`,
  // `-1m`) already names that tier.
  const spansTiers = tiers.size > 1
  const baseContext = tiers.has(undefined)
    ? undefined
    : Math.min(...[...tiers].filter((context): context is number => context !== undefined))

  const shortIds = parameters.map((params) => {
    const effort = params.find((parameter) => isEffortParameter(parameter.id))
    const value = effort?.value.trim().toLowerCase()
    if (!value) return undefined
    // Cursor publishes `xhigh`; `extra-high`/`extra high` are the same level
    // written differently, and a short id must not vary by that spelling.
    const effortId = value === "extra-high" || value === "extra high" ? "xhigh" : value
    if (!/^[a-z][a-z0-9]*$/.test(effortId)) return undefined
    const context = contextOf(params)
    const contextToken = contextTierToken(context, baseContext, spansTiers)
    const fastToken = isFast(params) && hasFast && hasNonFast ? "-fast" : ""
    return `${effortId}${contextToken}${fastToken}`
  })

  const counts = new Map<string, number>()
  for (const id of shortIds) if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  const taken = new Set(entries.map(([id]) => id))
  for (const [index, id] of shortIds.entries()) {
    // Ambiguous (two variants, one id) or already published as a label.
    if (!id || counts.get(id) !== 1 || taken.has(id)) continue
    taken.add(id)
    variants.push({ id, settings: { ...entries[index]![1] } })
  }
  return variants
}

/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
export function modelConfigEntryToInfo(id: string, entry: Record<string, any>): CatalogModelInfo {
  const options = entry.options as Record<string, unknown> | undefined
  // Long-context and Fast entries get synthetic OpenCode ids (`<id>-1m`,
  // `<id>-fast`, `<id>-1m-fast`) while still addressing the same Cursor model
  // on the wire. V1 smuggled that through provider options; 2.0 has a
  // first-class `modelID` for exactly this.
  const wireId =
    typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
      ? (options[CURSOR_WIRE_MODEL_ID_KEY] as string)
      : id

  const variants = variantInfosWithShortEffortIds(
    Object.entries((entry.variants ?? {}) as Record<string, Record<string, unknown>>),
  )

  const inputModalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]
  const outputModalities = Array.isArray(entry.modalities?.output)
    ? entry.modalities.output.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]

  const info: CatalogModelInfo = {
    id,
    modelID: wireId,
    providerID: CURSOR_PROVIDER_ID,
    name: entry.name ?? id,
    capabilities: {
      tools: entry.tool_call !== false,
      input: inputModalities,
      output: outputModalities,
    },
    limit: {
      context: entry.limit?.context ?? 200_000,
      output: entry.limit?.output ?? 8192,
    },
    variants,
    status: "active",
    enabled: true,
    time: { released: 0 },
    cost: toOpenCode2Costs(entry.cost as OpenCodeModelCost | undefined),
  }
  if (typeof entry.family === "string" && entry.family.trim()) info.family = entry.family.trim()
  if (options) info.settings = { ...options }
  return info
}

/** Full model map for the in-memory provider inventory. */
export function modelsToCatalogModelMap(models: ModelInfo[]): Record<string, CatalogModelInfo> {
  const config = modelsToConfig(models)
  const out: Record<string, CatalogModelInfo> = {}
  for (const [id, entry] of Object.entries(config)) {
    out[id] = modelConfigEntryToInfo(id, entry as Record<string, any>)
  }
  return out
}

/**
 * Publish discovered Cursor models into the live provider inventory.
 *
 * Skip while empty (keeps the last successful inventory through a no-op
 * transform on first register), replace the definition with `editor.add`,
 * then `ctx.provider.reload()`.
 */
export function applyCursorProviderInventory(
  editor: ProviderEditor,
  models: ModelInfo[],
  sourceConnection?: ConnectionInfo,
): void {
  if (models.length === 0) return

  editor.add({
    info: {
      id: CURSOR_PROVIDER_ID,
      name: "Cursor",
      activation: "enabled",
      package: CURSOR_AISDK_PACKAGE,
      integrationID: CURSOR_INTEGRATION_ID,
    },
    models: Object.values(modelsToCatalogModelMap(models)),
    ...(sourceConnection ? { sourceConnection } : {}),
  })
}
