import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage, LanguageModelV3FinishReason } from "@ai-sdk/provider"
import type { CreateCursorOptions, CursorRetryOptions } from "./index.js"
import {
  bidiRunStream,
  CursorRunInterruptedError,
  normalizeAgentRunOrigin,
  type BidiStream,
} from "./transport/connect.js"
import { trace, traceRequestContextPaths } from "./debug.js"
import { buildRunRequest, buildHeartbeat } from "./protocol/request.js"
import { decodeFramePayload } from "./protocol/framing.js"
import { decodeMessage } from "./protocol/messages.js"
import {
  parseExecServerMessage,
  buildToolCallPart,
  buildExecClientMessages,
  parseExecIdFromToolCallId,
  detectExecVariantField,
  buildRequestContextResult,
  buildMcpStateResult,
  type OpencodeToolDef,
  type ParsedExecRequest,
} from "./protocol/tools.js"
import { describeCursorExecVariant } from "./protocol/exec-variants.js"
import {
  advertisedToolNamesFromDescriptors,
  extractExecDisplayCallId,
  extractProtobufSubmessage,
  listProtobufFieldNumbers,
  parseDisplayToolCall,
  resolveBridgedOpenCodeToolCall,
} from "./protocol/tool-call-bridge.js"
import { handleKvServerMessage } from "./protocol/kv.js"
import { handleInteractionQuery, inspectInteractionQueryWire } from "./protocol/interactions.js"
import { getCheckpoint, setCheckpoint } from "./protocol/checkpoint.js"
import { conversationBlobCount } from "./protocol/blob-store.js"
import {
  bindConversationId,
} from "./protocol/conversation-bind.js"
import {
  resolveContinuationPolicy,
  sessionManager,
  type CursorSession,
  type Frame,
} from "./session.js"
import {
  CursorAuthError,
  CursorLocalCancellationError,
  CursorProtocolError,
  CursorProviderError,
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  isTransientGrpcStatus,
  retrySuppressedError,
  toCursorProviderError,
} from "./errors.js"
import { readCache, cacheFilePath, resolveVariantParameters, paramsImplyMaxMode, extractCursorVariantParameters, resolveCursorWireModelId, type ModelInfo } from "./models.js"
import { buildRequestContext } from "./context/build.js"
import { workspaceRootFromRequestContext } from "./context/env.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { resolveAgentUrl } from "./agent-url.js"
import { CURSOR_API_HOST, CURSOR_COMPACTION_OPTION } from "./shared.js"
import type { SeedHistoryMessage } from "./protocol/request.js"
import {
  consumeCursorShellResult,
  registerCursorShellCall,
} from "./shell-timeout.js"

let _availableModels: ModelInfo[] | undefined
// mtime of the cache file the last time we loaded it. Compared on each call
// so discoverModels' background refresh is picked up without a process restart.
let _availableModelsMtimeMs = -1

// OpenCode omits tools from compaction calls. Keep the last real catalog per
// session so the new Cursor conversation is still born with tool definitions;
// execution remains disabled for the summary turn itself.
const toolCatalogBySession = new Map<string, OpencodeToolDef[]>()
// A compaction Run uses its own summary-agent system prompt. Its opaque Cursor
// checkpoint must never become the base for the resumed normal agent: doing so
// suppresses OpenCode's compacted prompt/system seed and makes Cursor narrate
// tool use instead of emitting exec requests. Rebase once on the next turn.
const postCompactionRebaseBySession = new Set<string>()
export const MAX_TURN_STATE_SESSIONS = 256
const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
} as const
const MAX_RETRY_ATTEMPTS = 10
const MAX_RETRY_DELAY_MS = 30_000

export type CursorRetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

function retryInteger(name: string, value: unknown, fallback: number): number {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CursorProtocolError(`Cursor retry ${name} must be a positive integer`)
  }
  return resolved
}

export function resolveRetryPolicy(options: CursorRetryOptions | undefined): CursorRetryPolicy {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new CursorProtocolError("Cursor retry options must be an object")
  }
  for (const key of Object.keys(options ?? {})) {
    if (!["maxAttempts", "baseDelayMs", "maxDelayMs"].includes(key)) {
      throw new CursorProtocolError(`Unknown Cursor retry option: ${key}`)
    }
  }
  const maxAttempts = retryInteger("maxAttempts", options?.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts)
  const baseDelayMs = retryInteger("baseDelayMs", options?.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs)
  const maxDelayMs = retryInteger("maxDelayMs", options?.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs)
  if (maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new CursorProtocolError(`Cursor retry maxAttempts must be no greater than ${MAX_RETRY_ATTEMPTS}`)
  }
  if (baseDelayMs > MAX_RETRY_DELAY_MS || maxDelayMs > MAX_RETRY_DELAY_MS) {
    throw new CursorProtocolError(`Cursor retry delays must be no greater than ${MAX_RETRY_DELAY_MS}ms`)
  }
  if (baseDelayMs > maxDelayMs) {
    throw new CursorProtocolError("Cursor retry baseDelayMs must be no greater than maxDelayMs")
  }
  return { maxAttempts, baseDelayMs, maxDelayMs }
}

function retryDelayMs(error: CursorProviderError, attempt: number, policy: CursorRetryPolicy): number {
  if (error.retryAfterMs !== undefined) return Math.min(MAX_RETRY_DELAY_MS, error.retryAfterMs)
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.floor(Math.random() * ceiling)
}

function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CursorLocalCancellationError("Cursor retry cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => finish(new CursorLocalCancellationError("Cursor retry cancelled"))
    function finish(error?: Error) {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryDelayFromValue(value: unknown): number | undefined {
  if (typeof value === "string") {
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
    if (seconds) return Math.ceil(Number(seconds[1]) * 1_000)
    const protobufDelay = retryInfoProtobufDelayMs(value.trim())
    if (protobufDelay !== undefined) return protobufDelay
  }
  if (!value || typeof value !== "object") return undefined
  const duration = value as { seconds?: unknown; nanos?: unknown }
  const seconds = Number(duration.seconds ?? 0)
  const nanos = Number(duration.nanos ?? 0)
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) return undefined
  return Math.ceil(seconds * 1_000 + nanos / 1_000_000)
}

/** Decode google.rpc.RetryInfo.value without adding another protobuf schema. */
function retryInfoProtobufDelayMs(encoded: string): number | undefined {
  if (!encoded || encoded.length > 512 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    return undefined
  }
  let bytes: Uint8Array
  try {
    bytes = Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64")
  } catch {
    return undefined
  }
  const readVarint = (input: Uint8Array, start: number): [bigint, number] | undefined => {
    let value = 0n
    let shift = 0n
    for (let offset = start; offset < input.length && offset < start + 10; offset++) {
      const byte = input[offset]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return [value, offset + 1]
      shift += 7n
    }
    return undefined
  }
  const outerKey = readVarint(bytes, 0)
  if (!outerKey || outerKey[0] !== 0x0an) return undefined
  const outerLength = readVarint(bytes, outerKey[1])
  if (!outerLength || outerLength[0] > BigInt(bytes.length - outerLength[1])) return undefined
  const duration = bytes.subarray(
    outerLength[1],
    outerLength[1] + Number(outerLength[0]),
  )
  let offset = 0
  let seconds = 0n
  let nanos = 0n
  while (offset < duration.length) {
    const key = readVarint(duration, offset)
    if (!key) return undefined
    offset = key[1]
    const field = Number(key[0] >> 3n)
    if (Number(key[0] & 7n) !== 0) return undefined
    const item = readVarint(duration, offset)
    if (!item) return undefined
    offset = item[1]
    if (field === 1) seconds = item[0]
    else if (field === 2) nanos = item[0]
  }
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER) || nanos > 999_999_999n) return undefined
  return Math.ceil(Number(seconds) * 1_000 + Number(nanos) / 1_000_000)
}

export function connectFrameError(payload: string): CursorProviderError {
  try {
    const envelope = JSON.parse(payload) as {
      error?: { code?: unknown; details?: unknown; retryAfter?: unknown; retry_after?: unknown }
    }
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : "unknown"
    if (code === "unauthenticated" || code === "permission_denied") {
      return new CursorAuthError(`Cursor authentication failed (${code}); reauthenticate with Cursor`, { code })
    }
    let retryAfterMs = retryDelayFromValue(
      envelope.error?.retryAfter ?? envelope.error?.retry_after,
    )
    let hasRetryInfo = false
    if (Array.isArray(envelope.error?.details)) {
      for (const detail of envelope.error.details) {
        if (!detail || typeof detail !== "object") continue
        const record = detail as Record<string, unknown>
        const type = record.type
        if (type === "google.rpc.RetryInfo" || (typeof type === "string" && type.endsWith("/google.rpc.RetryInfo"))) {
          hasRetryInfo = true
          retryAfterMs ??= retryDelayFromValue(
            record.retryDelay ?? record.retry_delay ?? record.value,
          )
        }
      }
    }
    return new CursorServerError(`Cursor API error (code=${code})`, {
      transient: isTransientGrpcStatus(code) || hasRetryInfo,
      replaySafe: true,
      code,
      retryAfterMs: retryAfterMs === undefined
        ? undefined
        : Math.min(MAX_RETRY_DELAY_MS, retryAfterMs),
    })
  } catch {
    return new CursorProtocolError("Cursor returned a malformed Connect error envelope")
  }
}

function rememberToolCatalog(sessionKey: string, tools: OpencodeToolDef[]): void {
  toolCatalogBySession.delete(sessionKey)
  toolCatalogBySession.set(sessionKey, tools)
  while (toolCatalogBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = toolCatalogBySession.keys().next().value as string | undefined
    if (!oldest) break
    toolCatalogBySession.delete(oldest)
  }
}

function rememberPostCompactionRebase(sessionKey: string): void {
  postCompactionRebaseBySession.delete(sessionKey)
  postCompactionRebaseBySession.add(sessionKey)
  while (postCompactionRebaseBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = postCompactionRebaseBySession.values().next().value as string | undefined
    if (!oldest) break
    postCompactionRebaseBySession.delete(oldest)
  }
}

type V3Part = LanguageModelV3StreamPart

export function createCursorLanguageModel(
  modelId: string,
  providerId: string,
  options: CreateCursorOptions,
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      return doStreamImpl(modelId, options, callOptions)
    },

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const result = await doStreamImpl(modelId, options, callOptions)
      const parts: V3Part[] = []
      const reader = result.stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return foldStreamParts(parts)
    },
  }
}

async function doStreamImpl(
  modelId: string,
  options: CreateCursorOptions,
  callOptions: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult> {
  // A raw `sk-...` API key must be exchanged for a JWT before it can be used
  // as a Bearer token (the plugin path does this in auth.ts). The accessToken
  // path is already a JWT from OAuth/key-exchange, so we use it as-is.
  // resolveBearerToken caches apiKey exchanges so we don't hit /auth/exchange
  // on every turn.
  const { resolveBearerToken } = await import("./auth.js")
  const token = await resolveBearerToken({
    accessToken: options.accessToken,
    apiKey: options.apiKey,
    baseUrl: resolveApiBaseURL(options),
  })

  const prompt = callOptions.prompt
  const promptTokens = estimatePromptTokens(prompt)
  const retryPolicy = resolveRetryPolicy(options.retry)
  // pumpWithRecovery owns the complete per-turn attempt budget.  Opening a
  // replacement session here must be a single attempt; otherwise setup retry
  // loops nest inside recovery and `maxAttempts` no longer caps total Runs.
  const openSession = (startOptions?: { recovery?: CursorRunRecovery }) =>
    startSession(modelId, token, callOptions, options, startOptions)

  // ── Continuation vs fresh turn ──
  // OpenCode embeds *all* historical tool results in every prompt. Only the
  // trailing tool-message suffix (after the last assistant/user message) is a
  // live continuation. Treating mid-prompt history as continuation caused
  // false "orphaned tool results" errors after Cursor turn_ended and OpenCode
  // started the next step with old tools still in the prompt body.
  const trailingToolResults = extractTrailingToolResults(prompt)
  let session = findContinuationSession(trailingToolResults)

  if (session) {
    // Write pending results onto the held-open Run. A dead stream closes the
    // session and returns undefined so we fall through to history rebase
    // instead of pumping a connection that can no longer accept writes.
    session = deliverContinuationResults(session, trailingToolResults)
  }

  if (!session) {
    if (trailingToolResults.length > 0) {
      // True continuation (prompt ends with tool results) but the held-open Run
      // is gone (or its write path just failed). Rebase the complete OpenCode
      // prompt onto a fresh conversation: its seed history includes the
      // completed tool result, so no result or advertised tool is lost and
      // Cursor can continue instead of deadlocking.
      const ids = trailingToolResults.map((r) => `${r.sessionId}:${r.execId}`).join(",")
      trace(`continuation: ${trailingToolResults.length} interrupted trailing tool result(s) [${ids}] — rebasing fresh Run`)
      session = await openSession({ recovery: { kind: "rebase" } })
    } else {
      // Fresh turn (prompt ends with user/assistant text). Historical tool
      // results may exist mid-prompt; they are not live exec replies.
      const historical = extractToolResults(prompt).length
      if (historical > 0) {
        trace(`fresh turn: ignoring ${historical} historical tool result(s) (not trailing)`)
      }
      session = await openSession()
    }
  }

  let activeSession = session

  return {
    stream: new ReadableStream<V3Part>({
      async pull(controller) {
        // The outer try is a safety net for any throw that escapes pump() —
        // e.g. an unhandled decode/gunzip error or a frames-iterator throw on
        // a non-200 HTTP/2 response. Without it the pull promise rejects, the
        // ReadableStream errors, and the session is never cleaned up.
        try {
          try {
            controller.enqueue({ type: "stream-start", warnings: [] } as V3Part)
          } catch (e) {
            // Controller already cancelled by the consumer — stop pumping.
            trace(`pull: stream-start enqueue failed (cancelled) err=${(e as Error).message}`)
            return
          }
          activeSession = await pumpWithRecovery({
            initialSession: activeSession,
            controller,
            abortSignal: callOptions.abortSignal,
            promptTokens,
            retryPolicy,
            recover: (recovery) => openSession({ recovery }),
            onSession: (next) => { activeSession = next },
          })
          try {
            controller.close()
          } catch (e) {
            trace(`pull: close failed (already closed/cancelled) err=${(e as Error).message}`)
          }
        } catch (e) {
          activeSession.pumpActive = false
          trace(`pull: pump threw (cleaning up): ${(e as Error).message}`)
          sessionManager.close(activeSession)
          try {
            controller.error(e instanceof Error ? e : new Error(String(e)))
          } catch {
            /* controller already errored/closed */
          }
        }
      },
      cancel() {
        // OpenCode cancels the ReadableStream after "tool-calls"; keep the
        // Cursor Run stream alive so the next doStream can write results.
        trace("ReadableStream cancel() → closeUnlessPending")
        sessionManager.closeUnlessPending(activeSession)
      },
    }),
  }
}

export async function pumpWithRecovery(input: {
  initialSession: CursorSession
  controller: ReadableStreamDefaultController<V3Part>
  abortSignal?: AbortSignal
  promptTokens?: number
  retryPolicy?: CursorRetryPolicy
  recover: (recovery: CursorRunRecovery) => Promise<CursorSession>
  onSession?: (session: CursorSession) => void
  maxRecoveries?: number
}): Promise<CursorSession> {
  let session = input.initialSession
  const retryPolicy = input.retryPolicy ?? {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: (input.maxRecoveries ?? 1) + 1,
  }
  const maxRecoveries = retryPolicy.maxAttempts - 1
  const requestUsage = { outputChars: 0 }
  input.onSession?.(session)

  for (let attempt = 0; ; attempt++) {
    const pumpedSession = session
    const pumpOwner = Symbol("cursor-pump")
    sessionManager.beginPump(pumpedSession, pumpOwner)
    try {
      await pump(
        pumpedSession,
        input.controller,
        {
          textId: crypto.randomUUID(),
          reasoningId: crypto.randomUUID(),
          promptTokens: input.promptTokens ?? 0,
          requestUsage,
        },
        input.abortSignal,
      )
      return session
    } catch (error) {
      const failure = toCursorProviderError(error, {
        replaySafe: error instanceof CursorProviderError ? error.replaySafe : false,
        fallback: "Cursor Run interrupted",
      })
      if (!failure.transient) throw failure
      const checkpoint = pumpedSession.resumeCheckpoint
      if (!failure.replaySafe && !checkpoint) {
        throw retrySuppressedError(
          failure,
          "after visible output or stateful server activity",
          attempt + 1,
          maxRecoveries + 1,
        )
      }
      if (attempt >= maxRecoveries) {
        throw new CursorRetryExhaustedError(attempt + 1, failure)
      }
      trace(
        `Run interrupted: sessionId=${pumpedSession.sessionId} attempt=${attempt + 1}/${maxRecoveries} ` +
          `err=${failure.message} — ${checkpoint ? `resuming ${checkpoint.length}B checkpoint` : "rebasing fresh Run"}`,
      )
      sessionManager.close(pumpedSession, "remote-error", failure)
      const delayMs = retryDelayMs(failure, attempt + 1, retryPolicy)
      trace(`Run retry backoff: attempt=${attempt + 1}/${maxRecoveries} delayMs=${delayMs}`)
      await sleepForRetry(delayMs, input.abortSignal)
      session = await input.recover(
        checkpoint
          ? {
              kind: "resume",
              conversationId: pumpedSession.conversationId,
              checkpoint: Uint8Array.from(checkpoint),
            }
          : { kind: "rebase" },
      )
      input.onSession?.(session)
    } finally {
      sessionManager.endPump(pumpedSession, pumpOwner)
    }
  }
}

export type CursorRunRecovery =
  | { kind: "rebase" }
  | { kind: "resume"; conversationId: string; checkpoint: Uint8Array }

async function startSession(
  modelId: string,
  token: string,
  callOptions: LanguageModelV3CallOptions,
  options: CreateCursorOptions,
  startOptions?: { recovery?: CursorRunRecovery },
): Promise<CursorSession> {
  const continuationPolicy = resolveContinuationPolicy(options.continuation)
  const prompt = callOptions.prompt
  const incomingTools = extractTools(callOptions)
  const sessionKey = opencodeSessionKey(callOptions)
  const providerOptions = callOptions.providerOptions?.cursor as Record<string, unknown> | undefined
  // The classic plugin marks OpenCode's agent="compaction" through chat.params.
  // Do not infer this from tools/toolChoice: standalone no-tool calls are valid.
  const isCompaction = providerOptions?.[CURSOR_COMPACTION_OPTION] === true
  const toolState = resolveTurnToolState({
    sessionKey,
    incomingTools,
    toolChoice: callOptions.toolChoice,
    isCompaction,
  })
  const tools = toolState.advertisedTools
  const allowTools = toolState.allowTools
  const resetState = resolveTurnConversationReset({ sessionKey, isCompaction })
  const recovery = startOptions?.recovery
  const resuming = recovery?.kind === "resume"
  // Compaction must not reuse the prior conversation; its first normal turn
  // must also rebase so the summary-agent checkpoint cannot replace the normal
  // system prompt and OpenCode's newly compacted history.
  const bound = resuming
    ? { conversationId: recovery.conversationId, reset: false, previousId: undefined }
    : bindConversationId(sessionKey, { reset: resetState.reset || recovery?.kind === "rebase" })
  const conversationId = bound.conversationId
  if (bound.reset) {
    trace(
      `conversation reset: reason=${recovery?.kind === "rebase" ? "interrupted-run" : (resetState.reason ?? "unknown")} ` +
        `sessionKey=${sessionKey ?? "(none)"} ` +
        `previousId=${bound.previousId ?? "-"} → conversationId=${conversationId}`,
    )
  }

  const userText = recovery?.kind === "rebase"
    ? "Continue the interrupted turn from the conversation history above. Do not repeat completed work."
    : (extractUserText([...prompt].reverse().find((m) => m.role === "user")) || ".")
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd())
  const baseSystemPrompt = extractSystemPrompt(prompt)
  const interactionGuidance = buildOpenCodeInteractionGuidance(tools, isCompaction, workspaceRoot)
  const systemPrompt = interactionGuidance
    ? [baseSystemPrompt, interactionGuidance].filter(Boolean).join("\n\n")
    : baseSystemPrompt
  const history = extractPromptHistory(prompt, {
    preserveTrailingUser: recovery?.kind === "rebase",
    toolResults: isCompaction ? "all" : (recovery?.kind === "rebase" ? "trailing" : "omit"),
  })

  await loadAvailableModels()

  // Resolve the region-specific Run stream origin once per process (memoized
  // in agent-url.ts). Explicit agent host overrides skip GetServerConfig but
  // still go through the Cursor agent-host allowlist.
  const agentBaseUrl =
    resolveExplicitAgentBaseURL(options) ??
    (await resolveAgentUrl(token, {
      apiBaseURL: resolveApiBaseURL(options),
      telemetryEnabled: resolveTelemetryEnabled(options),
    }))

  // OpenCode merges model, agent, and selected-variant options before placing
  // them under providerOptions.cursor. Read only the plugin's dedicated nested
  // payload so unrelated options never become requested_model.parameters.
  const picked = extractCursorVariantParameters(providerOptions)
  const cursorModelId = resolveCursorWireModelId(providerOptions, modelId)
  const reasoningEffort = typeof providerOptions?.reasoningEffort === "string"
    ? providerOptions.reasoningEffort
    : undefined
  const hintMaxMode = !!(providerOptions?.maxMode ?? false)

  const modelInfo = _availableModels?.find((m) => m.id === cursorModelId)
  const parameterValues = resolveVariantParameters(modelInfo, {
    reasoningEffort,
    maxMode: hintMaxMode,
    picked,
  })
  // Wire max_mode from the hint *or* a 1m context pick — OpenCode's variant
  // paramMap does not include a maxMode key when the user selects 1m.
  const maxMode = hintMaxMode || paramsImplyMaxMode(parameterValues)

  // Do NOT pass callOptions.abortSignal into the h2 Run stream. OpenCode aborts
  // that signal when a turn ends with tool-calls; the Cursor stream must stay
  // open until we write the exec results on the next doStream.
  const stream = await bidiRunStream(token, {
    baseURL: agentBaseUrl,
    headers: options.headers,
  })
  const requestContext = await buildRequestContext({ workspaceRoot, tools })
  // Resolve descriptors once from the merged OpenCode config so MCP identity is
  // consistent across AgentRunRequest and both request_context reply paths.
  const toolDescriptors = Array.isArray(requestContext.tools)
    ? requestContext.tools as Array<Record<string, unknown>>
    : []
  // CLI parity: echo the last conversation_checkpoint_update as conversation_state.
  // After compaction reset there is no checkpoint — seed from OpenCode history.
  const conversationState = resuming
    ? recovery.checkpoint
    : (bound.reset ? undefined : getCheckpoint(conversationId))
  const reqBytes = buildRunRequest({
    text: userText,
    modelId: cursorModelId,
    conversationId,
    systemPrompt: conversationState ? undefined : systemPrompt,
    history: conversationState ? undefined : history,
    conversationState,
    parameterValues,
    maxMode,
    tools,
    toolDescriptors,
    requestContext,
    action: resuming ? "resume" : "user",
  })
  // Content hashes — Cursor content-addresses large payloads; logging these lets
  // us match a server get_blob_args.blob_id to what it wants served.
  const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex")
  const skillsCount = Array.isArray(requestContext.agent_skills)
    ? requestContext.agent_skills.length
    : 0
  const hooksCtx =
    typeof requestContext.hooks_additional_context === "string"
      ? requestContext.hooks_additional_context
      : ""
  const historyChars = history.reduce((n, m) => n + m.content.length, 0)
  const usageEstimate = {
    inputTokens: estimateTokens(
      (systemPrompt?.length ?? 0) + userText.length + historyChars + (conversationState?.length ?? 0),
    ),
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  trace(
    `outbound Run: model=${cursorModelId} opencodeModel=${modelId} conversationId=${conversationId} ` +
      `params=${JSON.stringify(parameterValues ?? [])} ` +
      `maxMode=${maxMode} systemPromptLen=${systemPrompt?.length ?? 0} ` +
      `tools=${tools.length} incomingTools=${incomingTools.length} compaction=${isCompaction} ` +
      `skills=${skillsCount} hooks=${hooksCtx ? hooksCtx.split("\n").length : 0} ` +
      `availableModels=${_availableModels?.length ?? 0} userTextLen=${userText.length} ` +
      `historyMsgs=${history.length} historyChars=${historyChars} ` +
      `checkpointLen=${conversationState?.length ?? 0} reset=${bound.reset} ` +
      `resume=${resuming} ` +
      `usageEstimateIn=${usageEstimate.inputTokens} runRequestBytes=${reqBytes.length}`,
  )
  if (hooksCtx) trace(`outbound Run hooks_additional_context: ${hooksCtx}`)
  trace(`hash run_request sha256=${sha(reqBytes)}`)
  if (systemPrompt) trace(`hash systemPrompt sha256=${sha(systemPrompt)}`)
  if (conversationState) trace(`hash checkpoint sha256=${sha(conversationState)}`)

  try {
    await writeWithBackpressure(stream, reqBytes, "initial Run request")
  } catch (error) {
    stream.destroy()
    throw error
  }

  const session: CursorSession = {
    sessionId: crypto.randomUUID(),
    conversationId,
    resumeCheckpoint: undefined,
    openCodeSessionId: sessionKey,
    stream,
    frames: stream.frames()[Symbol.asyncIterator](),
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors,
    requestContext,
    allowTools,
    usageEstimate,
    pumpActive: false,
    pumpOwner: null,
    heartbeat: null,
    heartbeatCancel: null,
    hardDeadlineTimer: null,
    semanticDeadlineCancel: null,
    terminalUnsubscribe: null,
    deferredTerminalReason: null,
    policy: continuationPolicy,
    createdAt: Date.now(),
    lastInboundAt: Date.now(),
    lastHeartbeatWriteAt: Date.now(),
    semanticDeadlineAt: Date.now() + continuationPolicy.semanticIdleMs,
    closeError: null,
    closed: false,
  }
  sessionManager.registerSession(session)
  let heartbeatWritePending = false
  session.heartbeat = setInterval(() => {
    if (session.closed) return
    if (heartbeatWritePending) {
      sessionManager.close(
        session,
        "heartbeat-write-failed",
        new CursorTransportError("Cursor heartbeat write remained backpressured", {
          transient: false,
          replaySafe: false,
          code: "CURSOR_HEARTBEAT_BACKPRESSURE",
        }),
      )
      return
    }
    heartbeatWritePending = true
    void writeWithBackpressure(stream, buildHeartbeat(), "heartbeat")
      .then(() => sessionManager.recordHeartbeatWrite(session))
      .catch((cause) => {
        sessionManager.close(
          session,
          "heartbeat-write-failed",
          toCursorProviderError(cause, {
            replaySafe: false,
            fallback: "Cursor heartbeat write failed",
          }),
        )
      })
      .finally(() => { heartbeatWritePending = false })
  }, continuationPolicy.heartbeatMs)
  session.heartbeat.unref?.()
  session.heartbeatCancel = () => {
    if (session.heartbeat) clearInterval(session.heartbeat)
  }

  callOptions.abortSignal?.addEventListener("abort", () => {
    // Abort after tool-calls is normal — preserve pending sessions.
    trace("abortSignal aborted → closeUnlessPending")
    sessionManager.closeUnlessPending(session)
  }, { once: true })
  return session
}

/**
 * OpenCode re-sends the full tool-result history on every continuation. Prefer
 * the newest result that still has a live pending exec on its tagged session.
 */
export function findContinuationSession(
  toolResults: Array<{ sessionId: string; execId: number }>,
): CursorSession | undefined {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i]
    const s = sessionManager.findByExecIds(r.sessionId, [r.execId])
    if (s) return s
  }
  return undefined
}

/**
 * Deliver trailing tool results onto a live continuation session.
 * Returns the same session when writes succeed (or only bridged results were
 * cleared). Returns undefined after closing the session when a write fails, so
 * the caller can rebase onto a fresh Run instead of pumping a dead stream.
 */
export function deliverContinuationResults(
  session: CursorSession,
  trailingToolResults: ExtractedToolResult[],
): CursorSession | undefined {
  const pendingResults = trailingToolResults.filter(
    (r) => r.sessionId === session.sessionId && session.pending.has(r.execId),
  )
  trace(
    `continuation: ${trailingToolResults.length} trailing tool result(s), ` +
      `${pendingResults.length} pending for sessionId=${session.sessionId} ` +
      `pending={${[...session.pending.keys()].join(",")}}`,
  )
  for (const r of pendingResults) {
    const claim = sessionManager.claim(session.sessionId, r.execId)
    if ("kind" in claim) {
      if (claim.kind === "deliverable") {
        throw new CursorProtocolError("Cursor continuation claim remained unclaimed")
      }
      if (claim.kind === "duplicate") {
        trace(`continuation: skipped duplicate execId=${r.execId} reason=${claim.reason}`)
        continue
      }
      trace(`continuation: unavailable execId=${r.execId} reason=${claim.reason}`)
      return undefined
    }
    const pending = claim.pending
    let frames: Uint8Array[] = []
    if (!pending.bridged) {
      try {
        const shellResult =
          pending.resultField === "shell_stream"
          || pending.resultField === "background_shell_spawn_result"
            ? consumeCursorShellResult(r.toolCallId, r.output)
            : undefined
        frames = buildExecClientMessages({
          execId: r.execId,
          resultField: pending.resultField,
          output: shellResult?.output ?? r.output,
          error: r.error,
          toolName: pending.toolName ?? r.toolName,
          resultMetadata: pending.resultMetadata,
          shellOutcome: shellResult?.outcome,
        })
      } catch (error) {
        trace(`continuation: result encode FAILED execId=${r.execId} err=${(error as Error).message}`)
        sessionManager.close(session, "result-write-failed")
        return undefined
      }
    }
    const outcome = sessionManager.deliverClaim(claim, frames)
    if (outcome.kind !== "delivered") {
      trace(`continuation: delivery stopped execId=${r.execId} reason=${outcome.reason}`)
      if (outcome.kind === "duplicate") continue
      return undefined
    }
    session.usageEstimate.inputTokens += estimateTokens(r.output.length)
    if (pending.bridged) {
      trace(
        `continuation: completed bridged result execId=${r.execId} toolName=${pending.toolName ?? r.toolName} outLen=${r.output.length}`,
      )
      continue
    }
    trace(
      `continuation: wrote exec result execId=${r.execId} field=${pending.resultField} ` +
        `frames=${outcome.framesWritten} outLen=${r.output.length}`,
    )
  }
  return session
}

async function loadAvailableModels(): Promise<void> {
  const cacheDir = opencodeGlobalCacheDir()
  try {
    const filePath = cacheFilePath(cacheDir)
    let mtime = 0
    try {
      const stat = await fs.promises.stat(filePath)
      mtime = stat.mtimeMs
    } catch {
      // file missing — fall through with mtime=0
    }
    // Re-read when the file changed (discoverModels background refresh).
    if (mtime !== _availableModelsMtimeMs) {
      const cached = await readCache(cacheDir)
      _availableModels = cached?.models
      _availableModelsMtimeMs = mtime
    }
  } catch { /* ignore */ }
}

function resolveApiBaseURL(options: CreateCursorOptions): string {
  return options.apiBaseURL ?? process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
}

function resolveTelemetryEnabled(options: CreateCursorOptions): boolean {
  return options.telemetryEnabled ?? isTruthyEnv(process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY)
}

function resolveExplicitAgentBaseURL(options: CreateCursorOptions): string | undefined {
  const raw = options.agentBaseURL ?? options.baseURL
  if (!raw) return undefined
  const normalized = normalizeAgentRunOrigin(raw)
  if (!normalized) {
    throw new CursorProtocolError(
      "Invalid Cursor agent base URL override: expected https://*.cursor.sh",
    )
  }
  return normalized
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true"
}

async function writeWithBackpressure(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
): Promise<void> {
  let accepted: boolean | void
  try {
    accepted = stream.write(message)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} write failed`,
    })
  }
  if (accepted !== false) return
  if (!stream.waitForDrain) {
    throw new CursorTransportError(`Cursor ${operation} write was backpressured`, {
      transient: false,
      replaySafe: false,
      code: "CURSOR_WRITE_BACKPRESSURE",
    })
  }
  try {
    await stream.waitForDrain(5_000)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} backpressure drain failed`,
    })
  }
}

async function nextFrameWithSemanticDeadline(
  session: CursorSession,
): Promise<IteratorResult<Frame>> {
  const remainingMs = session.semanticDeadlineAt - Date.now()
  if (remainingMs <= 0) {
    throw new CursorTransportError(
      `Cursor semantic-progress timeout after ${session.policy.semanticIdleMs}ms`,
      { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" },
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCancelled: ((error: CursorProviderError) => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    rejectCancelled = reject
    timer = setTimeout(() => {
      reject(
        new CursorTransportError(
          `Cursor semantic-progress timeout after ${session.policy.semanticIdleMs}ms`,
          { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" },
        ),
      )
    }, remainingMs)
    timer.unref?.()
  })
  session.semanticDeadlineCancel = () => {
    rejectCancelled?.(
      session.closeError ?? new CursorTransportError("Cursor semantic wait cancelled locally", {
        transient: false,
        replaySafe: false,
      }),
    )
  }
  try {
    return await Promise.race([session.frames.next(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
    session.semanticDeadlineCancel = null
  }
}

/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - a tool call (exec_server_message) → emit tool-call, finish "tool-calls",
 *    and KEEP the session open for the result on the next doStream call;
 *  - turn_ended → finish "stop" and close the session;
 *  - transport EOF before turn_ended → throw for one fresh-Run recovery.
 */
export async function pump(
  session: CursorSession,
  controller: ReadableStreamDefaultController<V3Part>,
  ids: {
    textId: string
    reasoningId: string
    promptTokens?: number
    requestUsage?: { outputChars: number }
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  sessionManager.registerSession(session)
  const { textId, reasoningId } = ids
  const promptTokens = ids.promptTokens ?? 0
  const advertisedToolNames = advertisedToolNamesFromDescriptors(session.toolDescriptors)
  const advertisedToolNameSet = new Set(advertisedToolNames)
  let textStarted = false
  let reasoningStarted = false
  const requestUsage = ids.requestUsage ?? { outputChars: 0 }
  let replaySafe = true
  // OpenCode cancels the ReadableStream between turns (see the cancel handler
  // in doStreamImpl). The frames iterator can still yield a final `done` after
  // the cancel lands — controller.enqueue on a cancelled controller throws.
  // safeEnqueue swallows that throw and tracks the close so we stop pumping.
  let streamClosed = false
  const safeEnqueue = (part: V3Part): boolean => {
    if (streamClosed) return false
    try {
      controller.enqueue(part)
      return true
    } catch (e) {
      streamClosed = true
      trace(`pump: enqueue on closed controller (suppressing) err=${(e as Error).message}`)
      return false
    }
  }
  const safeError = (err: Error): void => {
    if (streamClosed) return
    try {
      controller.error(err)
    } catch (e) {
      trace(`pump: controller.error failed (suppressing) err=${(e as Error).message}`)
    }
    streamClosed = true
  }

  /** Reply on Cursor's correlated exec channel without exposing a host tool call. */
  const rejectExec = (parsed: ParsedExecRequest, reason: string, label: string): boolean => {
    try {
      for (const frame of buildExecClientMessages({
        execId: parsed.id,
        resultField: parsed.resultField,
        output: "",
        error: reason,
        toolName: parsed.toolName,
        resultMetadata: parsed.resultMetadata,
      })) {
        session.stream.write(frame)
      }
      trace(`exec: REFUSED ${label} toolName=${parsed.toolName} id=${parsed.id}`)
      return true
    } catch (e) {
      const error = new Error(
        `Failed to reject Cursor tool request (${label}): ${(e as Error).message}`,
      )
      trace(`exec: REFUSED reply FAILED ${error.message}`)
      safeError(error)
      sessionManager.close(session)
      return false
    }
  }

  /**
   * Cursor's streamed edit handshake reads the target before it sends the
   * replacement through write_args. For a new file that read naturally fails,
   * which makes the model abandon the edit and fall back to a shell heredoc.
   * Treat only a missing target correlated to an edit_tool_call as an empty
   * file, allowing Cursor to continue to the ordinary OpenCode write call.
   */
  const recoverMissingEditRead = (
    parsed: ParsedExecRequest,
    displayCallId: string | undefined,
  ): boolean => {
    if (
      !displayCallId ||
      parsed.resultField !== "read_result" ||
      parsed.toolName !== "read" ||
      !advertisedToolNameSet.has("write")
    ) return false

    const stored = session.displayToolCalls.get(displayCallId)
    const display = parseDisplayToolCall(displayCallId, stored)
    if (display?.variant !== "edit_tool_call" || display.bridgeable === false) return false

    const requestedPath = typeof parsed.args.filePath === "string" ? parsed.args.filePath : ""
    const editPath = typeof display.args.path === "string" ? display.args.path : ""
    if (!requestedPath || !editPath) return false

    // Prefer env.workspace_paths — project_folder / workspace_project_dir are
    // Cursor metadata roots under ~/.cache/opencode/projects/, not the git tree.
    const workspaceRoot = workspaceRootFromRequestContext(session.requestContext)
    const resolvePath = (value: string) => path.resolve(workspaceRoot, value)
    const absolutePath = resolvePath(requestedPath)
    if (absolutePath !== resolvePath(editPath) || fs.existsSync(absolutePath)) return false

    try {
      for (const frame of buildExecClientMessages({
        execId: parsed.id,
        resultField: parsed.resultField,
        output: "",
        toolName: parsed.toolName,
        resultMetadata: { path: requestedPath },
      })) {
        session.stream.write(frame)
      }
      trace(
        `exec: missing edit target treated as empty file id=${parsed.id} ` +
          `path=${JSON.stringify(requestedPath)}; awaiting write_args`,
      )
      return true
    } catch (e) {
      const error = new Error(
        `Failed to recover Cursor edit read for a new file: ${(e as Error).message}`,
      )
      trace(`exec: edit read recovery FAILED ${error.message}`)
      safeError(error)
      sessionManager.close(session)
      return true
    }
  }

  /** AI SDK V3 requires text-end / reasoning-end before finish or tool-call. */
  const closeOpenSpans = () => {
    for (const part of spanEndParts({ textStarted, reasoningStarted, textId, reasoningId })) {
      safeEnqueue(part as V3Part)
    }
    reasoningStarted = false
    textStarted = false
  }

  const emitText = (text: string) => {
    if (!text) return
    replaySafe = false
    // Close reasoning before text (hosts expect reasoning-end before text-start).
    if (reasoningStarted && !textStarted) {
      safeEnqueue({ type: "reasoning-end", id: reasoningId } as V3Part)
      reasoningStarted = false
    }
    if (!textStarted) {
      safeEnqueue({ type: "text-start", id: textId } as V3Part)
      textStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    if (safeEnqueue({ type: "text-delta", id: textId, delta: text } as V3Part)) {
      requestUsage.outputChars += text.length
    }
  }
  const emitReasoning = (text: string) => {
    if (!text) return
    replaySafe = false
    if (!reasoningStarted) {
      safeEnqueue({ type: "reasoning-start", id: reasoningId } as V3Part)
      reasoningStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    if (safeEnqueue({ type: "reasoning-delta", id: reasoningId, delta: text } as V3Part)) {
      requestUsage.outputChars += text.length
    }
  }
  const emitFinish = (
    te: Record<string, unknown> | undefined,
    reason: LanguageModelV3FinishReason,
  ) => {
    closeOpenSpans()
    if (te) {
      // Authoritative TurnEnded counts — replace the running estimate.
      session.usageEstimate = {
        inputTokens: Number(te.input_tokens ?? 0) || 0,
        outputTokens: Number(te.output_tokens ?? 0) || 0,
        cacheRead: Number(te.cache_read ?? 0) || 0,
        cacheWrite: Number(te.cache_write ?? 0) || 0,
      }
    }
    const est = session.usageEstimate
    const usage: LanguageModelV3Usage = {
      inputTokens: {
        total: promptTokens,
        noCache: undefined,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: estimateTokens(requestUsage.outputChars),
        text: undefined,
        reasoning: undefined,
      },
    }
    const providerMetadata = te ? cursorTurnEndedProviderMetadata(te) : undefined
    const reasonLabel = typeof reason === "object" && reason && "unified" in reason
      ? String((reason as { unified?: string }).unified ?? "unknown")
      : String(reason)
    trace(
      `finish: reason=${reasonLabel} ` +
        `requestIn=${usage.inputTokens.total} requestOut=${usage.outputTokens.total} ` +
        `rawIn=${est.inputTokens} rawOut=${est.outputTokens} ` +
        `rawCacheRead=${est.cacheRead} rawCacheWrite=${est.cacheWrite} ` +
        `source=${te ? "turn_ended" : "estimate"}`,
    )
    safeEnqueue({
      type: "finish",
      usage,
      finishReason: reason,
      ...(providerMetadata ? { providerMetadata } : {}),
    } as V3Part)
  }

  while (true) {
    // Consumer cancelled / closed the ReadableStream. Stop reading Cursor
    // frames so a continuation doStream can resume the same iterator —
    // keeping the loop alive would discard frames the next pump needs.
    if (streamClosed) {
      trace(`pump: stream closed (consumer cancelled) pending=${session.pending.size}`)
      sessionManager.closeUnlessPending(session)
      return
    }
    if (abortSignal?.aborted) {
      // Stop feeding this ReadableStream, but keep the Run session if we still
      // owe Cursor an exec result (OpenCode aborts between tool-call turns).
      trace(`pump: abortSignal aborted pending=${session.pending.size}`)
      sessionManager.closeUnlessPending(session)
      return
    }

    let next: IteratorResult<Frame>
    try {
      next = session.pending.size === 0
        ? await nextFrameWithSemanticDeadline(session)
        : await session.frames.next()
    } catch (error) {
      closeOpenSpans()
      const failure = error instanceof CursorProviderError
        ? error
        : new CursorRunInterruptedError(
            `Cursor Run frame stream interrupted: ${(error as Error).message}`,
            { cause: error },
          )
      failure.replaySafe = replaySafe && failure.replaySafe
      throw failure
    }
    if (next.done) {
      closeOpenSpans()
      trace("pump: frames iterator ended before turn_ended")
      const failure = new CursorRunInterruptedError()
      failure.replaySafe = replaySafe
      throw failure
    }
    const frame = next.value as Frame

    if (frame.flags & 0x02) {
      // A successful agent turn has an explicit turn_ended update before the
      // Connect envelope closes. Reaching end-stream here means the Run was
      // interrupted, even if the HTTP status itself was 200.
      let payload = ""
      if (frame.payload.length > 0) {
        try {
          payload = new TextDecoder().decode(decodeFramePayload(frame))
        } catch { /* not decodable */ }
      }
      closeOpenSpans()
      const failure = payload
        ? connectFrameError(payload)
        : new CursorRunInterruptedError()
      failure.replaySafe = replaySafe && failure.replaySafe
      throw failure
    }

    // decodeFramePayload can throw on a corrupt gzip payload (gunzipSync).
    // Skip the frame rather than abort the whole turn.
    let payload: Uint8Array
    try {
      payload = decodeFramePayload(frame)
    } catch (e) {
      trace(`gunzip FAILED (skipping frame): flags=0x${frame.flags.toString(16)} len=${frame.payload.length} err=${(e as Error).message}`)
      continue
    }
    let asm: Record<string, unknown>
    try {
      asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", payload)
    } catch (e) {
      // A single malformed/truncated frame must not abort the whole turn
      // (protobufjs throws "index out of range: …" on length overruns). Log it
      // and keep pumping.
      replaySafe = false
      const preview = Array.from(payload.subarray(0, 32))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("")
      trace(
        `decode FAILED (skipping): flags=0x${frame.flags.toString(16)} len=${payload.length} ` +
          `topField=${payload.length ? payload[0] >> 3 : "-"} err=${(e as Error).message} hex=${preview}`,
      )
      continue
    }
    const iu = asm.interaction_update as Record<string, unknown> | undefined
    const esm = asm.exec_server_message as Record<string, unknown> | undefined
    const kv = asm.kv_server_message as Record<string, unknown> | undefined
    const interactionQuery = asm.interaction_query as Record<string, unknown> | undefined
    const checkpointRaw = asm.conversation_checkpoint_update
    const topField = payload.length > 0 ? payload[0] >> 3 : 0
    const textProgress = (iu?.text_delta as Record<string, unknown> | undefined)?.text
    const thinkingProgress = (iu?.thinking_delta as Record<string, unknown> | undefined)?.text
    const checkpointProgress = normalizeCheckpointBytes(checkpointRaw)
    if (
      (typeof textProgress === "string" && textProgress.length > 0) ||
      (typeof thinkingProgress === "string" && thinkingProgress.length > 0) ||
      !!iu?.turn_ended ||
      !!iu?.tool_call_started ||
      !!iu?.tool_call_completed ||
      !!esm ||
      !!kv ||
      !!interactionQuery ||
      !!checkpointProgress?.length
    ) {
      replaySafe = false
      sessionManager.recordSemanticProgress(session)
    }

    {
      const iuKind = iu ? Object.keys(iu).find((k) => iu[k]) : undefined
      trace(
        `pump frame: topField=${topField} interaction_update=${iuKind ?? "-"} ` +
          `exec=${esm ? "yes" : "no"} kv=${kv ? "yes" : "no"} ` +
          `interaction_query=${interactionQuery ? "yes" : "no"} ` +
          `checkpoint=${checkpointRaw ? "yes" : "no"}`,
      )
    }

    try {
    // CLI: conversationCheckpointUpdate → replace agentStore conversation state.
    // Store opaque bytes keyed by conversation_id; next Run echoes them.
    if (checkpointRaw != null) {
      const bytes = normalizeCheckpointBytes(checkpointRaw)
      if (bytes && bytes.length > 0) {
        setCheckpoint(session.conversationId, bytes)
        session.resumeCheckpoint = Uint8Array.from(bytes)
        trace(
          `checkpoint: stored ${bytes.length}B for conversationId=${session.conversationId}`,
        )
      }
    }

    if (iu?.text_delta) {
      emitText(((iu.text_delta as Record<string, unknown>).text as string) ?? "")
    } else if (iu?.thinking_delta) {
      emitReasoning(((iu.thinking_delta as Record<string, unknown>).text as string) ?? "")
    } else if (iu?.turn_ended) {
      emitFinish(iu.turn_ended as Record<string, unknown>, { unified: "stop", raw: undefined })
      sessionManager.close(session)
      return
    } else if (iu?.tool_call_started) {
      // Stash Cursor display ToolCall until exec claims it, or completed bridges it.
      const started = iu.tool_call_started as Record<string, unknown>
      const callId = typeof started.call_id === "string" ? started.call_id : ""
      const toolCall = started.tool_call as Record<string, unknown> | undefined
      if (callId && toolCall) {
        session.displayToolCalls.set(callId, toolCall)
        const variant = Object.keys(toolCall).find((k) => k.endsWith("_tool_call")) ?? "?"
        const callIdLog = callId.replace(/\r?\n/g, "\\n")
        let wireFields = ""
        if (variant === "?") {
          const toolBytes = extractProtobufSubmessage(payload, [1, 2, 2])
          if (toolBytes) {
            wireFields = ` wireFields=[${listProtobufFieldNumbers(toolBytes).join(",")}]`
          }
        }
        trace(`display tool_call_started: callId=${callIdLog} variant=${variant}${wireFields}`)
      }
    } else if (iu?.tool_call_completed) {
      const completed = iu.tool_call_completed as Record<string, unknown>
      const callId = typeof completed.call_id === "string" ? completed.call_id : ""
      // If exec already claimed this call_id, display map entry is gone — skip.
      if (!callId || !session.displayToolCalls.has(callId)) {
        if (callId) {
          trace(`display tool_call_completed: ignore (exec-handled or unknown) callId=${callId}`)
        }
      } else {
        const stored = session.displayToolCalls.get(callId)!
        session.displayToolCalls.delete(callId)
        const toolCall =
          (completed.tool_call as Record<string, unknown> | undefined) ?? stored
        if (!session.allowTools) {
          trace(`display tool_call_completed: SKIPPED (allowTools=false) callId=${callId}`)
        } else {
          const display = parseDisplayToolCall(callId, toolCall)
          const advertised = advertisedToolNamesFromDescriptors(session.toolDescriptors)
          const bridged = display
            ? resolveBridgedOpenCodeToolCall(display, advertised)
            : undefined
          if (!display) {
            const callIdLog = callId.replace(/\r?\n/g, "\\n")
            // AgentServerMessage.interaction_update(1).tool_call_completed(3).tool_call(2)
            const toolBytes = extractProtobufSubmessage(payload, [1, 3, 2])
            const wire = toolBytes
              ? ` wireFields=[${listProtobufFieldNumbers(toolBytes).join(",")}]`
              : ""
            trace(
              `display tool_call_completed: unparsed callId=${callIdLog} ` +
                `keys=[${Object.keys(toolCall).join(",")}]${wire}`,
            )
          } else if (!bridged) {
            trace(
              `display tool_call_completed: no advertised OpenCode tool ` +
                `callId=${callId} variant=${display.variant} preferred=${display.preferredToolName} ` +
                `advertised=[${advertised.join(",")}]`,
            )
          } else {
            const execId = session.nextBridgedExecId++
            sessionManager.registerPending(
              execId,
              session,
              "bridged",
              bridged.toolName,
              true,
            )
            const toolCallId = `cursor_${session.sessionId}_${execId}`
            const input = JSON.stringify(bridged.args ?? {})
            trace(
              `display BRIDGED tool-call toolCallId=${toolCallId} toolName=${bridged.toolName} ` +
                `variant=${bridged.variant} callId=${callId} inputLen=${input.length}`,
            )
            closeOpenSpans()
            safeEnqueue({
              type: "tool-call",
              toolCallId,
              toolName: bridged.toolName,
              input,
            } as V3Part)
            emitFinish(undefined, { unified: "tool-calls", raw: undefined })
            return
          }
        }
      }
    } else if (esm) {
      const esmId = (esm.id as number) ?? 0
      if (esm.request_context_args) {
        // Server turn-setup probe (#10). Reply with full OpenCode-sourced context.
        {
          const rc = session.requestContext
          const skills = Array.isArray(rc.agent_skills) ? rc.agent_skills.length : 0
          const hooks =
            typeof rc.hooks_additional_context === "string" ? rc.hooks_additional_context : ""
          trace(
            `exec request_context: id=${esmId} — replying context ` +
              `tools=${session.toolDescriptors.length} skills=${skills} ` +
              `hooks=${hooks ? hooks.split("\n").length : 0}`,
          )
          if (hooks) trace(`exec request_context hooks_additional_context: ${hooks}`)
        }
        try {
          traceRequestContextPaths(
            `exec request_context reply id=${esmId}`,
            session.requestContext,
          )
          session.stream.write(buildRequestContextResult(esmId, session.requestContext))
          trace(`exec request_context: replied`)
        } catch (e) {
          const error = new Error(
            `Failed to answer Cursor request_context probe: ${(e as Error).message}`,
          )
          trace(`exec request_context: write FAILED ${error.message}`)
          safeError(error)
          sessionManager.close(session)
          return
        }
      } else if (esm.mcp_state_exec_args) {
        // MCP-backed writes/reads can be preceded by this control-plane probe.
        // Confirm the virtual servers from the already-advertised context, then
        // keep pumping until Cursor emits the actual mcp_args tool request.
        const stateArgs = esm.mcp_state_exec_args as Record<string, unknown>
        const requested = Array.isArray(stateArgs.server_identifiers)
          ? stateArgs.server_identifiers.join(",")
          : ""
        try {
          session.stream.write(buildMcpStateResult(esmId, stateArgs, session.requestContext))
          trace(`exec mcp_state: replied id=${esmId} requested=[${requested}]`)
        } catch (e) {
          const error = new Error(`Failed to answer Cursor MCP state probe: ${(e as Error).message}`)
          trace(`exec mcp_state: write FAILED ${error.message}`)
          safeError(error)
          sessionManager.close(session)
          return
        }
      } else {
        const parsed = parseExecServerMessage(esm)
        const displayCallId = extractExecDisplayCallId(esm)
        trace(`exec: id=${parsed?.id} variant=${parsed ? Object.keys(parsed).join(",") : "none"} toolName=${parsed?.toolName} resultField=${parsed?.resultField}`)
        if (parsed) {
          if (parsed.localError) {
            if (!rejectExec(parsed, parsed.localError, "invalid mapping")) return
            continue
          }
          // OpenCode throws "Tool call not allowed while generating summary"
          // when assistantMessage.summary is set. Compaction/summary turns
          // advertise no tools — refuse on the Cursor channel and keep
          // pumping for text / turn_ended instead of emitting tool-call.
          if (!session.allowTools) {
            const reason = "Tool calls are not available during this turn (summary/compaction)."
            if (!rejectExec(parsed, reason, "allowTools=false")) return
            continue
          }
          // Cursor has native capabilities (Task, filesystem, shell, etc.) in
          // addition to the MCP descriptors sent by this provider. The model
          // can request one even when the current OpenCode agent omitted its
          // corresponding host tool. Emitting that request makes OpenCode
          // manufacture an `invalid` tool result. Refuse it on the held-open
          // Cursor exec channel instead, using the request's exact typed result.
          if (!advertisedToolNameSet.has(parsed.toolName)) {
            const available = advertisedToolNames.length > 0
              ? advertisedToolNames.join(", ")
              : "none"
            const reason =
              `OpenCode tool '${parsed.toolName}' is unavailable for the current agent. ` +
              `Available tools: ${available}. Continue using only available tools; do not retry ` +
              `'${parsed.toolName}'.`
            trace(
              `exec: unavailable catalog target toolName=${parsed.toolName} ` +
                `advertised=[${advertisedToolNames.join(",")}]`,
            )
            if (!rejectExec(parsed, reason, "unavailable tool")) return
            continue
          }
          if (recoverMissingEditRead(parsed, displayCallId)) continue
          if (displayCallId) {
            session.displayToolCalls.delete(displayCallId)
            trace(`exec: claimed display callId=${displayCallId}`)
          }
          const tc = buildToolCallPart(parsed, session.sessionId)
          if (
            parsed.resultField === "shell_stream"
            || parsed.resultField === "background_shell_spawn_result"
          ) {
            registerCursorShellCall(tc.toolCallId, parsed.resultMetadata)
          }
          // Keep the stream open; the result arrives on the next doStream call.
          sessionManager.registerPending(
            parsed.id,
            session,
            parsed.resultField,
            parsed.toolName,
            false,
            parsed.resultMetadata,
          )
          // tc.input is already a JSON string (LanguageModelV3ToolCall.input).
          trace(`exec: EMITTED tool-call toolCallId=${tc.toolCallId} toolName=${tc.toolName} inputLen=${tc.input.length}`)
          // Close open text/reasoning spans before tool-call (required by AI SDK V3).
          closeOpenSpans()
          safeEnqueue({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          } as V3Part)
          emitFinish(undefined, { unified: "tool-calls", raw: undefined })
          return
        }
        // Never guess a response type for an unknown exec variant. Request and
        // result field numbers are not universally identical; a structurally
        // wrong reply recreates the heartbeat-only deadlock. Fail promptly so
        // schema drift is actionable.
        const variantField = detectExecVariantField(payload)
        const variantDescription = describeCursorExecVariant(variantField)
        const hex = Array.from(payload.subarray(0, 48))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("")
        trace(
          `exec UNMAPPED: id=${esmId} variant=${variantDescription} keys=[${Object.keys(esm).join(",")}] hex=${hex}`,
        )
        const err = new Error(
          `Unsupported Cursor exec variant ${variantDescription} (id=${esmId})`,
        )
        safeError(err)
        sessionManager.close(session)
        return
      }
    } else if (interactionQuery) {
      // InteractionQuery is a must-reply channel, just like exec and KV. AI
      // SDK has no Cursor-specific UI callback, so answer immediately with the
      // conservative headless policy from protocol/interactions.ts (including
      // F14 create_plan auto-ack / empty plan_uri for CLI headless parity).
      try {
        const handled = handleInteractionQuery(interactionQuery, payload)
        session.stream.write(handled.reply)
        trace(
          `interaction_query: replied id=${handled.id} variant=${handled.variantName} ` +
            `field=${handled.variantField} outcome=${handled.outcome}`,
        )
      } catch (e) {
        const info = inspectInteractionQueryWire(payload)
        const err = e instanceof Error ? e : new Error(String(e))
        trace(
          `interaction_query: FAILED id=${info.id ?? "?"} ` +
            `variantField=${info.variantField ?? "?"} err=${err.message}`,
        )
        safeError(err)
        sessionManager.close(session)
        return
      }
    } else if (kv) {
      // KV blob channel: ack set_blob / answer get_blob, then keep pumping.
      // Not replying hangs the turn — see protocol/kv.ts.
      trace(
        `kv frame raw: gunzippedLen=${payload.length} id=${kv.id ?? "?"} ` +
          `get=${!!kv.get_blob_args} set=${!!kv.set_blob_args} ` +
          `getBlobIdLen=${(kv.get_blob_args as any)?.blob_id?.length ?? "-"} ` +
          `setBlobIdLen=${(kv.set_blob_args as any)?.blob_id?.length ?? "-"} ` +
          `setDataLen=${(kv.set_blob_args as any)?.blob_data?.length ?? "-"}`,
      )
      const handled = handleKvServerMessage(kv, session)
      if (handled) {
        try {
          session.stream.write(handled.reply)
          trace(
            `kv replied: kind=${handled.kind} id=${handled.id} blobId=${handled.blobIdHex.slice(0, 16)}… ` +
              `found=${handled.found} echoed=${!!handled.echoed} ` +
              `sessionBlobs=${session.blobs.size} convBlobs=${conversationBlobCount(session.conversationId)}`,
            )
        } catch (e) {
          const error = new Error(`Failed to answer Cursor KV blob request: ${(e as Error).message}`)
          trace(`kv: write FAILED ${error.message}`)
          safeError(error)
          sessionManager.close(session)
          return
        }
      }
    }
    } catch (e) {
      // Any per-frame dispatch throw (e.g. protobufjs length overrun in
      // exec/args decode) must not abort the whole turn — log and skip.
      trace(`frame dispatch FAILED (skipping): topField=${topField} err=${(e as Error).message}`)
    }
    // heartbeat / step / partial_tool_call → ignore (partial args are
    // display-only; the exec channel is authoritative. Checkpoints and
    // interaction queries are handled above.)
  }
}

/** Normalize protobufjs bytes / Buffer / number[] into a Uint8Array. */
function normalizeCheckpointBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw)
  if (Array.isArray(raw)) return Uint8Array.from(raw)
  if (raw && typeof raw === "object" && "type" in (raw as object) && "data" in (raw as object)) {
    // protobufjs sometimes yields { type: "Buffer", data: number[] }
    const data = (raw as { data: unknown }).data
    if (Array.isArray(data)) return Uint8Array.from(data)
  }
  return undefined
}

// ── Prompt extraction ──

type ExtractedToolResult = {
  toolCallId: string
  sessionId: string
  execId: number
  toolName: string
  output: string
  error?: string
}

function extractToolResults(prompt: LanguageModelV3CallOptions["prompt"]): ExtractedToolResult[] {
  const out: ExtractedToolResult[] = []
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      const p = part as unknown as Record<string, unknown>
      if (p.type !== "tool-result") continue
      const toolCallId = (p.toolCallId as string) ?? ""
      const parsed = parseExecIdFromToolCallId(toolCallId)
      if (!parsed) continue
      const { text, isError } = toolResultOutputToText(p.output)
      out.push({
        toolCallId,
        sessionId: parsed.sessionId,
        execId: parsed.execId,
        toolName: (p.toolName as string) ?? "mcp",
        output: text,
        error: isError ? text : undefined,
      })
    }
  }
  return out
}

/**
 * Tool results that form a live continuation: only the trailing run of `tool`
 * messages after the last non-tool message. Mid-prompt historical tool results
 * are ignored — they are conversation history, not replies for a held-open Run.
 */
export function extractTrailingToolResults(
  prompt: LanguageModelV3CallOptions["prompt"],
): ExtractedToolResult[] {
  if (prompt.length === 0) return []
  let i = prompt.length - 1
  while (i >= 0 && prompt[i].role === "tool") i--
  // Continuations end with tool messages. Anything else (user/assistant/system)
  // means this is a fresh model call that merely carries tools in history.
  if (i === prompt.length - 1) return []
  return extractToolResults(prompt.slice(i + 1))
}

function toolResultOutputToText(output: unknown): { text: string; isError: boolean } {
  if (output == null) return { text: "", isError: false }
  if (typeof output === "string") return { text: output, isError: false }
  const o = output as Record<string, unknown>
  // LanguageModelV3 tool-result output: { type: "text"|"json"|"error-text"|..., value }
  const isError = typeof o.type === "string" && (o.type as string).startsWith("error")
  if (o.type === "text" || o.type === "error-text") {
    return { text: String(o.value ?? ""), isError }
  }
  if (o.type === "json" || o.type === "error-json") {
    return { text: JSON.stringify(o.value ?? null), isError }
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    const text = o.value
      .map((c) => {
        const cp = c as Record<string, unknown>
        return cp.type === "text" ? String(cp.text ?? "") : ""
      })
      .join("")
    return { text, isError }
  }
  return { text: JSON.stringify(output), isError }
}

function extractSystemPrompt(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined {
  const parts: string[] = []
  for (const m of prompt) {
    if (m.role === "system" && typeof m.content === "string") parts.push(m.content)
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

/**
 * Cursor's native UI interactions cannot be surfaced through the AI SDK.
 * Redirect only to OpenCode tools that are genuinely advertised this turn;
 * compaction keeps its dedicated summary prompt unchanged.
 */
export function buildOpenCodeInteractionGuidance(
  tools: OpencodeToolDef[],
  isCompaction: boolean,
  workspaceRoot: string,
): string | undefined {
  if (isCompaction) return undefined
  const names = new Set(tools.map((tool) => tool.name))
  if (names.size === 0) return undefined
  const instructions: string[] = []

  if (names.has("question")) {
    instructions.push(
      "- When user input is required, call the OpenCode `question` tool; do not use Cursor's native AskQuestion interaction.",
    )
  }
  if (names.has("plan_enter")) {
    instructions.push(
      "- To enter plan mode, call the OpenCode `plan_enter` tool; do not use Cursor's native SwitchMode or CreatePlan interactions.",
    )
  } else if (names.has("todowrite")) {
    instructions.push(
      "- For planning, call the OpenCode `todowrite` tool and explain the plan in normal text; do not use Cursor's native SwitchMode or CreatePlan interactions.",
    )
  }
  if (names.has("plan_exit")) {
    instructions.push("- To leave plan mode, call the OpenCode `plan_exit` tool.")
  }
  if (names.has("webfetch")) {
    instructions.push(
      "- To fetch a known URL, call the OpenCode `webfetch` tool; do not use Cursor's native WebFetch interaction.",
    )
  }
  if (names.has("write")) {
    instructions.push(
      names.has("edit")
        ? "- For file changes, use OpenCode `edit` for targeted changes to existing files and `write` to create files or intentionally replace complete contents; do not use shell, Python, or heredocs to change file content while these tools are available."
        : "- Use OpenCode `write` for file-content changes; do not use shell, Python, or heredocs to change file content while it is available.",
    )
  }
  return [
    `OpenCode exposes exactly these executable tools for this turn: ${[...names].map((name) => `\`${name}\``).join(", ")}.`,
    `Workspace root: ${JSON.stringify(workspaceRoot)}. Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them.`,
    "Call only tools in that exact list. Cursor-native tools that are not listed—including Task/subagents—are unavailable; do not invoke them. If a capability is absent, complete the work directly with the listed tools or explain the limitation.",
    ...(instructions.length > 0
      ? ["Use these OpenCode tools instead of equivalent Cursor-native UI interactions:"]
      : []),
    ...instructions,
    "Emit the actual tool call and wait for its result; never merely claim or summarize that a tool was used.",
  ].join("\n")
}

/** Rough char→token estimate for mid-turn usage before TurnEnded arrives. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}

/** Estimate current-request prompt tokens from the complete serialized V3 prompt. */
export function estimatePromptTokens(prompt: LanguageModelV3CallOptions["prompt"]): number {
  const serializedContent = prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (JSON.stringify(message.content) ?? ""),
    )
    .join("\n")
  return estimateTokens(serializedContent.length)
}

/** Preserve cumulative Cursor counters as diagnostics, never as AI SDK request usage. */
export function cursorTurnEndedProviderMetadata(te: Record<string, unknown>): {
  cursor: {
    usageVersion: number
    inputTokensRaw: number
    outputTokensRaw: number
    cacheReadRaw: number
    cacheWriteRaw: number
    reasoningTokensRaw: number
  }
} {
  const counter = (key: string): number => {
    const value = te[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : 0
  }
  return {
    cursor: {
      usageVersion: 2,
      inputTokensRaw: counter("input_tokens"),
      outputTokensRaw: counter("output_tokens"),
      cacheReadRaw: counter("cache_read"),
      cacheWriteRaw: counter("cache_write"),
      reasoningTokensRaw: counter("reasoning_tokens"),
    },
  }
}

/**
 * Prior prompt turns for a seed ConversationStateStructure. Tool results must
 * never be replayed as assistant-authored prose: that teaches the model to
 * counterfeit `Tool result (...)` text instead of emitting a real tool call.
 * Normal rebases omit old results; compaction can retain all results and
 * interrupted continuations retain only the trailing live result suffix as
 * explicit OpenCode-host observations.
 */
export function extractPromptHistory(
  prompt: LanguageModelV3CallOptions["prompt"],
  options?: {
    preserveTrailingUser?: boolean
    toolResults?: "omit" | "all" | "trailing"
  },
): SeedHistoryMessage[] {
  const out: SeedHistoryMessage[] = []
  const toolResults = options?.toolResults ?? "omit"
  let trailingToolStart = prompt.length
  if (toolResults === "trailing") {
    while (trailingToolStart > 0 && prompt[trailingToolStart - 1]?.role === "tool") {
      trailingToolStart--
    }
  }
  for (let messageIndex = 0; messageIndex < prompt.length; messageIndex++) {
    const m = prompt[messageIndex]!
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) {
        out.push({ role: "system", content: m.content })
      }
      continue
    }
    if (m.role === "user") {
      const text = extractUserText(m as unknown as Record<string, unknown>)
      if (text && text !== ".") out.push({ role: "user", content: text })
      continue
    }
    if (m.role === "assistant") {
      const text = extractAssistantHistoryText(m as unknown as Record<string, unknown>)
      if (text) appendSeedHistory(out, "assistant", text)
      continue
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      if (
        toolResults === "omit" ||
        (toolResults === "trailing" && messageIndex < trailingToolStart)
      ) continue
      const results: string[] = []
      for (const part of m.content) {
        const p = part as unknown as Record<string, unknown>
        if (p.type !== "tool-result") continue
        const toolName = typeof p.toolName === "string" && p.toolName ? p.toolName : "tool"
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : ""
        const result = toolResultOutputToText(p.output)
        results.push(formatSeedToolObservation({
          toolName,
          toolCallId,
          output: result.text,
          isError: result.isError,
        }))
      }
      if (results.length > 0) appendSeedHistory(out, "user", results.join("\n\n"))
    }
  }
  // Live user message is the Run action, not seed history.
  if (!options?.preserveTrailingUser && out.length > 0 && out[out.length - 1]!.role === "user") {
    out.pop()
  }
  return out
}

function formatSeedToolObservation(input: {
  toolName: string
  toolCallId: string
  output: string
  isError: boolean
}): string {
  const metadata = JSON.stringify({
    source: "opencode-tool",
    tool: input.toolName,
    callId: input.toolCallId,
    status: input.isError ? "error" : "completed",
  })
  return `OpenCode host observation ${metadata}:\n${input.output}`
}

function extractAssistantHistoryText(msg: Record<string, unknown>): string {
  const content = msg.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts: string[] = []
  for (const part of content) {
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      texts.push(p.text)
    }
  }
  return texts.join("\n")
}

function appendSeedHistory(
  out: SeedHistoryMessage[],
  role: SeedHistoryMessage["role"],
  content: string,
): void {
  if (!content) return
  const last = out[out.length - 1]
  if (last?.role === role) {
    last.content += `\n\n${content}`
    return
  }
  out.push({ role, content })
}

/** OpenCode session id header, if present. */
export function opencodeSessionKey(callOptions: LanguageModelV3CallOptions): string | undefined {
  const h = callOptions.headers ?? {}
  const raw =
    h["x-session-id"] ??
    h["X-Session-Id"] ??
    h["x-session-affinity"] ??
    h["x-opencode-session"]
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  return undefined
}

/**
 * Map OpenCode's session id header to the active Cursor conversation_id.
 * Compaction resets remint via bindConversationId; otherwise the binding is
 * sticky for the OpenCode session. Falls back to a random UUID with no header.
 */
export function resolveConversationId(callOptions: LanguageModelV3CallOptions): string {
  return bindConversationId(opencodeSessionKey(callOptions)).conversationId
}

export { sessionIdToUuid } from "./protocol/conversation-bind.js"

function extractTools(callOptions: LanguageModelV3CallOptions): OpencodeToolDef[] {
  const tools = callOptions.tools
  if (!tools || tools.length === 0) {
    trace("extractTools: callOptions.tools empty/missing")
    return []
  }
  const out: OpencodeToolDef[] = []
  for (const t of tools) {
    // LanguageModelV3FunctionTool always has type:"function". Be defensive in
    // case a middleware strips it — still accept anything with a name + schema.
    const any = t as { type?: string; name?: string; description?: string; inputSchema?: unknown }
    if (any.type === "function" || (any.name && any.inputSchema !== undefined)) {
      if (!any.name) continue
      out.push({ name: any.name, description: any.description, inputSchema: any.inputSchema })
    }
  }
  trace(`extractTools: ${tools.length} incoming → ${out.length} advertised [${out.map((t) => t.name).join(",")}]`)
  return out
}

/** Exported for tests — AI SDK V3 span ends that must precede finish / tool-call. */
export function spanEndParts(opts: {
  textStarted: boolean
  reasoningStarted: boolean
  textId: string
  reasoningId: string
}): Array<{ type: "text-end" | "reasoning-end"; id: string }> {
  const out: Array<{ type: "text-end" | "reasoning-end"; id: string }> = []
  if (opts.reasoningStarted) out.push({ type: "reasoning-end", id: opts.reasoningId })
  if (opts.textStarted) out.push({ type: "text-end", id: opts.textId })
  return out
}

/** Exported for tests — false for compaction/summary (no tools) and toolChoice none. */
export function computeAllowTools(
  toolCount: number,
  toolChoice: LanguageModelV3CallOptions["toolChoice"] | undefined,
): boolean {
  return toolCount > 0 && toolChoice?.type !== "none"
}

export function resolveTurnToolState(input: {
  sessionKey?: string
  incomingTools: OpencodeToolDef[]
  toolChoice?: LanguageModelV3CallOptions["toolChoice"]
  isCompaction: boolean
}): { advertisedTools: OpencodeToolDef[]; allowTools: boolean } {
  const { sessionKey, incomingTools, isCompaction } = input
  if (sessionKey && incomingTools.length > 0) {
    rememberToolCatalog(sessionKey, incomingTools.map((tool) => ({ ...tool })))
  }
  const cached = sessionKey ? toolCatalogBySession.get(sessionKey) : undefined
  if (sessionKey && cached && incomingTools.length === 0) {
    rememberToolCatalog(sessionKey, cached)
  }
  const advertisedTools = isCompaction && incomingTools.length === 0
    ? (cached?.map((tool) => ({ ...tool })) ?? [])
    : incomingTools
  return {
    advertisedTools,
    allowTools: !isCompaction && computeAllowTools(incomingTools.length, input.toolChoice),
  }
}

export function resolveTurnConversationReset(input: {
  sessionKey?: string
  isCompaction: boolean
}): { reset: boolean; reason?: "compaction" | "post-compaction-rebase" } {
  const { sessionKey, isCompaction } = input
  if (isCompaction) {
    if (sessionKey) rememberPostCompactionRebase(sessionKey)
    return { reset: true, reason: "compaction" }
  }
  if (sessionKey && postCompactionRebaseBySession.delete(sessionKey)) {
    return { reset: true, reason: "post-compaction-rebase" }
  }
  return { reset: false }
}

export function resetTurnStateForTests(): void {
  toolCatalogBySession.clear()
  postCompactionRebaseBySession.clear()
}

function extractUserText(lastUser: Record<string, unknown> | undefined): string {
  if (!lastUser) return "."
  const content = lastUser.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      const p = part as Record<string, unknown>
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return "."
}

function foldStreamParts(parts: V3Part[]): LanguageModelV3GenerateResult {
  let text = ""
  let reasoning = ""
  const content: LanguageModelV3GenerateResult["content"] = []
  let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined }
  let usage: LanguageModelV3Usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }

  for (const part of parts) {
    if (part.type === "text-delta") text += part.delta
    else if (part.type === "reasoning-delta") reasoning += part.delta
    else if (part.type === "tool-call") {
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    } else if (part.type === "finish") {
      finishReason = part.finishReason
      usage = part.usage
    }
  }

  if (reasoning) content.unshift({ type: "reasoning", text: reasoning })
  if (text) content.unshift({ type: "text", text })

  return { content, finishReason, usage, warnings: [] }
}
