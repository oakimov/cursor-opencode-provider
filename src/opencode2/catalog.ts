import { pathToFileURL } from "node:url"
import { CURSOR_PROVIDER_ID } from "../shared.js"
import { CURSOR_WIRE_MODEL_ID_KEY, type ModelInfo } from "../models.js"
import { modelsToConfig } from "../model-config.js"
import type { CatalogDraft, ModelVariantInfo } from "./types.js"

/**
 * Catalog registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `config` hook.
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
 * `DynamicProviderPlugin` can still resolve it if our own hook is ever
 * bypassed — that fallback runs `npm.add(pkg)` against the *published*
 * registry into `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring
 * any local `file://` plugin path this process was loaded from.
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

/** Register (or update) the Cursor provider entry. `update` is an upsert. */
export function applyCursorProvider(draft: CatalogDraft): void {
  draft.provider.update(CURSOR_PROVIDER_ID, (provider) => {
    provider.id = CURSOR_PROVIDER_ID
    provider.name = "Cursor"
    provider.package = CURSOR_AISDK_PACKAGE
    // Links the provider to the integration that stores its credentials, so
    // `connection.active(...)` resolves the token the user set up via /connect.
    provider.integrationID = CURSOR_INTEGRATION_ID
  })
}

/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
function applyModelEntry(draft: CatalogDraft, id: string, entry: Record<string, any>): void {
  const options = entry.options as Record<string, unknown> | undefined
  // Long-context entries get a synthetic OpenCode id (`<id>-1m`) while still
  // addressing the same Cursor model on the wire. V1 smuggled that through
  // provider options; 2.0 has a first-class `modelID` for exactly this.
  const wireId =
    typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
      ? (options[CURSOR_WIRE_MODEL_ID_KEY] as string)
      : id

  const variants: ModelVariantInfo[] = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }))

  draft.model.update(CURSOR_PROVIDER_ID, id, (model) => {
    model.id = id
    model.modelID = wireId
    model.providerID = CURSOR_PROVIDER_ID
    model.name = entry.name
    model.capabilities = {
      tools: entry.tool_call !== false,
      // The provider does not convert file/image prompt parts, so text-only is
      // the honest declaration. Revisit alongside Cursor's `supports_images`.
      input: ["text"],
      output: ["text"],
    }
    model.limit = { context: entry.limit.context, output: entry.limit.output }
    model.variants = variants
    model.status = "active"
    model.enabled = true
    model.time = { released: 0 }
    model.cost = []
    // Carries the default variant parameters (and the wire id) through to
    // doStream as provider options, matching the classic plugin.
    if (options) model.settings = { ...options }
  })
}

/** Register every discovered Cursor model. Safe to re-run; `update` upserts. */
export function applyCursorModels(draft: CatalogDraft, models: ModelInfo[]): void {
  const config = modelsToConfig(models)
  for (const [id, entry] of Object.entries(config)) {
    applyModelEntry(draft, id, entry as Record<string, any>)
  }
}
