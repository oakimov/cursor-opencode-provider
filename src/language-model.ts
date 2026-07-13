import path from "node:path"
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
import { sessionManager, type CursorSession, type Frame } from "./session.js"
import { readCache, resolveVariantParameters, type ModelInfo } from "./models.js"

let _availableModels: ModelInfo[] | undefined

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
  const token = options.accessToken ?? options.apiKey
  if (!token) throw new Error("Cursor provider: no access token or API key provided")

  const prompt = callOptions.prompt

  // ── Continuation: does this call carry tool results for a held-open stream? ──
  const toolResults = extractToolResults(prompt)
  let session = toolResults.length > 0
    ? sessionManager.findByExecIds(toolResults.map((r) => r.execId))
    : undefined

  if (session) {
    // Deliver each awaited result back on the SAME Run stream, then resume.
    trace(`continuation: ${toolResults.length} tool result(s) execIds=[${toolResults.map((r) => r.execId).join(",")}] session=found pending={${[...session.pending.keys()].join(",")}}`)
    for (const r of toolResults) {
      const pending = session.pending.get(r.execId)
      if (!pending) {
        trace(`continuation: execId ${r.execId} NOT in pending — dropping result`)
        continue
      }
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
      } catch (e) {
        trace(`continuation: write FAILED execId=${r.execId} err=${(e as Error).message}`)
      }
      sessionManager.resolve(r.execId)
    }
    sessionManager.touch(session)
  } else {
    if (toolResults.length > 0) {
      trace(`continuation: ${toolResults.length} tool result(s) but NO session found execIds=[${toolResults.map((r) => r.execId).join(",")}] — starting fresh turn (TOOL LOOP BROKEN)`)
    }
    // ── Fresh turn: open a new Run stream + session. ──
    session = await startSession(modelId, token, callOptions)
  }

  const boundSession = session
  const textId = crypto.randomUUID()
  const reasoningId = crypto.randomUUID()

  return {
    stream: new ReadableStream<V3Part>({
      async pull(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] } as V3Part)
        await pump(boundSession, controller, { textId, reasoningId }, callOptions.abortSignal)
        controller.close()
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
): Promise<CursorSession> {
  const prompt = callOptions.prompt
  const conversationId = crypto.randomUUID()
  const userText = extractUserText([...prompt].reverse().find((m) => m.role === "user")) || "."
  const systemPrompt = extractSystemPrompt(prompt)
  const history = extractHistory(prompt)
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
  const stream = await bidiRunStream(token)
  trace(
    `outbound Run: model=${modelId} params=${JSON.stringify(parameterValues ?? [])} ` +
      `maxMode=${maxMode} systemPromptLen=${systemPrompt?.length ?? 0} tools=${tools.length} ` +
      `historyTurns=${history.length} availableModels=${_availableModels?.length ?? 0} userTextLen=${userText.length}`,
  )
  // Build the tool descriptors once — advertised in AgentRunRequest #4 mcp_tools
  // AND echoed into the request_context reply (server turn-setup probe).
  const toolDescriptors = tools.length > 0 ? toolsToDescriptors(tools) : []
  // Compaction/summary turns pass tools:{} (and may set toolChoice "none").
  // Cursor still has native Grep/etc.; allowTools gates emitting tool-call parts.
  const allowTools = computeAllowTools(toolDescriptors.length, callOptions.toolChoice)
  const reqBytes = buildRunRequest({
    text: userText,
    modelId,
    conversationId,
    systemPrompt,
    history,
    parameterValues,
    maxMode,
    availableModels: _availableModels,
    tools,
  })
  // Content hashes — Cursor content-addresses large payloads; logging these lets
  // us match a server get_blob_args.blob_id to what it wants served.
  const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex")
  trace(`hash run_request sha256=${sha(reqBytes)}`)
  if (systemPrompt) trace(`hash systemPrompt sha256=${sha(systemPrompt)}`)

  stream.write(reqBytes)

  const session: CursorSession = {
    stream,
    frames: stream.frames()[Symbol.asyncIterator](),
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors,
    allowTools,
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

async function loadAvailableModels(): Promise<void> {
  if (_availableModels) return
  const configDir = resolveModelCacheDir()
  if (!configDir) return
  try {
    const cached = await readCache(configDir)
    _availableModels = cached?.models
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

  /** AI SDK V3 requires text-end / reasoning-end before finish or tool-call. */
  const closeOpenSpans = () => {
    for (const part of spanEndParts({ textStarted, reasoningStarted, textId, reasoningId })) {
      controller.enqueue(part as V3Part)
    }
    reasoningStarted = false
    textStarted = false
  }

  const emitText = (text: string) => {
    if (!text) return
    // Close reasoning before text (hosts expect reasoning-end before text-start).
    if (reasoningStarted && !textStarted) {
      controller.enqueue({ type: "reasoning-end", id: reasoningId } as V3Part)
      reasoningStarted = false
    }
    if (!textStarted) {
      controller.enqueue({ type: "text-start", id: textId } as V3Part)
      textStarted = true
    }
    controller.enqueue({ type: "text-delta", id: textId, delta: text } as V3Part)
  }
  const emitReasoning = (text: string) => {
    if (!text) return
    if (!reasoningStarted) {
      controller.enqueue({ type: "reasoning-start", id: reasoningId } as V3Part)
      reasoningStarted = true
    }
    controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta: text } as V3Part)
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
    controller.enqueue({ type: "finish", usage, finishReason: reason } as V3Part)
  }

  while (true) {
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
            controller.error(new Error(`Cursor API error: ${text.slice(0, 500)}`))
            sessionManager.close(session)
            return
          }
        } catch { /* not decodable */ }
      }
      emitFinish(undefined, { unified: "stop", raw: undefined })
      sessionManager.close(session)
      return
    }

    const payload = decodeFramePayload(frame)
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
    const topField = payload.length > 0 ? payload[0] >> 3 : 0

    {
      const iuKind = iu ? Object.keys(iu).find((k) => iu[k]) : undefined
      trace(
        `pump frame: topField=${topField} interaction_update=${iuKind ?? "-"} ` +
          `exec=${esm ? "yes" : "no"} kv=${kv ? "yes" : "no"}`,
      )
    }

    try {
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
        // Server turn-setup probe (#10). Reply with env + tools, keep pumping.
        // Not replying here was the "times out, no response" root cause.
        trace(`exec request_context: id=${esmId} — replying env+tools(${session.toolDescriptors.length})`)
        try {
          session.stream.write(buildRequestContextResult(esmId, session.toolDescriptors))
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
          const tc = buildToolCallPart(parsed)
          // Keep the stream open; the result arrives on the next doStream call.
          sessionManager.registerPending(parsed.id, session, parsed.resultField)
          // tc.input is already a JSON string (LanguageModelV3ToolCall.input).
          trace(`exec: EMITTED tool-call toolCallId=${tc.toolCallId} toolName=${tc.toolName} inputLen=${tc.input.length}`)
          // Close open text/reasoning spans before tool-call (required by AI SDK V3).
          closeOpenSpans()
          controller.enqueue({
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
              `found=${handled.found} echoed=${!!handled.echoed} blobs=${session.blobs.size}`,
          )
        } catch { /* stream closed; pump will surface end */ }
      }
    }
    } catch (e) {
      // Any per-frame dispatch throw (e.g. protobufjs length overrun in
      // exec/args decode) must not abort the whole turn — log and skip.
      trace(`frame dispatch FAILED (skipping): topField=${topField} err=${(e as Error).message}`)
    }
    // heartbeat / checkpoint / step / partial_tool_call / interaction_query →
    // ignore (partial args are display-only; the exec channel is authoritative).
  }
}

// ── Prompt extraction ──

type ExtractedToolResult = { execId: number; toolName: string; output: string; error?: string }

function extractToolResults(prompt: LanguageModelV3CallOptions["prompt"]): ExtractedToolResult[] {
  const out: ExtractedToolResult[] = []
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      const p = part as unknown as Record<string, unknown>
      if (p.type !== "tool-result") continue
      const execId = parseExecIdFromToolCallId((p.toolCallId as string) ?? "")
      if (execId === undefined) continue
      const { text, isError } = toolResultOutputToText(p.output)
      out.push({
        execId,
        toolName: (p.toolName as string) ?? "mcp",
        output: text,
        error: isError ? text : undefined,
      })
    }
  }
  return out
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
 * Prior user/assistant text for conversation_state.turns. Excludes the last
 * user message (sent as the live action) and skips tool / system roles.
 */
function extractHistory(
  prompt: LanguageModelV3CallOptions["prompt"],
): Array<{ role: "user" | "assistant"; text: string }> {
  const entries: Array<{ role: "user" | "assistant"; text: string }> = []
  for (const m of prompt) {
    if (m.role === "user") {
      const text = extractUserText(m as unknown as Record<string, unknown>)
      if (text && text !== ".") entries.push({ role: "user", text })
    } else if (m.role === "assistant") {
      const text = extractAssistantText(m as unknown as Record<string, unknown>)
      if (text) entries.push({ role: "assistant", text })
    }
  }
  // Drop the trailing user message — it is the current turn's action.
  if (entries.length > 0 && entries[entries.length - 1].role === "user") {
    entries.pop()
  }
  return entries
}

function extractAssistantText(msg: Record<string, unknown> | undefined): string {
  if (!msg) return ""
  const content = msg.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts: string[] = []
  for (const part of content) {
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
  }
  return texts.join("\n")
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
