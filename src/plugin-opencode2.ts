import { CURSOR_PROVIDER_ID } from "./shared.js"
import { createSdk, cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled, isCursorPackage } from "./plugin-core.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { discoverModels, isCacheFresh, readCache, type ModelInfo } from "./models.js"
import { resolveAgentUrl } from "./agent-url.js"
import { sessionActivity } from "./activity.js"
import { fetchOpenCodeWebSearchText, type OpenCodeWebSearchArgs } from "./web-tools.js"
import {
  executeCursorImageSave,
  type ImageSaveResult,
  type ImageSaveToolContext,
} from "./image-save.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "./protocol/generate-image.js"
import {
  captureCursorShellResult,
  cursorShellOriginalCommand,
  prepareCursorShellArgs,
  releaseCursorShellEnv,
  sanitizeRegisteredCursorShellOutput,
} from "./shell-timeout.js"
import { applyCursorModels, applyCursorProvider } from "./opencode2/catalog.js"
import { applyCursorIntegration, resolveCursorAccessToken } from "./opencode2/integration.js"
import { markCompactionSession } from "./compaction-marker.js"
import { markSessionDirectory } from "./session-directory.js"
import { setPlanExecutionKickoff } from "./plan-execution-kickoff.js"
import type { CreateCursorOptions } from "./index.js"
import type { Cleanup, PluginContext, Plugin2 } from "./opencode2/types.js"

/**
 * OpenCode 2.0 beta plugin.
 *
 * Separate from `plugin-v2.ts` on purpose: the OpenCode 1.18 `/v2/promise` API
 * and the 2.0 API are source-incompatible (hook signatures, OAuth value type,
 * provider schema), so they cannot share an entrypoint. Shared behavior lives in
 * `plugin-core.ts`, `model-config.ts`, and `opencode2/*`.
 *
 * Load with:  { "plugins": ["cursor-opencode-provider/plugin/opencode2"] }
 */

async function loadModels(cacheDir: string, accessToken: string | undefined): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  if (cached?.models.length && isCacheFresh(cached)) return cached.models

  if (accessToken) {
    try {
      return await discoverModels(accessToken, cacheDir, { baseURL: cursorApiBaseURL() })
    } catch {
      // Fall through to stale-on-failure below.
    }
  }
  // Preserve offline / stale-cache behavior rather than emptying the picker.
  return cached?.models ?? []
}

function toolExecutionID(event: { readonly id?: string; readonly callID?: string }): string {
  const id = event.id ?? event.callID
  if (!id) throw new Error("OpenCode 2.0 tool hook did not provide an execution id")
  return id
}

const plugin: Plugin2 = {
  id: "cursor.provider",

  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    const cacheDir = opencodeGlobalCacheDir()

    // The 2.0 SessionDomain has `prompt` but no agent-selection method, so it
    // cannot faithfully reproduce classic plan_exit's `agent: "build"` kickoff.
    // Leave the handler absent: the continuation reports an execution error and
    // retains plan mode instead of returning false success.
    setPlanExecutionKickoff(undefined)

    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => {
      registrations.push(await p)
    }

    let models: ModelInfo[] = []

    // ── Credentials ──────────────────────────────────────────────────────────
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

    // ── Catalog ──────────────────────────────────────────────────────────────
    // Runs now with whatever models we have (likely none) and is replayed by the
    // host on every `catalog.reload()`, so the async fill below just re-triggers it.
    await track(
      ctx.catalog.transform((draft) => {
        applyCursorProvider(draft)
        applyCursorModels(draft, models)
      }),
    )

    // ── AI SDK wiring ────────────────────────────────────────────────────────
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
          // real per-request directory comes from the session.context hook
          // below via `getSessionDirectory`, which `language-model.ts` prefers.
          workspaceRoot: process.cwd(),
          cacheDir,
          ...event.options,
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

    // ── Web search ───────────────────────────────────────────────────────────
    // Registered as a tool, matching the classic plugin. 2.0 also has a
    // first-class `websearch` domain, but its Result shape is structured
    // ({url, title?, content?}) while the Exa backend here returns an opaque
    // text blob — mapping one to the other would mean guessing Exa's payload
    // shape, so the tool form stays until that can be verified against a live
    // response.
    await track(
      ctx.tool.transform((draft) => {
        draft.add({
          name: "custom_websearch",
          description: "Search the web for current information using OpenCode's web search backend.",
          input: {
            type: "object",
            properties: {
              query: { type: "string", description: "Web search query" },
              numResults: { type: "integer", minimum: 1, maximum: 20 },
              livecrawl: { type: "string", enum: ["fallback", "preferred"] },
              type: { type: "string", enum: ["auto", "fast", "deep"] },
              contextMaxCharacters: { type: "integer", exclusiveMinimum: 0 },
            },
            required: ["query"],
            additionalProperties: false,
          },
          execute: async (input: OpenCodeWebSearchArgs, context: any) => {
            const output = await fetchOpenCodeWebSearchText(input, context?.abort)
            return {
              title: `Exa Web Search: ${input.query}`,
              output,
              metadata: { provider: "exa" },
            }
          },
        })

        // Same handle-only commit tool as classic plugin.ts. Uses host-neutral
        // executeCursorImageSave (not image-save-tool.ts) so this entrypoint never
        // imports `@opencode-ai/plugin`'s classic `tool()` helper.
        draft.add({
          name: CURSOR_IMAGE_SAVE_TOOL,
          description:
            "Save an image that Cursor generated during this session to its target path. "
            + "Takes only the id of an already-generated image — it cannot write arbitrary "
            + "files, and it is not a general-purpose file writer. You do not normally call "
            + "this: the Cursor provider issues it after an image is generated.",
          input: {
            type: "object",
            properties: {
              image_id: {
                type: "string",
                description: "Id of the pending Cursor-generated image to save",
              },
            },
            required: ["image_id"],
            additionalProperties: false,
          },
          execute: async (input: { image_id?: string }, context: any) => {
            const saveCtx: ImageSaveToolContext = {
              worktree: typeof context?.worktree === "string" ? context.worktree : "",
              directory: typeof context?.directory === "string" ? context.directory : "",
              ask: typeof context?.ask === "function"
                ? context.ask.bind(context)
                : async () => {
                  throw new Error(
                    "OpenCode 2.0 tool context did not provide ask(); cannot gate image save",
                  )
                },
            }
            const result = await executeCursorImageSave(input, saveCtx)
            if (typeof result === "string") {
              return { title: CURSOR_IMAGE_SAVE_TOOL, output: result, metadata: {} }
            }
            const typed = result as ImageSaveResult
            return {
              title: typed.title,
              output: typed.output,
              metadata: {},
            }
          },
        })
      }),
    )

    // ── Shell timeout wrapper ────────────────────────────────────────────────
    await track(
      ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "bash") return
        const executionID = toolExecutionID(event)
        // No `shell.env` in 2.0 → always use the wrapper-file command form.
        prepareCursorShellArgs(executionID, event.input as Record<string, unknown>, {
          preferWrapperCommand: true,
        })
      }),
    )

    await track(
      ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== "bash") return
        const executionID = toolExecutionID(event)
        try {
          if (event.status !== "completed") return
          const result = event.result as Record<string, any>
          result.title = cursorShellOriginalCommand(executionID) ?? result.title
          result.output = captureCursorShellResult(
            executionID,
            result.output,
            result.metadata as Record<string, unknown> | undefined,
          )
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

    // ── Compaction marker + session directory ───────────────────────────────
    // 2.0 removed `chat.params`, and `session.hook("context")` exposes no
    // provider-options channel — only `system`/`messages`/`tools` are mutable.
    // But it does name the owning agent and the session id, and the provider
    // already derives the same session id from request headers, so record
    // both facts here and let doStream read them back via
    // `isCompactionSession` / `getSessionDirectory`.
    await track(
      ctx.session.hook("context", async (event) => {
        markCompactionSession(event.sessionID, event.agent === "compaction")
        try {
          const info = await ctx.session.get({ sessionID: event.sessionID })
          markSessionDirectory(event.sessionID, info.location?.directory)
        } catch {
          // Best effort — falls back to the static workspaceRoot above.
        }
      }),
    )

    // ── Model discovery ──────────────────────────────────────────────────────
    // Idempotent and cheap once satisfied, so it is safe to call from anywhere
    // that might mark the moment credentials became available.
    let modelsLoaded = false
    let ensureInflight: Promise<void> | undefined
    const ensureModels = (): Promise<void> => {
      if (modelsLoaded) return Promise.resolve()
      ensureInflight ??= (async () => {
        try {
          const token = await accessToken()
          const discovered = await loadModels(cacheDir, token)
          if (!discovered.length) return
          models = discovered
          modelsLoaded = true
          // Replays the catalog transform above, this time with models.
          await ctx.catalog.reload().catch(() => {})
          if (token) {
            // Resolve the region-specific Run origin so the first turn doesn't
            // pay for GetServerConfig. Best effort: startSession surfaces real
            // failures.
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

    // On a fresh install the user connects *after* startup, and the host has no
    // "connection established" hook we can key on. Poll briefly so models show
    // up within seconds of /connect instead of requiring a restart. The window
    // is bounded; after it, any session/message event still triggers a retry.
    const RETRY_INTERVAL_MS = 3_000
    const RETRY_WINDOW_MS = 300_000
    const startedAt = Date.now()
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
        clearInterval(retry)
        return
      }
      void ensureModels()
    }, RETRY_INTERVAL_MS)
    // Do not hold the process open on this timer.
    ;(retry as unknown as { unref?: () => void }).unref?.()

    void ensureModels()

    // ── Session activity ─────────────────────────────────────────────────────
    // Doubles as a retry trigger: any host activity after the polling window has
    // closed still gets one more chance to pick up newly-added credentials.
    const unsubscribe = subscribeSessionActivity(ctx, ensureModels)

    return async () => {
      clearInterval(retry)
      unsubscribe?.()
      setPlanExecutionKickoff(undefined)
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }
    }
  },
}

/** Feed OpenCode session/message events into the shared activity tracker. */
function subscribeSessionActivity(
  ctx: PluginContext,
  onEvent?: () => void,
): (() => void) | undefined {
  try {
    const stream = ctx.event.subscribe()
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return undefined
    let stopped = false
    void (async () => {
      for await (const event of stream as AsyncIterable<any>) {
        if (stopped) break
        applySessionActivity(event)
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

function applySessionActivity(event: any): void {
  switch (event?.type) {
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
}

export default plugin
