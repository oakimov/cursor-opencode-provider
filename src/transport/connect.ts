import { CURSOR_API_HOST, CONNECT_PROTOCOL_VERSION, SERVER_CONFIG_PATH } from "../shared.js"
import { encodeFrame, streamFrames } from "../protocol/framing.js"
import { createCursorChecksumHeader } from "../protocol/checksum.js"
import { getDeviceIds } from "../protocol/device-id.js"
import { resolveClientVersion } from "../protocol/client-version.js"
import { trace } from "../debug.js"
import {
  CursorLocalCancellationError,
  CursorProtocolError,
  CursorTransportError,
  cursorGrpcError,
  cursorHttpError,
  errorCode,
  CursorProviderError,
} from "../errors.js"
import http2 from "node:http2"

const API_BASE = `https://${CURSOR_API_HOST}`
const DEFAULT_UNARY_TIMEOUT_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647

function unaryTimeoutMs(operation: string, value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_UNARY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new CursorProtocolError(
      `${operation} timeout must be a positive integer no greater than ${MAX_TIMER_MS}`,
      { code: "CURSOR_INVALID_TIMEOUT" },
    )
  }
  return timeoutMs
}

/**
 * Bound a complete unary operation, not only fetch(). Response body readers can
 * ignore abort signals, so Promise.race remains the authoritative deadline.
 */
async function withUnaryDeadline<T>(
  operation: string,
  timeoutMs: number,
  timeoutCode: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CursorTransportError(`${operation} timed out after ${timeoutMs}ms`, {
        transient: true,
        replaySafe: true,
        code: timeoutCode,
      }))
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([run(controller.signal), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resolveApiBaseURL(options: { apiBaseURL?: string; baseURL?: string }): string {
  return new URL(options.apiBaseURL ?? options.baseURL ?? API_BASE).origin
}

trace("connect.ts module loaded")

export function buildBaseHeaders(
  token: string,
  clientVersion: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const { machineId, macMachineId } = getDeviceIds()
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": clientVersion,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    "x-ghost-mode": "true",
    ...extra,
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-request-id") delete headers[key]
  }
  headers["x-request-id"] = crypto.randomUUID()
  return headers
}

// ── Unary (AvailableModels) ──

export async function unaryAvailableModels(
  token: string,
  options: {
    apiBaseURL?: string
    baseURL?: string
    headers?: Record<string, string>
    timeoutMs?: number
  } = {},
): Promise<Record<string, unknown>> {
  const base = resolveApiBaseURL(options)
  const url = `${base}/aiserver.v1.AiService/AvailableModels`
  const timeoutMs = unaryTimeoutMs("AvailableModels", options.timeoutMs)
  return withUnaryDeadline(
    "AvailableModels",
    timeoutMs,
    "CURSOR_AVAILABLE_MODELS_TIMEOUT",
    async (signal) => {
      const clientVersion = await resolveClientVersion()
      const headers = buildBaseHeaders(token, clientVersion, options.headers)
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json",
          },
          // Request parameterized effort/context/fast variants like Cursor IDE.
          body: JSON.stringify({
            includeLongContextModels: true,
            useModelParameters: true,
            useCloudAgentEffortModes: true,
          }),
          signal,
        })
      } catch (cause) {
        throw new CursorTransportError("AvailableModels network request failed", {
          transient: true,
          replaySafe: true,
          code: errorCode(cause),
          cause,
        })
      }

      if (!res.ok) {
        throw await cursorHttpResponseError("AvailableModels failed:", res)
      }

      try {
        return (await res.json()) as Record<string, unknown>
      } catch (cause) {
        throw new CursorProtocolError("AvailableModels returned malformed JSON", { cause })
      }
    },
  )
}

// ── Unary (GetServerConfig) ──

/**
 * Cursor Run stream hosts from GetServerConfig / agentBaseURL.
 * Any HTTPS subdomain of cursor.sh is accepted — hostnames vary
 * (agentn.*, agent.*, agent-gcpp-*, api5 / api5lat, …) and may change.
 */
export function isAllowedAgentHost(hostname: string): boolean {
  return /^([a-z0-9-]+\.)+cursor\.sh$/i.test(hostname)
}

/**
 * Normalize a GetServerConfig agent URL to an https origin.
 * Returns null for missing, malformed, non-https, or non-*.cursor.sh hosts.
 */
export function normalizeAgentRunOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withScheme)
    if (parsed.protocol !== "https:") return null
    if (parsed.username || parsed.password) return null
    if (!isAllowedAgentHost(parsed.hostname)) return null
    return parsed.origin
  } catch {
    return null
  }
}


/**
 * Fetch the Cursor server config (a Connect unary RPC on the API host) and
 * return the `agentUrlConfig.agentnUrl` field — the region-specific Run stream
 * origin the server routes this account/team to (e.g. `agentn.us.api5.cursor.sh`).
 *
 * Region-routed accounts can be silently rejected by the wrong regional host, so
 * this lookup fails closed instead of substituting any host on error. Any
 * authoritative `*.cursor.sh` origin from GetServerConfig is accepted.
 */
export async function fetchAgentUrl(
  token: string,
  options: {
    apiBaseURL?: string
    baseURL?: string
    telemetryEnabled?: boolean
    timeoutMs?: number
  } = {},
): Promise<string> {
  const base = resolveApiBaseURL(options)
  const url = `${base}${SERVER_CONFIG_PATH}`
  const timeoutMs = unaryTimeoutMs("GetServerConfig", options.timeoutMs)
  return withUnaryDeadline(
    "GetServerConfig",
    timeoutMs,
    "CURSOR_AGENT_URL_TIMEOUT",
    async (signal) => {
      const clientVersion = await resolveClientVersion()
      // Match Cursor CLI: GetServerConfig uses base headers only — session headers belong on Run.
      const headers = buildBaseHeaders(token, clientVersion)

      trace(`GetServerConfig POST ${url}`)
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ telem_enabled: options.telemetryEnabled ?? false }),
          signal,
        })
      } catch (cause) {
        throw new CursorTransportError("GetServerConfig network request failed", {
          transient: true,
          replaySafe: true,
          code: errorCode(cause),
          cause,
        })
      }

      if (!res.ok) {
        throw await cursorHttpResponseError("GetServerConfig failed:", res)
      }

      let body: Record<string, unknown>
      try {
        body = (await res.json()) as Record<string, unknown>
      } catch (cause) {
        throw new CursorProtocolError("GetServerConfig returned malformed JSON", { cause })
      }
      const cfg = body.agentUrlConfig as { agentnUrl?: string; agentUrl?: string } | undefined
      const raw = cfg?.agentnUrl || cfg?.agentUrl
      const normalized = normalizeAgentRunOrigin(raw)
      trace(
        `GetServerConfig reply: agentnUrl=${cfg?.agentnUrl ?? "<missing>"} ` +
          `agentUrl=${cfg?.agentUrl ?? "<missing>"} → ${normalized ?? "<invalid>"}`,
      )
      if (!normalized) {
        throw new CursorProtocolError(
          raw
            ? "GetServerConfig returned an invalid Cursor agent URL"
            : "GetServerConfig response missing agentUrlConfig.agentnUrl",
        )
      }
      return normalized
    },
  )
}

// ── Bidi (Run stream) ──

export type BidiStream = {
  write(msg: Uint8Array): boolean | void
  waitForDrain?(timeoutMs: number): Promise<void>
  end(): void
  frames(): AsyncIterable<{ flags: number; payload: Uint8Array }>
  destroy(): void
  isClosed(): boolean
  onTerminal(listener: (event: BidiTerminalEvent) => void): () => void
}

export type BidiTerminalEvent =
  | { kind: "remote-clean-close" }
  | { kind: "remote-error"; error: CursorProviderError }
  | { kind: "local-close" }

export class CursorRunInterruptedError extends CursorTransportError {
  constructor(message = "Cursor Run ended before turn_ended", options?: ErrorOptions) {
    super(message, {
      transient: true,
      replaySafe: true,
      cause: options?.cause,
    })
    this.name = "CursorRunInterruptedError"
  }
}

export function cursorRunTerminationError(input: {
  responseStatus: number
  responseHeaders?: Record<string, unknown>
  responseTrailers?: Record<string, unknown>
  streamError?: Error | null
}): CursorProviderError {
  const headers = input.responseHeaders ?? {}
  const trailers = input.responseTrailers ?? {}
  if (input.streamError) {
    return new CursorRunInterruptedError(
      `Cursor Run transport interrupted: ${input.streamError.message}`,
      { cause: input.streamError },
    )
  }
  if (input.responseStatus !== 0 && input.responseStatus !== 200) {
    return cursorRunHttpError(input.responseStatus, headers)
  }
  const grpcStatus = trailers["grpc-status"] ?? headers["grpc-status"]
  if (grpcStatus !== undefined && String(grpcStatus) !== "0") {
    return cursorRunGrpcError(String(grpcStatus), headers, trailers)
  }
  return new CursorRunInterruptedError()
}

function withErrorMessageSuffix(error: CursorProviderError, suffix: string): CursorProviderError {
  if (suffix) error.message += suffix
  return error
}

async function cursorHttpResponseError(operation: string, res: Response): Promise<CursorProviderError> {
  const text = await res.text().catch(() => "")
  return withErrorMessageSuffix(
    cursorHttpError(operation, res.status),
    `${res.statusText ? ` ${res.statusText}` : ""}${text ? ` - ${text.slice(0, 200)}` : ""}`,
  )
}

function cursorRunHttpError(
  statusCode: number,
  headers: Record<string, unknown>,
): CursorProviderError {
  return withErrorMessageSuffix(
    cursorHttpError("Cursor Run failed by remote:", statusCode),
    ` ${JSON.stringify(stripPseudo(headers))}`,
  )
}

function cursorRunGrpcError(
  grpcStatus: string,
  headers: Record<string, unknown>,
  trailers: Record<string, unknown>,
): CursorProviderError {
  const message = trailers["grpc-message"] ?? headers["grpc-message"]
  return withErrorMessageSuffix(
    cursorGrpcError("Cursor Run failed by remote:", grpcStatus),
    message === undefined ? "" : `: ${message}`,
  )
}

// Cache http2 sessions keyed by origin so a custom baseURL never reuses a
// connection opened to the default agent host — and vice versa.
const _http2Sessions = new Map<string, http2.ClientHttp2Session>()
const _http2SessionCreatedAt = new WeakMap<http2.ClientHttp2Session, number>()
const _http2SessionListenerCleanup = new WeakMap<http2.ClientHttp2Session, () => void>()
// Validation and connect work for the same origin shares one Promise.
const _http2Connecting = new Map<string, Promise<http2.ClientHttp2Session>>()

// Bound the time we'll wait for the initial connect. Without this, a dead or
// unreachable host (DNS failure, network partition) hangs the provider forever
// because the 'connect' / 'error' event may never fire.
const CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_SESSION_PING_TIMEOUT_MS = 5_000
const DEFAULT_READ_IDLE_MS = 120_000
const WRITE_DRAIN_TIMEOUT_CODE = "CURSOR_WRITE_DRAIN_TIMEOUT"
export const HTTP2_SESSION_MAX_AGE_MS = 15 * 60_000

export function shouldReuseHttp2Session(
  state: { destroyed: boolean; closed: boolean },
  createdAt: number,
  now = Date.now(),
): boolean {
  return !state.destroyed && !state.closed && now - createdAt < HTTP2_SESSION_MAX_AGE_MS
}

/** Resolve the HTTP/2 connect origin for a Run stream (exported for tests). */
export function resolveAgentOrigin(baseURL: string): string {
  const origin = normalizeAgentRunOrigin(baseURL)
  if (!origin) {
    throw new CursorProtocolError("Cursor Run stream requires an allowlisted Cursor agent base URL")
  }
  return origin
}

function dropSession(origin: string, session: http2.ClientHttp2Session): void {
  if (_http2Sessions.get(origin) === session) _http2Sessions.delete(origin)
}

/** Test cleanup for local HTTP/2 fixtures; production sessions stay process-cached. */
export function closeCachedHttp2SessionsForTests(): void {
  for (const session of _http2Sessions.values()) {
    _http2SessionListenerCleanup.get(session)?.()
    try { session.destroy() } catch { /* already closed */ }
  }
  _http2Sessions.clear()
  _http2Connecting.clear()
}

function timeoutMs(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_MS) {
    throw new CursorProtocolError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_MS}`,
    )
  }
  return resolved
}

function toTransportError(value: unknown, fallback: string): CursorTransportError {
  if (value instanceof CursorTransportError) return value
  return new CursorTransportError(fallback, {
    transient: true,
    replaySafe: true,
    code: errorCode(value),
    cause: value,
  })
}

function installSessionInvalidation(
  origin: string,
  session: http2.ClientHttp2Session,
): void {
  const socket = session.socket
  let cleaned = false
  let removeSocketListeners: (() => void) | undefined
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    session.removeListener("close", onSessionClose)
    session.removeListener("goaway", onSessionGoaway)
    session.removeListener("error", onSessionError)
    removeSocketListeners?.()
    removeSocketListeners = undefined
    _http2SessionListenerCleanup.delete(session)
  }
  const onSessionClose = () => {
    trace(`h2 session closed: origin=${origin}`)
    dropSession(origin, session)
    cleanup()
  }
  const onSessionGoaway = (errorCode: number, lastStreamID: number) => {
    trace(`h2 session GOAWAY: origin=${origin} errorCode=${errorCode} lastStreamID=${lastStreamID}`)
    // Existing streams may drain, but future Runs must use a fresh session.
    dropSession(origin, session)
  }
  const onSessionError = (error: Error) => {
    trace(`h2 session error: origin=${origin} err=${error.message}`)
    dropSession(origin, session)
  }
  const onSocketEnd = () => {
    trace(`h2 socket ended: origin=${origin}`)
    dropSession(origin, session)
  }
  const onSocketClose = () => {
    trace(`h2 socket closed: origin=${origin}`)
    dropSession(origin, session)
  }

  session.once("close", onSessionClose)
  session.on("goaway", onSessionGoaway)
  // Keep an error listener until close so teardown errors cannot become an
  // unhandled EventEmitter error.
  session.on("error", onSessionError)
  if (socket) {
    socket.once("end", onSocketEnd)
    socket.once("close", onSocketClose)
    // Http2Session.socket is a lifecycle-bound proxy. Looking up methods after
    // detach throws ERR_HTTP2_SOCKET_UNBOUND, so bind removers while attached.
    const removeEndListener = socket.removeListener.bind(socket, "end", onSocketEnd)
    const removeCloseListener = socket.removeListener.bind(socket, "close", onSocketClose)
    removeSocketListeners = () => {
      try { removeEndListener() } catch { /* teardown is best-effort */ }
      try { removeCloseListener() } catch { /* teardown is best-effort */ }
    }
  }
  _http2SessionListenerCleanup.set(session, cleanup)
}

/** Node-runtime regression hook; production callers use getSession(). */
export function installSessionInvalidationForTests(
  origin: string,
  session: http2.ClientHttp2Session,
): void {
  installSessionInvalidation(origin, session)
}

function invalidateSession(origin: string, session: http2.ClientHttp2Session): void {
  dropSession(origin, session)
  _http2SessionListenerCleanup.get(session)?.()
  try { session.destroy() } catch { /* already closed */ }
}

function validateCachedSession(
  session: http2.ClientHttp2Session,
  pingTimeoutMs: number,
): Promise<void> {
  if (session.destroyed || session.closed) {
    return Promise.reject(new CursorTransportError("Cursor HTTP/2 cached session is already closed"))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.removeListener("close", onClosed)
      session.removeListener("goaway", onGoaway)
      session.removeListener("error", onError)
      if (error) reject(error)
      else resolve()
    }
    const onClosed = () => finish(new CursorTransportError("Cursor HTTP/2 cached session closed during ping"))
    const onGoaway = () => finish(new CursorTransportError("Cursor HTTP/2 cached session received GOAWAY during ping"))
    const onError = (error: Error) => finish(toTransportError(error, "Cursor HTTP/2 cached session ping failed"))
    const timer = setTimeout(() => {
      finish(new CursorTransportError(`Cursor HTTP/2 cached session ping timed out after ${pingTimeoutMs}ms`))
    }, pingTimeoutMs)
    timer.unref?.()
    session.once("close", onClosed)
    session.once("goaway", onGoaway)
    session.once("error", onError)
    try {
      const accepted = session.ping((error) => {
        if (error) finish(toTransportError(error, "Cursor HTTP/2 cached session ping failed"))
        else finish()
      })
      if (!accepted) finish(new CursorTransportError("Cursor HTTP/2 cached session refused a health-check ping"))
    } catch (error) {
      finish(toTransportError(error, "Cursor HTTP/2 cached session ping failed"))
    }
  })
}

function connectSession(origin: string): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(origin)
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      session.removeListener("error", onError)
      session.removeListener("close", onClose)
      session.removeListener("connect", onConnect)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      dropSession(origin, session)
      try { session.destroy() } catch { /* ignore */ }
      reject(error)
    }
    const onError = (error: Error) => fail(toTransportError(error, "Cursor HTTP/2 connection failed"))
    const onClose = () => fail(new CursorTransportError(`HTTP/2 connection to ${origin} closed before connecting`))
    const onConnect = () => {
      if (settled) return
      settled = true
      cleanup()
      installSessionInvalidation(origin, session)
      if (session.destroyed || session.closed) {
        const error = new CursorTransportError(`HTTP/2 connection to ${origin} closed while connecting`)
        invalidateSession(origin, session)
        reject(error)
        return
      }
      _http2SessionCreatedAt.set(session, Date.now())
      _http2Sessions.set(origin, session)
      trace(`h2 session connected: origin=${origin}`)
      resolve(session)
    }
    const timer = setTimeout(() => {
      fail(new CursorTransportError(`HTTP/2 connect to ${origin} timed out after ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()
    session.on("error", onError)
    session.once("close", onClose)
    session.once("connect", onConnect)
  })
}

export function getSession(
  baseURL: string,
  options: { pingTimeoutMs?: number } = {},
): Promise<http2.ClientHttp2Session> {
  const origin = resolveAgentOrigin(baseURL)
  const pingTimeoutMs = timeoutMs(
    "Cursor provider pingTimeoutMs",
    options.pingTimeoutMs,
    DEFAULT_SESSION_PING_TIMEOUT_MS,
  )
  const inflight = _http2Connecting.get(origin)
  if (inflight) return inflight

  const promise = (async () => {
    const existing = _http2Sessions.get(origin)
    if (existing) {
      const createdAt = _http2SessionCreatedAt.get(existing) ?? 0
      if (!shouldReuseHttp2Session(existing, createdAt)) {
        trace(`h2 session rotate: origin=${origin} ageMs=${Math.max(0, Date.now() - createdAt)}`)
        dropSession(origin, existing)
        try { existing.close() } catch { /* already closed */ }
      } else {
        try {
          await validateCachedSession(existing, pingTimeoutMs)
          if (_http2Sessions.get(origin) === existing && !existing.destroyed && !existing.closed) {
            trace(`h2 cached session ping ok: origin=${origin}`)
            return existing
          }
        } catch (error) {
          trace(`h2 cached session ping failed: origin=${origin} err=${(error as Error).message}`)
          invalidateSession(origin, existing)
        }
      }
    }
    return connectSession(origin)
  })()
  _http2Connecting.set(origin, promise)
  const cleanup = () => {
    if (_http2Connecting.get(origin) === promise) _http2Connecting.delete(origin)
  }
  promise.then(cleanup, cleanup)
  return promise
}

export async function bidiRunStream(
  token: string,
  options: {
    signal?: AbortSignal
    baseURL: string
    headers?: Record<string, string>
    readIdleMs?: number
    pingTimeoutMs?: number
  },
): Promise<BidiStream> {
  const origin = resolveAgentOrigin(options.baseURL)
  const readIdleMs = timeoutMs(
    "Cursor provider readIdleMs",
    options.readIdleMs,
    DEFAULT_READ_IDLE_MS,
  )
  const [session, clientVersion] = await Promise.all([
    getSession(options.baseURL, { pingTimeoutMs: options.pingTimeoutMs }),
    resolveClientVersion(),
  ])
  const headers = {
    ...buildBaseHeaders(token, clientVersion, options.headers),
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
    "connect-accept-encoding": "gzip,br",
    // The CLI's streaming interceptor sets this on the bidi Run stream
    // (decompiled client.ts:1190). Without it Cursor may treat the stream as
    // non-streaming.
    "x-cursor-streaming": "true",
    "user-agent": "connect-es/1.6.1",
  }

  const stream = session.request(headers as unknown as http2.OutgoingHttpHeaders, {
    endStream: false,
  })

  let writable = true
  let locallyClosed = false
  let remotelyClosed = false
  let backpressured = false
  let responseStatus = 0
  let responseHeaders: Record<string, unknown> = {}
  let responseTrailers: Record<string, unknown> = {}
  let rawStreamError: unknown
  let streamFailure: CursorProviderError | null = null
  let terminalEvent: BidiTerminalEvent | undefined
  let terminalSettlementScheduled = false
  const terminalListeners = new Set<(event: BidiTerminalEvent) => void>()

  const inboundFrames: Array<{ flags: number; payload: Uint8Array }> = []
  const pendingChunks: Uint8Array[] = []
  let inboundEnded = false
  let inboundFailure: Error | undefined
  let inboundWaiter:
    | {
        resolve: (frame: { flags: number; payload: Uint8Array } | undefined) => void
        reject: (error: Error) => void
      }
    | undefined
  let readIdleTimer: ReturnType<typeof setTimeout> | undefined
  let inboundReaderStarted = false
  const abortSignal = options.signal
  let abortHandler: (() => void) | undefined

  const observedFailure = (): CursorProviderError | undefined => {
    if (streamFailure) return streamFailure
    if (responseStatus !== 0 && responseStatus !== 200) {
      streamFailure = cursorRunHttpError(responseStatus, responseHeaders)
      return streamFailure
    }
    const grpcStatus = responseTrailers["grpc-status"] ?? responseHeaders["grpc-status"]
    if (grpcStatus !== undefined && String(grpcStatus) !== "0") {
      streamFailure = cursorRunGrpcError(String(grpcStatus), responseHeaders, responseTrailers)
      return streamFailure
    }
    if (rawStreamError) {
      streamFailure = toTransportError(rawStreamError, "Cursor Run transport interrupted")
      return streamFailure
    }
    return undefined
  }
  const settleTerminal = (event: BidiTerminalEvent) => {
    if (terminalEvent) return
    terminalEvent = event
    for (const listener of terminalListeners) {
      try { listener(event) } catch { /* observers cannot destabilize teardown */ }
    }
    terminalListeners.clear()
  }
  const clearReadIdleTimer = () => {
    if (readIdleTimer) clearTimeout(readIdleTimer)
    readIdleTimer = undefined
  }
  const cleanupTerminalResources = () => {
    clearReadIdleTimer()
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler)
      abortHandler = undefined
    }
  }
  const finishInbound = (error?: Error) => {
    if (error) {
      inboundFailure = error
      pendingChunks.length = 0
    } else if (!inboundFailure) {
      inboundEnded = true
    }
    const waiter = inboundWaiter
    inboundWaiter = undefined
    if (!waiter) return
    if (inboundFailure) waiter.reject(inboundFailure)
    else waiter.resolve(undefined)
  }
  const stopInboundReader = () => {
    cleanupTerminalResources()
    if (inboundReaderStarted) {
      stream.removeListener("data", onInboundChunk)
      inboundReaderStarted = false
    }
  }
  const nextInboundFrame = (): Promise<{ flags: number; payload: Uint8Array } | undefined> => {
    const queued = inboundFrames.shift()
    if (queued) return Promise.resolve(queued)
    if (inboundFailure) return Promise.reject(inboundFailure)
    if (inboundEnded) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      inboundWaiter = { resolve, reject }
    })
  }
  const enqueueFrame = (frame: { flags: number; payload: Uint8Array }) => {
    const waiter = inboundWaiter
    inboundWaiter = undefined
    if (waiter) waiter.resolve(frame)
    else inboundFrames.push(frame)
  }
  const settleObservedTerminal = () => {
    terminalSettlementScheduled = false
    if (terminalEvent) return
    if (locallyClosed) {
      finishInbound()
      stopInboundReader()
      settleTerminal({ kind: "local-close" })
      return
    }
    const failure = observedFailure()
    finishInbound(failure)
    stopInboundReader()
    settleTerminal(
      failure
        ? { kind: "remote-error", error: failure }
        : { kind: "remote-clean-close" },
    )
  }
  const scheduleTerminalSettlement = () => {
    if (terminalEvent || terminalSettlementScheduled) return
    terminalSettlementScheduled = true
    // HTTP/2 often emits end/aborted immediately before error/close. One turn
    // lets the strongest terminal metadata win.
    setImmediate(settleObservedTerminal)
  }
  const onReadIdleTimeout = () => {
    readIdleTimer = undefined
    if (locallyClosed || remotelyClosed || streamFailure) return
    streamFailure = new CursorTransportError(
      `Cursor Run stream read-idle timeout after ${readIdleMs}ms — connection presumed dead`,
      { transient: true, replaySafe: true, code: "CURSOR_READ_IDLE_TIMEOUT" },
    )
    writable = false
    finishInbound(streamFailure)
    stopInboundReader()
    settleTerminal({ kind: "remote-error", error: streamFailure })
    try { stream.destroy(streamFailure) } catch { /* already closing */ }
  }
  const armReadIdleWatchdog = () => {
    clearReadIdleTimer()
    if (locallyClosed || remotelyClosed || streamFailure) return
    readIdleTimer = setTimeout(onReadIdleTimeout, readIdleMs)
    readIdleTimer.unref?.()
  }
  const onInboundChunk = (chunk: Buffer | Uint8Array) => {
    armReadIdleWatchdog()
    if (inboundEnded || inboundFailure) return
    pendingChunks.push(new Uint8Array(chunk))
    const merged = mergeBuffers(pendingChunks)
    const parsed = Array.from(streamFrames(merged))
    const consumed = parsed.reduce((sum, frame) => sum + 5 + frame.payload.length, 0)
    pendingChunks.length = 0
    if (consumed < merged.length) pendingChunks.push(merged.subarray(consumed))
    for (const frame of parsed) enqueueFrame(frame)
  }
  const startInboundReader = () => {
    if (inboundReaderStarted || locallyClosed || remotelyClosed || streamFailure) return
    inboundReaderStarted = true
    stream.on("data", onInboundChunk)
    armReadIdleWatchdog()
  }

  // Capture the HTTP/2 response status/headers and any stream-level error.
  // Without this, a non-200 or RST_STREAM surfaces as a silent clean end
  // (frames() just stops) — which looks exactly like "no response, no error".
  stream.on("response", (h: Record<string, unknown>) => {
    responseHeaders = h
    responseStatus = h[":status"] !== undefined ? Number(h[":status"]) : 0
    trace(`h2 response: status=${responseStatus} headers=${JSON.stringify(stripPseudo(h))}`)
  })
  stream.on("trailers", (h: Record<string, unknown>) => {
    responseTrailers = h
    trace(`h2 trailers: ${JSON.stringify(stripPseudo(h))}`)
  })
  stream.on("error", (err: Error) => {
    rawStreamError = err
    writable = false
    trace(`h2 stream error: ${err?.name}: ${err?.message}`)
    scheduleTerminalSettlement()
  })
  stream.on("aborted", () => {
    writable = false
    rawStreamError ??= new CursorTransportError("Cursor Run stream aborted by remote", {
      transient: true,
      replaySafe: true,
      rstCode: stream.rstCode,
      code: "ERR_HTTP2_STREAM_CANCEL",
    })
    scheduleTerminalSettlement()
  })
  stream.on("end", () => {
    writable = false
    scheduleTerminalSettlement()
  })
  stream.on("close", () => {
    writable = false
    remotelyClosed = !locallyClosed
    if (remotelyClosed) {
      dropSession(origin, session)
      // Stop assigning sibling Runs to a connection that remotely lost one
      // of its streams. close() drains existing streams without destroying
      // them; the next Run opens a fresh HTTP/2 session.
      try { session.close() } catch { /* already closed */ }
    }
    trace(
      `h2 stream closed (status=${responseStatus}, local=${locallyClosed}, ` +
        `err=${rawStreamError instanceof Error ? rawStreamError.message : "none"})`,
    )
    scheduleTerminalSettlement()
  })

  if (abortSignal) {
    abortHandler = () => {
      if (!locallyClosed) {
        locallyClosed = true
        writable = false
        inboundFrames.length = 0
        pendingChunks.length = 0
        finishInbound()
        stopInboundReader()
        settleTerminal({ kind: "local-close" })
        stream.close()
      }
    }
    abortSignal.addEventListener("abort", abortHandler, { once: true })
    if (abortSignal.aborted) abortHandler()
  }

  startInboundReader()

  return {
    write(msg: Uint8Array) {
      if (!writable || remotelyClosed || stream.closed || stream.destroyed) {
        if (locallyClosed) {
          throw new CursorLocalCancellationError("Cursor Run stream is closed locally")
        }
        throw observedFailure() ?? new CursorRunInterruptedError("Cursor Run stream is no longer writable")
      }
      const frame = encodeFrame(0x00, msg)
      try {
        const accepted = stream.write(frame)
        backpressured = !accepted
        return accepted
      } catch (cause) {
        rawStreamError = cause
        streamFailure = toTransportError(cause, "Cursor Run stream write failed")
        streamFailure.replaySafe = false
        writable = false
        scheduleTerminalSettlement()
        throw streamFailure
      }
    },
    waitForDrain(timeout) {
      if (!backpressured) return Promise.resolve()
      const drainTimeoutMs = timeoutMs("Cursor write drain timeout", timeout, timeout)
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: CursorProviderError) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          stream.removeListener("drain", onDrain)
          stream.removeListener("error", onError)
          stream.removeListener("close", onClose)
          if (error) reject(error)
          else resolve()
        }
        const onDrain = () => {
          backpressured = false
          finish()
        }
        const onError = (cause: Error) => {
          streamFailure ??= toTransportError(cause, "Cursor Run stream drain failed")
          streamFailure.replaySafe = false
          finish(streamFailure)
        }
        const onClose = () => {
          finish(
            locallyClosed
              ? new CursorLocalCancellationError("Cursor Run stream closed locally during drain")
              : observedFailure() ?? new CursorRunInterruptedError("Cursor Run stream closed before drain"),
          )
        }
        const timer = setTimeout(() => {
          streamFailure ??= new CursorTransportError(
            `Cursor Run stream backpressure did not drain after ${drainTimeoutMs}ms`,
            { transient: false, replaySafe: false, code: WRITE_DRAIN_TIMEOUT_CODE },
          )
          finish(streamFailure)
          try { stream.destroy(streamFailure) } catch { /* already closing */ }
        }, drainTimeoutMs)
        timer.unref?.()
        stream.once("drain", onDrain)
        stream.once("error", onError)
        stream.once("close", onClose)
      })
    },
    end() {
      locallyClosed = true
      writable = false
      inboundFrames.length = 0
      pendingChunks.length = 0
      finishInbound()
      stopInboundReader()
      settleTerminal({ kind: "local-close" })
      stream.end()
    },
    async *frames() {
      try {
        while (true) {
          const frame = await nextInboundFrame()
          if (!frame) break
          trace(`frame yield: flags=0x${frame.flags.toString(16)} payload=${frame.payload.length}B`)
          yield frame
        }

        remotelyClosed = !locallyClosed
        if (locallyClosed) return

        // A clean HTTP/2 end before Cursor's turn_ended is still an interrupted
        // Run at the provider layer.
        throw observedFailure() ?? cursorRunTerminationError({
          responseStatus,
          responseHeaders,
          responseTrailers,
        })
      } catch (error) {
        if (locallyClosed) return
        if (error instanceof CursorProviderError) throw error
        throw toTransportError(
          error,
          `Cursor Run transport interrupted: ${error instanceof Error ? error.message : "unknown error"}`,
        )
      } finally {
        stopInboundReader()
      }
    },
    destroy() {
      if (!locallyClosed) {
        locallyClosed = true
        writable = false
        inboundFrames.length = 0
        pendingChunks.length = 0
        finishInbound()
        stopInboundReader()
        settleTerminal({ kind: "local-close" })
        stream.close()
      }
    },
    isClosed() {
      return remotelyClosed || locallyClosed || stream.closed || stream.destroyed
    },
    onTerminal(listener) {
      if (terminalEvent) {
        try { listener(terminalEvent) } catch { /* observers cannot destabilize teardown */ }
        return () => {}
      }
      terminalListeners.add(listener)
      return () => terminalListeners.delete(listener)
    },
  }
}

function mergeBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0)
  if (buffers.length === 1) return buffers[0]
  const total = buffers.reduce((s, b) => s + b.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    merged.set(b, offset)
    offset += b.length
  }
  return merged
}

export function makeRequestId(): string {
  return crypto.randomUUID()
}

function stripPseudo(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(":")) {
      if (k === ":status") out[k] = v
      continue
    }
    if (k === "authorization" || k === "x-cursor-checksum") {
      out[k] = "<redacted>"
      continue
    }
    out[k] = v
  }
  return out
}
