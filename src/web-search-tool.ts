import { tool } from "@opencode-ai/plugin"
import { executeOpenCodeWebSearch } from "./web-tools.js"

/**
 * Classic-plugin web search tool registration.
 *
 * Kept apart from `./web-tools.ts` on purpose: this is a *value* import from
 * `@opencode-ai/plugin`, and the OpenCode 2.0 entrypoint shares the search
 * implementation in that module. 2.0's package root exports no `tool`, so
 * importing it from a module on the 2.0 graph would throw during plugin load.
 * Only `plugin.ts` (classic hooks) may import this file.
 */
export const openCodeWebSearchTool = tool({
  description: "Search the web for current information using OpenCode's web search backend.",
  args: {
    query: tool.schema.string().describe("Web search query"),
    numResults: tool.schema.number().int().min(1).max(20).optional(),
    livecrawl: tool.schema.enum(["fallback", "preferred"]).optional(),
    type: tool.schema.enum(["auto", "fast", "deep"]).optional(),
    contextMaxCharacters: tool.schema.number().int().positive().optional(),
  },
  execute: executeOpenCodeWebSearch,
})
