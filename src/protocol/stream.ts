import { decodeMessage } from "./messages.js"

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "finish"; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; finishReason: string }
  | { type: "tool-call-started"; callId: string; toolName: string; args: string }
  | { type: "tool-call-completed"; callId: string; result: string }
  | { type: "tool-input-delta"; callId: string; delta: string }
  | { type: "heartbeat" }
  | { type: "step" }

/**
 * Parse an AgentServerMessage frame payload into a stream event.
 * Returns null for frames that should be skipped.
 */
export function parseInteractionUpdate(payload: Uint8Array): StreamEvent | null {
  const asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", payload)
  const iu = asm.interaction_update as Record<string, unknown> | undefined
  if (!iu) return null

  if (iu.heartbeat) return { type: "heartbeat" }

  if (iu.text_delta) {
    const td = iu.text_delta as Record<string, unknown>
    return { type: "text-delta", text: (td.text as string) ?? "" }
  }

  if (iu.thinking_delta) {
    const td = iu.thinking_delta as Record<string, unknown>
    return { type: "reasoning-delta", text: (td.text as string) ?? "" }
  }

  if (iu.turn_ended) {
    const te = iu.turn_ended as Record<string, unknown>
    return {
      type: "finish",
      usage: {
        input: (te.input_tokens as number) ?? 0,
        output: (te.output_tokens as number) ?? 0,
        cacheRead: (te.cache_read as number) ?? 0,
        cacheWrite: (te.cache_write as number) ?? 0,
      },
      finishReason: "stop",
    }
  }

  if (iu.tool_call_started) {
    const tc = iu.tool_call_started as Record<string, unknown>
    const toolCall = tc.tool_call as Record<string, unknown> | undefined
    const variant =
      toolCall && typeof toolCall === "object"
        ? Object.keys(toolCall).find((k) => k.endsWith("_tool_call"))
        : undefined
    const variantPayload =
      variant && toolCall ? (toolCall[variant] as Record<string, unknown> | undefined) : undefined
    const args = variantPayload?.args ?? variantPayload
    return {
      type: "tool-call-started",
      callId: (tc.call_id as string) ?? "",
      toolName: variant ?? "",
      args: JSON.stringify(args ?? {}),
    }
  }

  if (iu.tool_call_completed) {
    const tc = iu.tool_call_completed as Record<string, unknown>
    const toolCall = tc.tool_call as Record<string, unknown> | undefined
    return {
      type: "tool-call-completed",
      callId: (tc.call_id as string) ?? "",
      result: JSON.stringify(toolCall ?? {}),
    }
  }

  if (iu.partial_tool_call) {
    const ptc = iu.partial_tool_call as Record<string, unknown>
    return {
      type: "tool-input-delta",
      callId: (ptc.call_id as string) ?? "",
      delta: (ptc.args_text_delta as string) ?? "",
    }
  }

  if (iu.step_started || iu.step_completed) {
    return { type: "step" }
  }

  return null
}