export type CursorErrorOrigin =
  | "local-cancel"
  | "transport"
  | "server"
  | "protocol"
  | "auth"

export type CursorErrorDiagnostics = {
  statusCode?: number
  grpcStatus?: number | string
  rstCode?: number
  code?: string
  retryAfterMs?: number
}

export type CursorProviderErrorOptions = CursorErrorDiagnostics & {
  origin: CursorErrorOrigin
  transient: boolean
  replaySafe: boolean
  cause?: unknown
}

/** Structured provider failure with retry and transport diagnostics. */
export class CursorProviderError extends Error {
  readonly origin: CursorErrorOrigin
  readonly transient: boolean
  replaySafe: boolean
  readonly statusCode?: number
  readonly grpcStatus?: number | string
  readonly rstCode?: number
  readonly code?: string
  readonly retryAfterMs?: number

  constructor(message: string, options: CursorProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CursorProviderError"
    this.origin = options.origin
    this.transient = options.transient
    this.replaySafe = options.replaySafe
    this.statusCode = options.statusCode
    this.grpcStatus = options.grpcStatus
    this.rstCode = options.rstCode
    this.code = options.code
    this.retryAfterMs = options.retryAfterMs
  }
}

export class CursorLocalCancellationError extends CursorProviderError {
  constructor(message = "Cursor request cancelled locally", cause?: unknown) {
    super(message, {
      origin: "local-cancel",
      transient: false,
      replaySafe: false,
      cause,
    })
    this.name = "CursorLocalCancellationError"
  }
}

export class CursorTransportError extends CursorProviderError {
  constructor(
    message: string,
    options: Omit<CursorProviderErrorOptions, "origin"> = {
      transient: true,
      replaySafe: true,
    },
  ) {
    super(message, { ...options, origin: "transport" })
    this.name = "CursorTransportError"
  }
}

export class CursorServerError extends CursorProviderError {
  constructor(message: string, options: Omit<CursorProviderErrorOptions, "origin">) {
    super(message, { ...options, origin: "server" })
    this.name = "CursorServerError"
  }
}

export class CursorProtocolError extends CursorProviderError {
  constructor(message: string, options: Partial<CursorErrorDiagnostics> & { cause?: unknown } = {}) {
    super(message, {
      ...options,
      origin: "protocol",
      transient: false,
      replaySafe: false,
    })
    this.name = "CursorProtocolError"
  }
}

export class CursorAuthError extends CursorProviderError {
  constructor(
    message = "Cursor authentication failed; reauthenticate with Cursor",
    options: Partial<CursorErrorDiagnostics> & { cause?: unknown } = {},
  ) {
    super(message, {
      ...options,
      origin: "auth",
      transient: false,
      replaySafe: false,
    })
    this.name = "CursorAuthError"
  }
}

export class CursorRetryExhaustedError extends CursorProviderError {
  readonly attempts: number

  constructor(attempts: number, last: CursorProviderError) {
    super(`Cursor retry exhausted after ${attempts} attempts: ${last.message}`, {
      origin: last.origin,
      transient: false,
      replaySafe: false,
      statusCode: last.statusCode,
      grpcStatus: last.grpcStatus,
      rstCode: last.rstCode,
      code: last.code,
      retryAfterMs: last.retryAfterMs,
      cause: last,
    })
    this.name = "CursorRetryExhaustedError"
    this.attempts = attempts
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ETIMEDOUT",
])

export function isTransientGrpcStatus(status: number | string): boolean {
  const normalized = String(status).toLowerCase().replaceAll("-", "_")
  return (
    normalized === "8" ||
    normalized === "13" ||
    normalized === "14" ||
    normalized === "internal" ||
    normalized === "resource_exhausted" ||
    normalized === "unavailable"
  )
}

export function isAuthGrpcStatus(status: number | string): boolean {
  const normalized = String(status).toLowerCase().replaceAll("-", "_")
  return (
    normalized === "7" ||
    normalized === "16" ||
    normalized === "permission_denied" ||
    normalized === "unauthenticated"
  )
}

export function cursorHttpError(
  operation: string,
  statusCode: number,
  diagnostics: Omit<CursorErrorDiagnostics, "statusCode"> = {},
): CursorProviderError {
  if (statusCode === 401 || statusCode === 403) {
    return new CursorAuthError(
      `Cursor authentication failed (HTTP ${statusCode}); reauthenticate with Cursor`,
      { ...diagnostics, statusCode },
    )
  }
  return new CursorServerError(`${operation} HTTP ${statusCode}`, {
    ...diagnostics,
    statusCode,
    transient: statusCode === 429 || statusCode >= 500,
    replaySafe: true,
  })
}

export function cursorGrpcError(
  operation: string,
  grpcStatus: number | string,
  diagnostics: Omit<CursorErrorDiagnostics, "grpcStatus"> = {},
): CursorProviderError {
  if (isAuthGrpcStatus(grpcStatus)) {
    return new CursorAuthError(
      `Cursor authentication failed (gRPC ${grpcStatus}); reauthenticate with Cursor`,
      { ...diagnostics, grpcStatus },
    )
  }
  return new CursorServerError(`${operation} gRPC status ${grpcStatus}`, {
    ...diagnostics,
    grpcStatus,
    transient: isTransientGrpcStatus(grpcStatus),
    replaySafe: true,
  })
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

export function toCursorProviderError(
  error: unknown,
  options: { replaySafe: boolean; fallback?: string } = { replaySafe: false },
): CursorProviderError {
  if (error instanceof CursorProviderError) {
    error.replaySafe = options.replaySafe && error.replaySafe
    return error
  }

  const code = errorCode(error)
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : ""
  if (name.startsWith("Auth") || /access token|api key|authentication/i.test(message)) {
    return new CursorAuthError(undefined, { code, cause: error })
  }

  const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1]
  if (httpStatus) {
    const failure = cursorHttpError("Cursor request failed with", Number(httpStatus), { code })
    failure.replaySafe = options.replaySafe && failure.replaySafe
    return failure
  }

  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return new CursorTransportError(`Cursor transport failure (${code})`, {
      transient: true,
      replaySafe: options.replaySafe,
      code,
      cause: error,
    })
  }
  if (error instanceof TypeError) {
    return new CursorProtocolError(options.fallback ?? "Invalid Cursor provider configuration", {
      code,
      cause: error,
    })
  }
  return new CursorProtocolError(options.fallback ?? `Cursor provider failure (${name})`, {
    code,
    cause: error,
  })
}

export function retrySuppressedError(
  cause: CursorProviderError,
  reason: string,
  attempt: number,
  maxAttempts: number,
): CursorProviderError {
  const subject = cause.message.replace(/^Cursor Run stream /, "Cursor stream ")
  return new CursorProviderError(
    `${subject} ${reason}; automatic retry unsafe (attempt ${attempt}/${maxAttempts})`,
    {
      origin: cause.origin,
      transient: false,
      replaySafe: false,
      statusCode: cause.statusCode,
      grpcStatus: cause.grpcStatus,
      rstCode: cause.rstCode,
      code: cause.code,
      retryAfterMs: cause.retryAfterMs,
      cause,
    },
  )
}
