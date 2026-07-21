import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin"

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const WEB_SEARCH_TIMEOUT_MS = 25_000

export type OpenCodeWebSearchArgs = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
}

function exaMcpUrl(): string {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return EXA_MCP_URL
  const url = new URL(EXA_MCP_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.href
}

function mcpText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const result = (value as { result?: unknown }).result
  if (!result || typeof result !== "object") return undefined
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text
    }
  }
  return undefined
}

export function parseOpenCodeWebSearchResponse(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const text = mcpText(JSON.parse(trimmed))
    if (text) return text
  } catch {
    // MCP may respond as an SSE stream instead of one JSON object.
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const text = mcpText(JSON.parse(line.slice(6)))
      if (text) return text
    } catch {
      // Ignore non-JSON SSE events.
    }
  }
  return undefined
}

export async function executeOpenCodeWebSearch(
  args: OpenCodeWebSearchArgs,
  context: ToolContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  await context.ask({
    permission: "websearch",
    patterns: [args.query],
    always: ["*"],
    metadata: {
      query: args.query,
      numResults: args.numResults,
      livecrawl: args.livecrawl,
      type: args.type,
      contextMaxCharacters: args.contextMaxCharacters,
      provider: "exa",
    },
  })

  const controller = new AbortController()
  const abort = () => controller.abort(context.abort.reason)
  if (context.abort.aborted) abort()
  else context.abort.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error("Web search timed out")), WEB_SEARCH_TIMEOUT_MS)

  try {
    const response = await fetchImpl(exaMcpUrl(), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: args.query,
            type: args.type ?? "auto",
            numResults: args.numResults ?? 8,
            livecrawl: args.livecrawl ?? "fallback",
            contextMaxCharacters: args.contextMaxCharacters,
          },
        },
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Web search failed (${response.status}): ${raw.slice(0, 500)}`)
    const output = parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query."
    return {
      title: `Exa Web Search: ${args.query}`,
      output,
      metadata: { provider: "exa" },
    }
  } finally {
    clearTimeout(timeout)
    context.abort.removeEventListener("abort", abort)
  }
}

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
