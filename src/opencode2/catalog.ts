import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
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

const PACKAGE_NAME = "cursor-opencode-provider"

/** The published package, which the host installs from the registry. */
export const CURSOR_AISDK_REGISTRY_PACKAGE = `aisdk:${PACKAGE_NAME}`

type PackageManifest = {
  name?: unknown
  main?: unknown
  exports?: unknown
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Recognize the simple root ESM declarations used by local builds. */
function declaredRootEntry(manifest: PackageManifest): string | undefined {
  const exported = manifest.exports
  if (exported === undefined) return typeof manifest.main === "string" ? manifest.main : undefined
  let root: unknown = exported
  if (isPlainRecord(exported)) {
    const keys = Object.keys(exported)
    if (keys.some((key) => key.startsWith("."))) {
      if (!keys.every((key) => key.startsWith("./") || key === ".")) return undefined
      root = exported["."]
    }
  }
  if (typeof root === "string") return root.startsWith("./") ? root : undefined
  if (!isPlainRecord(root)) return undefined
  // The first applicable condition wins. A runtime-specific condition ahead
  // of import/default makes the entry ambiguous for this structural check.
  for (const [condition, target] of Object.entries(root)) {
    if (condition === "types" || condition === "require") continue
    if (condition !== "import" && condition !== "default") return undefined
    return typeof target === "string" && target.startsWith("./") ? target : undefined
  }
  return undefined
}

function nearestManifest(directory: string): string | undefined {
  for (let current = directory; ; current = path.dirname(current)) {
    const candidate = path.join(current, "package.json")
    if (existsSync(candidate)) return candidate
    if (path.dirname(current) === current) return undefined
  }
}

/**
 * The built package entry beside this module, when it is a local build of this
 * package. Both modules must resolve into the same package's dist tree, and
 * the package manifest must declare dist/index.js as its root entry.
 */
function verifiedLocalEntry(moduleUrl: string): string | undefined {
  try {
    if (!moduleUrl.startsWith("file:")) return undefined
    const modulePath = realpathSync(fileURLToPath(moduleUrl))
    if (modulePath.split(path.sep).includes("node_modules")) return undefined
    const moduleDirectory = path.dirname(modulePath)
    const manifestPath = nearestManifest(moduleDirectory)
    if (!manifestPath) return undefined
    const packageDirectory = path.dirname(manifestPath)
    if (path.relative(packageDirectory, moduleDirectory) !== path.join("dist", "opencode2")) return undefined
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest
    if (manifest.name !== PACKAGE_NAME) return undefined
    const declared = declaredRootEntry(manifest)
    const entry = path.join(packageDirectory, "dist", "index.js")
    if (!declared || path.resolve(packageDirectory, declared) !== entry) return undefined
    return realpathSync(entry) === entry && statSync(entry).isFile() ? entry : undefined
  } catch {
    // A missing, unreadable or malformed layout cannot be verified.
    return undefined
  }
}

/**
 * The AI SDK package published in the provider inventory.
 *
 * `aisdk:` selects OpenCode 2.x's AI SDK path, which surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. When our `sdk` hook does not claim the event, the host's own loader
 * resolves this package instead: it imports an `aisdk:file://…` entry directly
 * and installs any other name from the registry into its cache.
 *
 * In priority order:
 * 1. `CURSOR_OPENCODE2_DEV_ENTRY`, an explicit entry file (e.g. `dist/index.js`).
 * 2. `CURSOR_OPENCODE2_USE_LOCAL_DIST=0` selects the published package.
 * 3. A verified local build's own `dist/index.js` (`verifiedLocalEntry`), so a
 *    fallback runs the same build as the plugin rather than the published one.
 * 4. The published package: registry installs, source runs, and missing or
 *    unverified local entries.
 */
export function resolveAiSdkPackageSpec(
  moduleUrl: string = import.meta.url,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const devEntry = env.CURSOR_OPENCODE2_DEV_ENTRY
  if (devEntry) return `aisdk:${pathToFileURL(devEntry).href}`
  if (env.CURSOR_OPENCODE2_USE_LOCAL_DIST?.trim() === "0") return CURSOR_AISDK_REGISTRY_PACKAGE
  const entry = verifiedLocalEntry(moduleUrl)
  return entry ? `aisdk:${pathToFileURL(entry).href}` : CURSOR_AISDK_REGISTRY_PACKAGE
}

/** Resolved once per module copy, from the environment the host started with. */
export const CURSOR_AISDK_PACKAGE = resolveAiSdkPackageSpec()

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
