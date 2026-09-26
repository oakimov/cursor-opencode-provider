import { describe, expect, test } from "bun:test"
import {
  CURSOR_OPENCODE2_MCP_CODEMODE_ENV,
  applyDirectMcpTools,
  isOpenCode2McpCodeModeKept,
} from "../src/opencode2/mcp-codemode.js"
import type { McpEditor } from "../src/opencode2/types.js"

function fakeMcpEditor(servers: Record<string, { type: string; codemode?: boolean }>): McpEditor {
  return {
    list: () => Object.entries(servers),
    update: (name, update) => {
      const config = servers[name]
      if (config) update(config)
    },
  }
}

describe("applyDirectMcpTools", () => {
  test("turns Code Mode off for servers that leave it unset", () => {
    const servers: Record<string, { type: string; codemode?: boolean }> = {
      github: { type: "local" },
      docs: { type: "remote" },
    }
    applyDirectMcpTools(fakeMcpEditor(servers))
    expect(servers.github?.codemode).toBe(false)
    expect(servers.docs?.codemode).toBe(false)
  })

  test("keeps an explicit codemode value either way", () => {
    const servers: Record<string, { type: string; codemode?: boolean }> = {
      executor: { type: "local", codemode: true },
      direct: { type: "local", codemode: false },
    }
    applyDirectMcpTools(fakeMcpEditor(servers))
    expect(servers.executor?.codemode).toBe(true)
    expect(servers.direct?.codemode).toBe(false)
  })

  test("does nothing without servers", () => {
    expect(() => applyDirectMcpTools(fakeMcpEditor({}))).not.toThrow()
  })
})

describe("isOpenCode2McpCodeModeKept", () => {
  test("off by default", () => {
    expect(isOpenCode2McpCodeModeKept({})).toBe(false)
  })

  test("1 or true (any case) keeps the host default", () => {
    expect(isOpenCode2McpCodeModeKept({ [CURSOR_OPENCODE2_MCP_CODEMODE_ENV]: "1" })).toBe(true)
    expect(isOpenCode2McpCodeModeKept({ [CURSOR_OPENCODE2_MCP_CODEMODE_ENV]: "TRUE" })).toBe(true)
  })

  test("other values do not", () => {
    expect(isOpenCode2McpCodeModeKept({ [CURSOR_OPENCODE2_MCP_CODEMODE_ENV]: "0" })).toBe(false)
    expect(isOpenCode2McpCodeModeKept({ [CURSOR_OPENCODE2_MCP_CODEMODE_ENV]: "yes" })).toBe(false)
  })
})
