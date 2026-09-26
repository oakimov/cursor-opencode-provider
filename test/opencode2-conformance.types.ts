/**
 * Compile-time guard that this plugin's OpenCode 2.0 calls and payloads still
 * fit the host contract in `opencode2-host-contract.ts`.
 *
 * No runtime assertions; not part of `bun test`. Checked by
 * `tsc -p tsconfig.test.json`, wired into `bun run typecheck`.
 *
 * Usage-level on purpose: the real host types are Effect-schema derived
 * (branded strings, DeepMutable drafts). Whole-context equality would churn on
 * unrelated host fields. Each block mirrors a call site in
 * `src/plugin-opencode2.ts` / `src/opencode2/*`.
 */

import plugin from "../src/plugin-opencode2.js"
import {
  applyCursorProviderInventory,
  CURSOR_AISDK_PACKAGE,
  modelsToCatalogModelMap,
} from "../src/opencode2/catalog.js"
import { applyCursorIntegration } from "../src/opencode2/integration.js"
import { applyDirectMcpTools } from "../src/opencode2/mcp-codemode.js"
import { registerTodoTools } from "../src/opencode2/todo-tools.js"
import type { HostModelInfo, HostPluginContext, HostProviderEditor, HostProviderInfo } from "./opencode2-host-contract.js"

declare const ctx: HostPluginContext
declare const editor: HostProviderEditor

const _id: string = plugin.id
void _id
void (() => plugin.setup(ctx))

void (() =>
  ctx.provider.transform((hostEditor) => {
    applyCursorProviderInventory(hostEditor, [])
  }))
void (() => ctx.provider.reload())

void (() => applyCursorProviderInventory(editor, []))

const publishedInfo: HostProviderInfo = {
  id: "cursor",
  name: "Cursor",
  activation: "enabled",
  package: CURSOR_AISDK_PACKAGE,
  integrationID: "cursor",
}
const publishedModels: readonly HostModelInfo[] = Object.values(
  modelsToCatalogModelMap([
    {
      id: "claude-sonnet-4-5",
      displayName: "Sonnet 4.5",
      supportsAgent: true,
      variants: [],
    },
  ]),
)
void editor.add({
  info: publishedInfo,
  models: publishedModels,
  sourceConnection: { type: "env", name: "CURSOR_API_KEY" },
})

void (() =>
  ctx.aisdk.hook("sdk", (event) => {
    const pkg: string = event.package
    const provider: string = event.model.providerID
    const options: Record<string, any> = event.options
    event.sdk = {}
    void [pkg, provider, options]
  }))

void (() =>
  ctx.aisdk.hook("language", (event) => {
    const wire: string = event.model.modelID
    const id: string = event.model.id
    void [wire, id, event.sdk]
  }))

void (() => ctx.integration.transform(applyCursorIntegration))
void (() => ctx.tool.transform((hostEditor) => registerTodoTools(hostEditor)))
void (() => ctx.mcp.transform((hostEditor) => applyDirectMcpTools(hostEditor)))

void (async () => {
  const connection = await ctx.integration.connection.active("cursor")
  if (connection) await ctx.integration.connection.resolve(connection)
})

void (() =>
  ctx.tool.hook("execute.before", (event) => {
    const tool: string = event.tool
    const id: string = event.id ?? event.callID
    event.input = {}
    void [tool, id]
  }))

void (() =>
  ctx.tool.hook("execute.after", (event) => {
    const id: string = event.id ?? event.callID
    if (event.status === "completed") void event.result
    void id
  }))

void (() =>
  ctx.session.hook("context", (event) => {
    const sessionID: string = event.sessionID
    const agent: string = event.agent
    event.options = { ...(event.options ?? {}), flagged: true }
    void [sessionID, agent]
  }))

void (() =>
  ctx.session.hook("compaction", (event) => {
    event.options = { ...(event.options ?? {}), compact: true }
    void event.sessionID
  }))

void (() => ctx.session.hook("generate", (event) => void event.sessionID))
void (() => ctx.session.hook("title", (event) => void event.sessionID))

void (async () => {
  const info = await ctx.session.get({ sessionID: "s" })
  const directory: string = info.location.directory
  const loc: string = ctx.location.directory
  await ctx.session.switchAgent({ sessionID: "s", agent: "build" })
  await ctx.session.synthetic({ sessionID: "s", text: "go" })
  await ctx.session.prompt({ sessionID: "s", text: "go" })
  void [directory, loc]
})

void (() =>
  ctx.shell.hook("create.before", (event) => {
    event.env = { ...event.env, CURSOR: "1" }
    void event.command
  }))

void (() =>
  ctx.websearch.transform((editor) => {
    editor.add({
      id: "cursor-exa",
      name: "Exa",
      execute: async () => [],
    })
  }))
