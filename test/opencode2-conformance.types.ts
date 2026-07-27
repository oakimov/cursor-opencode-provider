import type { Plugin } from "@opencode-ai/plugin-next"
import plugin from "../src/plugin-opencode2.js"

/**
 * Compile-time guard for the hand-maintained OpenCode 2.0 types in
 * `src/opencode2/types.ts`. No runtime assertions; not part of the `bun test`
 * suite. Checked by `tsc -p tsconfig.test.json`, wired into `bun run typecheck`.
 *
 * `src/plugin-opencode2.ts` deliberately avoids importing `@opencode-ai/plugin`
 * at runtime: the 2.0 types live on the `@next` dist-tag and cannot coexist with
 * this package's `@opencode-ai/plugin@^1.17.13` dependency under the same
 * specifier. The aliased `@opencode-ai/plugin-next` devDependency exists purely
 * for this file.
 *
 * These are deliberately *usage-level* assertions rather than whole-context
 * assignability. The host's types are Effect-schema derived (branded strings,
 * DeepMutable drafts); mirroring them exactly would churn on unrelated upstream
 * edits while protecting nothing. What matters is that the real API still
 * supports the exact calls the plugin makes — so each block below mirrors one
 * call site in `plugin-opencode2.ts`.
 */

declare const ctx: Plugin.Context

// ── The plugin object itself ──
const _id: string = plugin.id
void _id
void (() => plugin.setup(ctx as any))

// ── aisdk: hooks are (name, callback), and the events carry what we read ──
void (() =>
  ctx.aisdk.hook("sdk", (event) => {
    const _pkg: string = event.package
    const _provider: string = event.model.providerID
    const _options: Record<string, any> = event.options
    event.sdk = {}
    void [_pkg, _provider, _options]
  }))

void (() =>
  ctx.aisdk.hook("language", (event) => {
    // `modelID` is what we send on the wire; losing it would silently break
    // long-context entries, which rely on it differing from `id`.
    const _wire: string = event.model.modelID
    const _id2: string = event.model.id
    void [_wire, _id2, event.sdk]
  }))

// ── catalog: provider/model upsert via `update` ──
void (() =>
  ctx.catalog.transform((draft) => {
    draft.provider.update("cursor" as any, (provider) => {
      provider.name = "Cursor"
      provider.package = "aisdk:cursor-opencode-provider"
      provider.integrationID = "cursor" as any
    })
    draft.model.update("cursor" as any, "m" as any, (model) => {
      model.modelID = "m" as any
      model.name = "M"
      model.enabled = true
      model.status = "active"
      model.limit = { context: 1, output: 1 }
      model.capabilities = { tools: true, input: ["text"], output: ["text"] }
      model.variants = []
    })
  }))
void (() => ctx.catalog.reload())

// ── integration: methods + connection lookup ──
void (() =>
  ctx.integration.transform((draft) => {
    draft.update("cursor" as any, (integration) => {
      integration.name = "Cursor"
    })
    draft.method.update({
      integrationID: "cursor" as any,
      method: { id: "oauth" as any, type: "oauth", label: "Cursor account" },
      // Promise-valued in 2.0. This is the single biggest difference from the
      // 1.18 `/v2/promise` API, where these are Effect-valued — if 2.0 ever
      // moved back, this line is what catches it.
      authorize: async () => ({
        url: "https://example.invalid",
        instructions: "",
        mode: "auto" as const,
        callback: Promise.resolve({
          type: "oauth" as const,
          methodID: "oauth" as any,
          access: "a",
          refresh: "r",
          expires: 0,
        }),
      }),
      refresh: async (credential) => credential,
    })
    draft.method.update({ integrationID: "cursor" as any, method: { type: "key" } })
    draft.method.update({
      integrationID: "cursor" as any,
      method: { type: "env", names: ["CURSOR_API_KEY"] },
    })
  }))

void (async () => {
  const connection = await ctx.integration.connection.active("cursor" as any)
  if (connection) await ctx.integration.connection.resolve(connection)
})

// ── tool: registration + execute hooks (our shell-timeout wrapper) ──
void (() =>
  ctx.tool.hook("execute.before", (event) => {
    const _tool: string = event.tool
    const _callID: string = event.callID
    // We rewrite the bash command here because 2.0 has no `shell.env`.
    event.input = {}
    void [_tool, _callID]
  }))

void (() =>
  ctx.tool.hook("execute.after", (event) => {
    const _callID: string = event.callID
    if (event.status === "completed") void event.result
    void _callID
  }))

// ── session: the only place the owning agent is named (compaction marker),
// and `get` is how we resolve a session's actual project directory ──
void (() =>
  ctx.session.hook("context", (event) => {
    const _sessionID: string = event.sessionID
    const _agent: string = event.agent
    void [_sessionID, _agent]
  }))

void (async () => {
  const info = await ctx.session.get({ sessionID: "s" as any })
  const _directory: string = info.location.directory
  void _directory
})
