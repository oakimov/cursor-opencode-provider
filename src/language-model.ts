import fs from "node:fs"
import { createHash } from "node:crypto"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage, LanguageModelV3FinishReason } from "@ai-sdk/provider"
import type { CreateCursorOptions } from "./index.js"
import { bidiRunStream, normalizeAgentRunOrigin } from "./transport/connect.js"
import { trace } from "./debug.js"
import { buildRunRequest, buildHeartbeat } from "./protocol/request.js"
import { decodeFramePayload } from "./protocol/framing.js"
import { decodeMessage } from "./protocol/messages.js"
import {
  parseExecServerMessage,
  buildToolCallPart,
  buildExecClientMessages,
  parseExecIdFromToolCallId,
  detectExecVariantField,
  buildRawEmptyExecReply,
  buildRequestContextResult,
  REQUEST_CONTEXT_RESULT_FIELD,
  type OpencodeToolDef,
} from "./protocol/tools.js"
import { handleKvServerMessage } from "./protocol/kv.js"
import { handleInteractionQuery, inspectInteractionQueryWire } from "./protocol/interactions.js"
import { getCheckpoint, setCheckpoint } from "./protocol/checkpoint.js"
import { conversationBlobCount } from "./protocol/blob-store.js"
import {
  bindConversationId,
} from "./protocol/conversation-bind.js"
import { sessionManager, type CursorSession, type Frame } from "./session.js"
import { readCache, cacheFilePath, resolveVariantParameters, paramsImplyMaxMode, extractCursorVariantParameters, resolveCursorWireModelId, type ModelInfo } from "./models.js"
import { buildRequestContext } from "./context/build.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { resolveAgentUrl } from "./agent-url.js"
import { CURSOR_API_HOST, CURSOR_COMPACTION_OPTION } from "./shared.js"
import type { SeedHistoryMessage } from "./protocol/request.js"

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

  // ── Continuation vs fresh turn ──
  // OpenCode embeds *all* historical tool results in every prompt. Only the
  // trailing tool-message suffix (after the last assistant/user message) is a
  // live continuation. Treating mid-prompt history as continuation caused
  // false "orphaned tool results" errors after Cursor turn_ended and OpenCode
  // started the next step with old tools still in the prompt body.
  const trailingToolResults = extractTrailingToolResults(prompt)
  let session = findContinuationSession(trailingToolResults)

  if (session) {
    // Deliver only results that this live session is still awaiting.
    const pendingResults = trailingToolResults.filter(
      (r) => r.sessionId === session!.sessionId && session!.pending.has(r.execId),
    )
    trace(
      `continuation: ${trailingToolResults.length} trailing tool result(s), ` +
        `${pendingResults.length} pending for sessionId=${session.sessionId} ` +
        `pending={${[...session.pending.keys()].join(",")}}`,
    )
    for (const r of pendingResults) {
      const pending = session.pending.get(r.execId)
      if (!pending) continue
      try {
        for (const frame of buildExecClientMessages({
          execId: r.execId,
          resultField: pending.resultField,
          output: r.output,
          error: r.error,
          toolName: pending.toolName ?? r.toolName,
        })) {
          session.stream.write(frame)
        }
        // Tool results enlarge Cursor's context for the rest of this Run.
        session.usageEstimate.inputTokens += estimateTokens(r.output.length)
        trace(`continuation: wrote exec result execId=${r.execId} field=${pending.resultField} outLen=${r.output.length}`)
        // Only resolve after the write succeeded — if it threw, the server never
        // got the result and would block on heartbeats forever otherwise.
        sessionManager.resolve(session.sessionId, r.execId)
      } catch (e) {
        trace(`continuation: write FAILED execId=${r.execId} err=${(e as Error).message} — leaving pending`)
      }
    }
    sessionManager.touch(session)
  } else if (trailingToolResults.length > 0) {
    // True continuation (prompt ends with tool results) but the Cursor Run is
    // gone. Soft-stop instead of re-prompting (doom loop) or hard-erroring.
    const ids = trailingToolResults.map((r) => `${r.sessionId}:${r.execId}`).join(",")
    trace(`continuation: ${trailingToolResults.length} orphaned trailing tool result(s) [${ids}] — soft-stop`)
    return orphanedToolResultsStream(ids)
  } else {
    // Fresh turn (prompt ends with user/assistant text). Historical tool
    // results may exist mid-prompt; they are not live exec replies.
    const historical = extractToolResults(prompt).length
    if (historical > 0) {
      trace(`fresh turn: ignoring ${historical} historical tool result(s) (not trailing)`)
    }
    session = await startSession(modelId, token, callOptions, options)
  }

  const boundSession = session
  const textId = crypto.randomUUID()
  const reasoningId = crypto.randomUUID()

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
          boundSession.pumpActive = true
          try {
            await pump(boundSession, controller, { textId, reasoningId }, callOptions.abortSignal)
          } finally {
            boundSession.pumpActive = false
          }
          try {
            controller.close()
          } catch (e) {
            trace(`pull: close failed (already closed/cancelled) err=${(e as Error).message}`)
          }
        } catch (e) {
          boundSession.pumpActive = false
          trace(`pull: pump threw (cleaning up): ${(e as Error).message}`)
          sessionManager.closeUnlessPending(boundSession)
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
        sessionManager.closeUnlessPending(boundSession)
      },
    }),
  }
}

async function startSession(
  modelId: string,
  token: string,
  callOptions: LanguageModelV3CallOptions,
  options: CreateCursorOptions,
): Promise<CursorSession> {
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
  // Compaction must not reuse the prior conversation; its first normal turn
  // must also rebase so the summary-agent checkpoint cannot replace the normal
  // system prompt and OpenCode's newly compacted history.
  const bound = bindConversationId(sessionKey, { reset: resetState.reset })
  const conversationId = bound.conversationId
  if (bound.reset) {
    trace(
      `conversation reset: reason=${resetState.reason ?? "unknown"} ` +
        `sessionKey=${sessionKey ?? "(none)"} ` +
        `previousId=${bound.previousId ?? "-"} → conversationId=${conversationId}`,
    )
  }

  const userText = extractUserText([...prompt].reverse().find((m) => m.role === "user")) || "."
  const systemPrompt = extractSystemPrompt(prompt)
  const history = extractPromptHistory(prompt)

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
  const workspaceRoot = options.workspaceRoot || process.cwd()
  const requestContext = await buildRequestContext({ workspaceRoot, tools })
  // Resolve descriptors once from the merged OpenCode config so MCP identity is
  // consistent across AgentRunRequest and both request_context reply paths.
  const toolDescriptors = Array.isArray(requestContext.tools)
    ? requestContext.tools as Array<Record<string, unknown>>
    : []
  // CLI parity: echo the last conversation_checkpoint_update as conversation_state.
  // After compaction reset there is no checkpoint — seed from OpenCode history.
  const conversationState = bound.reset ? undefined : getCheckpoint(conversationId)
  const reqBytes = buildRunRequest({
    text: userText,
    modelId: cursorModelId,
    conversationId,
    systemPrompt: conversationState ? undefined : systemPrompt,
    history: conversationState ? undefined : history,
    conversationState,
    parameterValues,
    maxMode,
    availableModels: _availableModels,
    tools,
    toolDescriptors,
    requestContext,
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
      `usageEstimateIn=${usageEstimate.inputTokens} runRequestBytes=${reqBytes.length}`,
  )
  if (hooksCtx) trace(`outbound Run hooks_additional_context: ${hooksCtx}`)
  trace(`hash run_request sha256=${sha(reqBytes)}`)
  if (systemPrompt) trace(`hash systemPrompt sha256=${sha(systemPrompt)}`)
  if (conversationState) trace(`hash checkpoint sha256=${sha(conversationState)}`)

  stream.write(reqBytes)

  const session: CursorSession = {
    sessionId: crypto.randomUUID(),
    conversationId,
    stream,
    frames: stream.frames()[Symbol.asyncIterator](),
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors,
    requestContext,
    allowTools,
    usageEstimate,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 300_000,
  }
  session.heartbeat = setInterval(() => {
    try { stream.write(buildHeartbeat()) } catch { /* closed */ }
  }, 5000)

  callOptions.abortSignal?.addEventListener("abort", () => {
    // Abort after tool-calls is normal — preserve pending sessions.
    trace("abortSignal aborted → closeUnlessPending")
    sessionManager.closeUnlessPending(session)
  }, { once: true })
  return session
}

/** Emit a soft-stop stream when trailing tool results have no live Cursor Run. */
function orphanedToolResultsStream(ids: string): LanguageModelV3StreamResult {
  const textId = crypto.randomUUID()
  const message =
    `The Cursor agent stream ended before tool results could be delivered ` +
    `(${ids.split(",").length} result(s)). Please retry your request.`
  trace(`orphanedToolResultsStream: soft-stop for [${ids}]`)
  return {
    stream: new ReadableStream<V3Part>({
      pull(controller) {
        try {
          controller.enqueue({ type: "stream-start", warnings: [] } as V3Part)
          controller.enqueue({ type: "text-start", id: textId } as V3Part)
          controller.enqueue({ type: "text-delta", id: textId, delta: message } as V3Part)
          controller.enqueue({ type: "text-end", id: textId } as V3Part)
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 0, noCache: undefined, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: undefined, reasoning: undefined },
            },
          } as V3Part)
          controller.close()
        } catch (e) {
          trace(`orphanedToolResultsStream: enqueue failed err=${(e as Error).message}`)
        }
      },
    }),
  }
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
    throw new Error(
      "Invalid Cursor agent base URL override: expected https://*.cursor.sh",
    )
  }
  return normalized
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true"
}

/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - a tool call (exec_server_message) → emit tool-call, finish "tool-calls",
 *    and KEEP the session open for the result on the next doStream call;
 *  - turn_ended / stream end → finish "stop" and close the session.
 */
export async function pump(
  session: CursorSession,
  controller: ReadableStreamDefaultController<V3Part>,
  ids: { textId: string; reasoningId: string },
  abortSignal?: AbortSignal,
): Promise<void> {
  const { textId, reasoningId } = ids
  let textStarted = false
  let reasoningStarted = false
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
    safeEnqueue({ type: "text-delta", id: textId, delta: text } as V3Part)
  }
  const emitReasoning = (text: string) => {
    if (!text) return
    if (!reasoningStarted) {
      safeEnqueue({ type: "reasoning-start", id: reasoningId } as V3Part)
      reasoningStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    safeEnqueue({ type: "reasoning-delta", id: reasoningId, delta: text } as V3Part)
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
        total: est.inputTokens,
        noCache: undefined,
        cacheRead: est.cacheRead,
        cacheWrite: est.cacheWrite,
      },
      outputTokens: {
        total: est.outputTokens,
        text: undefined,
        reasoning: undefined,
      },
    }
    const reasonLabel = typeof reason === "object" && reason && "unified" in reason
      ? String((reason as { unified?: string }).unified ?? "unknown")
      : String(reason)
    trace(
      `finish: reason=${reasonLabel} ` +
        `in=${est.inputTokens} out=${est.outputTokens} ` +
        `cacheRead=${est.cacheRead} cacheWrite=${est.cacheWrite} ` +
        `source=${te ? "turn_ended" : "estimate"}`,
    )
    safeEnqueue({ type: "finish", usage, finishReason: reason } as V3Part)
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

    const next = await session.frames.next()
    if (next.done) {
      trace("pump: frames iterator ended with NO frames received (silent end)")
      emitFinish(undefined, { unified: "stop", raw: undefined })
      sessionManager.close(session)
      return
    }
    const frame = next.value as Frame

    if (frame.flags & 0x02) {
      // End-stream: the real server half-closes without a trailer, but surface
      // any Connect error payload if present.
      if (frame.payload.length > 0) {
        try {
          const text = new TextDecoder().decode(decodeFramePayload(frame))
          if (text.includes('"error"')) {
            safeError(new Error(`Cursor API error: ${text.slice(0, 500)}`))
            sessionManager.close(session)
            return
          }
        } catch { /* not decodable */ }
      }
      emitFinish(undefined, { unified: "stop", raw: undefined })
      sessionManager.close(session)
      return
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
          session.stream.write(buildRequestContextResult(esmId, session.requestContext))
          trace(`exec request_context: replied`)
        } catch (e) {
          trace(`exec request_context: write FAILED ${(e as Error).message}`)
        }
      } else {
        const parsed = parseExecServerMessage(esm)
        trace(`exec: id=${parsed?.id} variant=${parsed ? Object.keys(parsed).join(",") : "none"} toolName=${parsed?.toolName} resultField=${parsed?.resultField}`)
        if (parsed) {
          // OpenCode throws "Tool call not allowed while generating summary"
          // when assistantMessage.summary is set. Compaction/summary turns
          // advertise no tools — refuse on the Cursor channel and keep
          // pumping for text / turn_ended instead of emitting tool-call.
          if (!session.allowTools) {
            const reason = "Tool calls are not available during this turn (summary/compaction)."
            trace(`exec: REFUSED (allowTools=false) toolName=${parsed.toolName} — auto-replying`)
            try {
              for (const frame of buildExecClientMessages({
                execId: parsed.id,
                resultField: parsed.resultField,
                output: "",
                error: reason,
                toolName: parsed.toolName,
              })) {
                session.stream.write(frame)
              }
            } catch (e) {
              trace(`exec: REFUSED write FAILED ${(e as Error).message}`)
            }
            continue
          }
          const tc = buildToolCallPart(parsed, session.sessionId)
          // Keep the stream open; the result arrives on the next doStream call.
          sessionManager.registerPending(parsed.id, session, parsed.resultField, parsed.toolName)
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
        // Unmapped exec variant (diagnostics/smart-mode-classifier/etc.). We
        // MUST still reply or the server blocks. Emit an empty result at the
        // variant's field number (request/result share the number) and keep
        // pumping. The hex dump records exactly which variant it was.
        const variantField = detectExecVariantField(payload)
        const hex = Array.from(payload.subarray(0, 48))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("")
        trace(
          `exec UNMAPPED: id=${esmId} variantField=${variantField} keys=[${Object.keys(esm).join(",")}] hex=${hex}`,
        )
        if (variantField && variantField !== REQUEST_CONTEXT_RESULT_FIELD) {
          try {
            session.stream.write(buildRawEmptyExecReply(esmId, variantField))
            trace(`exec UNMAPPED: replied empty result field=${variantField}`)
          } catch (e) {
            trace(`exec UNMAPPED: write FAILED field=${variantField} err=${(e as Error).message}`)
          }
        }
      }
    } else if (interactionQuery) {
      // InteractionQuery is a must-reply channel, just like exec and KV. AI
      // SDK has no Cursor-specific UI callback, so answer immediately with the
      // conservative headless policy from protocol/interactions.ts.
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
        } catch { /* stream closed; pump will surface end */ }
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
      const parsed = parseExecIdFromToolCallId((p.toolCallId as string) ?? "")
      if (!parsed) continue
      const { text, isError } = toolResultOutputToText(p.output)
      out.push({
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

/** Rough char→token estimate for mid-turn usage before TurnEnded arrives. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}

/**
 * Prior prompt turns for a seed ConversationStateStructure after compaction
 * reset. Drops the trailing user message (live action), but preserves tool
 * result payloads as labeled assistant observations for Cursor's text history.
 */
export function extractPromptHistory(
  prompt: LanguageModelV3CallOptions["prompt"],
): SeedHistoryMessage[] {
  const out: SeedHistoryMessage[] = []
  for (const m of prompt) {
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
      const results: string[] = []
      for (const part of m.content) {
        const p = part as unknown as Record<string, unknown>
        if (p.type !== "tool-result") continue
        const toolName = typeof p.toolName === "string" && p.toolName ? p.toolName : "tool"
        const result = toolResultOutputToText(p.output)
        const label = result.isError ? "Tool error" : "Tool result"
        results.push(`${label} (${toolName}):\n${result.text}`)
      }
      if (results.length > 0) appendSeedHistory(out, "assistant", results.join("\n\n"))
    }
  }
  // Live user message is the Run action, not seed history.
  if (out.length > 0 && out[out.length - 1]!.role === "user") out.pop()
  return out
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
    toolCatalogBySession.set(sessionKey, incomingTools.map((tool) => ({ ...tool })))
  }
  const cached = sessionKey ? toolCatalogBySession.get(sessionKey) : undefined
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
    if (sessionKey) postCompactionRebaseBySession.add(sessionKey)
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
