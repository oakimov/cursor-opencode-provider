import { afterEach, describe, expect, it } from "bun:test"
import net from "node:net"
import {
  hostMatchesNoProxy,
  openHttpsConnectTunnel,
  resolveHttpsProxyUrl,
} from "../src/transport/https-proxy.js"
import { CursorTransportError } from "../src/errors.js"

afterEach(() => {
  // Keep process env untouched across cases that pass explicit env maps.
})

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

  it("honors port-qualified bypass only for 443", () => {
    expect(hostMatchesNoProxy("api.example", "api.example:443")).toBe(true)
    expect(hostMatchesNoProxy("api.example", "api.example:3128")).toBe(false)
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

  it("accepts proxy URLs without a scheme and ignores unsupported schemes", () => {
    expect(
      resolveHttpsProxyUrl("agent.example", { HTTPS_PROXY: "proxy.example:3128" })?.href,
    ).toBe("http://proxy.example:3128/")
    expect(
      resolveHttpsProxyUrl("agent.example", { HTTPS_PROXY: "socks5://proxy.example:1080" }),
    ).toBeUndefined()
  })
})

describe("openHttpsConnectTunnel", () => {
  it("sends CONNECT with Basic auth and returns the tunneled socket on 200", async () => {
    const seen: { request?: string } = {}
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0)
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (buf.includes("\r\n\r\n")) {
          seen.request = buf.toString("utf8")
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("expected TCP address")

    try {
      const proxy = new URL(`http://user:s3cret@127.0.0.1:${address.port}`)
      const tunneled = await openHttpsConnectTunnel({
        proxy,
        targetHost: "agentn.us.api5.cursor.sh",
        targetPort: 443,
      })
      expect(seen.request).toContain("CONNECT agentn.us.api5.cursor.sh:443 HTTP/1.1")
      expect(seen.request).toContain("Host: agentn.us.api5.cursor.sh:443")
      expect(seen.request).toContain(
        `Proxy-Authorization: Basic ${Buffer.from("user:s3cret", "utf8").toString("base64")}`,
      )
      expect(tunneled.destroyed).toBe(false)
      tunneled.destroy()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })

  it("rejects non-200 CONNECT responses", async () => {
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("expected TCP address")

    try {
      const proxy = new URL(`http://127.0.0.1:${address.port}`)
      await expect(
        openHttpsConnectTunnel({
          proxy,
          targetHost: "agentn.us.api5.cursor.sh",
        }),
      ).rejects.toBeInstanceOf(CursorTransportError)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })

  it("rejects https:// proxy URLs", async () => {
    await expect(
      openHttpsConnectTunnel({
        proxy: new URL("https://proxy.example:8443"),
        targetHost: "agentn.us.api5.cursor.sh",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_PROXY_UNSUPPORTED" })
  })
})
