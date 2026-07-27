import { CURSOR_API_HOST, CURSOR_PROVIDER_ID } from "./shared.js"
import { createCursorLanguageModel } from "./language-model.js"
import type { CreateCursorOptions } from "./index.js"

/**
 * Runtime-agnostic pieces shared by every plugin surface:
 *   • classic Hooks plugin      (`plugin.ts`)
 *   • OpenCode 1.18 v2 plugin   (`plugin-v2.ts`)
 *   • OpenCode 2.0 beta plugin  (`plugin-opencode2.ts`)
 *
 * Nothing here may import a host plugin API — the 1.18 and 2.0 APIs are
 * source-incompatible, so anything host-shaped belongs in the entrypoint.
 */

/** Minimal AI SDK provider surface OpenCode expects from an `aisdk` package. */
export type CursorSdk = {
  languageModel(modelId: string): ReturnType<typeof createCursorLanguageModel>
}

export function createSdk(options: CreateCursorOptions): CursorSdk {
  const providerId = options.name || CURSOR_PROVIDER_ID
  return {
    languageModel(modelId: string) {
      return createCursorLanguageModel(modelId, providerId, options)
    },
  }
}

/**
 * Whether an OpenCode `aisdk` package string refers to this provider.
 *
 * Matches on the provider id first (the common case once the catalog entry is
 * ours), then on the package specifier so a bare `cursor-opencode-provider`,
 * an `aisdk:`-prefixed form, or a resolved `dist/index.js` file URL all hit.
 */
export function isCursorPackage(pkg: string, providerID: string): boolean {
  if (providerID === CURSOR_PROVIDER_ID) return true
  return (
    pkg.includes("cursor-opencode-provider") ||
    /cursor-opencode-provider[/\\]dist[/\\]index\.js/.test(pkg)
  )
}

/** API base for auth, model discovery, and GetServerConfig. */
export function cursorApiBaseURL(): string {
  return process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
}

export function cursorGetServerConfigTelemetryEnabled(): boolean {
  return (
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "1" ||
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "true"
  )
}
