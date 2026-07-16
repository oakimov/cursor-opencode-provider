export const CURSOR_API_HOST = "api2.cursor.sh"
export const CURSOR_WEBSITE_HOST = "cursor.com"
export const FALLBACK_CLIENT_VERSION = "cli-2026.07.09-a3815c0"
export const CURSOR_PROVIDER_ID = "cursor"
export const TOKEN_EXPIRY_THRESHOLD_S = 300

export const RUN_PATH = "/agent.v1.AgentService/Run"
export const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels"
export const SERVER_CONFIG_PATH = "/aiserver.v1.ServerConfigService/GetServerConfig"

export const MODEL_CACHE_FILE = "cursor-models.json"
export const MODEL_CACHE_TTL_MS = 86_400_000
export const VERSION_CACHE_FILE = "cursor-client-version.json"

export const CONTENT_TYPE_CONNECT_PROTO = "application/connect+proto"
export const CONNECT_PROTOCOL_VERSION = "1"

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"
export type ContextOption = "200k" | "272k" | "300k" | "1m"
