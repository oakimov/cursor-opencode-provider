/**
 * OpenCode 2.0 plugin surfaces this package actually calls or publishes.
 *
 * This is a local host *contract*, not an import of `@opencode/plugin`. Runtime
 * code duck-types a subset (`src/opencode2/types.ts`). Extra host methods live
 * here so `test/opencode2-conformance.types.ts` can prove our calls and
 * payloads are still valid when the editor is the fuller host shape.
 */

export type HostRegistration = {
  readonly dispose: () => Promise<void>
}

export type HostTransform<Input> = (callback: (input: Input) => void) => Promise<HostRegistration>

export type HostHooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<HostRegistration>

export type HostConnectionInfo =
  | { type: "credential"; id: string; label: string }
  | { type: "env"; name: string }

export type HostProviderInfo = {
  id: string
  name: string
  package: string
  activation: "auto" | "enabled" | "disabled"
  integrationID?: string
  canonical?: string
  settings?: Record<string, any>
  headers?: Record<string, string>
  body?: Record<string, any>
}

export type HostModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  capabilities: { tools: boolean; input: readonly string[]; output: readonly string[] }
  variants: readonly { id: string; settings?: Record<string, any> }[]
  time: { released: number }
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
  package?: string
}

export type HostProviderRecord = {
  readonly provider: HostProviderInfo
  readonly models: ReadonlyMap<string, HostModelInfo>
  readonly sourceConnection?: HostConnectionInfo
}

export type HostToolContext = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly progress: (update: Record<string, unknown>) => Promise<void>
}

/** Fuller OpenCode 2.0 provider editor. Plugins may only call `add`. */
export type HostProviderEditor = {
  list(): readonly HostProviderRecord[]
  get(providerID: string): HostProviderRecord | undefined
  add(input: {
    info: HostProviderInfo
    models: readonly HostModelInfo[]
    sourceConnection?: HostConnectionInfo
  }): void
  update(providerID: string, update: (provider: HostProviderInfo) => void): void
  remove(providerID: string): void
  readonly models: {
    set(providerID: string, models: readonly HostModelInfo[]): void
    update(providerID: string, modelID: string, update: (model: HostModelInfo) => void): void
    remove(providerID: string, modelID: string): void
  }
}

export type HostCredentialOAuth = {
  type: "oauth"
  methodID: string
  refresh: string
  access: string
  expires: number
  metadata?: Record<string, unknown>
}

export type HostCredentialValue =
  | HostCredentialOAuth
  | { type: "key"; key: string; metadata?: Record<string, unknown> }

export type HostIntegrationRef = { id: string; name: string }

export type HostIntegrationEditor = {
  list(): readonly HostIntegrationRef[]
  get(id: string): HostIntegrationRef | undefined
  update(id: string, update: (integration: HostIntegrationRef) => void): void
  remove(id: string): void
  readonly method: {
    list(integrationID: string): readonly unknown[]
    update(input: unknown): void
    remove(integrationID: string, method: unknown): void
  }
}

export type HostPluginContext = {
  readonly aisdk: {
    readonly hook: HostHooks<{
      sdk: {
        readonly model: HostModelInfo
        readonly package: string
        readonly options: Record<string, any>
        sdk?: any
      }
      language: {
        readonly model: HostModelInfo
        readonly sdk: any
        readonly options: Record<string, any>
        language?: unknown
      }
    }>
  }
  readonly event: { readonly subscribe: (...args: any[]) => any }
  readonly integration: {
    readonly transform: HostTransform<HostIntegrationEditor>
    readonly reload: () => Promise<void>
    readonly connection: {
      readonly active: (integrationID: string) => Promise<HostConnectionInfo | undefined>
      readonly resolve: (connection: HostConnectionInfo) => Promise<HostCredentialValue | undefined>
    }
  }
  readonly provider: {
    readonly transform: HostTransform<HostProviderEditor>
    readonly reload: () => Promise<void>
  }
  readonly location: { readonly directory: string }
  readonly session: {
    readonly hook: HostHooks<{
      context: {
        readonly sessionID: string
        readonly agent: string
        readonly model: { providerID: string; id: string; variant?: string }
        system: Array<any>
        messages: Array<any>
        tools: Record<string, { description: string; input: unknown }>
        options?: Record<string, unknown>
      }
      compaction: {
        readonly sessionID: string
        readonly agent: string
        readonly model: { providerID: string; id: string; variant?: string }
        system: Array<any>
        messages: Array<any>
        tools: Record<string, { description: string; input: unknown }>
        options?: Record<string, unknown>
        result?: { summary: string }
      }
      generate: {
        readonly sessionID: string
        readonly agent: string
        readonly model: { providerID: string; id: string; variant?: string }
        system: Array<any>
        messages: Array<any>
        tools: Record<string, { description: string; input: unknown }>
        options?: Record<string, unknown>
      }
      title: {
        readonly sessionID: string
        readonly model: { providerID: string; id: string; variant?: string }
        system: Array<any>
        messages: Array<any>
        options?: Record<string, unknown>
        result?: string
      }
    }>
    readonly get: (input: { sessionID: string }) => Promise<{
      readonly id: string
      readonly location: { readonly directory: string }
    }>
    readonly switchAgent: (input: { sessionID: string; agent: string }) => Promise<void>
    readonly synthetic: (input: {
      sessionID: string
      text: string
      description?: string
      metadata?: Record<string, unknown>
      delivery?: "steer" | "queue"
      resume?: boolean
    }) => Promise<unknown>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
  }
  readonly shell: {
    readonly hook: HostHooks<{
      "create.before": {
        command: string
        cwd: string
        timeout: number
        shell: string
        env: Record<string, string | undefined>
      }
    }>
  }
  readonly mcp: {
    readonly transform: HostTransform<{
      list(): readonly [string, { type: "local" | "remote"; codemode?: boolean }][]
      update(name: string, update: (config: { type: "local" | "remote"; codemode?: boolean }) => void): void
    }>
    readonly reload: () => Promise<void>
  }
  readonly websearch: {
    readonly transform: HostTransform<{
      add(definition: {
        readonly id: string
        readonly name: string
        readonly execute: (
          input: { query: string },
          context: { readonly signal: AbortSignal },
        ) => Promise<readonly { url: string; title?: string; content?: string; time: { published?: number } }[]>
      }): void
    }>
    readonly reload: () => Promise<void>
  }
  readonly tool: {
    readonly transform: HostTransform<{
      add(tool: {
        readonly name: string
        readonly description: string
        readonly input: unknown
        readonly output?: unknown
        readonly options?: { readonly codemode?: boolean; readonly namespace?: string; readonly permission?: string }
        readonly execute: (input: any, context: HostToolContext) => Promise<any>
      }): void
      get?(id: string): {
        readonly name: string
        readonly description: string
        readonly input: unknown
        readonly output?: unknown
        readonly options?: { readonly codemode?: boolean; readonly namespace?: string; readonly permission?: string }
        readonly execute: (input: any, context: HostToolContext) => Promise<any>
        readonly id?: string
      } | undefined
      list?(): readonly {
        readonly id: string
        readonly name: string
        readonly description: string
        readonly input: unknown
        readonly output?: unknown
        readonly options?: { readonly codemode?: boolean; readonly namespace?: string; readonly permission?: string }
        readonly execute: (input: any, context: HostToolContext) => Promise<any>
      }[]
      update?(
        id: string,
        update: (tool: {
          options?: {
            namespace?: string
            permission?: string
            codemode?: boolean
            pinned?: boolean
          }
        }) => void,
      ): void
    }>
    readonly reload: () => Promise<void>
    readonly hook: HostHooks<{
      "execute.before": {
        tool: string
        readonly sessionID: string
        readonly agent: string
        readonly messageID: string
        readonly id: string
        readonly callID?: string
        input: unknown
      }
      "execute.after": {
        readonly tool: string
        readonly sessionID: string
        readonly agent: string
        readonly messageID: string
        readonly id: string
        readonly callID?: string
        readonly input: unknown
      } & (
        | { readonly status: "completed"; result: any }
        | { readonly status: "error"; error: any }
      )
    }>
  }
}
