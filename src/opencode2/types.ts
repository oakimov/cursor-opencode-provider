/**
 * Local structural types for the OpenCode 2.0 beta plugin API.
 *
 * Why not import from `@opencode-ai/plugin`?
 *   • The 2.0 types live on the `@next` dist-tag (`0.0.0-next-*`), which cannot
 *     coexist with this package's existing `@opencode-ai/plugin@^1.17.13`
 *     dependency under the same module specifier.
 *   • 2.0 is beta and its schema churns; a hand-maintained subset of only what
 *     we touch is more stable than pinning a moving target.
 *
 * These mirror `@opencode-ai/plugin@next` `dist/promise/*.d.ts` as of
 * `0.0.0-next-16281`. `test/opencode2-conformance.test-d.ts` asserts our
 * default export still satisfies the real 2.0 `Plugin` interface.
 *
 * Effect `Schema` brands (Provider.ID, Model.ID, …) are modelled as plain
 * `string`; brands are compile-time only and erase at runtime.
 */

// ── Registration primitives ──

export type Registration = {
  readonly dispose: () => Promise<void>
}

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>

export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>

// ── Schema shapes (mutable drafts) ──

export type ProviderInfo = {
  id: string
  name: string
  /** `"aisdk:<pkg>"` selects the AI SDK path; a bare specifier selects native. */
  package: string
  integrationID?: string
  disabled?: boolean
  settings?: Record<string, any>
  headers?: Record<string, string>
  body?: Record<string, any>
}

export type ModelVariantInfo = {
  id: string
  settings?: Record<string, any>
  headers?: Record<string, string>
  body?: Record<string, any>
}

export type ModelInfo2 = {
  id: string
  /** Wire id sent to the provider. Lets one Cursor model back several entries. */
  modelID: string
  providerID: string
  name: string
  family?: string
  // Arrays are `readonly` to match the published `Model.Info`. Catalog code
  // assigns whole arrays rather than mutating in place, so this costs nothing.
  capabilities: { tools: boolean; input: readonly string[]; output: readonly string[] }
  variants: readonly ModelVariantInfo[]
  time: { released: number }
  /** OpenCode 2.0 tiered $/1M rates; empty when Cursor does not publish a price. */
  cost: readonly {
    tier?: { type: "context"; size: number }
    input: number
    output: number
    cache: { read: number; write: number }
  }[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
  settings?: Record<string, any>
  headers?: Record<string, string>
  body?: Record<string, any>
  package?: string
}

// ── Credentials ──

export type CredentialOAuth = {
  type: "oauth"
  methodID: string
  refresh: string
  access: string
  expires: number
  metadata?: Record<string, unknown>
}

export type CredentialKey = {
  type: "key"
  key: string
  metadata?: Record<string, unknown>
}

export type CredentialValue = CredentialOAuth | CredentialKey

export type ConnectionInfo =
  | { type: "credential"; id: string; label: string }
  | { type: "env"; name: string }

// ── Catalog ──

/**
 * Read accessors we never call are intentionally loose (`any`). Modelling the
 * host's Effect-schema records exactly would make the conformance guard churn on
 * unrelated upstream edits without protecting anything we depend on. The
 * `update` signatures — the ones we actually build the catalog with — stay precise.
 */
export type CatalogDraft = {
  readonly provider: {
    list(): readonly any[]
    get(providerID: string): any
    /** Upsert: creates the provider when absent. */
    update(providerID: string, update: (provider: ProviderInfo) => void): void
    remove(providerID: string): void
  }
  readonly model: {
    get(providerID: string, modelID: string): any
    /** Upsert: creates provider and/or model when absent. */
    update(providerID: string, modelID: string, update: (model: ModelInfo2) => void): void
    remove(providerID: string, modelID: string): void
    readonly default: {
      get(): { providerID: string; modelID: string } | undefined
      set(providerID: string, modelID: string): void
    }
  }
}

export type CatalogDomain = {
  readonly transform: Transform<CatalogDraft>
  readonly reload: () => Promise<void>
}

// ── Integration ──

export type IntegrationTextPrompt = {
  type: "text"
  key: string
  message: string
  placeholder?: string
}

export type IntegrationOAuthMethod = {
  id: string
  type: "oauth"
  label: string
  prompts?: IntegrationTextPrompt[]
}

export type IntegrationKeyMethod = { type: "key"; label?: string }
export type IntegrationEnvMethod = { type: "env"; names: string[] }
export type IntegrationMethod =
  | IntegrationOAuthMethod
  | IntegrationKeyMethod
  | IntegrationEnvMethod

export type IntegrationOAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | { readonly mode: "auto"; readonly callback: Promise<CredentialOAuth> }
  | { readonly mode: "code"; readonly callback: (code: string) => Promise<CredentialOAuth> }
)

export type IntegrationOAuthMethodRegistration = {
  readonly integrationID: string
  readonly method: IntegrationOAuthMethod
  readonly authorize: (inputs: Record<string, string>) => Promise<IntegrationOAuthAuthorization>
  readonly refresh?: (credential: CredentialOAuth) => Promise<CredentialOAuth>
  readonly label?: (credential: CredentialOAuth) => string | undefined
}

export type IntegrationMethodRegistration =
  | IntegrationOAuthMethodRegistration
  | { readonly integrationID: string; readonly method: IntegrationKeyMethod }
  | { readonly integrationID: string; readonly method: IntegrationEnvMethod }

export type IntegrationRef = { id: string; name: string }

export type IntegrationDraft = {
  list(): readonly any[]
  get(id: string): any
  update(id: string, update: (integration: IntegrationRef) => void): void
  remove(id: string): void
  readonly method: {
    list(integrationID: string): readonly any[]
    update(input: IntegrationMethodRegistration): void
    remove(integrationID: string, method: any): void
  }
}

export type IntegrationDomain = {
  readonly transform: Transform<IntegrationDraft>
  readonly reload: () => Promise<void>
  readonly connection: {
    readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>
    readonly resolve: (connection: ConnectionInfo) => Promise<CredentialValue | undefined>
  }
}

// ── AI SDK ──

export type AISDKHooks = {
  sdk: {
    readonly model: ModelInfo2
    readonly package: string
    readonly options: Record<string, any>
    sdk?: any
  }
  language: {
    readonly model: ModelInfo2
    readonly sdk: any
    readonly options: Record<string, any>
    language?: unknown
  }
}

export type AISDKDomain = { readonly hook: Hooks<AISDKHooks> }

// ── Tools ──

export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input: unknown
  readonly output?: unknown
  readonly execute: (input: any, context: any) => Promise<any>
}

export type ToolDraft = { add(tool: ToolDefinition): void }

export type ToolHookBase = {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly callID: string
}

export type ToolHooks = {
  readonly "execute.before": ToolHookBase & { input: unknown }
  readonly "execute.after": ToolHookBase & { readonly input: unknown } & (
      | { readonly status: "completed"; result: any }
      | { readonly status: "error"; error: any }
    )
}

export type ToolDomain = {
  readonly transform: Transform<ToolDraft>
  readonly hook: Hooks<ToolHooks>
}

// ── Session ──

export type SessionContext = {
  readonly sessionID: string
  readonly agent: string
  readonly model: { providerID: string; id: string; variant?: string }
  system: Array<any>
  messages: Array<any>
  tools: Record<string, { description: string; input: unknown }>
}

export type SessionHooks = { readonly context: SessionContext }

/** Only the `location.directory` field we actually read; the rest of the real `SessionInfo` is loose. */
export type SessionInfo = {
  readonly id: string
  readonly location: { readonly directory: string }
}

export type SessionDomain = {
  readonly hook: Hooks<SessionHooks>
  readonly get: (input: { sessionID: string }) => Promise<SessionInfo>
}

// ── Web search ──

export type WebSearchDefinition = {
  readonly id: string
  readonly name: string
  readonly execute: (
    input: any,
    context: { readonly signal: AbortSignal },
  ) => Promise<readonly any[]>
}

export type WebSearchDraft = {
  add(definition: WebSearchDefinition): void
  readonly default: {
    get(): string | undefined
    set(providerID: string): void
  }
}

export type WebSearchDomain = {
  readonly transform: Transform<WebSearchDraft>
  readonly reload: () => Promise<void>
}

// ── Events ──

export type EventDomain = {
  readonly subscribe: (...args: any[]) => any
}

// ── Plugin ──

export type App = {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export type PluginContext = {
  readonly app: App
  readonly options: Readonly<Record<string, any>>
  readonly aisdk: AISDKDomain
  readonly catalog: CatalogDomain
  readonly event: EventDomain
  readonly integration: IntegrationDomain
  readonly session: SessionDomain
  readonly tool: ToolDomain
  readonly websearch: WebSearchDomain
}

export type Cleanup = () => Promise<void> | void

export type Plugin2 = {
  readonly id: string
  readonly setup: (context: PluginContext) => Promise<Cleanup | void> | Cleanup | void
}
