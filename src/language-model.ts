import path from "node:path"
import fs from "node:fs"
import { createHash } from "node:crypto"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage, LanguageModelV3FinishReason } from "@ai-sdk/provider"
import type { CreateCursorOptions } from "./index.js"
import { bidiRunStream, trace } from "./transport/connect.js"
import { buildRunRequest, buildHeartbeat } from "./protocol/request.js"
import { decodeFramePayload } from "./protocol/framing.js"
import { decodeMessage } from "./protocol/messages.js"
import {
  parseExecServerMessage,
  buildToolCallPart,
  buildExecClientMessages,
  parseExecIdFromToolCallId,
  toolsToDescriptors,
  detectExecVariantField,
  buildRawEmptyExecReply,
  buildRequestContextResult,
  REQUEST_CONTEXT_RESULT_FIELD,
  type OpencodeToolDef,
} from "./protocol/tools.js"
import { handleKvServerMessage } from "./protocol/kv.js"
import { getCheckpoint, setCheckpoint } from "./protocol/checkpoint.js"
import { conversationBlobCount } from "./protocol/blob-store.js"
import { sessionManager, type CursorSession, type Frame } from "./session.js"
import { readCache, cacheFilePath, resolveVariantParameters, type ModelInfo } from "./models.js"
import { buildRequestContext } from "./context/build.js"

let _availableModels: ModelInfo[] | undefined
// mtime of the cache file the last time we loaded it. Compared on each call
// so discoverModels' background refresh is picked up without a process restart.
let _availableModelsMtimeMs = 0

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
    baseUrl: options.baseURL,
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
        })) {
          session.stream.write(frame)
        }
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
  // Cursor stores server-side history keyed by conversation_id. Minting a new
  // UUID every turn made each OpenCode user message look like a brand-new chat.
  // OpenCode sends X-Session-Id / x-session-affinity on every call — derive a
  // stable UUID from that so follow-ups hit the same server conversation.
  const conversationId = resolveConversationId(callOptions)
  const userText = extractUserText([...prompt].reverse().find((m) => m.role === "user")) || "."
  const systemPrompt = extractSystemPrompt(prompt)
  const tools = extractTools(callOptions)

  await loadAvailableModels()

  const providerOptions = callOptions.providerOptions?.cursor as Record<string, unknown> | undefined
  const reasoningEffort = providerOptions?.reasoningEffort as string | undefined
  const maxMode = !!(providerOptions?.maxMode ?? false)

  const modelInfo = _availableModels?.find((m) => m.id === modelId)
  const parameterValues = resolveVariantParameters(modelInfo, { reasoningEffort, maxMode })

  // Do NOT pass callOptions.abortSignal into the h2 Run stream. OpenCode aborts
  // that signal when a turn ends with tool-calls; the Cursor stream must stay
  // open until we write the exec results on the next doStream.
  const stream = await bidiRunStream(token, {
    baseURL: options.baseURL,
    headers: options.headers,
  })
  // Build the tool descriptors once — advertised in AgentRunRequest #4 mcp_tools
  // AND echoed into the request_context reply (server turn-setup probe).
  const toolDescriptors = tools.length > 0 ? toolsToDescriptors(tools) : []
  // Compaction/summary turns pass tools:{} (and may set toolChoice "none").
  // Cursor still has native Grep/etc.; allowTools gates emitting tool-call parts.
  const allowTools = computeAllowTools(toolDescriptors.length, callOptions.toolChoice)
  const workspaceRoot = options.workspaceRoot || process.cwd()
  const requestContext = await buildRequestContext({ workspaceRoot, tools })
  // CLI parity: echo the last conversation_checkpoint_update as conversation_state.
  // Turn 1 (no checkpoint) seeds system prompt only; live user text is current-only.
  const conversationState = getCheckpoint(conversationId)
  const reqBytes = buildRunRequest({
    text: userText,
    modelId,
    conversationId,
    systemPrompt: conversationState ? undefined : systemPrompt,
    conversationState,
    parameterValues,
    maxMode,
    availableModels: _availableModels,
    tools,
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
  trace(
    `outbound Run: model=${modelId} conversationId=${conversationId} ` +
      `params=${JSON.stringify(parameterValues ?? [])} ` +
      `maxMode=${maxMode} systemPromptLen=${systemPrompt?.length ?? 0} tools=${tools.length} ` +
      `skills=${skillsCount} hooks=${hooksCtx ? hooksCtx.split("\n").length : 0} ` +
      `availableModels=${_availableModels?.length ?? 0} userTextLen=${userText.length} ` +
      `checkpointLen=${conversationState?.length ?? 0} runRequestBytes=${reqBytes.length}`,
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
  const configDir = resolveModelCacheDir()
  if (!configDir) return
  try {
    const filePath = cacheFilePath(configDir)
    let mtime = 0
    try {
      const stat = await fs.promises.stat(filePath)
      mtime = stat.mtimeMs
    } catch {
      // file missing — fall through with mtime=0
    }
    // Re-read when the file changed (discoverModels background refresh).
    if (mtime !== _availableModelsMtimeMs) {
      const cached = await readCache(configDir)
      _availableModels = cached?.models
      _availableModelsMtimeMs = mtime
    }
  } catch { /* ignore */ }
}

/** Same directory the plugin writes to (CURSOR_CONFIG_DIR, else OpenCode config). */
function resolveModelCacheDir(): string | undefined {
  if (process.env.CURSOR_CONFIG_DIR) return process.env.CURSOR_CONFIG_DIR
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return undefined
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(home, ".config", "opencode")
}

/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - a tool call (exec_server_message) → emit tool-call, finish "tool-calls",
 *    and KEEP the session open for the result on the next doStream call;
 *  - turn_ended / stream end → finish "stop" and close the session.
 */
async function pump(
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
    safeEnqueue({ type: "text-delta", id: textId, delta: text } as V3Part)
  }
  const emitReasoning = (text: string) => {
    if (!text) return
    if (!reasoningStarted) {
      safeEnqueue({ type: "reasoning-start", id: reasoningId } as V3Part)
      reasoningStarted = true
    }
    safeEnqueue({ type: "reasoning-delta", id: reasoningId, delta: text } as V3Part)
  }
  const emitFinish = (
    te: Record<string, unknown> | undefined,
    reason: LanguageModelV3FinishReason,
  ) => {
    closeOpenSpans()
    const usage: LanguageModelV3Usage = {
      inputTokens: {
        total: (te?.input_tokens as number) ?? 0,
        noCache: undefined,
        cacheRead: (te?.cache_read as number) ?? 0,
        cacheWrite: (te?.cache_write as number) ?? 0,
      },
      outputTokens: {
        total: (te?.output_tokens as number) ?? 0,
        text: undefined,
        reasoning: undefined,
      },
    }
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
    const checkpointRaw = asm.conversation_checkpoint_update
    const topField = payload.length > 0 ? payload[0] >> 3 : 0

    {
      const iuKind = iu ? Object.keys(iu).find((k) => iu[k]) : undefined
      trace(
        `pump frame: topField=${topField} interaction_update=${iuKind ?? "-"} ` +
          `exec=${esm ? "yes" : "no"} kv=${kv ? "yes" : "no"} ` +
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
          sessionManager.registerPending(parsed.id, session, parsed.resultField)
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
    // heartbeat / step / partial_tool_call / interaction_query →
    // ignore (partial args are display-only; the exec channel is authoritative.
    // Checkpoints are handled above.)
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

/**
 * Map OpenCode's session id header to a stable Cursor conversation_id (UUID).
 * Falls back to a random UUID when headers are absent (direct SDK use).
 */
export function resolveConversationId(callOptions: LanguageModelV3CallOptions): string {
  const h = callOptions.headers ?? {}
  const raw =
    h["x-session-id"] ??
    h["X-Session-Id"] ??
    h["x-session-affinity"] ??
    h["x-opencode-session"]
  if (typeof raw === "string" && raw.trim().length > 0) {
    return sessionIdToUuid(raw.trim())
  }
  return crypto.randomUUID()
}

/** Deterministic UUID (version-4 shape) from an arbitrary session key. */
export function sessionIdToUuid(sessionId: string): string {
  const hash = createHash("sha256").update(`cursor-opencode-provider:conv:${sessionId}`).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

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
