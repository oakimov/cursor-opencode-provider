import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { resolveAgentUrl, resetAgentUrlCache } from "../src/agent-url.js"
import { CURSOR_API_HOST, SERVER_CONFIG_PATH } from "../src/shared.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"

// ResolveClientVersion fetches the installer script when nothing is cached; the
// resolver's GetServerConfig fetch runs alongside it, so the mock must answer both.
const INSTALLER_FIXTURE = `var x="https://downloads.cursor.com/lab/2026.07.09-a3815c0/";`
const EXPECTED_ENDPOINT = `https://${CURSOR_API_HOST}${SERVER_CONFIG_PATH}`

function fakeJwt(ttlS: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlS }
  return `header.${btoa(JSON.stringify(payload))}.sig`
}

type RecordedCall = { url: string; method: string; headers: Headers; body: string }

describe("resolveAgentUrl", () => {
  let realFetch: typeof globalThis.fetch
  let getServerConfigCalls: RecordedCall[]
  let installerCalls: number

  beforeEach(() => {
    realFetch = globalThis.fetch
    getServerConfigCalls = []
    installerCalls = 0
    resetAgentUrlCache()
    resetClientVersionCache()

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        getServerConfigCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit),
          body: typeof init?.body === "string" ? init.body : "",
        })
        return Response.json({
          agentUrlConfig: {
            agentnUrl: "https://agentn.us.api5.cursor.sh",
            agentUrl: "https://agentn.us.api5.cursor.sh",
          },
        })
      }
      if (url.includes("cursor.com/install")) {
        installerCalls += 1
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    resetAgentUrlCache()
    resetClientVersionCache()
  })

  it("POSTs to GetServerConfig on the api2 host (not the agent host) with CLI auth", async () => {
    const url = await resolveAgentUrl(fakeJwt(3600))
    expect(url).toBe("https://agentn.us.api5.cursor.sh")

    expect(getServerConfigCalls).toHaveLength(1)
    const call = getServerConfigCalls[0]
    // Right server + endpoint — proves we query api2.cursor.sh, not agentn.*.
    expect(call.url).toBe(EXPECTED_ENDPOINT)
    expect(call.method).toBe("POST")
    expect(call.headers.get("authorization")).toMatch(/^Bearer /)
    expect(call.headers.get("content-type")).toBe("application/json")
    expect(call.headers.get("accept")).toBe("application/json")
    expect(call.headers.get("x-cursor-client-type")).toBe("cli")
    expect(call.headers.get("connect-protocol-version")).toBe("1")
    // Minimal valid GetServerConfigRequest body. Telemetry is disabled by default.
    expect(JSON.parse(call.body)).toEqual({ telem_enabled: false })
  })

  it("can opt in to GetServerConfig telemetry", async () => {
    await resolveAgentUrl(fakeJwt(3600), { telemetryEnabled: true })
    expect(getServerConfigCalls).toHaveLength(1)
    expect(JSON.parse(getServerConfigCalls[0].body)).toEqual({ telem_enabled: true })
  })

  it("returns agentUrlConfig.agentnUrl", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        agentUrlConfig: { agentnUrl: "https://agentn.eu.api5.cursor.sh" },
      })) as typeof fetch
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.eu.api5.cursor.sh")
  })

  it("prefers agentnUrl, else agentUrl", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        agentUrlConfig: { agentUrl: "agentn.eu.api5.cursor.sh" },
      })) as typeof fetch
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.eu.api5.cursor.sh")
  })

  it("memoizes the resolved url for the process lifetime — no refetch", async () => {
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(1)
  })

  it("treats omitted apiBaseURL and the default apiBaseURL as the same memo key", async () => {
    const token = fakeJwt(3600)
    expect(await resolveAgentUrl(token)).toBe("https://agentn.us.api5.cursor.sh")
    expect(await resolveAgentUrl(token, { apiBaseURL: `https://${CURSOR_API_HOST}` })).toBe(
      "https://agentn.us.api5.cursor.sh",
    )
    expect(getServerConfigCalls).toHaveLength(1)
  })

  it("dedups concurrent callers to a single GetServerConfig fetch", async () => {
    const results = await Promise.all([
      resolveAgentUrl(fakeJwt(3600)),
      resolveAgentUrl(fakeJwt(3600)),
      resolveAgentUrl(fakeJwt(3600)),
    ])
    expect(results).toEqual([
      "https://agentn.us.api5.cursor.sh",
      "https://agentn.us.api5.cursor.sh",
      "https://agentn.us.api5.cursor.sh",
    ])
    expect(getServerConfigCalls).toHaveLength(1)
  })

  it("throws when the fetch fails instead of falling back to the global host", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as typeof fetch
    await expect(resolveAgentUrl(fakeJwt(3600))).rejects.toThrow(
      "GetServerConfig network request failed",
    )
  })

  it("does not memoize empty agentUrlConfig — the next call retries and self-heals", async () => {
    let empty = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        getServerConfigCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit),
          body: typeof init?.body === "string" ? init.body : "",
        })
        if (empty) return Response.json({})
        return Response.json({ agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" } })
      }
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    await expect(resolveAgentUrl(fakeJwt(3600))).rejects.toThrow(
      "GetServerConfig response missing agentUrlConfig.agentnUrl",
    )
    expect(getServerConfigCalls).toHaveLength(1)

    empty = false
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(2)

    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(2)
  })

  it("does not memoize a failure — the next call retries and self-heals", async () => {
    let fail = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        getServerConfigCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit),
          body: typeof init?.body === "string" ? init.body : "",
        })
        if (fail) throw new Error("transient")
        return Response.json({ agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" } })
      }
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    // First call fails and is not memoized.
    await expect(resolveAgentUrl(fakeJwt(3600))).rejects.toThrow(
      "GetServerConfig network request failed",
    )
    expect(getServerConfigCalls).toHaveLength(1)

    // Backend recovers → second call resolves the real region and memoizes it.
    fail = false
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(2)

    // Third call reuses the memo — no further fetch.
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(2)
  })


  it("normalizes a bare hostname from GetServerConfig", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        agentUrlConfig: { agentnUrl: "agentn.us.api5.cursor.sh" },
      })) as typeof fetch
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
  })

  it("rejects a non-Cursor agent host without memoizing", async () => {
    let evil = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        getServerConfigCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit),
          body: typeof init?.body === "string" ? init.body : "",
        })
        if (evil) {
          return Response.json({ agentUrlConfig: { agentnUrl: "https://evil.example" } })
        }
        return Response.json({ agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" } })
      }
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    await expect(resolveAgentUrl(fakeJwt(3600))).rejects.toThrow(
      "GetServerConfig returned an invalid Cursor agent URL",
    )
    expect(getServerConfigCalls).toHaveLength(1)

    evil = false
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(2)
  })

  it("re-resolves when the bearer token changes (no cross-account memo bleed)", async () => {
    const tokenA = fakeJwt(3600)
    const tokenB = fakeJwt(7200)
    let regionForA = "https://agentn.us.api5.cursor.sh"
    let regionForB = "https://agentn.eu.api5.cursor.sh"

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        getServerConfigCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit),
          body: typeof init?.body === "string" ? init.body : "",
        })
        const auth = init?.headers instanceof Headers
          ? init.headers.get("authorization")
          : new Headers(init?.headers as HeadersInit).get("authorization")
        const region = auth?.includes(tokenA) ? regionForA : regionForB
        return Response.json({ agentUrlConfig: { agentnUrl: region } })
      }
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    expect(await resolveAgentUrl(tokenA)).toBe(regionForA)
    expect(await resolveAgentUrl(tokenA)).toBe(regionForA)
    expect(getServerConfigCalls).toHaveLength(1)

    expect(await resolveAgentUrl(tokenB)).toBe(regionForB)
    expect(getServerConfigCalls).toHaveLength(2)

    expect(await resolveAgentUrl(tokenB)).toBe(regionForB)
    expect(getServerConfigCalls).toHaveLength(2)
  })

  it("keeps resolved urls per token, not just the last token", async () => {
    const tokenA = fakeJwt(3600)
    const tokenB = fakeJwt(7200)
    const regionForA = "https://agentn.us.api5.cursor.sh"
    const regionForB = "https://agentn.eu.api5.cursor.sh"

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        getServerConfigCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit),
          body: typeof init?.body === "string" ? init.body : "",
        })
        const auth = new Headers(init?.headers as HeadersInit).get("authorization")
        return Response.json({
          agentUrlConfig: { agentnUrl: auth?.includes(tokenA) ? regionForA : regionForB },
        })
      }
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    expect(await resolveAgentUrl(tokenA)).toBe(regionForA)
    expect(await resolveAgentUrl(tokenB)).toBe(regionForB)
    expect(await resolveAgentUrl(tokenA)).toBe(regionForA)
    expect(getServerConfigCalls).toHaveLength(2)
  })

  it("re-resolves when telemetry opt-in changes", async () => {
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(await resolveAgentUrl(fakeJwt(3600))).toBe("https://agentn.us.api5.cursor.sh")
    expect(getServerConfigCalls).toHaveLength(1)

    expect(await resolveAgentUrl(fakeJwt(3600), { telemetryEnabled: true })).toBe(
      "https://agentn.us.api5.cursor.sh",
    )
    expect(getServerConfigCalls).toHaveLength(2)
    expect(JSON.parse(getServerConfigCalls[1].body)).toEqual({ telem_enabled: true })
  })

  it("honors a custom apiBaseURL, posting GetServerConfig to the override", async () => {
    await resolveAgentUrl(fakeJwt(3600), { apiBaseURL: "https://staging.cursor.sh" })
    expect(getServerConfigCalls).toHaveLength(1)
    expect(getServerConfigCalls[0].url).toBe(`https://staging.cursor.sh${SERVER_CONFIG_PATH}`)
  })
})
