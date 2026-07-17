import { CURSOR_PROVIDER_ID } from "./shared.js"
import { createCursorLanguageModel } from "./language-model.js"
import { CursorPlugin } from "./plugin.js"
import type { CursorContinuationOptions } from "./session.js"

export type CursorRetryOptions = {
  /** Total attempts including the initial request. Default: 3. */
  maxAttempts?: number
  /** Initial full-jitter backoff ceiling. Default: 500ms. */
  baseDelayMs?: number
  /** Exponential backoff ceiling. Default: 8000ms. */
  maxDelayMs?: number
}

export type CreateCursorOptions = {
  name: string
  accessToken?: string
  apiKey?: string
  /** API base for auth, model discovery, and GetServerConfig. */
  apiBaseURL?: string
  /** Explicit Cursor agent Run host override. */
  agentBaseURL?: string
  /** @deprecated Use agentBaseURL. Kept as the legacy agent Run host override. */
  baseURL?: string
  headers?: Record<string, string>
  /** Opt in to telemetry on the GetServerConfig endpoint lookup. Defaults to false. */
  telemetryEnabled?: boolean
  /** OpenCode project / worktree directory for request_context collectors. */
  workspaceRoot?: string
  /** Held-stream policy. Defaults: heartbeat 5s, semantic idle 120s, tool inactivity 10m. */
  continuation?: CursorContinuationOptions
  /** Fresh-turn retry policy. Defaults: 3 attempts, 500ms base, 8000ms cap. */
  retry?: CursorRetryOptions
}

export function createCursor(options: CreateCursorOptions) {
  const providerId = options.name || CURSOR_PROVIDER_ID
  return {
    languageModel(modelId: string) {
      return createCursorLanguageModel(modelId, providerId, options)
    },
  }
}

export { CursorPlugin }
export type { CursorContinuationOptions, CursorContinuationPolicy } from "./session.js"
export {
  CursorAuthError,
  CursorLocalCancellationError,
  CursorProtocolError,
  CursorProviderError,
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
} from "./errors.js"
export default CursorPlugin

// CursorPluginV2 is NOT re-exported here — see plugin-v2.ts.
// OpenCode's legacy plugin loader (getLegacyPlugins) iterates all exports
// and calls getServerPlugin on each; the v2 define() return is not a
// function, causing "Plugin export is not a function". Load it via
// the separate "cursor-opencode-provider/plugin/v2" export path.
