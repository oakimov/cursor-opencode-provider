import type { Hooks, PluginInput, AuthOAuthResult, Config } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk"
import { CURSOR_PROVIDER_ID, CURSOR_WEBSITE_HOST, CURSOR_API_HOST } from "./shared.js"
import { pollForTokens, exchangeApiKey, refreshAccessToken, isExpiringSoon, generatePkceParams, generatePkceChallenge, buildLoginUrl, decodeJwtPayload } from "./auth.js"
import { readCache, discoverModels, isCacheFresh, type ModelInfo } from "./models.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { readStoredAuth, type StoredAuth } from "./context/auth-store.js"
import { resolveAgentUrl } from "./agent-url.js"

const MODULE_URL = new URL("./index.js", import.meta.url).href

/**
 * Strip characters that break rendering in the OpenCode Desktop webview from a
 * model or variant display name: HTML/markup chars (`< > & " ' \``), parentheses,
 * Tabs/newlines collapse to single spaces; dots and unicode letters are preserved so names
 * stay readable. Fixes https://github.com/oakimov/cursor-opencode-provider/issues/2.
 */
function safeLabel(value: string): string {
  return (
    value
      .replace(/[()<>&"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "default"
  )
}

function baseName(mi: ModelInfo): string {
  return safeLabel(mi.displayName ?? mi.id)
}

function modelInfoVariants(mi: ModelInfo): Record<string, Record<string, unknown>> | undefined {
  if (mi.variants.length === 0) return undefined
  const entries: Record<string, Record<string, unknown>> = {}
  const usedKeys = new Set<string>()
  for (const v of mi.variants) {
    const base = safeLabel(v.displayName || v.key || "default")
    let key = base
    let suffix = 2
    while (usedKeys.has(key)) key = `${base}--${suffix++}`
    usedKeys.add(key)

    const params: Record<string, unknown> = {}
    for (const p of v.parameterValues) {
      params[p.id] = p.value
    }
    entries[key] = params
  }
  return entries
}

/**
 * Display names shared by both a thinking and a non-thinking model. A thinking
 * model with such a name needs a "Thinking" tag to disambiguate it from its
 * non-thinking twin (Cursor's Claude/Fable/Sonnet families). Models whose names
 * are already unique — including Cursor's GPT family, where the reasoning tier
 * ("None"/"Low"/"High"…) is baked into the name — are excluded, so they aren't
 * tagged redundantly.
 */
export function thinkingSuffixBaseNames(models: ModelInfo[]): Set<string> {
  const flags = new Map<string, { hasThinking: boolean; hasNonThinking: boolean }>()
  for (const m of models) {
    const base = baseName(m)
    const entry = flags.get(base) ?? { hasThinking: false, hasNonThinking: false }
    if (m.supportsThinking) entry.hasThinking = true
    else entry.hasNonThinking = true
    flags.set(base, entry)
  }
  const ambiguous = new Set<string>()
  for (const [base, f] of flags) if (f.hasThinking && f.hasNonThinking) ambiguous.add(base)
  return ambiguous
}

export function modelInfoToConfig(
  mi: ModelInfo,
  options: { thinkingSuffix?: boolean } = {},
) {
  let name = baseName(mi)
  if (options.thinkingSuffix) name += " Thinking"
  const config: Record<string, any> = {
    name,
    reasoning: mi.supportsThinking ?? false,
    tool_call: mi.supportsAgent ?? true,
    temperature: false,
    limit: {
      context: mi.maxContext ?? 200000,
      output: 4096,
    },
  }
  const variants = modelInfoVariants(mi)
  if (variants) config.variants = variants
  return config
}

function modelsToConfig(models: ModelInfo[]): Record<string, any> {
  const ambiguous = thinkingSuffixBaseNames(models)
  const out: Record<string, any> = {}
  for (const m of models) {
    out[m.id] = modelInfoToConfig(m, {
      thinkingSuffix: !!m.supportsThinking && ambiguous.has(baseName(m)),
    })
  }
  return out
}

function cursorApiBaseURL(): string {
  return process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
}

function cursorGetServerConfigTelemetryEnabled(): boolean {
  return (
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "1" ||
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "true"
  )
}

export async function CursorPlugin(input: PluginInput): Promise<Hooks> {
  const cacheDir = opencodeGlobalCacheDir()
  const apiBaseURL = cursorApiBaseURL()

  // Last access token successfully resolved in this plugin instance. Config's
  // loadModels can only read OpenCode's durable store (auth.json /
  // OPENCODE_AUTH_CONTENT); auth.loader gets live credentials via getAuth().
  // Those usually match, but after a refresh where persistAuthBestEffort fails,
  // getAuth() may still see the old credentials while we already hold a usable
  // token here — keep it so the loader can still discover models.
  let sessionAccessToken: string | undefined

  async function persistAuth(body: Auth): Promise<void> {
    await input.client.auth.set({
      path: { id: CURSOR_PROVIDER_ID },
      body,
    })
  }

  /** Persist refreshed credentials without failing the caller that already holds a live token. */
  async function persistAuthBestEffort(body: Auth): Promise<void> {
    try {
      await persistAuth(body)
    } catch {
      // ignore — token is still usable for this process
    }
  }

  /**
   * Durable credentials OpenCode stores on disk (same file getAuth() reads in
   * the normal path). Used from `config`, which has no getAuth() callback.
   */
  async function authFromStore(): Promise<Auth | StoredAuth | undefined> {
    return readStoredAuth(CURSOR_PROVIDER_ID)
  }

  /**
   * Prefer OpenCode's live getAuth(); fall back to the durable store so loader
   * and config share the same underlying credentials when possible.
   */
  async function authForLoader(
    getAuth: () => Promise<Auth | undefined>,
  ): Promise<Auth | StoredAuth | undefined> {
    return (await getAuth()) ?? (await authFromStore())
  }

  async function resolveAccessToken(auth: Auth | StoredAuth): Promise<string | undefined> {
    if (auth.type === "api") {
      let accessToken = auth.key
      const refreshToken = auth.metadata?.refreshToken
      // API-key exchange returns a short-lived JWT stored as `key`. Refresh
      // it the same way as OAuth when it is expiring / already expired.
      if (refreshToken && isExpiringSoon(auth.key)) {
        try {
          const newTokens = await refreshAccessToken(refreshToken, apiBaseURL)
          accessToken = newTokens.accessToken
          await persistAuthBestEffort({
            type: "api",
            key: newTokens.accessToken,
            metadata: {
              ...auth.metadata,
              refreshToken: newTokens.refreshToken,
            },
          })
        } catch {
          // refresh failed — keep the existing key; the next call may still work
        }
      }
      if (accessToken) sessionAccessToken = accessToken
      return accessToken
    }

    if (auth.type === "oauth") {
      if (!isExpiringSoon(auth.access)) {
        sessionAccessToken = auth.access
        return auth.access
      }
      if (!auth.refresh) return undefined
      try {
        const newTokens = await refreshAccessToken(auth.refresh, apiBaseURL)
        // Preserve optional OAuth fields (v2 Auth / plugin may carry these).
        const extras = auth as { accountId?: string; enterpriseUrl?: string }
        // Use the new token even if persisting back to OpenCode fails.
        await persistAuthBestEffort({
          type: "oauth",
          access: newTokens.accessToken,
          refresh: newTokens.refreshToken,
          expires: decodeExpFromJwt(newTokens.accessToken),
          ...(extras.accountId !== undefined ? { accountId: extras.accountId } : {}),
          ...(extras.enterpriseUrl !== undefined ? { enterpriseUrl: extras.enterpriseUrl } : {}),
        })
        sessionAccessToken = newTokens.accessToken
        return newTokens.accessToken
      } catch {
        return undefined
      }
    }

    return undefined
  }

  async function loadModels(): Promise<Record<string, any>> {
    const cached = await readCache(cacheDir)
    if (!cached || cached.models.length === 0) {
      // Config runs before auth.loader and has no getAuth(); read the durable
      // store (normally the same source getAuth() uses).
      const auth = await authFromStore()
      if (auth) {
        const accessToken = await resolveAccessToken(auth)
        if (accessToken) {
          try {
            const models = await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL })
            return modelsToConfig(models)
          } catch {
            // discovery failed — leave the list empty
          }
        }
      }
      return {}
    }
    return modelsToConfig(cached.models)
  }

  return {
    async config(cfg: Config) {
      cfg.provider ??= {}
      const models = await loadModels()
      const existing = cfg.provider[CURSOR_PROVIDER_ID]
      if (existing) {
        // Provider already declared (e.g. README stub with models: {}) —
        // still inject the cached model list when the user hasn't filled it in.
        const existingModels = (existing as { models?: Record<string, unknown> }).models
        if (!existingModels || Object.keys(existingModels).length === 0) {
          ;(existing as { models: Record<string, unknown> }).models = models
        }
        return
      }
      cfg.provider[CURSOR_PROVIDER_ID] = {
        name: "Cursor Integration",
        npm: MODULE_URL,
        models,
      }
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Cursor account (browser login)",
          async authorize(): Promise<AuthOAuthResult> {
            const params = generatePkceParams()
            const challenge = await generatePkceChallenge(params.verifier)
            const websiteUrl = process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`
            const apiBaseUrl = process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
            const url = buildLoginUrl(challenge, params.uuid, websiteUrl)

            return {
              url,
              instructions: "Open this URL in a browser to sign in to Cursor",
              method: "auto",
              async callback() {
                const result = await pollForTokens(params.uuid, params.verifier, apiBaseUrl)
                return {
                  type: "success",
                  provider: CURSOR_PROVIDER_ID,
                  access: result.accessToken,
                  refresh: result.refreshToken,
                  expires: decodeExpFromJwt(result.accessToken),
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API key (cursor.com/settings)",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Cursor API key",
              placeholder: "sk-...",
              validate(value: string) {
                if (!value.startsWith("sk-")) return "API key should start with sk-"
                return undefined
              },
            },
          ],
          async authorize(inputs) {
            const apiKey = inputs?.apiKey
            if (!apiKey) return { type: "failed" }
            try {
              const result = await exchangeApiKey(apiKey, apiBaseURL)
              return {
                type: "success",
                key: result.accessToken,
                provider: CURSOR_PROVIDER_ID,
                metadata: { refreshToken: result.refreshToken },
              }
            } catch {
              return { type: "failed" }
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await authForLoader(getAuth as () => Promise<Auth | undefined>)
        // Prefer credentials from getAuth/store; if refresh already succeeded in
        // loadModels but persist failed, fall back to the in-memory session token.
        const accessToken =
          (auth ? await resolveAccessToken(auth) : undefined) ?? sessionAccessToken
        if (accessToken) {
          // Skip when config already filled a fresh cache (avoids a second
          // AvailableModels round-trip + background refresh on cold start).
          const cached = await readCache(cacheDir)
          if (!cached || cached.models.length === 0 || !isCacheFresh(cached)) {
            // Await so an empty/missing cache is written before the loader returns
            // (fire-and-forget often loses the race on short-lived CLI commands).
            await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL }).catch(() => { /* non-fatal */ })
          }
          // Resolve the region-specific Run stream origin so the first turn
          // does not spend time on GetServerConfig. Best-effort: a failure is
          // surfaced by startSession, which can fail the actual model call with
          // a clear endpoint-resolution error instead of using global fallback.
          await resolveAgentUrl(accessToken, {
            apiBaseURL,
            telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
          }).catch(() => { /* non-fatal warmup */ })
        }

        return {
          ...(accessToken ? { accessToken } : {}),
          workspaceRoot: input.directory,
        }
      },
    },
  }
}

function decodeExpFromJwt(jwt: string): number {
  const payload = decodeJwtPayload(jwt)
  if (payload && typeof payload.exp === "number") return payload.exp * 1000
  return Date.now() + 3600_000
}
