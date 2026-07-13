import { describe, it, expect } from "bun:test"
import { resolveAgentOrigin } from "../src/transport/connect.js"
import { CURSOR_AGENT_HOST } from "../src/shared.js"

describe("resolveAgentOrigin", () => {
  it("defaults to the Cursor agent host", () => {
    expect(resolveAgentOrigin()).toBe(`https://${CURSOR_AGENT_HOST}`)
    expect(resolveAgentOrigin(undefined)).toBe(`https://${CURSOR_AGENT_HOST}`)
  })

  it("uses the origin of a custom baseURL (including port)", () => {
    expect(resolveAgentOrigin("https://alt.example:9443/agent")).toBe(
      "https://alt.example:9443",
    )
  })

  it("keeps distinct origins distinct (cache key property)", () => {
    const a = resolveAgentOrigin()
    const b = resolveAgentOrigin("https://127.0.0.1:8443")
    expect(a).not.toBe(b)
  })
})
