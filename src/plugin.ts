import type { Hooks, PluginInput, AuthOAuthResult, Config } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk"
import { CURSOR_COMPACTION_OPTION, CURSOR_PROVIDER_ID, CURSOR_WEBSITE_HOST, CURSOR_API_HOST } from "./shared.js"
import { cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled } from "./plugin-core.js"
import { pollForTokens, exchangeApiKey, refreshAccessToken, isExpiringSoon, generatePkceParams, generatePkceChallenge, buildLoginUrl, decodeJwtExpiryMs } from "./auth.js"
import { readCache, discoverModels, isCacheFresh } from "./models.js"
// Re-exported for API compatibility: tests and downstream code import these
// from "./plugin.js". Canonical home is ./model-config.ts, which stays free of
// host plugin imports so the OpenCode 2.0 entrypoint can share it.
import { modelsToConfig } from "./model-config.js"
export { modelInfoToConfig, modelsToConfig, thinkingSuffixBaseNames } from "./model-config.js"
import { adoptCompatHostCacheDir, opencodeGlobalCacheDir } from "./context/paths.js"
import { readStoredAuth, type StoredAuth } from "./context/auth-store.js"
import { resolveAgentUrl } from "./agent-url.js"
import {
  captureCursorShellResult,
  cursorShellEnvForCall,
  cursorShellOriginalCommand,
  prepareCursorShellArgs,
  releaseCursorShellEnv,
  sanitizeRegisteredCursorShellOutput,
  setCursorShellPath,
} from "./shell-timeout.js"
import { sessionActivity } from "./activity.js"
import { openCodeWebSearchTool } from "./web-search-tool.js"

const MODULE_URL = new URL("./index.js", import.meta.url).href

export async function CursorPlugin(input: PluginInput): Promise<Hooks> {
  // Prefer strong OCP host identity when available; otherwise resolve from explicit host signals/install path.
  await adoptCompatHostCacheDir()
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
          expires: decodeJwtExpiryMs(newTokens.accessToken) ?? Date.now(),
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
    if (cached?.models.length && isCacheFresh(cached)) {
      return modelsToConfig(cached.models)
    }

    // Config runs before auth.loader and has no getAuth(); read the durable
    // store (normally the same source getAuth() uses). Refresh missing, expired,
    // or old-schema caches here so this process materializes the new model set.
    const auth = await authFromStore()
    if (auth) {
      const accessToken = await resolveAccessToken(auth)
      if (accessToken) {
        try {
          const models = await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL })
          return modelsToConfig(models)
        } catch {
          // No usable cache and discovery failed — leave the list empty.
        }
      }
    }

    // Preserve stale-on-failure/offline behavior for an existing cache.
    return cached?.models.length ? modelsToConfig(cached.models) : {}
  }

  return {
    tool: {
      // `websearch` is a reserved OpenCode id and is filtered for third-party
      // providers after plugin tools are merged. Use the collision-safe id
      // Cursor already sees so this host-side fallback survives that filter.
      custom_websearch: openCodeWebSearchTool,
    },

    async event({ event }) {
      switch (event.type) {
        case "session.created":
          sessionActivity.linkSession(event.properties.info.id, event.properties.info.parentID)
          sessionActivity.recordActivity(event.properties.info.id)
          break
        case "session.updated":
          sessionActivity.linkSession(event.properties.info.id, event.properties.info.parentID)
          break
        case "session.deleted":
          sessionActivity.removeSession(event.properties.info.id)
          break
        case "message.updated":
          sessionActivity.recordActivity(event.properties.info.sessionID)
          break
        case "message.part.updated":
          sessionActivity.recordActivity(event.properties.part.sessionID)
          break
      }
    },

    async "tool.execute.before"(hookInput, output) {
      if (hookInput.tool !== "bash") return
      // bash/zsh retain the original display/permission command and wrap via
      // shell.env. sh/dash need a short wrapper-file command because their
      // non-interactive `-c` path ignores BASH_ENV / ZDOTDIR.
      prepareCursorShellArgs(hookInput.callID, output.args as Record<string, unknown>)
    },

    async "shell.env"(hookInput, output) {
      const env = cursorShellEnvForCall(hookInput.callID)
      if (!env) return
      Object.assign(output.env, env)
    },

    async "tool.execute.after"(hookInput, output) {
      if (hookInput.tool !== "bash") return
      try {
        output.title = cursorShellOriginalCommand(hookInput.callID) ?? output.title
        output.output = captureCursorShellResult(
          hookInput.callID,
          output.output,
          output.metadata as Record<string, unknown> | undefined,
        )
        // OpenCode's bash GUI falls back to metadata.output when output is empty
        // (`props.output || props.metadata.output`), so strip private markers there too.
        if (output.metadata && typeof output.metadata === "object") {
          const metadata = output.metadata as Record<string, unknown>
          if (typeof metadata.output === "string") {
            metadata.output = sanitizeRegisteredCursorShellOutput(hookInput.callID, metadata.output)
          }
        }
      } finally {
        releaseCursorShellEnv(hookInput.callID)
      }
    },

    async "chat.params"(hookInput, output) {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return
      // OpenCode's compaction pipeline invokes the LLM with agent="compaction".
      // Carry that stable runtime fact into LanguageModelV3 providerOptions so
      // the provider never has to guess from an empty tool list.
      if (hookInput.agent === "compaction") {
        output.options[CURSOR_COMPACTION_OPTION] = true
      }
    },

    async config(cfg: Config) {
      setCursorShellPath((cfg as Config & { shell?: string }).shell)
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
                  expires: decodeJwtExpiryMs(result.accessToken) ?? Date.now(),
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
              placeholder: "crsr_...",
              validate(value: string) {
                if (!value.startsWith("crsr_")) return "API key should start with crsr_"
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
          cacheDir,
        }
      },
    },
  }
}
