export const CURSOR_API_HOST = "api2.cursor.sh"
export const CURSOR_WEBSITE_HOST = "cursor.com"
/**
 * Production OAuth client id Cursor's IDE sends on `POST /oauth/token`
 * (Cursor 3.17.19 `workbench.desktop.main.js`, `cursorCreds.authClientId` for
 * `backendUrl` `https://api2.cursor.sh`). The IDE's non-production id is not
 * used: a custom `CURSOR_API_BASE_URL` keeps this one.
 */
export const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"
export const FALLBACK_CLIENT_VERSION = "cli-2026.07.09-a3815c0"
export const CURSOR_PROVIDER_ID = "cursor"
/** Private provider option injected by the OpenCode plugin for summary turns. */
export const CURSOR_COMPACTION_OPTION = "opencodeCompaction"
/** OpenCode host rebuilt its history without a provider compaction turn. */
export const CURSOR_HISTORY_REWRITE_OPTION = "opencodeHistoryRewrite"
/** Current OpenCode primary agent; used to invalidate incompatible checkpoints. */
export const CURSOR_HOST_AGENT_OPTION = "opencodeHostAgent"
/**
 * The session's last `edit` rule on `*` is deny. Set by the plugin from the
 * session payload; false when no global edit deny applies, absent without a read.
 */
export const CURSOR_SESSION_EDITS_DENIED_OPTION = "opencodeSessionEditsDenied"
/** A session lookup failed twice; planning approval must fail closed, ordinary requests may proceed. */
export const CURSOR_SESSION_PERMISSIONS_UNAVAILABLE_OPTION = "opencodeSessionPermissionsUnavailable"
export const TOKEN_EXPIRY_THRESHOLD_S = 300

export const RUN_PATH = "/agent.v1.AgentService/Run"
export const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels"
export const SERVER_CONFIG_PATH = "/aiserver.v1.ServerConfigService/GetServerConfig"

export const MODEL_CACHE_FILE = "cursor-models.json"
/** Bumped when the on-disk model cache shape/semantics change (forces refetch). */
export const MODEL_CACHE_SCHEMA_VERSION = 6
export const MODEL_CACHE_TTL_MS = 86_400_000
export const CONVERSATION_CACHE_DIR = "cursor-conversations"
export const CONVERSATION_CACHE_SCHEMA_VERSION = 4
/** Default retention for a persisted conversation snapshot (24 h). */
export const CONVERSATION_CACHE_TTL_MS = 86_400_000
/**
 * Operator override for snapshot retention. Snapshots older than this are
 * treated as expired, so a longer value keeps a conversation warm across a
 * longer break; abandoned `.tmp` files still expire on the fixed 24 h window
 * so disk use cannot grow with it.
 */
export const CONVERSATION_CACHE_TTL_ENV = "CURSOR_PROVIDER_CACHE_TTL_MS"

/**
 * Snapshot retention in milliseconds: `CONVERSATION_CACHE_TTL_ENV` when it
 * holds a positive safe integer, else the 24 h default. Anything else (empty,
 * non-numeric, zero, negative, unsafe) falls back rather than disabling
 * retention, and a leading `+`/space or float is not a valid integer.
 */
export function resolveConversationCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CONVERSATION_CACHE_TTL_ENV]?.trim()
  if (!raw || !/^\d+$/.test(raw)) return CONVERSATION_CACHE_TTL_MS
  const parsed = Number(raw)
  return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : CONVERSATION_CACHE_TTL_MS
}
export const VERSION_CACHE_FILE = "cursor-client-version.json"

export const CONTENT_TYPE_CONNECT_PROTO = "application/connect+proto"
export const CONNECT_PROTOCOL_VERSION = "1"

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"
export type ContextOption = "200k" | "272k" | "300k" | "1m"
