// Type-only: these erase at build time. This module must stay free of *value*
// imports from `@opencode-ai/plugin`, because the OpenCode 2.0 entrypoint pulls
// it in and 2.0's root export has no `tool` — a value import here would throw at
// plugin load under `opencode2`. The classic `tool(...)` registration therefore
// lives in ./web-search-tool.ts.
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"

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

/**
 * Raw Exa web-search call: no host tool context, no permission prompt.
 *
 * Split out so both the classic plugin's `custom_websearch` tool and the
 * OpenCode 2.0 plugin's tool registration share one implementation — 2.0's
 * ToolContext has no `ask`, permissions being handled by the host instead.
 */
export async function fetchOpenCodeWebSearchText(
  args: OpenCodeWebSearchArgs,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
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
    return parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query."
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
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

  const output = await fetchOpenCodeWebSearchText(args, context.abort, fetchImpl)
  return {
    title: `Exa Web Search: ${args.query}`,
    output,
    metadata: { provider: "exa" },
  }
}

