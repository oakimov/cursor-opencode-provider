import { MODEL_CACHE_FILE, MODEL_CACHE_SCHEMA_VERSION, MODEL_CACHE_TTL_MS } from "./shared.js"
import { unaryAvailableModels } from "./transport/connect.js"
import { buildRequestedModelParams } from "./protocol/thinking.js"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

// ── Types ──

export type ModelParameterValue = { id: string; value: string }

/** Dedicated OpenCode provider-option key for a selected Cursor variant. */
export const CURSOR_VARIANT_PARAMETERS_KEY = "cursorVariantParameters"
/** Real Cursor model id used when an OpenCode entry has a synthetic id. */
export const CURSOR_WIRE_MODEL_ID_KEY = "cursorModelId"

export type ModelVariant = {
  key: string
  parameterValues: ModelParameterValue[]
  displayName: string
  isDefaultNonMax: boolean
  isDefaultMax: boolean
}

export type ModelInfo = {
  id: string
  displayName?: string
  family?: string
  supportsThinking?: boolean
  supportsAgent?: boolean
  maxContext?: number
  /** Context window when max-mode is on (proto field 16). */
  maxContextForMaxMode?: number
  supportsMaxMode?: boolean
  variants: ModelVariant[]
}

export type ModelCache = {
  models: ModelInfo[]
  fetchedAt: number
  /** Absent or mismatched → treat cache as stale (forces AvailableModels refetch). */
  schemaVersion?: number
}

export class CursorVariantSelectionError extends Error {
  constructor(message: string) {
    super(`Cursor variant selection ${message}`)
    this.name = "CursorVariantSelectionError"
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function optionalString(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined | null {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue
    if (record[name] === undefined) return undefined
    return typeof record[name] === "string" ? record[name] : null
  }
  return undefined
}

function optionalBoolean(
  record: Record<string, unknown>,
  names: readonly string[],
): boolean | undefined | null {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue
    if (record[name] === undefined) return undefined
    return typeof record[name] === "boolean" ? record[name] : null
  }
  return undefined
}

function optionalPositiveNumber(
  record: Record<string, unknown>,
  names: readonly string[],
): number | undefined | null {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue
    const value = record[name]
    if (value === undefined) return undefined
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null
  }
  return undefined
}

export function normalizeModelParameterValues(value: unknown): ModelParameterValue[] | null {
  if (!Array.isArray(value)) return null
  const parameters: ModelParameterValue[] = []
  for (const parameter of value) {
    if (!isPlainRecord(parameter)) return null
    if (!isNonEmptyString(parameter.id) || typeof parameter.value !== "string") return null
    parameters.push({ id: parameter.id, value: parameter.value })
  }
  return parameters
}

function normalizeVariant(value: unknown, fallbackName: string): ModelVariant | null {
  if (!isPlainRecord(value)) return null
  const parameters = normalizeModelParameterValues(
    value.parameterValues ?? value.parameter_values ?? [],
  )
  if (!parameters) return null
  const key = optionalString(value, ["key"])
  const displayName = optionalString(value, ["displayName", "display_name"])
  const isDefaultNonMax = optionalBoolean(
    value,
    ["isDefaultNonMax", "isDefaultNonMaxConfig", "is_default_non_max_config"],
  )
  const isDefaultMax = optionalBoolean(
    value,
    ["isDefaultMax", "isDefaultMaxConfig", "is_default_max_config"],
  )
  if (
    key === null ||
    displayName === null ||
    isDefaultNonMax === null ||
    isDefaultMax === null
  ) {
    return null
  }
  if (
    (key !== undefined && !isNonEmptyString(key)) ||
    (displayName !== undefined && !isNonEmptyString(displayName))
  ) {
    return null
  }
  return {
    key: key ?? fallbackName,
    displayName: displayName ?? fallbackName,
    parameterValues: parameters,
    isDefaultNonMax: isDefaultNonMax ?? false,
    isDefaultMax: isDefaultMax ?? false,
  }
}

function normalizeModelInfo(value: unknown): ModelInfo | null {
  if (!isPlainRecord(value) || !isNonEmptyString(value.id)) return null
  const rawVariants = value.variants ?? []
  if (!Array.isArray(rawVariants)) return null
  const variants = rawVariants.map((variant) => normalizeVariant(variant, value.id as string))
  if (variants.some((variant) => variant === null)) return null

  const displayName = optionalString(value, ["displayName", "display_name"])
  const family = optionalString(value, ["family"])
  const supportsThinking = optionalBoolean(value, ["supportsThinking", "supports_thinking"])
  const supportsAgent = optionalBoolean(value, ["supportsAgent", "supports_agent"])
  const supportsMaxMode = optionalBoolean(value, ["supportsMaxMode", "supports_max_mode"])
  const maxContext = optionalPositiveNumber(
    value,
    ["maxContext", "contextTokenLimit", "context_token_limit"],
  )
  const maxContextForMaxMode = optionalPositiveNumber(
    value,
    ["maxContextForMaxMode", "contextTokenLimitForMaxMode", "context_token_limit_for_max_mode"],
  )
  if (
    displayName === null ||
    family === null ||
    supportsThinking === null ||
    supportsAgent === null ||
    supportsMaxMode === null ||
    maxContext === null ||
    maxContextForMaxMode === null
  ) {
    return null
  }
  return {
    id: value.id,
    ...(displayName === undefined ? {} : { displayName }),
    ...(family === undefined ? {} : { family }),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(supportsAgent === undefined ? {} : { supportsAgent }),
    ...(maxContext === undefined ? {} : { maxContext }),
    ...(maxContextForMaxMode === undefined ? {} : { maxContextForMaxMode }),
    ...(supportsMaxMode === undefined ? {} : { supportsMaxMode }),
    variants: variants as ModelVariant[],
  }
}

export function normalizeModelCache(value: unknown): ModelCache | null {
  if (!isPlainRecord(value) || !Array.isArray(value.models)) return null
  if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return null
  if (
    value.schemaVersion !== undefined &&
    (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 0)
  ) {
    return null
  }
  const models = value.models.map(normalizeModelInfo)
  if (models.some((model) => model === null)) return null
  return {
    models: models as ModelInfo[],
    fetchedAt: value.fetchedAt,
    ...(value.schemaVersion === undefined
      ? {}
      : { schemaVersion: value.schemaVersion as number }),
  }
}

/**
 * Read only the dedicated variant payload generated by the plugin. OpenCode
 * merges model, agent, and variant options into one providerOptions namespace;
 * treating that whole object as Cursor parameters would leak unrelated options
 * onto the wire.
 */
export function extractCursorVariantParameters(
  providerOptions: Record<string, unknown> | undefined,
): ModelParameterValue[] | undefined {
  if (!providerOptions || !Object.hasOwn(providerOptions, CURSOR_VARIANT_PARAMETERS_KEY)) {
    return undefined
  }
  const params = normalizeModelParameterValues(
    providerOptions[CURSOR_VARIANT_PARAMETERS_KEY],
  )
  if (!params) {
    throw new CursorVariantSelectionError(
      "is malformed: cursorVariantParameters must be a parameter array",
    )
  }
  return params
}

export function resolveCursorWireModelId(
  providerOptions: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const value = providerOptions?.[CURSOR_WIRE_MODEL_ID_KEY]
  return typeof value === "string" && value.trim() ? value : fallback
}

/** True when resolved params select the long-context (1m) tier. */
export function paramsImplyMaxMode(params: ModelParameterValue[]): boolean {
  return params.some(
    (parameter) =>
      parameter.id === "context" &&
      parseCursorContextLimit(parameter.value) === 1_000_000,
  )
}

// Cursor encodes a model's context window as a variant parameter `id: "context"`
// whose value is a tier string — the same 200k / 272k / 300k / 1m the IDE's
// picker shows. The base tier rides on the default non-max variant; the 1M
// tier (when the model supports max mode) rides on the default max variant.
// `context_token_limit` (#15) / `context_token_limit_for_max_mode` (#16) are
// also defined on AvailableModel but the server often leaves them empty — the
// variant param is the primary source (request flags may still populate them).
export function parseCursorContextLimit(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(text)
  if (match) {
    const multiplier = match[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000
    const limit = Number(match[1]) * multiplier
    return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
  }
  const numeric = Number(text)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

function variantContextTokens(v: ModelVariant | undefined): number | undefined {
  const raw = v?.parameterValues.find((p) => p.id === "context")?.value
  return parseCursorContextLimit(raw)
}

function isLongContextVariant(v: ModelVariant): boolean {
  return variantContextTokens(v) === 1_000_000
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

// ── Cache helpers ──

export function isCacheFresh(cache: ModelCache, ttlMs = MODEL_CACHE_TTL_MS): boolean {
  if (cache.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION) return false
  return Date.now() - cache.fetchedAt < ttlMs
}

export function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, MODEL_CACHE_FILE)
}

export async function readCache(cacheDir: string): Promise<ModelCache | null> {
  const filePath = cacheFilePath(cacheDir)
  try {
    const data = await readFile(filePath, "utf-8")
    return normalizeModelCache(JSON.parse(data))
  } catch {
    return null
  }
}

export async function writeCache(cacheDir: string, cache: ModelCache): Promise<void> {
  const normalized = normalizeModelCache(cache)
  if (!normalized) throw new Error("Refusing to write an invalid Cursor model cache")
  const filePath = cacheFilePath(cacheDir)
  const directory = path.dirname(filePath)
  const tempPath = path.join(
    directory,
    `.${MODEL_CACHE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf-8")
    await rename(tempPath, filePath)
  } finally {
    await unlink(tempPath).catch(() => {})
  }
}

// ── Map live API response to ModelInfo[] ──

function apiBoolean(record: Record<string, unknown>, names: readonly string[]): boolean {
  const value = optionalBoolean(record, names)
  if (value === null) throw new Error(`AvailableModels returned a non-boolean ${names[0]}`)
  return value ?? false
}

export function mapAvailableModelsResponse(
  raw: Record<string, unknown>,
): ModelInfo[] {
  const entries = (raw as { models?: unknown[] }).models ?? []
  const models: ModelInfo[] = []

  for (const entry of entries) {
    if (!isPlainRecord(entry)) continue
    const e = entry
    const name = e.name as string | undefined
    if (!isNonEmptyString(name)) continue

    const variants: ModelVariant[] = []
    const rawVariants = e.variants ?? []
    if (!Array.isArray(rawVariants)) {
      throw new Error(`AvailableModels returned invalid variants for ${name}`)
    }
    for (const v of rawVariants) {
      if (!isPlainRecord(v)) {
        throw new Error(`AvailableModels returned an invalid variant for ${name}`)
      }
      const rawParams = (v.parameterValues ?? v.parameter_values ?? []) as Record<string, unknown>[]
      const parameterValues = normalizeModelParameterValues(rawParams)
      if (!parameterValues) {
        throw new Error(`AvailableModels returned invalid parameter values for ${name}`)
      }
      variants.push({
        key: name,
        parameterValues,
        displayName: (v.displayName ?? v.display_name ?? name) as string,
        isDefaultNonMax: apiBoolean(v, ["isDefaultNonMaxConfig", "is_default_non_max_config"]),
        isDefaultMax: apiBoolean(v, ["isDefaultMaxConfig", "is_default_max_config"]),
      })
    }

    // Derive the context window from the variant `context` param (primary
    // source). Base tier ← default non-max variant; max tier ← default max
    // variant. Fall back to the (often empty) proto fields, then undefined.
    // Prefer a non-1m context when isDefaultNonMax is missing so a leading
    // max-mode variant cannot inflate the base window.
    const variantBaseContext =
      variantContextTokens(variants.find((v) => v.isDefaultNonMax)) ??
      variantContextTokens(
        variants.find((v) =>
          variantContextTokens(v) !== 1_000_000,
        ),
      ) ??
      variantContextTokens(variants.find((v) => v.parameterValues.some((p) => p.id === "context")))
    const variantMaxContext = variantContextTokens(variants.find((v) => v.isDefaultMax))

    models.push({
      id: name,
      displayName: (e.clientDisplayName ?? e.client_display_name ?? name) as string,
      supportsThinking: apiBoolean(e, ["supportsThinking", "supports_thinking"]),
      supportsAgent: apiBoolean(e, ["supportsAgent", "supports_agent"]),
      maxContext: variantBaseContext ?? positiveNumber(e.contextTokenLimit ?? e.context_token_limit),
      maxContextForMaxMode:
        variantMaxContext ??
        positiveNumber(e.contextTokenLimitForMaxMode ?? e.context_token_limit_for_max_mode),
      supportsMaxMode: apiBoolean(e, ["supportsMaxMode", "supports_max_mode"]),
      variants,
    })
  }

  return models
}

// ── Variant resolution ──

/**
 * Resolve the parameter values to send in `requested_model.parameters` for a
 * given model + the variant opencode selected. Each variant already carries
 * the full `{id,value}` set (per-model vocabulary — effort, fast, thinking,
 * context, …), so we pick the matching variant and return its parameters
 * verbatim — the client never constructs these by hand.
 *
 * `picked` is the user-selected variant paramMap (opencode sends it under
 * `providerOptions.cursor`); when present it wins over effort/maxMode hints
 * so every param the user chose (context, fast, …) is forwarded to Cursor.
 * Hints (`reasoningEffort`, `maxMode`) live beside the dedicated picked array,
 * so the picked values are already isolated and can be matched verbatim.
 */
export function resolveVariantParameters(
  model: ModelInfo | undefined,
  opts: {
    reasoningEffort?: string
    maxMode?: boolean
    picked?: ModelParameterValue[]
  } = {},
): ModelParameterValue[] {
  const picked = opts.picked?.map((p) => ({ ...p }))

  if (!model || model.variants.length === 0) {
    if (picked !== undefined) {
      throw new CursorVariantSelectionError(
        `is stale: model ${JSON.stringify(model?.id ?? "unknown")} has no cached variants`,
      )
    }
    return opts.reasoningEffort ? [{ id: "effort", value: opts.reasoningEffort }] : []
  }

  const effortOf = (v: ModelVariant): string | undefined =>
    v.parameterValues.find((p) => p.id === "effort" || p.id === "reasoning")?.value
  const isFast = (v: ModelVariant): boolean =>
    v.parameterValues.find((p) => p.id === "fast")?.value === "true"
  const isMaxVariant = (v: ModelVariant): boolean =>
    v.isDefaultMax || isLongContextVariant(v)

  const wantMax = opts.maxMode ?? false
  // Non-fast pool for hint-based resolution only. Exact `picked` matching
  // searches all variants so Fast selections are not silently dropped.
  const pool = model.variants.filter((v) => !isFast(v))
  const scoped = pool.length > 0 ? pool : model.variants

  // 1. Variant explicitly picked by opencode (verbatim — preserves context, fast, …).
  if (picked !== undefined) {
    const pickedById = new Map(picked.map((parameter) => [parameter.id, parameter.value]))
    const exact = model.variants.find(
      (v) =>
        v.parameterValues.length === picked.length &&
        pickedById.size === picked.length &&
        v.parameterValues.every((parameter) => pickedById.get(parameter.id) === parameter.value),
    )
    if (exact) {
      return buildRequestedModelParams(exact.parameterValues, {
        reasoningEffort: opts.reasoningEffort,
        maxMode: wantMax,
      })
    }
    throw new CursorVariantSelectionError(
      `is stale for model ${JSON.stringify(model.id)}: its exact parameter tuple is unavailable`,
    )
  }

  // When maxMode is requested, prefer max-tier variants for effort matching
  // so "high + max" lands on 1m high rather than the first 300k high.
  const maxScoped = wantMax ? scoped.filter(isMaxVariant) : []
  const effortPool = maxScoped.length > 0 ? maxScoped : scoped

  // 2. Effort hint (e.g. user passed reasoningEffort through the CLI).
  if (opts.reasoningEffort) {
    const match = effortPool.find((v) => effortOf(v) === opts.reasoningEffort)
    if (match) {
      return buildRequestedModelParams(match.parameterValues, {
        reasoningEffort: opts.reasoningEffort,
        maxMode: wantMax,
      })
    }
  }

  // 3. Max-mode hint → prefer the default max variant (1m context).
  if (wantMax) {
    const max = scoped.find((v) => v.isDefaultMax) ?? scoped.find(isLongContextVariant)
    if (max) return buildRequestedModelParams(max.parameterValues, { maxMode: true })
  }

  // 4. Default non-max variant.
  const byDefault = scoped.find((v) => v.isDefaultNonMax) ?? scoped[0]
  return buildRequestedModelParams(byDefault.parameterValues, {
    reasoningEffort: opts.reasoningEffort,
    maxMode: false,
  })
}

// ── Fetch + cache orchestration ──

export async function fetchModels(
  token: string,
  options: { baseURL?: string; headers?: Record<string, string> } = {},
): Promise<ModelInfo[]> {
  const raw = await unaryAvailableModels(token, options)
  return mapAvailableModelsResponse(raw)
}

const refreshesByDirectory = new Map<string, Promise<ModelInfo[]>>()

export async function refreshModelCache(
  cacheDir: string,
  fetcher: () => Promise<ModelInfo[]>,
): Promise<ModelInfo[]> {
  const key = path.resolve(cacheDir)
  const existing = refreshesByDirectory.get(key)
  if (existing) return existing
  const refresh = (async () => {
    const models = await fetcher()
    await writeCache(cacheDir, {
      models,
      fetchedAt: Date.now(),
      schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    })
    return models
  })()
  refreshesByDirectory.set(key, refresh)
  try {
    return await refresh
  } finally {
    if (refreshesByDirectory.get(key) === refresh) refreshesByDirectory.delete(key)
  }
}

export async function discoverModels(
  token: string,
  cacheDir: string,
  options: { baseURL?: string; headers?: Record<string, string> } = {},
): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  const refresh = () =>
    refreshModelCache(cacheDir, () => fetchModels(token, options))

  // Cache is fresh → return it; refresh in background
  if (cached && isCacheFresh(cached)) {
    // Background refresh (fire and forget)
    void refresh()
      .catch(() => {
        /* background refresh failure is non-fatal */
      })
    return cached.models
  }

  // Cache exists but expired → try fetch, serve stale on failure
  if (cached) {
    try {
      return await refresh()
    } catch {
      return cached.models
    }
  }

  // No cache → must fetch
  return refresh()
}
