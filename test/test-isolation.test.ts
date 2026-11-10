import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import type { EventEmitter } from "node:events"
import http2 from "node:http2"
import net from "node:net"
import path from "node:path"
import tls from "node:tls"
import { readStoredAuth } from "../src/context/auth-store.js"
import { hostGlobalDataDir } from "../src/context/paths.js"
import { resetClientVersionCache, resolveClientVersion } from "../src/protocol/client-version.js"
import { isLocalHost, takeNetworkAttempts } from "./network-guard.js"

/** TEST-NET-1 (RFC 5737): reserved for documentation and never routed. */
const REMOTE = "192.0.2.1"
const REFUSED = "Tests run without the network"

const firstError = (emitter: EventEmitter): Promise<Error> =>
  new Promise((resolve) => emitter.once("error", resolve))

describe("test run isolation (test/preload.ts)", () => {
  it("starts on the run's own empty credential store", async () => {
    const dataHome = path.join(process.env.TMPDIR!, "xdg-data")
    expect(process.env.XDG_DATA_HOME).toBe(dataHome)
    expect(process.env.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(hostGlobalDataDir()).toBe(path.join(dataHome, "opencode"))
    expect(existsSync(hostGlobalDataDir())).toBe(false)
    expect(await readStoredAuth("cursor")).toBeUndefined()
  })

  it("resolves the client version without the operator's Cursor CLI or Cursor's installer page", async () => {
    resetClientVersionCache()
    expect(await resolveClientVersion()).toBe("cli-test")
  })

  it("refuses a request that leaves this machine and records it without its query", async () => {
    const url = `https://${REMOTE}/v1/models`
    for (const input of [`${url}?token=example`, new URL(url), new Request(url, { method: "POST" })]) {
      await expect(fetch(input)).rejects.toThrow(REFUSED)
    }
    expect(takeNetworkAttempts()).toEqual([`fetch ${url}`, `fetch ${url}`, `fetch ${url}`])
  })

  it("refuses node:net, node:tls and node:http2 connections that leave this machine", async () => {
    expect((await firstError(net.connect({ host: REMOTE, port: 80 }))).message).toContain(REFUSED)
    expect((await firstError(net.connect(80, REMOTE))).message).toContain(REFUSED)
    expect((await firstError(tls.connect({ host: REMOTE, port: 443 }))).message).toContain(REFUSED)
    expect((await firstError(http2.connect(`https://${REMOTE}`))).message).toContain(REFUSED)
    expect(takeNetworkAttempts()).toEqual([
      `a connection to ${REMOTE}:80`,
      `a connection to ${REMOTE}:80`,
      `a connection to ${REMOTE}:443`,
      `a connection to ${REMOTE}:443`,
    ])
  })

  /** A local server that redirects by path and records what reached it. */
  function redirector() {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url)
        const body = await request.text()
        seen.push(`${request.method} ${pathname} ${request.headers.get("content-type")} ${JSON.stringify(body)}`)
        const to = (status: number, location: string) => new Response(null, { status, headers: { location } })
        if (pathname === "/out") return to(302, `https://${REMOTE}/elsewhere?token=example`)
        if (pathname === "/hop") return to(307, "/out")
        if (pathname === "/repeat") return to(307, "/see-other")
        if (pathname === "/see-other") return to(303, "/end")
        if (pathname === "/moved") return to(302, "/end")
        if (pathname === "/loop") return to(302, "/loop")
        return new Response("end")
      },
    })
    return { server, seen, base: `http://127.0.0.1:${server.port}` }
  }

  it("refuses a redirect that leaves this machine before following it", async () => {
    const { server, seen, base } = redirector()
    using _server = server
    await expect(fetch(`${base}/out`)).rejects.toThrow(REFUSED)
    const post = { method: "POST", body: "payload", headers: { "content-type": "text/plain" } }
    await expect(fetch(new Request(`${base}/hop`, post))).rejects.toThrow(REFUSED)
    expect(takeNetworkAttempts()).toEqual([
      `fetch https://${REMOTE}/elsewhere, redirected from ${base}/out`,
      `fetch https://${REMOTE}/elsewhere, redirected from ${base}/out`,
    ])
    expect(seen).toEqual(['GET /out null ""', 'POST /hop text/plain "payload"', 'POST /out text/plain "payload"'])
  })

  it("follows redirects on this machine as fetch does", async () => {
    const { server, seen, base } = redirector()
    using _server = server
    const post = { method: "POST", body: "payload", headers: { "content-type": "text/plain" } }

    const repeated = await fetch(`${base}/repeat`, post)
    expect([repeated.status, repeated.redirected, repeated.url, await repeated.text()]).toEqual([200, true, `${base}/end`, "end"])
    expect(seen.splice(0)).toEqual(['POST /repeat text/plain "payload"', 'POST /see-other text/plain "payload"', 'GET /end null ""'])

    expect(await (await fetch(new Request(`${base}/repeat`, post))).text()).toBe("end")
    expect(seen.splice(0)).toEqual(['POST /repeat text/plain "payload"', 'POST /see-other text/plain "payload"', 'GET /end null ""'])

    expect(await (await fetch(`${base}/moved`, post)).text()).toBe("end")
    expect(seen.splice(0)).toEqual(['POST /moved text/plain "payload"', 'GET /end null ""'])

    const unfollowed = await fetch(`${base}/moved`, { redirect: "manual" })
    expect([unfollowed.status, unfollowed.redirected, unfollowed.headers.get("location")]).toEqual([302, false, "/end"])
    await expect(fetch(`${base}/moved`, { redirect: "error" })).rejects.toThrow("UnexpectedRedirect")
    await expect(fetch(`${base}/loop`)).rejects.toThrow("more than 20 redirects")
    expect(takeNetworkAttempts()).toEqual([])
  })

  it("leaves this machine reachable", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("local") })
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("local")
    expect(await (await fetch(new URL(`http://localhost:${server.port}/`))).text()).toBe("local")
    const answer = await new Promise<string>((resolve, reject) => {
      let received = ""
      const socket = net.connect(server.port!, "127.0.0.1", () => socket.write("GET / HTTP/1.0\r\n\r\n"))
      socket.on("data", (chunk) => { received += String(chunk) })
      socket.on("close", () => resolve(received))
      socket.on("error", reject)
    })
    expect(answer).toEndWith("local")
    expect(takeNetworkAttempts()).toEqual([])
  })

  it("tells this machine from every other host", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "0.0.0.0", "::"]) {
      expect(isLocalHost(host)).toBe(true)
    }
    for (const host of ["api2.cursor.sh", "localhost.example.com", "127.0.0.1.example.com", "1127.0.0.1", "10.0.0.1", REMOTE]) {
      expect(isLocalHost(host)).toBe(false)
    }
  })
})

/** Run one fixture file in its own `bun test`, under the same preload. */
function runFixture(name: string): { exitCode: number; output: string; pass: number; fail: number } {
  const child = Bun.spawnSync([process.execPath, "test", `./test/fixtures/isolation/${name}.fixture.ts`], {
    cwd: path.join(import.meta.dir, ".."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = `${child.stdout.toString()}${child.stderr.toString()}`
  const count = (label: string) => Number(new RegExp(`^\\s*(\\d+) ${label}$`, "m").exec(output)?.[1])
  return { exitCode: child.exitCode, output, pass: count("pass"), fail: count("fail") }
}

describe("a test that breaks isolation", () => {
  it("fails when it tried the network, even though the code swallowed the refusal", () => {
    const run = runFixture("network")
    expect(run.output).toContain("tried to reach the network (fetch https://192.0.2.1/models)")
    expect(run.output).not.toContain("token=example")
    expect(run.output).toContain("(fail) swallows a refused request")
    expect({ pass: run.pass, fail: run.fail, exitCode: run.exitCode }).toEqual({ pass: 1, fail: 1, exitCode: 1 })
  }, 30_000)

  it("fails when it leaves the credential store redirected, and the next test is isolated again", () => {
    const run = runFixture("credential-store")
    expect(run.output).toContain("left XDG_DATA_HOME or OPENCODE_AUTH_CONTENT changed")
    expect(run.output).toContain("(fail) leaves the native data root unset")
    expect(run.output).toContain("(fail) leaves injected credentials behind")
    expect({ pass: run.pass, fail: run.fail, exitCode: run.exitCode }).toEqual({ pass: 1, fail: 2, exitCode: 1 })
  }, 30_000)

  it("does not pass its temp host cache on when it times out", () => {
    const run = runFixture("host-cache-timeout")
    expect(run.output).toContain("(fail) times out inside a temp host cache")
    expect(run.output).not.toContain("Tests left")
    expect({ pass: run.pass, fail: run.fail, exitCode: run.exitCode }).toEqual({ pass: 3, fail: 1, exitCode: 1 })
  }, 30_000)

  it("does not pass its temp host cache on when it times out while that cache is cleaned up", () => {
    const run = runFixture("host-cache-cleanup-timeout")
    expect(run.output).toContain("(fail) times out while its temp host cache is cleaned up")
    expect(run.output).not.toContain("Tests left")
    expect({ pass: run.pass, fail: run.fail, exitCode: run.exitCode }).toEqual({ pass: 3, fail: 1, exitCode: 1 })
  }, 30_000)
})
