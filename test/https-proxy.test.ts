import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import net from "node:net"
import type tls from "node:tls"
import {
  hostMatchesNoProxy,
  openHttpsConnectTunnel,
  openProxiedTlsSocket,
  proxyEndpoint,
  resolveHttpsProxyUrl,
} from "../src/transport/https-proxy.js"
import { closeCachedHttp2SessionsForTests, getSession } from "../src/transport/connect.js"
import { CursorTransportError } from "../src/errors.js"

type FakeProxy = {
  port: number
  /** Raw CONNECT request text per accepted connection, in order. */
  requests: string[]
  /** Resolves when the first accepted connection is closed by the client. */
  firstConnectionClosed: Promise<void>
  close: () => Promise<void>
}

/** Minimal CONNECT proxy: replies `response` once the request headers arrive. */
async function startFakeProxy(response: string | undefined): Promise<FakeProxy> {
  const requests: string[] = []
  const sockets = new Set<net.Socket>()
  let markClosed: () => void = () => {}
  const firstConnectionClosed = new Promise<void>((resolve) => { markClosed = resolve })
  const server = net.createServer((socket) => {
    const first = sockets.size === 0
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => {
      sockets.delete(socket)
      if (first) markClosed()
    })
    let buf = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!buf.includes("\r\n\r\n")) return
      requests.push(buf.toString("utf8"))
      buf = Buffer.alloc(0)
      if (response !== undefined) socket.write(response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("expected TCP address")
  return {
    port: address.port,
    requests,
    firstConnectionClosed,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    },
  }
}

describe("hostMatchesNoProxy", () => {
  it("matches * , exact hosts, and domain suffixes", () => {
    expect(hostMatchesNoProxy("agentn.us.api5.cursor.sh", "*")).toBe(true)
    expect(hostMatchesNoProxy("agentn.us.api5.cursor.sh", "agentn.us.api5.cursor.sh")).toBe(true)
    expect(hostMatchesNoProxy("foo.corp.example", ".corp.example")).toBe(true)
    expect(hostMatchesNoProxy("foo.corp.example", "corp.example")).toBe(true)
    expect(hostMatchesNoProxy("corp.example", "corp.example")).toBe(true)
    expect(hostMatchesNoProxy("notcorp.example", "corp.example")).toBe(false)
    expect(hostMatchesNoProxy("agentn.us.api5.cursor.sh", ".corp.example")).toBe(false)
  })

  it("honors a port-qualified bypass only for the dialed port", () => {
    expect(hostMatchesNoProxy("api.example", "api.example:443")).toBe(true)
    expect(hostMatchesNoProxy("api.example", "api.example:3128")).toBe(false)
    expect(hostMatchesNoProxy("api.example", "api.example:8443", 8443)).toBe(true)
    expect(hostMatchesNoProxy("api.example", "api.example:443", 8443)).toBe(false)
  })
})

describe("resolveHttpsProxyUrl", () => {
  it("prefers HTTPS_PROXY and skips NO_PROXY hosts", () => {
    expect(
      resolveHttpsProxyUrl("agentn.us.api5.cursor.sh", {
        HTTPS_PROXY: "http://proxy.example.com:3128",
      })?.href,
    ).toBe("http://proxy.example.com:3128/")

    expect(
      resolveHttpsProxyUrl("agentn.us.api5.cursor.sh", {
        https_proxy: "http://proxy.example.com:3128",
        NO_PROXY: ".cursor.sh",
      }),
    ).toBeUndefined()

    expect(
      resolveHttpsProxyUrl("intranet.corp.example", {
        HTTPS_PROXY: "http://proxy.example.com:3128",
        NO_PROXY: ".corp.example",
      }),
    ).toBeUndefined()
  })

  it("applies port-qualified NO_PROXY entries to the target port", () => {
    const env = { HTTPS_PROXY: "http://proxy.example:3128", NO_PROXY: "agent.cursor.sh:8443" }
    expect(resolveHttpsProxyUrl("agent.cursor.sh", env, 8443)).toBeUndefined()
    expect(resolveHttpsProxyUrl("agent.cursor.sh", env, 443)?.href).toBe("http://proxy.example:3128/")
  })

  it("does not use HTTP_PROXY for HTTPS targets", () => {
    expect(
      resolveHttpsProxyUrl("agent.example", {
        HTTP_PROXY: "http://proxy.example:3128",
        http_proxy: "http://proxy.example:3128",
      }),
    ).toBeUndefined()
  })

  it("accepts proxy URLs without a scheme and ignores non-http schemes", () => {
    expect(
      resolveHttpsProxyUrl("agent.example", { HTTPS_PROXY: "proxy.example:3128" })?.href,
    ).toBe("http://proxy.example:3128/")
    expect(
      resolveHttpsProxyUrl("agent.example", { HTTPS_PROXY: "socks5://proxy.example:1080" }),
    ).toBeUndefined()
    expect(
      resolveHttpsProxyUrl("agent.example", { HTTPS_PROXY: "https://proxy.example:8443" }),
    ).toBeUndefined()
  })
})

describe("proxyEndpoint", () => {
  it("strips IPv6 brackets and defaults to port 80", () => {
    expect(proxyEndpoint(new URL("http://[fd00::1]:3128"))).toEqual({ host: "fd00::1", port: 3128 })
    expect(proxyEndpoint(new URL("http://proxy.example"))).toEqual({ host: "proxy.example", port: 80 })
  })
})

describe("openHttpsConnectTunnel", () => {
  it("sends CONNECT with Basic auth and returns the tunneled socket on 200", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 200 Connection Established\r\n\r\n")
    try {
      const proxy = new URL(`http://user:s3cret@127.0.0.1:${proxyServer.port}`)
      const tunneled = await openHttpsConnectTunnel({
        proxy,
        targetHost: "agentn.us.api5.cursor.sh",
        targetPort: 443,
      })
      const request = proxyServer.requests[0]
      expect(request).toContain("CONNECT agentn.us.api5.cursor.sh:443 HTTP/1.1")
      expect(request).toContain("Host: agentn.us.api5.cursor.sh:443")
      expect(request).toContain(
        `Proxy-Authorization: Basic ${Buffer.from("user:s3cret", "utf8").toString("base64")}`,
      )
      expect(tunneled.destroyed).toBe(false)
      tunneled.destroy()
    } finally {
      await proxyServer.close()
    }
  })

  it("sends userinfo that is not valid percent-encoding as typed", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 200 Connection Established\r\n\r\n")
    try {
      const proxy = new URL(`http://user:pa%ss@127.0.0.1:${proxyServer.port}`)
      const tunneled = await openHttpsConnectTunnel({ proxy, targetHost: "agent.cursor.sh" })
      expect(proxyServer.requests[0]).toContain(
        `Proxy-Authorization: Basic ${Buffer.from("user:pa%ss", "utf8").toString("base64")}`,
      )
      tunneled.destroy()
    } finally {
      await proxyServer.close()
    }
  })

  it("accepts any 2xx CONNECT response", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 204 No Content\r\n\r\n")
    try {
      const tunneled = await openHttpsConnectTunnel({
        proxy: new URL(`http://127.0.0.1:${proxyServer.port}`),
        targetHost: "agent.cursor.sh",
      })
      expect(tunneled.destroyed).toBe(false)
      tunneled.destroy()
    } finally {
      await proxyServer.close()
    }
  })

  it("rejects proxy denials as non-transient and 5xx as transient", async () => {
    for (const [statusLine, transient] of [
      ["HTTP/1.1 403 Forbidden", false],
      ["HTTP/1.1 407 Proxy Authentication Required", false],
      ["HTTP/1.1 503 Service Unavailable", true],
    ] as const) {
      const proxyServer = await startFakeProxy(`${statusLine}\r\n\r\n`)
      try {
        const error = await openHttpsConnectTunnel({
          proxy: new URL(`http://127.0.0.1:${proxyServer.port}`),
          targetHost: "agentn.us.api5.cursor.sh",
        }).catch((err: unknown) => err)
        expect(error).toBeInstanceOf(CursorTransportError)
        expect(error).toMatchObject({ code: "CURSOR_PROXY_CONNECT_REJECTED", transient })
        await proxyServer.firstConnectionClosed
      } finally {
        await proxyServer.close()
      }
    }
  })

  it("dials IPv6 proxy literals without URL brackets", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 200 Connection Established\r\n\r\n")
    const dialed: unknown[] = []
    const connect = ((port: number, host: string) => {
      dialed.push([port, host])
      return net.connect(proxyServer.port, "127.0.0.1")
    }) as typeof net.connect
    try {
      const tunneled = await openHttpsConnectTunnel({
        proxy: new URL("http://[fd00::1]:3128"),
        targetHost: "agent.cursor.sh",
        connect,
      })
      expect(dialed).toEqual([[3128, "fd00::1"]])
      tunneled.destroy()
    } finally {
      await proxyServer.close()
    }
  })

  it("destroys the proxy socket when aborted during the handshake", async () => {
    const proxyServer = await startFakeProxy(undefined)
    const abort = new AbortController()
    try {
      const pending = openHttpsConnectTunnel({
        proxy: new URL(`http://127.0.0.1:${proxyServer.port}`),
        targetHost: "agent.cursor.sh",
        signal: abort.signal,
      })
      while (proxyServer.requests.length === 0) await new Promise((r) => setTimeout(r, 5))
      abort.abort(new Error("stop"))
      expect(await pending.catch((err: unknown) => err)).toMatchObject({ code: "CURSOR_PROXY_ABORTED" })
      await proxyServer.firstConnectionClosed
    } finally {
      await proxyServer.close()
    }
  })

  it("rejects https:// proxy URLs", async () => {
    const error = await openHttpsConnectTunnel({
      proxy: new URL("https://proxy.example:8443"),
      targetHost: "agentn.us.api5.cursor.sh",
    }).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: "CURSOR_PROXY_UNSUPPORTED" })
  })
})

describe("openProxiedTlsSocket", () => {
  it("starts TLS on the tunneled socket with SNI and ALPN h2", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 200 Connection Established\r\n\r\n")
    let seen: tls.ConnectionOptions | undefined
    const fake = Object.assign(new EventEmitter(), { destroy: () => {} })
    const tlsConnect = ((options: tls.ConnectionOptions) => {
      seen = options
      queueMicrotask(() => fake.emit("secureConnect"))
      return fake
    }) as unknown as typeof tls.connect
    try {
      const socket = await openProxiedTlsSocket({
        proxy: new URL(`http://127.0.0.1:${proxyServer.port}`),
        targetHost: "agent.cursor.sh",
        tlsConnect,
      })
      expect(socket).toBe(fake as unknown as tls.TLSSocket)
      expect(seen?.servername).toBe("agent.cursor.sh")
      expect(seen?.ALPNProtocols).toEqual(["h2"])
      expect(seen?.socket).toBeInstanceOf(net.Socket)
      ;(seen?.socket as net.Socket).destroy()
    } finally {
      await proxyServer.close()
    }
  })

  it("destroys the tunnel when TLS setup throws synchronously", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 200 Connection Established\r\n\r\n")
    const tlsConnect = (() => {
      throw new Error("bad TLS options")
    }) as unknown as typeof tls.connect
    try {
      const error = await openProxiedTlsSocket({
        proxy: new URL(`http://127.0.0.1:${proxyServer.port}`),
        targetHost: "agent.cursor.sh",
        tlsConnect,
      }).catch((err: unknown) => err)
      expect(error).toMatchObject({ code: "CURSOR_PROXY_TLS_FAILED" })
      await proxyServer.firstConnectionClosed
    } finally {
      await proxyServer.close()
    }
  })
})

describe("getSession through HTTPS_PROXY", () => {
  it("tunnels the Run connect through the proxy and surfaces its rejection", async () => {
    const proxyServer = await startFakeProxy("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
    const keys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyServer.port}`
    try {
      const error = await getSession("https://agentn.proxy-test.cursor.sh").catch((err: unknown) => err)
      expect(error).toMatchObject({ code: "CURSOR_PROXY_CONNECT_REJECTED", transient: false })
      expect(proxyServer.requests[0]).toContain("CONNECT agentn.proxy-test.cursor.sh:443 HTTP/1.1")
      await proxyServer.firstConnectionClosed
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      closeCachedHttp2SessionsForTests()
      await proxyServer.close()
    }
  })
})
