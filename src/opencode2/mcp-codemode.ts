import type { McpEditor } from "./types.js"

/**
 * OpenCode 2 routes every MCP server through Code Mode unless its config says
 * `codemode: false` ("Defaults to true", `packages/schema/src/mcp.ts`). Code
 * Mode tools never join the direct AI SDK catalog: the model only sees one
 * `execute` tool, so Cursor cannot call `github_create_pull_request` & co. by
 * name and falls back to searching the workspace for them.
 *
 * The plugin therefore turns Code Mode off for every MCP server that leaves it
 * unset, the same way OpenCode's own `mcp-codemode-exclusion` plugin does for
 * servers that provide Code Mode themselves. An explicit `codemode` value
 * (true or false) is kept.
 *
 * This edits host MCP config, so it also applies to other providers in the
 * same OpenCode. `CURSOR_OPENCODE2_MCP_CODEMODE=1` (or `true`) keeps the host
 * default instead. Same truthy rule as `CURSOR_OPENCODE2_TODOS`.
 */
export const CURSOR_OPENCODE2_MCP_CODEMODE_ENV = "CURSOR_OPENCODE2_MCP_CODEMODE"

export function isOpenCode2McpCodeModeKept(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[CURSOR_OPENCODE2_MCP_CODEMODE_ENV]?.toLowerCase()
  return value === "1" || value === "true"
}

export function applyDirectMcpTools(editor: McpEditor): void {
  for (const [name] of editor.list()) {
    editor.update(name, (config) => {
      config.codemode ??= false
    })
  }
}
