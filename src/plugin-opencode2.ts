import {
  CURSOR_PROVIDER_ID,
  CURSOR_COMPACTION_OPTION,
  CURSOR_HOST_AGENT_OPTION,
} from "./shared.js"
import { createSdk, cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled, isCursorPackage } from "./plugin-core.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { discoverModels, isCacheFresh, readCache, type ModelInfo } from "./models.js"
import { resolveAgentUrl } from "./agent-url.js"
import { sessionActivity } from "./activity.js"
import {
  fetchOpenCodeWebSearchText,
  parseExaWebSearchResults,
} from "./web-tools.js"
import {
  captureCursorShellResult,
  cursorShellEnvForCommand,
  prepareCursorShellArgs,
  releaseCursorShellEnv,
  sanitizeRegisteredCursorShellOutput,
} from "./shell-timeout.js"
import { applyCursorProviderInventory, CURSOR_INTEGRATION_ID } from "./opencode2/catalog.js"
import { applyCursorIntegration, resolveCursorAccessToken } from "./opencode2/integration.js"
import { registerTodoTools } from "./opencode2/todo-tools.js"
import { OPENCODE_2_TOOL_DIALECT } from "./protocol/tools.js"
import { clearSessionTodos } from "./todo-store.js"
import { markCompactionSession } from "./compaction-marker.js"
import { markSessionDirectory } from "./session-directory.js"
import {
  cancelPlanExecutionKickoff,
  createPlanExecutionKickoffText,
  setPlanExecutionKickoff,
} from "./plan-execution-kickoff.js"
import {
  cancelHostAgentModeSwitch,
  setHostAgentModeSwitch,
} from "./host-agent-mode.js"
import {
  clearActiveCursorMode,
  getActiveCursorMode,
  normalizeSwitchModeId,
  setActiveCursorMode,
} from "./protocol/switch-mode.js"
import { CursorPlugin } from "./plugin.js"
import type { CreateCursorOptions } from "./index.js"
import type {
  Cleanup,
  ConnectionInfo,
  PluginContext,
  Plugin2,
  SessionContext,
} from "./opencode2/types.js"

/**
 * OpenCode 2.0 plugin.
 *
 * Separate from `plugin-v2.ts` on purpose: the OpenCode 1.18 `/v2/promise` API
 * and the 2.0 API are source-incompatible (hook signatures, OAuth value type,
 * provider schema), so they cannot share an entrypoint. Shared behavior lives in
 * `plugin-core.ts`, `model-config.ts`, and `opencode2/*`.
 *
 * Models register in memory via `ctx.provider.transform` + `editor.add` +
 * `reload()`. Nothing is written into `opencode.json`.
 *
 * Dual export: `{ id, setup, server: CursorPlugin }`. OpenCode 2.0 Host.resolve
 * loads `./server` then `setup()`. OpenCode 1.18 also prefers `exports["./server"]`
 * and then calls `server()` so classic 1.x hooks still run.
 *
 * Load with:  { "plugin": ["cursor-opencode-provider/plugin/opencode2"] }
 * or a local package directory under `$OPENCODE_CONFIG_DIR/plugins/` that
 * re-exports `dist/plugin-opencode2.js` (OpenCode 2.0 requires a directory,
 * not a .js path).
 */

async function loadModels(
  cacheDir: string,
  accessToken: string | undefined,
  forceRefresh = false,
): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  if (!forceRefresh && cached?.models.length && isCacheFresh(cached)) return cached.models

  if (accessToken) {
    try {
      return await discoverModels(accessToken, cacheDir, {
        baseURL: cursorApiBaseURL(),
        forceRefresh,
      })
    } catch {
      // A forced refresh follows a credential switch. Do not bind a cache
      // produced by the prior account to the new connection on failure.
      if (forceRefresh) return []
    }
  }
  if (forceRefresh) return []
  // Preserve offline / stale-cache behavior rather than emptying the picker.
  return cached?.models ?? []
}

function toolExecutionID(event: { readonly id?: string; readonly callID?: string }): string {
  const id = event.id ?? event.callID
  if (!id) throw new Error("OpenCode 2.0 tool hook did not provide an execution id")
  return id
}

function isShellTool(name: string | undefined): boolean {
  return name === "bash" || name === "shell"
}

function eventPayload(event: any): any {
  if (event?.data && typeof event.data === "object") return event.data
  if (event?.properties && typeof event.properties === "object") return event.properties
  return event
}

function markCompactionAndOptions(
  event: Pick<SessionContext, "sessionID" | "options">,
  isCompaction: boolean,
): void {
  markCompactionSession(event.sessionID, isCompaction)
  // Keep the request-local flag authoritative. Explicit false prevents a
  // concurrent title/generate/primary request for the same session from
  // inheriting the process-wide fallback marker.
  event.options ??= {}
  event.options[CURSOR_COMPACTION_OPTION] = isCompaction
}

const plugin: Plugin2 & { server: typeof CursorPlugin } = {
  id: "cursor.provider",
  server: CursorPlugin,

  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    const cacheDir = opencodeGlobalCacheDir()
    const workspaceRoot = ctx.location?.directory || process.cwd()
    const hasShellEnvHook = typeof ctx.shell?.hook === "function"

    const admitPlanKickoff = typeof ctx.session.synthetic === "function"
      ? ctx.session.synthetic
      : ctx.session.prompt
    if (typeof ctx.session.switchAgent === "function" && typeof admitPlanKickoff === "function") {
      const switchAgent = ctx.session.switchAgent
      setPlanExecutionKickoff(async ({ sessionID, planPath }) => {
        await switchAgent({ sessionID, agent: "build" })
        try {
          await admitPlanKickoff({
            sessionID,
            text: createPlanExecutionKickoffText(planPath),
          })
        } catch (error) {
          // Switching and admitting input are separate public APIs. Restore the
          // plan agent if admission fails so the shared retry state is honest:
          // the plan remains active rather than silently leaving the session in
          // build mode with no execution turn.
          await switchAgent({ sessionID, agent: "plan" }).catch(() => {})
          throw error
        }
      })
    } else {
      setPlanExecutionKickoff(undefined)
    }

    if (typeof ctx.session.switchAgent === "function") {
      const switchAgent = ctx.session.switchAgent
      setHostAgentModeSwitch(async ({ sessionID, targetModeID }) => {
        const mode = normalizeSwitchModeId(targetModeID)
        await switchAgent({
          sessionID,
          agent: mode === "plan" || mode === "spec" ? "plan" : "build",
        })
      })
    } else {
      setHostAgentModeSwitch(undefined)
    }

    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => {
      registrations.push(await p)
    }

    let models: ModelInfo[] = []
    let sourceConnection: ConnectionInfo | undefined

    // ── Credentials ─────────────────────────────────────────
    await track(ctx.integration.transform(applyCursorIntegration))

    let cachedToken: string | undefined
    let tokenInflight: Promise<string | undefined> | undefined
    /**
     * Cache only a *successful* resolution.
     *
     * On a fresh install `setup()` runs before the user has connected, so the
     * first attempt necessarily returns nothing. Memoizing that would pin the
     * plugin to "no credentials" for the whole process and models would never
     * load, even after a successful /connect.
     */
    const accessToken = async (): Promise<string | undefined> => {
      if (cachedToken) return cachedToken
      tokenInflight ??= resolveCursorAccessToken(ctx.integration).finally(() => {
        tokenInflight = undefined
      })
      const token = await tokenInflight
      if (token) cachedToken = token
      return token
    }

    const refreshSourceConnection = async (): Promise<void> => {
      try {
        sourceConnection = await ctx.integration.connection.active(CURSOR_INTEGRATION_ID)
      } catch {
        sourceConnection = undefined
      }
    }

    // ── Provider inventory (in-memory `editor.add`) ─────────────────────
    // Transform replays on provider.reload(). Skip while `models` is empty so
    // the first registration is a no-op; discovery/cache then reload.
    await track(
      ctx.provider.transform((editor) => {
        applyCursorProviderInventory(editor, models, sourceConnection)
      }),
    )

    try {
      const cached = await readCache(cacheDir)
      if (cached?.models?.length) {
        models = cached.models
        await refreshSourceConnection()
        await ctx.provider.reload()
      }
    } catch {
      // Cache seed is best-effort; auth/aisdk still work without it.
    }

    const publishModels = async (next: ModelInfo[]): Promise<boolean> => {
      const previousModels = models
      const previousConnection = sourceConnection
      models = next
      await refreshSourceConnection()
      try {
        await ctx.provider.reload()
        return true
      } catch {
        // Keep the transform backed by the last inventory that actually
        // reloaded. A later host replay must not publish a failed account
        // refresh merely because the candidate remained in this closure.
        models = previousModels
        sourceConnection = previousConnection
        return false
      }
    }

    // ── AI SDK wiring ────────────────────────────────────────
    await track(
      ctx.aisdk.hook("sdk", async (event) => {
        if (event.sdk) return
        if (!isCursorPackage(event.package, event.model.providerID)) return
        const token = await accessToken()
        event.sdk = createSdk({
          name: event.model.providerID || CURSOR_PROVIDER_ID,
          ...(token ? { accessToken: token } : {}),
          // Static fallback only. This hook fires once per model/package, not
          // per session, and 2.0 runs one daemon across many projects — the
          // real per-request directory comes from `x-opencode-directory` and
          // the session.context hook below via `getSessionDirectory`.
          workspaceRoot,
          cacheDir,
          ...event.options,
          // Keep after `event.options` so the OC2 plugin always selects the
          // `path`/`shell` dialect when advertised schemas are opaque.
          defaultDialect: OPENCODE_2_TOOL_DIALECT,
        } as CreateCursorOptions)
      }),
    )

    await track(
      ctx.aisdk.hook("language", (event) => {
        if (event.language) return
        if (event.model.providerID !== CURSOR_PROVIDER_ID) return
        if (typeof event.sdk?.languageModel !== "function") return
        // `modelID` is the Cursor wire id; `id` may be a synthetic long-context entry.
        event.language = event.sdk.languageModel(event.model.modelID || event.model.id)
      }),
    )

    // ── Web search ───────────────────────────────────────────
    // Publish an OpenCode 2.0 `websearch` provider (`{url,title,content,time}`).
    // The classic entrypoint owns the permission-aware `custom_websearch`
    // fallback; 2.0's public plugin tool context cannot request permission.
    if (ctx.websearch) {
      await track(
        ctx.websearch.transform((draft) => {
          draft.add({
            id: "cursor-exa",
            name: "Exa",
            execute: async (input, context) => {
              const output = await fetchOpenCodeWebSearchText(
                { query: input.query },
                context.signal,
              )
              return parseExaWebSearchResults(output)
            },
          })
        }),
      )
    }

    await track(
      ctx.tool.transform((draft) => {
        // OpenCode 2 dropped host todowrite/todoread. Off by default
        // (`CURSOR_OPENCODE2_TODOS=1`/`true` force-enables). When on, register
        // them as direct catalog tools (`codemode: false` + output schema) if
        // the host does not already own those names. When off, register none.
        registerTodoTools(draft)
      }),
    )

    // ── Shell timeout wrapper ────────────────────────────────
    await track(
      ctx.tool.hook("execute.before", (event) => {
        if (!isShellTool(event.tool)) return
        const executionID = toolExecutionID(event)
        prepareCursorShellArgs(executionID, event.input as Record<string, unknown>, {
          // OpenCode 2.0 `shell.create.before` can inject env for bash/zsh.
          preferWrapperCommand: !hasShellEnvHook,
        })
      }),
    )

    await track(
      ctx.tool.hook("execute.after", (event) => {
        if (!isShellTool(event.tool)) return
        const executionID = toolExecutionID(event)
        try {
          if (event.status !== "completed") return
          const result = event.result as Record<string, any>
          // V1: `output` is the model-facing string. V2: `output` is structured
          // per-tool output (shell: `{ output: string, ... }`) and the
          // model-facing text lives on `content`. Sanitize every string
          // location; non-strings pass through via the guards in shell-timeout.
          if (typeof result.output === "string") {
            result.output = captureCursorShellResult(
              executionID,
              result.output,
              result.metadata as Record<string, unknown> | undefined,
            )
          } else if (result.output && typeof result.output === "object") {
            const structured = result.output as Record<string, unknown>
            if (typeof structured.output === "string") {
              structured.output = captureCursorShellResult(
                executionID,
                structured.output,
                result.metadata as Record<string, unknown> | undefined,
              )
            }
          }
          if (typeof result.content === "string") {
            result.content = sanitizeRegisteredCursorShellOutput(executionID, result.content)
          } else if (Array.isArray(result.content)) {
            result.content = result.content.map((item: unknown) => {
              if (!item || typeof item !== "object") return item
              const content = item as Record<string, unknown>
              if (content.type !== "text" || typeof content.text !== "string") return item
              return {
                ...content,
                text: sanitizeRegisteredCursorShellOutput(executionID, content.text),
              }
            })
          } else if (typeof result.output === "string" && result.content === undefined) {
            result.content = result.output
          }
          if (result.metadata && typeof result.metadata === "object") {
            const metadata = result.metadata as Record<string, unknown>
            if (typeof metadata.output === "string") {
              metadata.output = sanitizeRegisteredCursorShellOutput(executionID, metadata.output)
            }
          }
        } finally {
          releaseCursorShellEnv(executionID)
        }
      }),
    )

    if (ctx.shell) {
      await track(
        ctx.shell.hook("create.before", (event) => {
          const env = cursorShellEnvForCommand(event.command, event.cwd)
          if (!env) return
          event.env = { ...event.env, ...env }
        }),
      )
    }

    const rememberSessionDirectory = async (sessionID: string) => {
      try {
        const info = (await ctx.session.get({ sessionID })) as {
          directory?: string
          location?: { directory?: string }
        }
        // OpenCode 2.0 stable exposes a flat `directory`; older shapes nest it
        // under `location.directory`. Prefer the flat field when both exist.
        markSessionDirectory(sessionID, info.directory ?? info.location?.directory)
      } catch {
        // Best effort — falls back to the static workspaceRoot above.
      }
    }

    await track(
      ctx.session.hook("context", async (event) => {
        markCompactionAndOptions(event, event.agent === "compaction")
        event.options ??= {}
        event.options[CURSOR_HOST_AGENT_OPTION] = event.agent
        if (event.agent !== "compaction") {
          const activeMode = getActiveCursorMode(event.sessionID)
          if (event.agent === "plan") {
            if (activeMode !== "plan" && activeMode !== "spec") {
              setActiveCursorMode(event.sessionID, "plan")
            }
          } else if (activeMode === "plan" || activeMode === "spec") {
            // A direct OpenCode UI switch away from Plan is authoritative. Do
            // not overwrite other Cursor-only modes (chat/debug/etc.) merely
            // because their closest native primary agent is `build`.
            setActiveCursorMode(event.sessionID, "agent")
          }
        }
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("compaction", async (event) => {
        markCompactionAndOptions(event, true)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("generate", async (event) => {
        markCompactionAndOptions(event, false)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("title", async (event) => {
        markCompactionAndOptions(event, false)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    // ── Model discovery ────────────────────────────────────────
    let modelsLoaded = false
    let credentialGeneration = 0
    let loadedCredentialGeneration = 0
    let ensureInflight: Promise<void> | undefined
    const ensureModels = (): Promise<void> => {
      if (modelsLoaded && loadedCredentialGeneration === credentialGeneration) {
        return Promise.resolve()
      }
      // If credentials change during an existing discovery, wait for that
      // attempt and immediately run again. The generation check prevents the
      // older attempt from suppressing the account-scoped refresh.
      if (ensureInflight) return ensureInflight.then(() => ensureModels())

      const attemptGeneration = credentialGeneration
      const forceRefresh = loadedCredentialGeneration !== attemptGeneration
      ensureInflight = (async () => {
        try {
          const token = await accessToken()
          const discovered = await loadModels(cacheDir, token, forceRefresh)
          if (!discovered.length) return
          if (credentialGeneration !== attemptGeneration) return
          if (!await publishModels(discovered)) return
          // A newer credential event arrived while this request was in flight.
          // Keep the state dirty so the chained ensure uses the latest token.
          if (credentialGeneration !== attemptGeneration) return
          modelsLoaded = true
          loadedCredentialGeneration = attemptGeneration
          if (token) {
            await resolveAgentUrl(token, {
              apiBaseURL: cursorApiBaseURL(),
              telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
            }).catch(() => {})
          }
        } finally {
          ensureInflight = undefined
        }
      })()
      return ensureInflight
    }

    const RETRY_INTERVAL_MS = 3_000
    const RETRY_WINDOW_MS = 300_000
    const startedAt = Date.now()
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
        clearInterval(retry)
        return
      }
      void ensureModels().catch(() => {})
    }, RETRY_INTERVAL_MS)
    ;(retry as unknown as { unref?: () => void }).unref?.()

    void ensureModels().catch(() => {})

    const onCredentialSwitch = () => {
      cachedToken = undefined
      modelsLoaded = false
      credentialGeneration++
    }

    const unsubscribe = subscribeSessionActivity(ctx, ensureModels, onCredentialSwitch)

    return async () => {
      clearInterval(retry)
      unsubscribe?.()
      setPlanExecutionKickoff(undefined)
      setHostAgentModeSwitch(undefined)
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }
    }
  },
}

function subscribeSessionActivity(
  ctx: PluginContext,
  onEvent?: () => void,
  onCredentialSwitch?: () => void,
): (() => void) | undefined {
  try {
    const stream = ctx.event.subscribe()
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return undefined
    let stopped = false
    void (async () => {
      for await (const event of stream as AsyncIterable<any>) {
        if (stopped) break
        applySessionActivity(event, onCredentialSwitch)
        onEvent?.()
      }
    })().catch(() => {})
    return () => {
      stopped = true
    }
  } catch {
    return undefined
  }
}

function applySessionActivity(event: any, onCredentialSwitch?: () => void): void {
  const payload = eventPayload(event)
  const info = payload?.info
  switch (event?.type) {
    case "credential.switched":
    case "credential.updated": {
      const integrationID = payload?.integrationID
      if (!integrationID || integrationID === CURSOR_INTEGRATION_ID || integrationID === CURSOR_PROVIDER_ID) {
        onCredentialSwitch?.()
      }
      break
    }
    case "session.created":
    case "session.updated":
    case "session.forked": {
      const id = payload?.sessionID ?? info?.id
      const parentID = payload?.parentID ?? info?.parentID
      if (id) {
        sessionActivity.linkSession(id, parentID)
        if (event.type === "session.created") sessionActivity.recordActivity(id)
      }
      break
    }
    case "session.deleted": {
      const id = payload?.sessionID ?? info?.id
      if (id) {
        sessionActivity.removeSession(id)
        clearSessionTodos(id)
        clearActiveCursorMode(id)
        cancelPlanExecutionKickoff(id)
        cancelHostAgentModeSwitch(id)
      }
      break
    }
    case "message.updated": {
      const id = payload?.sessionID ?? info?.sessionID
      if (id) sessionActivity.recordActivity(id)
      break
    }
    case "message.part.updated": {
      const id = payload?.sessionID ?? payload?.part?.sessionID ?? info?.sessionID
      if (id) sessionActivity.recordActivity(id)
      break
    }
    case "session.usage.updated":
    case "session.usage.recorded": {
      const id = payload?.sessionID
      if (id) sessionActivity.recordActivity(id)
      break
    }
    default: {
      // OpenCode 2.0 emits granular `session.*` progress events instead of
      // the V1 `message.updated` family (`session.tool.called/success/failed`,
      // `session.step.*`, `session.text.*`, `session.execution.*`, ...). Any of
      // them proves the session is alive and renews a pending-tool lease.
      const type = typeof event?.type === "string" ? event.type : ""
      if (type.startsWith("session.") && type !== "session.deleted") {
        const id = payload?.sessionID ?? info?.sessionID ?? info?.id
        if (id) sessionActivity.recordActivity(id)
      }
      break
    }
  }
}

export default plugin
