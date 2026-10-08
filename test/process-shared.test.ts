import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as agentUrlA from "../src/agent-url.js"
import * as renewalA from "../src/auth-renewal.js"
import { CursorAuthError } from "../src/errors.js"
import { processShared } from "../src/process-shared.js"
import { resetClientVersionCache, resolveClientVersion } from "../src/protocol/client-version.js"

// OpenCode 2 imports a separate copy of the plugin's module graph for each
// location it serves. A query string gives Bun the same: a second instance of
// the module with its own top-level state.
let copies = 0
async function secondCopy<T>(specifier: string): Promise<T> {
  copies += 1
  return (await import(`${specifier}?copy=${copies}`)) as T
}

const DAY_S = 86_400

function sessionJwt(issuedAgoS: number): string {
  const issued = Math.floor(Date.now() / 1000) - issuedAgoS
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    type: "session",
    time: String(issued),
    exp: issued + 60 * DAY_S,
    randomness: Math.random().toString(36).slice(2),
  })).toString("base64url")
  return `${header}.${payload}.sig`
}

function keyJwt(expInS: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expInS,
    randomness: Math.random(),
  })).toString("base64url")
  return `${header}.${payload}.sig`
}

function cursorStub(respond: (path: string) => Response | Promise<Response>) {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      paths.push(path)
      return respond(path)
    },
  })
  return { server, paths, base: `http://localhost:${server.port}` }
}

describe("processShared", () => {
  it("returns one value per name for the whole process", () => {
    const name = `test.${Math.random()}.v1`
    let created = 0
    const first = processShared(name, () => ({ created: ++created }))
    const again = processShared(name, () => ({ created: ++created }))
    expect(again).toBe(first)
    expect(created).toBe(1)
  })

  it("is visible to another copy of the module", async () => {
    const copy = await secondCopy<typeof import("../src/process-shared.js")>("../src/process-shared.ts")
    expect(copy.processShared).not.toBe(processShared)
    const name = `test.${Math.random()}.v1`
    const value = processShared(name, () => new Map<string, string>())
    expect(copy.processShared(name, () => new Map<string, string>())).toBe(value)
  })
})

describe("credential renewal across module copies", () => {
  beforeEach(() => renewalA.resetAuthRenewalState())

  it("renews one session once, whichever copy asks", async () => {
    const renewalB = await secondCopy<typeof renewalA>("../src/auth-renewal.ts")
    expect(renewalB.renewSessionIfDue).not.toBe(renewalA.renewSessionIfDue)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fresh = sessionJwt(0)
    const stub = cursorStub(async () => {
      await gate
      return Response.json({ access_token: fresh, shouldLogout: false })
    })
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const tokens = { accessToken: token, refreshToken: token }
    const pending = [
      renewalA.renewSessionIfDue(tokens, { baseUrl: stub.base }),
      renewalB.renewSessionIfDue(tokens, { baseUrl: stub.base }),
    ]
    release()
    expect((await Promise.all(pending)).map((r) => r.accessToken)).toEqual([fresh, fresh])
    expect(stub.paths).toEqual(["/oauth/token"])
    // A copy that asks later is handed the successor without another request.
    const renewalC = await secondCopy<typeof renewalA>("../src/auth-renewal.ts")
    expect(renewalC.latestSessionTokens(tokens).accessToken).toBe(fresh)
    expect(stub.paths).toHaveLength(1)
  })

  it("raises a logout latched by one copy in another as that copy's own sign-in error", async () => {
    const renewalB = await secondCopy<typeof renewalA>("../src/auth-renewal.ts")
    const stub = cursorStub(() => Response.json({ access_token: "", shouldLogout: true }))
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const tokens = { accessToken: token, refreshToken: token }
    await renewalA.renewSessionIfDue(tokens, { baseUrl: stub.base }).catch(() => undefined)
    const failure = await renewalB.renewSessionIfDue(tokens, { baseUrl: stub.base, force: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorAuthError)
    expect((failure as CursorAuthError).code).toBe("session_logout")
    expect(stub.paths).toHaveLength(1)
  })

  it("exchanges one API key once, whichever copy asks", async () => {
    const renewalB = await secondCopy<typeof renewalA>("../src/auth-renewal.ts")
    const stub = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "unused" }))
    using _ = stub.server
    const a = await renewalA.resolveApiKeyToken("crsr_shared_key", { baseUrl: stub.base })
    const b = await renewalB.resolveApiKeyToken("crsr_shared_key", { baseUrl: stub.base })
    expect(b.accessToken).toBe(a.accessToken)
    expect(stub.paths).toEqual(["/auth/exchange_user_api_key"])
  })
})

describe("agent host across module copies", () => {
  let realFetch: typeof globalThis.fetch
  let serverConfigCalls: number

  beforeEach(() => {
    realFetch = globalThis.fetch
    serverConfigCalls = 0
    agentUrlA.resetAgentUrlCache()
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("GetServerConfig")) {
        serverConfigCalls += 1
        await Bun.sleep(5)
        return Response.json({ agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" } })
      }
      if (url.includes("cursor.com/install")) {
        return new Response(`var x="https://downloads.cursor.com/lab/2026.07.09-a3815c0/";`)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    agentUrlA.resetAgentUrlCache()
    resetClientVersionCache()
  })

  it("asks GetServerConfig once per account, whichever copy asks", async () => {
    const agentUrlB = await secondCopy<typeof agentUrlA>("../src/agent-url.ts")
    expect(agentUrlB.resolveAgentUrl).not.toBe(agentUrlA.resolveAgentUrl)
    const token = keyJwt(3600)
    const urls = await Promise.all([agentUrlA.resolveAgentUrl(token), agentUrlB.resolveAgentUrl(token)])
    expect(urls).toEqual(["https://agentn.us.api5.cursor.sh", "https://agentn.us.api5.cursor.sh"])
    expect(await agentUrlB.resolveAgentUrl(token)).toBe("https://agentn.us.api5.cursor.sh")
    expect(serverConfigCalls).toBe(1)
  })
})

describe("client version across module copies", () => {
  afterEach(() => resetClientVersionCache())

  it("resolves once per process", async () => {
    const copy = await secondCopy<typeof import("../src/protocol/client-version.js")>("../src/protocol/client-version.ts")
    const original = process.env.CURSOR_CLIENT_VERSION
    process.env.CURSOR_CLIENT_VERSION = "cli-2026.01.01-shared"
    try {
      resetClientVersionCache()
      expect(copy.resolveClientVersion()).toBe(resolveClientVersion())
    } finally {
      if (original === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = original
    }
  })
})
