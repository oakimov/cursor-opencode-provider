/**
 * HTTPS proxy helpers for the Cursor Run HTTP/2 transport.
 *
 * Unary RPCs use Bun `fetch()`, which already honors HTTPS_PROXY / NO_PROXY.
 * `node:http2` does not, so Run sessions tunnel through an HTTP CONNECT proxy
 * when those env vars apply. See GitHub issue #26.
 *
 * Important (Bun 1.3.x): do the CONNECT handshake on a native `net.Socket`,
 * then `tls.connect({ socket })` on that same socket. Do not insert a custom
 * Duplex between the proxy socket and TLS — destroying such a session mid-
 * handshake can segfault Bun.
 */

import net from "node:net"
import tls from "node:tls"
import { CursorTransportError } from "../errors.js"

export type ProxyEnv = Record<string, string | undefined>

/** Prefer HTTPS_PROXY / https_proxy (HTTP proxies used for HTTPS CONNECT). */
export function resolveHttpsProxyUrl(
  targetHost: string,
  env: ProxyEnv = process.env,
): URL | undefined {
  if (!targetHost) return undefined
  if (hostMatchesNoProxy(targetHost, env.NO_PROXY ?? env.no_proxy)) return undefined

  const raw = (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)?.trim()
  if (!raw) return undefined

  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`
    const url = new URL(withScheme)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (!url.hostname) return undefined
    return url
  } catch {
    return undefined
  }
}

/**
 * curl/Node-style NO_PROXY matching: `*`, exact host, optional `:port`, and
 * leading-dot / bare-domain suffix forms (`.corp.example` / `corp.example`).
 */
export function hostMatchesNoProxy(
  targetHost: string,
  noProxy: string | undefined,
): boolean {
  if (!noProxy?.trim()) return false
  const host = targetHost.trim().toLowerCase().replace(/\.$/, "")
  if (!host) return false

  for (const part of noProxy.split(/[\s,]+/)) {
    const entry = part.trim().toLowerCase()
    if (!entry) continue
    if (entry === "*") return true

    const [entryHostRaw, entryPort] = splitHostPort(entry)
    const entryHost = entryHostRaw.replace(/^\./, "").replace(/\.$/, "")
    if (!entryHost) continue
    // Port-qualified entries only bypass that port; we always dial 443 for Runs.
    if (entryPort !== undefined && entryPort !== "443") continue

    if (host === entryHost) return true
    if (host.endsWith(`.${entryHost}`)) return true
  }
  return false
}

function splitHostPort(entry: string): [string, string | undefined] {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]")
    if (end === -1) return [entry, undefined]
    const host = entry.slice(1, end)
    const rest = entry.slice(end + 1)
    if (rest.startsWith(":") && rest.length > 1) return [host, rest.slice(1)]
    return [host, undefined]
  }
  const idx = entry.lastIndexOf(":")
  if (idx > 0 && /^\d+$/.test(entry.slice(idx + 1))) {
    return [entry.slice(0, idx), entry.slice(idx + 1)]
  }
  return [entry, undefined]
}

function proxyAuthorizationHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64")
  return `Basic ${token}`
}

export type OpenHttpsConnectTunnelOptions = {
  proxy: URL
  targetHost: string
  targetPort?: number
  signal?: AbortSignal
  /** Injected for tests. */
  connect?: typeof net.connect
}

/**
 * Open a plain TCP connection to the proxy and establish an HTTP CONNECT tunnel
 * to `targetHost:targetPort`. Returns the tunneled socket ready for TLS.
 */
export async function openHttpsConnectTunnel(
  options: OpenHttpsConnectTunnelOptions,
): Promise<net.Socket> {
  const targetPort = options.targetPort ?? 443
  const proxy = options.proxy
  if (proxy.protocol !== "http:") {
    throw new CursorTransportError(
      `HTTPS CONNECT proxy must use http:// (got ${proxy.protocol}); https:// proxies are not supported`,
      { transient: false, replaySafe: true, code: "CURSOR_PROXY_UNSUPPORTED" },
    )
  }

  const proxyPort = proxy.port ? Number(proxy.port) : 80
  const proxyHost = proxy.hostname
  const connect = options.connect ?? net.connect

  if (options.signal?.aborted) {
    throw new CursorTransportError("HTTPS CONNECT tunnel aborted before connect", {
      transient: true,
      replaySafe: true,
      code: "CURSOR_PROXY_ABORTED",
      cause: options.signal.reason,
    })
  }

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = connect(proxyPort, proxyHost)
    const onAbort = () => {
      cleanup()
      try { s.destroy() } catch { /* ignore */ }
      reject(new CursorTransportError("HTTPS CONNECT tunnel aborted during TCP connect", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_PROXY_ABORTED",
        cause: options.signal?.reason,
      }))
    }
    const cleanup = () => {
      s.removeListener("connect", onConnect)
      s.removeListener("error", onError)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(new CursorTransportError(
        `HTTPS CONNECT proxy TCP connect to ${proxyHost}:${proxyPort} failed`,
        { transient: true, replaySafe: true, code: "CURSOR_PROXY_CONNECT_FAILED", cause: error },
      ))
    }
    const onConnect = () => {
      cleanup()
      resolve(s)
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    s.once("connect", onConnect)
    s.once("error", onError)
  })

  const authority = `${options.targetHost}:${targetPort}`
  const auth = proxyAuthorizationHeader(proxy)
  const request = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: keep-alive",
    ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
    "",
    "",
  ].join("\r\n")

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let buffer = Buffer.alloc(0)

    const onAbort = () => {
      fail(new CursorTransportError("HTTPS CONNECT tunnel aborted during handshake", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_PROXY_ABORTED",
        cause: options.signal?.reason,
      }))
    }
    const cleanup = () => {
      socket.removeListener("data", onData)
      socket.removeListener("error", onError)
      socket.removeListener("close", onClose)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try { socket.destroy() } catch { /* ignore */ }
      reject(error)
    }
    const onError = (error: Error) => {
      fail(new CursorTransportError("HTTPS CONNECT tunnel socket error", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_PROXY_CONNECT_FAILED",
        cause: error,
      }))
    }
    const onClose = () => {
      fail(new CursorTransportError("HTTPS CONNECT tunnel closed before response", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_PROXY_CONNECT_FAILED",
      }))
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const headerEnd = buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) {
        if (buffer.length > 64_000) {
          fail(new CursorTransportError("HTTPS CONNECT response headers too large", {
            transient: true,
            replaySafe: true,
            code: "CURSOR_PROXY_CONNECT_FAILED",
          }))
        }
        return
      }

      const headerText = buffer.subarray(0, headerEnd).toString("utf8")
      const statusLine = headerText.split("\r\n", 1)[0] ?? ""
      const match = /^HTTP\/\d\.\d\s+(\d{3})\b/i.exec(statusLine)
      const status = match ? Number(match[1]) : NaN
      if (status !== 200) {
        fail(new CursorTransportError(
          `HTTPS CONNECT to ${authority} via ${proxyHost}:${proxyPort} failed: ${statusLine || "no status"}`,
          { transient: true, replaySafe: true, code: "CURSOR_PROXY_CONNECT_REJECTED" },
        ))
        return
      }

      const rest = buffer.subarray(headerEnd + 4)
      if (settled) return
      settled = true
      cleanup()
      if (rest.length > 0) socket.unshift(rest)
      resolve()
    }

    options.signal?.addEventListener("abort", onAbort, { once: true })
    socket.on("data", onData)
    socket.once("error", onError)
    socket.once("close", onClose)
    try {
      socket.write(request)
    } catch (error) {
      fail(new CursorTransportError("HTTPS CONNECT request write failed", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_PROXY_CONNECT_FAILED",
        cause: error,
      }))
    }
  })

  return socket
}

export type OpenProxiedTlsSocketOptions = {
  proxy: URL
  targetHost: string
  targetPort?: number
  signal?: AbortSignal
  connect?: typeof net.connect
  tlsConnect?: typeof tls.connect
}

/** CONNECT through the proxy, then complete TLS (ALPN h2) on the native socket. */
export async function openProxiedTlsSocket(
  options: OpenProxiedTlsSocketOptions,
): Promise<tls.TLSSocket> {
  const targetPort = options.targetPort ?? 443
  const plain = await openHttpsConnectTunnel({
    proxy: options.proxy,
    targetHost: options.targetHost,
    targetPort,
    signal: options.signal,
    connect: options.connect,
  })

  const tlsConnect = options.tlsConnect ?? tls.connect
  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      fail(new CursorTransportError("HTTPS CONNECT TLS handshake aborted", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_PROXY_ABORTED",
        cause: options.signal?.reason,
      }))
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try { socket.destroy() } catch { /* ignore */ }
      try { plain.destroy() } catch { /* ignore */ }
      reject(error)
    }
    const cleanup = () => {
      socket.removeListener("secureConnect", onSecure)
      socket.removeListener("error", onError)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const onError = (error: Error) => {
      fail(new CursorTransportError(
        `HTTPS CONNECT TLS to ${options.targetHost} failed`,
        { transient: true, replaySafe: true, code: "CURSOR_PROXY_TLS_FAILED", cause: error },
      ))
    }
    const onSecure = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }

    const socket = tlsConnect({
      socket: plain,
      servername: options.targetHost,
      ALPNProtocols: ["h2"],
    })
    options.signal?.addEventListener("abort", onAbort, { once: true })
    socket.once("secureConnect", onSecure)
    socket.once("error", onError)
  })
}
