import net from "node:net"

/**
 * Tests run without the network. A `fetch`, or a socket opened through
 * node:net, node:tls or node:http2 (all three connect through
 * `net.Socket.prototype.connect`), to anything but this machine is refused
 * before a byte is sent, and recorded. `test/preload.ts` fails the test that
 * tried, so code that swallows the refusal is caught as well. Processes a test
 * spawns are not covered.
 */

const attempts: string[] = []

/** Names and addresses that stay on this machine. */
export function isLocalHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase()
  return name === "localhost"
    || name.endsWith(".localhost")
    || name === "::1"
    || name === "::"
    || name === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(name)
}

/** What was refused since the last call, without query strings or headers. */
export function takeNetworkAttempts(): string[] {
  return attempts.splice(0)
}

function refuse(attempt: string): Error {
  attempts.push(attempt)
  return new Error(`Tests run without the network; refused ${attempt}. Stub fetch or use a local server.`)
}

/** `origin + path` of an http(s) request that would leave this machine. */
function remoteRequest(input: unknown): string | undefined {
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : String(input))
  } catch {
    // Not an absolute URL: fetch reports that itself.
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return isLocalHost(url.hostname) ? undefined : `${url.origin}${url.pathname}`
}

/** `host:port` of a socket that would leave this machine. */
function remoteSocket(args: unknown[]): string | undefined {
  // net.connect, tls.connect and http2.connect pass their normalized
  // `[options, callback]` as one argument.
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0]
  let host: unknown
  let port: unknown
  if (first !== null && typeof first === "object") {
    const options = first as { host?: unknown; port?: unknown; path?: unknown }
    // A socket file or named pipe.
    if (typeof options.path === "string") return undefined
    host = options.host
    port = options.port
  } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    port = first
    host = args[1]
  } else {
    return undefined
  }
  const name = typeof host === "string" && host.length > 0 ? host : "localhost"
  return isLocalHost(name) ? undefined : `${name}:${String(port)}`
}

/** Refuse and record everything that leaves this machine, for the rest of the process. */
export function installNetworkGuard(): void {
  const realFetch = globalThis.fetch
  const guardedFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const remote = remoteRequest(input)
    return remote === undefined ? realFetch(input, init) : Promise.reject(refuse(`fetch ${remote}`))
  }
  const preconnect: typeof fetch.preconnect = (url, options) => {
    const remote = remoteRequest(url)
    if (remote === undefined) realFetch.preconnect(url, options)
    else refuse(`fetch.preconnect ${remote}`)
  }
  globalThis.fetch = Object.assign(guardedFetch, { preconnect })

  const realConnect = net.Socket.prototype.connect
  const guardedConnect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const remote = remoteSocket(args)
    if (remote === undefined) return Reflect.apply(realConnect, this, args) as net.Socket
    const refusal = refuse(`a connection to ${remote}`)
    // Fail it the way a connect error arrives: after the caller has its listeners on.
    queueMicrotask(() => this.destroy(refusal))
    return this
  }
  net.Socket.prototype.connect = guardedConnect as typeof net.Socket.prototype.connect
}
