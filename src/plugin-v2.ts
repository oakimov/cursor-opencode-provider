import { define } from "@opencode-ai/plugin/v2/promise"
import { CURSOR_PROVIDER_ID } from "./shared.js"
import { createCursorLanguageModel } from "./language-model.js"
import type { CreateCursorOptions } from "./index.js"

/**
 * OpenCode Effect / Promise v2 plugin.
 *
 * Wires the Cursor provider through `ctx.aisdk.sdk` / `ctx.aisdk.language`
 * (the V2 extension points). Auth still lives in the classic Hooks plugin
 * (`plugin.ts`) until OpenCode integrations fully replace provider OAuth.
 */
function isCursorPackage(pkg: string, providerID: string): boolean {
  if (providerID === CURSOR_PROVIDER_ID) return true
  return (
    pkg.includes("cursor-opencode-provider") ||
    /cursor-opencode-provider[/\\]dist[/\\]index\.js/.test(pkg)
  )
}

function createSdk(options: CreateCursorOptions) {
  const providerId = options.name || CURSOR_PROVIDER_ID
  return {
    languageModel(modelId: string) {
      return createCursorLanguageModel(modelId, providerId, options)
    },
  }
}

export default define({
  id: "cursor.provider",
  setup: async (ctx) => {
    await ctx.aisdk.sdk((event) => {
      if (event.sdk) return
      if (!isCursorPackage(event.package, event.model.providerID)) return
      event.sdk = createSdk({
        name: event.model.providerID || CURSOR_PROVIDER_ID,
        ...event.options,
      } as CreateCursorOptions)
    })

    await ctx.aisdk.language((event) => {
      if (event.model.providerID !== CURSOR_PROVIDER_ID) return
      if (event.language) return
      if (typeof event.sdk?.languageModel !== "function") return
      event.language = event.sdk.languageModel(event.model.api.id)
    })
  },
})
