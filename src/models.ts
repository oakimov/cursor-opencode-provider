import { MODEL_CACHE_FILE, MODEL_CACHE_TTL_MS } from "./shared.js"
import { unaryAvailableModels } from "./transport/connect.js"
import { buildRequestedModelParams } from "./protocol/thinking.js"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

// ── Types ──

export type ModelParameterValue = { id: string; value: string }

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
  supportsMaxMode?: boolean
  variants: ModelVariant[]
}

export type ModelCache = {
  models: ModelInfo[]
  fetchedAt: number
}

// ── Cache helpers ──

export function isCacheFresh(cache: ModelCache, ttlMs = MODEL_CACHE_TTL_MS): boolean {
  return Date.now() - cache.fetchedAt < ttlMs
}

export function cacheFilePath(configDir: string): string {
  return path.join(configDir, MODEL_CACHE_FILE)
}

export async function readCache(configDir: string): Promise<ModelCache | null> {
  const filePath = cacheFilePath(configDir)
  try {
    if (!existsSync(filePath)) return null
    const data = await readFile(filePath, "utf-8")
    return JSON.parse(data) as ModelCache
  } catch {
    return null
  }
}

export async function writeCache(configDir: string, cache: ModelCache): Promise<void> {
  const filePath = cacheFilePath(configDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(cache, null, 2), "utf-8")
}

// ── Map live API response to ModelInfo[] ──

export function mapAvailableModelsResponse(
  raw: Record<string, unknown>,
): ModelInfo[] {
  const entries = (raw as { models?: unknown[] }).models ?? []
  const models: ModelInfo[] = []

  for (const entry of entries) {
    const e = entry as Record<string, unknown>
    const name = e.name as string | undefined
    if (!name) continue

    const variants: ModelVariant[] = []
    const rawVariants = (e.variants ?? []) as Record<string, unknown>[]
    for (const v of rawVariants) {
      const rawParams = (v.parameterValues ?? v.parameter_values ?? []) as Record<string, unknown>[]
      const parameterValues: ModelParameterValue[] = rawParams.map((p) => ({
        id: p.id as string,
        value: String(p.value ?? ""),
      }))
      variants.push({
        key: name,
        parameterValues,
        displayName: (v.displayName ?? v.display_name ?? name) as string,
        isDefaultNonMax: !!(v.isDefaultNonMaxConfig ?? v.is_default_non_max_config ?? false),
        isDefaultMax: !!(v.isDefaultMaxConfig ?? v.is_default_max_config ?? false),
      })
    }

    models.push({
      id: name,
      displayName: (e.clientDisplayName ?? e.client_display_name ?? name) as string,
      supportsThinking: !!(e.supportsThinking ?? e.supports_thinking ?? false),
      supportsAgent: !!(e.supportsAgent ?? e.supports_agent ?? false),
      maxContext: (e.contextTokenLimit ?? e.context_token_limit ?? undefined) as number | undefined,
      supportsMaxMode: !!(e.supportsMaxMode ?? e.supports_max_mode ?? false),
      variants,
    })
  }

  return models
}

// ── Variant resolution ──

/**
 * Resolve the parameter values to send in `requested_model.parameters` for a
 * given model + requested reasoning effort. Each variant already carries the
 * full `{id,value}` set (per-model vocabulary), so we pick the matching variant
 * and return its parameters verbatim — the client never constructs these by
 * hand.
 */
export function resolveVariantParameters(
  model: ModelInfo | undefined,
  opts: { reasoningEffort?: string; maxMode?: boolean } = {},
): ModelParameterValue[] {
  if (!model || model.variants.length === 0) {
    // No variant metadata: fall back to a bare effort param if requested.
    return opts.reasoningEffort ? [{ id: "effort", value: opts.reasoningEffort }] : []
  }

  const effortOf = (v: ModelVariant): string | undefined =>
    v.parameterValues.find((p) => p.id === "effort" || p.id === "reasoning")?.value
  const isFast = (v: ModelVariant): boolean =>
    v.parameterValues.find((p) => p.id === "fast")?.value === "true"

  const wantMax = opts.maxMode ?? false
  const candidates = model.variants.filter((v) => !isFast(v))
  const pool = candidates.length > 0 ? candidates : model.variants

  if (opts.reasoningEffort) {
    const match = pool.find((v) => effortOf(v) === opts.reasoningEffort)
    if (match) {
      return buildRequestedModelParams(match.parameterValues, {
        reasoningEffort: opts.reasoningEffort,
        maxMode: wantMax,
      })
    }
  }

  const byDefault = pool.find((v) => (wantMax ? v.isDefaultMax : v.isDefaultNonMax))
  const base = (byDefault ?? pool[0]).parameterValues
  return buildRequestedModelParams(base, {
    reasoningEffort: opts.reasoningEffort,
    maxMode: wantMax,
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

export async function discoverModels(
  token: string,
  configDir: string,
  options: { baseURL?: string; headers?: Record<string, string> } = {},
): Promise<ModelInfo[]> {
  const cached = await readCache(configDir)

  // Cache is fresh → return it; refresh in background
  if (cached && isCacheFresh(cached)) {
    // Background refresh (fire and forget)
    fetchModels(token, options)
      .then((models) =>
        writeCache(configDir, { models, fetchedAt: Date.now() }),
      )
      .catch(() => {
        /* background refresh failure is non-fatal */
      })
    return cached.models
  }

  // Cache exists but expired → try fetch, serve stale on failure
  if (cached) {
    try {
      const models = await fetchModels(token, options)
      const newCache: ModelCache = { models, fetchedAt: Date.now() }
      await writeCache(configDir, newCache)
      return models
    } catch {
      return cached.models
    }
  }

  // No cache → must fetch
  const models = await fetchModels(token, options)
  const newCache: ModelCache = { models, fetchedAt: Date.now() }
  await writeCache(configDir, newCache)
  return models
}
