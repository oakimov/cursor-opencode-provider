import {
  buildDynamicRequestContext,
  buildRequestContext,
  materializeRequestContext,
  requestContextBase,
  type BuildRequestContextInput,
} from "./build.js"
import { trace } from "../debug.js"
import { encodeMessage } from "../protocol/messages.js"

/**
 * Freeze the expensive RequestContext base for the life of a conversation_id.
 *
 * Cursor's current exec-daemon cache treats RequestContext as a baked stable
 * base plus live plugin/tool overlays. Rebuilding volatile git/layout data on
 * every Run shifts the prompt prefix and tanks prompt-cache hits.
 *
 * Skills, subagents, plugin metadata, and tool/MCP capabilities are rebuilt on
 * each Run and overlaid on that base. If their encoded bytes did not change,
 * the exact prior materialized object is reused. This matches Cursor's newer
 * baked-context + live-overlay design without retaining stale capabilities.
 */

const byConversationId = new Map<string, Record<string, unknown>>()
const materializedByConversationId = new Map<
  string,
  { context: Record<string, unknown>; bytes: Uint8Array }
>()
const buildsByConversationId = new Map<string, Promise<Record<string, unknown>>>()
export const MAX_FROZEN_REQUEST_CONTEXTS = 256

function freezeSnapshot<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object") return value
  const object = value as object
  if (seen.has(object) || ArrayBuffer.isView(object)) return value
  seen.add(object)
  for (const child of Object.values(object)) freezeSnapshot(child, seen)
  return Object.freeze(value)
}

function remember(conversationId: string, context: Record<string, unknown>): void {
  // Map insertion order is the LRU order. Refresh existing entries on use.
  byConversationId.delete(conversationId)
  // Clone + recursively freeze so session.requestContext cannot mutate the
  // byte-stable snapshot retained for later Runs in the same conversation.
  byConversationId.set(conversationId, freezeSnapshot(structuredClone(context)))
  materializedByConversationId.delete(conversationId)
  while (byConversationId.size > MAX_FROZEN_REQUEST_CONTEXTS) {
    const oldest = byConversationId.keys().next().value as string | undefined
    if (!oldest) break
    byConversationId.delete(oldest)
    materializedByConversationId.delete(oldest)
  }
}

/** Frozen stable RequestContext base for this conversation, if any. */
export function getFrozenRequestContext(
  conversationId: string,
): Record<string, unknown> | undefined {
  const frozen = byConversationId.get(conversationId)
  if (!frozen) return undefined
  // Touch for LRU.
  byConversationId.delete(conversationId)
  byConversationId.set(conversationId, frozen)
  return frozen
}

/** Replace the frozen stable base, stripping any live capability fields. */
export function setFrozenRequestContext(
  conversationId: string,
  context: Record<string, unknown>,
): void {
  if (!conversationId) return
  remember(conversationId, requestContextBase(context))
}

/** Drop a conversation's frozen RequestContext (compaction / binding reset). */
export function clearFrozenRequestContext(conversationId: string): void {
  byConversationId.delete(conversationId)
  materializedByConversationId.delete(conversationId)
}

/**
 * Move a stable workspace base across a conversation-id reset.
 *
 * Compaction changes Cursor's state/checkpoint identity, not the OpenCode
 * workspace. Preserve the expensive base and the prior materialized bytes as a
 * comparison seed; getOrBuildRequestContext still rediscovers live capability
 * overlays and only reuses the complete context when those bytes also match.
 */
export function transferFrozenRequestContext(
  previousConversationId: string,
  nextConversationId: string,
): boolean {
  if (!previousConversationId || !nextConversationId) return false
  const base = byConversationId.get(previousConversationId)
  const materialized = materializedByConversationId.get(previousConversationId)
  clearFrozenRequestContext(previousConversationId)
  clearFrozenRequestContext(nextConversationId)
  if (!base) return false
  remember(nextConversationId, base)
  if (materialized) {
    materializedByConversationId.set(nextConversationId, {
      context: materialized.context,
      bytes: Uint8Array.from(materialized.bytes),
    })
  }
  return true
}

/** Test helper — wipe all frozen contexts. */
export function resetFrozenRequestContextsForTests(): void {
  byConversationId.clear()
  materializedByConversationId.clear()
  buildsByConversationId.clear()
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function rememberMaterialized(
  conversationId: string,
  context: Record<string, unknown>,
): { context: Record<string, unknown>; reused: boolean } {
  const bytes = encodeMessage("RequestContext", context)
  const previous = materializedByConversationId.get(conversationId)
  if (previous && sameBytes(previous.bytes, bytes)) {
    return { context: previous.context, reused: true }
  }
  const frozen = freezeSnapshot(structuredClone(context))
  materializedByConversationId.set(conversationId, {
    context: frozen,
    bytes: Uint8Array.from(bytes),
  })
  return { context: frozen, reused: false }
}

/**
 * Return a stable-base + live-overlay RequestContext for `conversationId`.
 * The base is built once; capability sections are rediscovered every Run.
 */
export async function getOrBuildRequestContext(
  conversationId: string,
  input: BuildRequestContextInput,
  opts?: { refresh?: boolean },
): Promise<{ context: Record<string, unknown>; reused: boolean }> {
  if (!opts?.refresh && conversationId) {
    const base = getFrozenRequestContext(conversationId)
    if (base) {
      const dynamic = await buildDynamicRequestContext(input)
      const materialized = rememberMaterialized(
        conversationId,
        materializeRequestContext(base, dynamic),
      )
      trace(
        `request_context: materialized conversationId=${conversationId} ` +
          `tools=${Array.isArray(materialized.context.tools) ? materialized.context.tools.length : 0} ` +
          `reused=${materialized.reused}`,
      )
      return materialized
    }
  }

  // Two overlapping model calls can open Runs for the same conversation. Share
  // the first build so both Runs receive the same snapshot instead of racing
  // two independently collected git/layout views into the cache.
  if (!opts?.refresh && conversationId) {
    const inFlight = buildsByConversationId.get(conversationId)
    if (inFlight) {
      await inFlight
      return getOrBuildRequestContext(conversationId, input)
    }
  }

  const build = buildRequestContext(input)
  if (conversationId) buildsByConversationId.set(conversationId, build)
  let context: Record<string, unknown>
  try {
    context = await build
  } finally {
    if (conversationId && buildsByConversationId.get(conversationId) === build) {
      buildsByConversationId.delete(conversationId)
    }
  }
  if (conversationId) setFrozenRequestContext(conversationId, context)
  // The first full build already contains both base and live overlay.
  const materialized = conversationId
    ? rememberMaterialized(conversationId, context)
    : { context: freezeSnapshot(structuredClone(context)), reused: false }
  trace(
    `request_context: built+frozen conversationId=${conversationId || "(none)"} ` +
      `tools=${Array.isArray(materialized.context.tools) ? materialized.context.tools.length : 0} ` +
      `refresh=${!!opts?.refresh}`,
  )
  return { context: materialized.context, reused: false }
}
