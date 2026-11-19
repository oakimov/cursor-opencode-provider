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
import { contextSuffix, modelsToConfig, RESERVED_VARIANT_KEY } from "../model-config.js"
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

function shortEffortId(params: ModelParameterValue[]): string | undefined {
  const efforts = new Set(params.filter(({ id }) => isEffortParameter(id)).map(({ value }) => {
    const effort = value.trim().toLowerCase()
    return effort === "extra-high" || effort === "extra high" ? "xhigh" : effort
  }))
  // Several effort fields can agree, but their order must never pick a winner.
  if (efforts.size !== 1) return undefined
  const [effort] = efforts
  return effort && effort !== RESERVED_VARIANT_KEY && /^[a-z][a-z0-9]*$/.test(effort)
    ? effort
    : undefined
}

/** Map unambiguous short IDs to the existing visible labels. */
export function shortVariantAliases(
  variants: readonly ModelVariantInfo[],
  baseContext: number,
): Map<string, string> {
  const parameters = variants.map(({ settings }) => {
    const parsed = normalizeModelParameterValues(settings?.[CURSOR_VARIANT_PARAMETERS_KEY])
    return parsed ?? []
  })
  // An omitted context leaves the choice on the entry's own tier.
  const contextOf = (params: ModelParameterValue[]) => parseCursorContextLimit(
    params.find((parameter) => parameter.id === "context")?.value,
  ) ?? baseContext
  const isFast = (params: ModelParameterValue[]) =>
    params.find((parameter) => parameter.id === "fast")?.value === "true"
  // A tier/speed suffix only disambiguates something the entry actually mixes.
  const contexts = parameters.map(contextOf)
  const tiers = new Set(contexts)
  const speeds = parameters.map(isFast)
  const spansSpeeds = speeds.includes(true) && speeds.includes(false)
  const spansTiers = tiers.size > 1

  const shortIds = parameters.map((params, index) => {
    const effortId = shortEffortId(params)
    if (!effortId) return undefined
    const context = contexts[index]!
    const contextToken = spansTiers && context !== baseContext ? `-${contextSuffix(context)}` : ""
    const fastToken = speeds[index] && spansSpeeds ? "-fast" : ""
    return `${effortId}${contextToken}${fastToken}`
  })

  const counts = new Map<string, number>()
  for (const id of shortIds) if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  const taken = new Set(variants.map(({ id }) => id))
  const aliases = new Map<string, string>()
  for (const [index, id] of shortIds.entries()) {
    if (!id || counts.get(id) !== 1 || taken.has(id)) continue
    aliases.set(id, variants[index]!.id)
  }
  return aliases
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

  const context = entry.limit?.context ?? 200_000
  const variants = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([id, settings]) => ({ id, settings: { ...settings } }))

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
      context,
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
  const out: Record<string, CatalogModelInfo> = Object.create(null)
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
