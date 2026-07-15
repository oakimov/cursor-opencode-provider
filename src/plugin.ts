import type { Hooks, PluginInput, AuthOAuthResult, Config } from "@opencode-ai/plugin"
import { CURSOR_PROVIDER_ID, CURSOR_WEBSITE_HOST, CURSOR_API_HOST } from "./shared.js"
import { pollForTokens, exchangeApiKey, refreshAccessToken, isExpiringSoon, generatePkceParams, generatePkceChallenge, buildLoginUrl, decodeJwtPayload } from "./auth.js"
import { readCache, discoverModels, type ModelInfo } from "./models.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"

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

export async function CursorPlugin(input: PluginInput): Promise<Hooks> {
  const cacheDir = opencodeGlobalCacheDir()

  async function loadModels(): Promise<Record<string, any>> {
    const cached = await readCache(cacheDir)
    if (!cached || cached.models.length === 0) return {}
    const ambiguous = thinkingSuffixBaseNames(cached.models)
    const models: Record<string, any> = {}
    for (const m of cached.models) {
      models[m.id] = modelInfoToConfig(m, {
        thinkingSuffix: !!m.supportsThinking && ambiguous.has(baseName(m)),
      })
    }
    return models
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
              const result = await exchangeApiKey(apiKey)
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
        const auth = await getAuth()
        if (!auth) return {}

        let accessToken: string | undefined

        if (auth.type === "api") {
          accessToken = auth.key
          const refreshToken = auth.metadata?.refreshToken
          // API-key exchange returns a short-lived JWT stored as `key`. Refresh
          // it the same way as OAuth when it is expiring / already expired.
          if (refreshToken && isExpiringSoon(auth.key)) {
            try {
              const newTokens = await refreshAccessToken(refreshToken)
              await input.client.auth.set({
                path: { id: CURSOR_PROVIDER_ID },
                body: {
                  type: "api",
                  key: newTokens.accessToken,
                  metadata: { refreshToken: newTokens.refreshToken },
                },
              })
              accessToken = newTokens.accessToken
            } catch {
              // refresh failed — keep the existing key; the next call may still work
            }
          }
        } else if (auth.type === "oauth") {
          if (!isExpiringSoon(auth.access)) {
            accessToken = auth.access
          } else if (auth.refresh) {
            try {
              const newTokens = await refreshAccessToken(auth.refresh)
              await input.client.auth.set({
                path: { id: CURSOR_PROVIDER_ID },
                body: {
                  type: "oauth",
                  access: newTokens.accessToken,
                  refresh: newTokens.refreshToken,
                  expires: decodeExpFromJwt(newTokens.accessToken),
                },
              })
              accessToken = newTokens.accessToken
            } catch {
              // refresh failed
            }
          }
        }

        if (accessToken) {
          // Use discoverModels so we respect TTL / serve-stale semantics and
          // write through the same cache path language-model reads.
          discoverModels(accessToken, cacheDir).catch(() => { /* non-fatal */ })
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
