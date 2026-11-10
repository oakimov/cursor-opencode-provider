import net from "node:net"

/**
 * Tests run without the network. A `fetch`, or a socket opened through
 * node:net, node:tls or node:http2 (all three connect through
 * `net.Socket.prototype.connect`), to anything but this machine is refused
 * before a byte is sent, and recorded. That includes a redirect: Bun follows
 * those inside `fetch`, so the guard follows them itself and checks each
 * destination first. `test/preload.ts` fails the test that tried, so code that
 * swallows the refusal is caught as well. Processes a test spawns are not
 * covered.
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

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
/** The Fetch standard's limit. */
const MAX_REDIRECTS = 20
/** Headers that describe a body, dropped with it when a redirect turns the request into a GET. */
const BODY_HEADERS = ["content-encoding", "content-language", "content-length", "content-location", "content-type"]

/**
 * `fetch` with every redirect made here, one request at a time, by the Fetch
 * standard's rules: 303 and a redirected POST (301, 302) continue as a GET
 * without the body, 307 and 308 repeat the request, and credentials stay on
 * their origin. A destination outside this machine is refused instead.
 */
async function fetchLocally(realFetch: typeof fetch, input: FetchInput, init?: FetchInit): Promise<Response> {
  const request = input instanceof Request ? input : undefined
  let url: URL
  try {
    url = new URL(request ? request.url : String(input))
  } catch {
    // Not an absolute URL: fetch reports that itself.
    return realFetch(input, init)
  }
  // Only "follow" makes fetch request a redirect's destination.
  if ((init?.redirect ?? request?.redirect ?? "follow") !== "follow") return realFetch(input, init)

  // A Request's body can be read once; a 307 or 308 sends it again.
  let replay = request?.body && init?.body === undefined ? request.clone() : undefined
  let method = (init?.method ?? request?.method ?? "GET").toUpperCase()
  const headers = new Headers(init?.headers ?? request?.headers)
  let body = init?.body
  const signal = init?.signal ?? request?.signal
  let response = await realFetch(input, { ...init, redirect: "manual" })
  let redirects = 0
  for (;;) {
    const location = REDIRECT_STATUS.has(response.status) ? response.headers.get("location") : null
    if (location === null) break
    if (++redirects > MAX_REDIRECTS) throw new TypeError(`fetch failed: more than ${MAX_REDIRECTS} redirects`)
    const next = new URL(location, url)
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new TypeError(`fetch failed: redirect to a ${next.protocol} URL`)
    }
    const remote = remoteRequest(next)
    if (remote !== undefined) throw refuse(`fetch ${remote}, redirected from ${url.origin}${url.pathname}`)

    const toGet = response.status === 303
      ? method !== "GET" && method !== "HEAD"
      : method === "POST" && (response.status === 301 || response.status === 302)
    if (toGet) {
      method = "GET"
      body = undefined
      void replay?.body?.cancel()
      replay = undefined
      for (const name of BODY_HEADERS) headers.delete(name)
    } else if (body instanceof ReadableStream) {
      throw new TypeError("fetch failed: a redirect cannot send a streamed body again")
    } else if (replay) {
      body = await replay.arrayBuffer()
      replay = undefined
    }
    if (next.origin !== url.origin) headers.delete("authorization")
    await response.body?.cancel()
    url = next
    response = await realFetch(url, { ...init, redirect: "manual", method, headers, body, signal })
  }
  void replay?.body?.cancel()
  if (redirects > 0) Object.defineProperty(response, "redirected", { value: true })
  return response
}

/** Refuse and record everything that leaves this machine, for the rest of the process. */
export function installNetworkGuard(): void {
  const realFetch = globalThis.fetch
  const guardedFetch = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const remote = remoteRequest(input)
    return remote === undefined
      ? fetchLocally(realFetch, input, init)
      : Promise.reject(refuse(`fetch ${remote}`))
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
