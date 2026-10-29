import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession } from "../src/session.js"
import { findContinuationSession, deliverContinuationResults, extractTrailingToolResults, hasApprovedUncorrelatedPlanStageResult, rememberMirroredTodos, refreshHeldSessionToolCatalog, resetTurnStateForTests, snapshotMirroredTodosBySession, decodeTrailingToolImages } from "../src/language-model.js"
import { getOrBuildRequestContext } from "../src/context/frozen.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { CREATE_PLAN_RESULT_FIELD } from "../src/protocol/create-plan.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { buildMcpStateResult, editReadIdentity } from "../src/protocol/tools.js"
import { getActiveCursorMode, setActiveCursorMode } from "../src/protocol/switch-mode.js"
import { runHistoryImages } from "../src/protocol/sent-history-images.js"
import {
  captureCursorShellResult,
  captureCursorShellFailure,
  registerCursorShellCall,
  resetCursorShellCalls,
} from "../src/shell-timeout.js"
import { sessionFixture } from "./session-fixture.js"
import { withTempHostCache } from "./host-cache.js"

let _seq = 0
function fakeSession(id?: string): CursorSession {
  return sessionFixture({
    sessionId: id ?? `sess_test_${++_seq}`,
    conversationId: `conv_test_${_seq}`,
    stream: {
      write() {},
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      destroy() {},
      isClosed: () => false,
    } as any,
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
  })
}

function toolMsg(sessionId: string, execId: number): LanguageModelV3CallOptions["prompt"][number] {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `cursor_${sessionId}_${execId}`,
        toolName: "glob",
        output: { type: "text", value: "ok" },
      },
    ],
  } as LanguageModelV3CallOptions["prompt"][number]
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("findContinuationSession", () => {
  it("prefers the newest tool result whose session is still pending", () => {
    const live = fakeSession("live-sess")
    sessionManager.registerPending(0, live, "grep_result")

    const toolResults = [
      { sessionId: "dead-sess", execId: 0 },
      { sessionId: "dead-sess", execId: 3 },
      { sessionId: "live-sess", execId: 0 },
    ]
    expect(findContinuationSession(toolResults)).toBe(live)
  })

  it("returns undefined when no result matches a live pending exec", () => {
    const toolResults = [
      { sessionId: "gone-a", execId: 1 },
      { sessionId: "gone-b", execId: 2 },
    ]
    expect(findContinuationSession(toolResults)).toBeUndefined()
  })

  it("skips newer results that are not pending and falls back to an older live one", () => {
    const older = fakeSession("older-sess")
    sessionManager.registerPending(5, older, "read_result")
    const toolResults = [
      { sessionId: "older-sess", execId: 5 },
      { sessionId: "newer-gone", execId: 9 },
    ]
    expect(findContinuationSession(toolResults)).toBe(older)
  })
})

describe("extractTrailingToolResults", () => {
  it("preserves execution-denied as an error instead of reporting success", async () => {
    const results = extractTrailingToolResults([{
      role: "tool", content: [{ type: "tool-result", toolCallId: "cursor_denied_1", toolName: "read",
        output: { type: "execution-denied", reason: "User declined" } }],
    }])
    expect(results[0]?.error).toBe("User declined")
    const writes: Uint8Array[] = []
    const live = fakeSession("denied")
    live.stream.write = frame => { writes.push(frame) }
    sessionManager.registerPending(1, live, "read_result", "read")
    await deliverContinuationResults(live, results)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]).exec_client_message.read_result.error.error).toBe("User declined")
  })

  it("keeps valid text and media siblings when a content item is malformed", () => {
    const results = extractTrailingToolResults([{
      role: "tool", content: [{ type: "tool-result", toolCallId: "cursor_live_1", toolName: "badge",
        output: { type: "content", value: [null, { type: "text", text: "badge" },
          { type: "image-data", mediaType: "image/png", data: "AQID" }] } }],
    }] as unknown as LanguageModelV3CallOptions["prompt"])
    expect(results[0]?.output).toBe("badge")
    expect(results[0]?.media).toHaveLength(1)
  })

  it("does not crash on media owned by an uncorrelated host tool", () => {
    const prompt = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "host-owned", toolName: "read",
        output: { type: "text", value: "Image read successfully" } }] },
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" },
        { type: "file", mediaType: "image/png", data: "AQID" }] },
    ] as LanguageModelV3CallOptions["prompt"]
    expect(extractTrailingToolResults(prompt)).toEqual([])
    const own = { role: "tool", content: [{ type: "tool-result", toolCallId: "cursor_live_1", toolName: "read",
      output: { type: "text", value: "Image read successfully" } }] } as LanguageModelV3CallOptions["prompt"][number]
    const results = extractTrailingToolResults([prompt[0]!, own, {
      role: "user", content: [{ type: "text", text: "Attached media from tool result:" },
        { type: "file", mediaType: "image/png", data: "AQID" },
        { type: "file", mediaType: "image/png", data: "BAUG" }],
    }])
    expect(results[0]?.media).toEqual([{ type: "file", mediaType: "image/png", data: "BAUG" }])
  })

  it("never turns a text read into a binary read using another tool's image", () => {
    const prompt = [
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "cursor_live_1", toolName: "badge", output: { type: "text", value: "badge attached" } },
        { type: "tool-result", toolCallId: "cursor_live_2", toolName: "read", output: { type: "text", value: "plain source text" } },
      ] },
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" },
        { type: "file", mediaType: "image/png", data: "AQID" }] },
    ] as LanguageModelV3CallOptions["prompt"]
    expect(extractTrailingToolResults(prompt).map(result => result.media?.length)).toEqual([1, undefined])
  })

  it("does not guess how multiple opaque tools divide detached images", () => {
    const results = extractTrailingToolResults([
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "cursor_live_1", toolName: "badge_a", output: { type: "text", value: "attached" } },
        { type: "tool-result", toolCallId: "cursor_live_2", toolName: "badge_b", output: { type: "text", value: "attached" } },
      ] },
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" },
        { type: "file", mediaType: "image/png", data: "AQID" }] },
    ])
    expect(results.every(result => result.media === undefined)).toBe(true)
  })

  it("recognizes an approved host-owned canonical stage result only at the live tail", () => {
    const stage = (type: "text" | "error-text", id = "host_plan_stage_review") => ({
      role: "tool", content: [{ type: "tool-result", toolCallId: id,
        toolName: "cursor_plan_stage", output: { type, value: "review result" } }],
    }) as LanguageModelV3CallOptions["prompt"][number]
    expect(hasApprovedUncorrelatedPlanStageResult([stage("text")])).toBe(true)
    expect(hasApprovedUncorrelatedPlanStageResult([stage("error-text")])).toBe(false)
    expect(hasApprovedUncorrelatedPlanStageResult([stage("text"), stage("error-text")])).toBe(false)
    expect(hasApprovedUncorrelatedPlanStageResult([stage("text", "cursor_live_8")])).toBe(false)
    expect(hasApprovedUncorrelatedPlanStageResult([stage("text"),
      { role: "user", content: [{ type: "text", text: "new request" }] }])).toBe(false)
    expect(hasApprovedUncorrelatedPlanStageResult([stage("text"),
      { role: "user", content: [{ type: "text", text: "<system-update>\nNew skills are available.\n</system-update>" }] }])).toBe(true)
  })

  it("returns only tool results after the last non-tool message", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      toolMsg("old", 0),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      toolMsg("live", 1),
      toolMsg("live", 2),
    ] as LanguageModelV3CallOptions["prompt"]

    const trailing = extractTrailingToolResults(prompt)
    expect(trailing).toEqual([
      { toolCallId: "cursor_live_1", sessionId: "live", execId: 1, toolName: "glob", output: "ok", error: undefined },
      { toolCallId: "cursor_live_2", sessionId: "live", execId: 2, toolName: "glob", output: "ok", error: undefined },
    ])
  })

  it("returns empty when the prompt ends with a user message (fresh turn)", () => {
    // Regression: after turn_ended, the next OpenCode step still carries
    // historical tool results mid-prompt — must NOT be treated as continuation.
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      toolMsg("old", 0),
      toolMsg("old", 1),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as LanguageModelV3CallOptions["prompt"]

    expect(extractTrailingToolResults(prompt)).toEqual([])
  })

  it("sees through host notes OpenCode appends after live tool results", () => {
    // OpenCode 2.x lowers a mid-turn skill/MCP change to a wrapped user message
    // and re-sends tool-result media as a captioned user message, both right
    // after the tool result. The call must stay a continuation.
    const update = (text: string) => ({ role: "user", content: [{ type: "text", text: `<system-update>\n${text}\n</system-update>` }] })
    const prompt = [
      { role: "system", content: "base prompt" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      toolMsg("live", 1),
      { role: "user", content: [
        { type: "text", text: "Attached media from tool result:" },
        { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ] },
      update("The following skill IDs are no longer available: repro-r7."),
      { role: "system", content: "MCP server instructions are no longer available." },
    ] as LanguageModelV3CallOptions["prompt"]

    const trailing = extractTrailingToolResults(prompt)
    expect(trailing.map((r) => r.toolCallId)).toEqual(["cursor_live_1"])
    // Notes ride on the last result outside output so parse/encode stays clean.
    expect(trailing[0]!.output).toBe("ok")
    expect(trailing[0]!.notes).toEqual([
      "<system-update>\nThe following skill IDs are no longer available: repro-r7.\n</system-update>",
      "MCP server instructions are no longer available.",
    ])
    // A note after a real user message is still a fresh turn.
    expect(extractTrailingToolResults([
      toolMsg("old", 0),
      { role: "user", content: [{ type: "text", text: "next" }] },
      update("New skills are available."),
    ] as LanguageModelV3CallOptions["prompt"])).toEqual([])
    // Ordinary user text that merely mentions the tag is a fresh turn.
    expect(extractTrailingToolResults([
      toolMsg("old", 0),
      { role: "user", content: [{ type: "text", text: "what is <system-update>?" }] },
    ] as LanguageModelV3CallOptions["prompt"])).toEqual([])
  })

  it("sees through OpenCode plan-mode system-reminder notes without appending them", () => {
    const reminder = {
      role: "user" as const,
      content: [{
        type: "text" as const,
        text: "<system-reminder>\nYou are in Plan mode. Tell them they need to switch agents.\n</system-reminder>",
      }],
    }
    const trailing = extractTrailingToolResults([
      toolMsg("live", 1),
      reminder,
      reminder,
    ] as LanguageModelV3CallOptions["prompt"])
    expect(trailing).toEqual([{
      toolCallId: "cursor_live_1",
      sessionId: "live",
      execId: 1,
      toolName: "glob",
      output: "ok",
      error: undefined,
    }])
  })

  it("returns empty for an empty prompt", () => {
    expect(extractTrailingToolResults([])).toEqual([])
  })

  it("keeps continuation output text-only when content also carries an image", () => {
    const prompt = [{
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "cursor_live_3",
        toolName: "screenshot",
        output: {
          type: "content",
          value: [
            { type: "text", text: "captured" },
            { type: "file-data", mediaType: "image/png", data: "AQID" },
          ],
        },
      }],
    }] as LanguageModelV3CallOptions["prompt"]

    expect(extractTrailingToolResults(prompt)).toEqual([{
      toolCallId: "cursor_live_3",
      sessionId: "live",
      execId: 3,
      toolName: "screenshot",
      output: "captured",
      error: undefined,
      media: [{ type: "file-data", mediaType: "image/png", data: "AQID" }],
    }])
  })

  it("attributes OpenCode's trailing tool media to the step's single result", () => {
    const image = { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=", filename: "badge.png" }
    const read = {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "cursor_live_4",
        toolName: "read",
        output: { type: "text", value: "Image read successfully" },
      }],
    }
    const caption = { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, image] }

    const [result] = extractTrailingToolResults([read, caption] as LanguageModelV3CallOptions["prompt"])
    expect(result).toMatchObject({ execId: 4, output: "Image read successfully", media: [image] })
    const updated = [read, caption, { role: "system", content: "New tool instructions" }] as LanguageModelV3CallOptions["prompt"]
    expect(extractTrailingToolResults(updated)[0]?.notes).toEqual(["New tool instructions"])

    // With several results, the media read takes its one file.
    const several = extractTrailingToolResults([toolMsg("live", 1), read, caption] as LanguageModelV3CallOptions["prompt"])
    expect(several.map((r) => r.media)).toEqual([undefined, [image]])
  })

  it("splits one media message across a step's results by OpenCode's markers", () => {
    const result = (execId: number, toolName: string, value: string) => ({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `cursor_live_${execId}`, toolName, output: { type: "text", value } }],
    })
    const badge = { type: "file", mediaType: "image/png", data: "YmFkZ2U=" }
    const shot = { type: "file", mediaType: "image/png", data: "c2hvdA==", filename: "shot.png" }
    const step = [
      result(1, "parity_get_deploy_token", "dtk_123"),
      result(2, "parity_get_status_badge", "Media attached in the following user message."),
      result(3, "read", "Image read successfully"),
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, badge, shot] },
    ] as LanguageModelV3CallOptions["prompt"]

    expect(extractTrailingToolResults(step).map((r) => r.media)).toEqual([undefined, [badge], [shot]])

    // Opaque text-plus-media results do not identify the owner. The final
    // read slice is still uniquely positioned, so it can be delivered safely.
    const unmarked = [
      result(1, "a", "first"),
      result(2, "parity_get_status_badge", "Status badge attached as an image"),
      result(3, "read", "Image read successfully"),
      { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, badge, shot] },
    ] as LanguageModelV3CallOptions["prompt"]
    expect(extractTrailingToolResults(unmarked).map((r) => r.media)).toEqual([undefined, undefined, [shot]])
  })

  it("keeps plan-mode reminders off the tool result while attributing trailing media", () => {
    const image = { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=", filename: "shot.png" }
    const read = {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "cursor_live_5",
        toolName: "read",
        output: { type: "text", value: "Image read successfully" },
      }],
    }
    const caption = { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, image] }
    const reminder = {
      role: "user",
      content: [{ type: "text", text: "<system-reminder>Stay in plan mode.</system-reminder>" }],
    }

    const [result] = extractTrailingToolResults(
      [read, caption, reminder] as LanguageModelV3CallOptions["prompt"],
    )
    expect(result).toMatchObject({
      execId: 5,
      output: "Image read successfully",
      media: [image],
    })
    expect(result?.output).not.toContain("Stay in plan mode")
  })
})

describe("decodeTrailingToolImages", () => {
  it("shares a byte budget across pending results and reports omitted images", async () => {
    const live = fakeSession("bounded-images")
    live.supportsImages = true
    sessionManager.registerPending(1, live, "mcp_result", "badge_a")
    sessionManager.registerPending(2, live, "read_result", "read")
    const results = [1, 2].map(execId => ({
      toolCallId: `cursor_bounded-images_${execId}`, sessionId: live.sessionId, execId,
      toolName: execId === 1 ? "badge_a" : "read", output: "Image read successfully",
      media: [{ type: "file-data", mediaType: "image/png", data: "AQID" }],
    }))
    const decoded = await decodeTrailingToolImages(live, results, undefined, 4)
    expect(decoded[0]?.images).toHaveLength(1)
    expect(decoded[1]?.images).toHaveLength(0)
    expect(decoded[1]?.error).toContain("omitted")
  })

  it("delivers a kept read image's omission notice as hook context on that read", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("read-image-notice")
    live.supportsImages = true
    live.stream.write = frame => { writes.push(frame) }
    sessionManager.registerPending(1, live, "read_result", "read", false, { path: "/work/badge.png" })
    const image = { type: "file-data", mediaType: "image/png", data: "AQID" }
    const [decoded] = await decodeTrailingToolImages(live, [{
      toolCallId: "cursor_read-image-notice_1", sessionId: live.sessionId, execId: 1,
      toolName: "read", output: "Image read successfully", media: [image, image],
    }])
    expect(decoded?.images).toHaveLength(1)
    expect(decoded?.output).toBe("Image read successfully")
    expect(decoded?.error).toBeUndefined()
    expect(decoded?.notices?.[0]).toContain("1 tool-result image(s) omitted")

    expect(await deliverContinuationResults(live, [decoded!])).toBe(live)
    const exec = writes
      .map(frame => decodeMessage<any>("AgentClientMessage", frame).exec_client_message)
      .find(message => message?.read_result)
    expect(Uint8Array.from(exec.read_result.success.data)).toEqual(Uint8Array.from([1, 2, 3]))
    expect(exec.hook_additional_contexts).toEqual([
      { hook_event_name: "postToolUse", content: decoded!.notices![0] },
    ])
  })

  it("does not resolve media for failed, bridged, foreign, or text-only execs", async () => {
    const live = fakeSession("skip-images")
    live.supportsImages = true
    sessionManager.registerPending(1, live, "mcp_result", "badge")
    sessionManager.registerPending(2, live, "mcp_result", "badge", true)
    sessionManager.registerPending(3, live, "write_result", "write")
    const media = [{ type: "file", mediaType: "image/png", data: new URL("https://invalid.example/image.png") }]
    const results = [1, 2, 3, 4].map(execId => ({
      toolCallId: `cursor_skip-images_${execId}`, sessionId: live.sessionId, execId,
      toolName: "badge", output: "completed", media,
      ...(execId === 1 ? { error: "refused" } : {}),
    }))
    expect(await decodeTrailingToolImages(live, results)).toEqual(results)
  })
})

describe("deliverContinuationResults", () => {
  it("leaves provider plan mode after a directly called stage tool succeeds", async () => {
    const live = fakeSession("direct-stage")
    live.openCodeSessionId = "host-direct-stage"
    setActiveCursorMode(live.openCodeSessionId, "plan")
    sessionManager.registerPending(8, live, "mcp_result", "cursor_plan_stage")

    expect(await deliverContinuationResults(live, [{ toolCallId: "result-244",
      sessionId: live.sessionId, execId: 8, toolName: "cursor_plan_stage", output: "Plan approved",
    }])).toBe(live)
    expect(getActiveCursorMode(live.openCodeSessionId)).toBe("agent")

    setActiveCursorMode(live.openCodeSessionId, "plan")
    sessionManager.registerPending(9, live, "mcp_result", "cursor_plan_stage")
    expect(await deliverContinuationResults(live, [{ toolCallId: "result-251",
      sessionId: live.sessionId, execId: 9, toolName: "cursor_plan_stage", output: "", error: "Keep planning",
    }])).toBe(live)
    expect(getActiveCursorMode(live.openCodeSessionId)).toBe("plan")
  })

  it("writes pending exec results and keeps the live session", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("live-write")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    sessionManager.registerPending(7, live, "grep_result", "glob")

    const kept = await deliverContinuationResults(live, [
      { toolCallId: "result-264", sessionId: "live-write", execId: 7, toolName: "glob", output: "a.ts" },
    ])

    expect(kept).toBe(live)
    expect(writes.length).toBeGreaterThan(0)
    expect(live.pending.has(7)).toBe(false)
  })

  it("delivers a read image as ReadSuccess.data on the held Run", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("image-read")
    live.openCodeSessionId = "host-image-read"
    live.historyImages = runHistoryImages()
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    sessionManager.registerPending(12, live, "read_result", "read", false, { path: "/work/badge.png" })
    const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    expect(await deliverContinuationResults(live, [{
      toolCallId: "cursor_image-read_12",
      sessionId: "image-read",
      execId: 12,
      toolName: "read",
      output: "Image read successfully",
      images: [{ data, filename: "badge.png", mimeType: "image/png" }],
      imageHashes: ["hash"],
    }])).toBe(live)

    const result = decodeMessage<any>("AgentClientMessage", writes[0]).exec_client_message
    expect(Uint8Array.from(result.read_result.success.data)).toEqual(data)
    expect(result.read_result.success.content).toBeUndefined()
    expect(live.historyImages.sent.map((image) => image.hash)).toEqual(["hash"])
  })

  it("injects a host update after an image read and leaves the bytes unchanged", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("image-read-update")
    live.runId = "run-image-update"
    live.stream.write = frame => { writes.push(frame) }
    sessionManager.registerPending(12, live, "read_result", "read", false, { path: "/work/badge.png" })
    const notes = ["<system-update>New tool instructions</system-update>"]
    const data = Uint8Array.from([1, 2, 3])
    expect(await deliverContinuationResults(live, [{
      toolCallId: "cursor_image-read-update_12", sessionId: live.sessionId, execId: 12, toolName: "read",
      output: "Image read successfully", notes,
      images: [{ data, filename: "badge.png", mimeType: "image/png" }],
    }])).toBe(live)
    const decoded = writes.map(frame => decodeMessage<any>("AgentClientMessage", frame))
    const readAt = decoded.findIndex(message => message.exec_client_message?.read_result)
    const injectAt = decoded.findIndex(message => message.conversation_action?.inject_context_action)
    expect(injectAt).toBeGreaterThan(readAt)
    const injection = decoded[injectAt].conversation_action.inject_context_action
    expect(injection.expected_run_id).toBe("run-image-update")
    expect(injection.user_context.user_message.text).toBe("New tool instructions")
    const exec = decoded[readAt].exec_client_message
    expect(exec.hook_additional_contexts).toEqual([])
    const success = exec.read_result.success
    expect(Uint8Array.from(success.data)).toEqual(data)
    expect(success.content).toBeUndefined()
    expect(JSON.stringify(success)).not.toContain("New tool instructions")
    expect(decoded.filter(message => message.run_request)).toEqual([])
  })

  it("does not record history-image hashes when the image write never lands", async () => {
    const live = fakeSession("image-read-fail")
    live.openCodeSessionId = "host-image-read-fail"
    live.historyImages = runHistoryImages()
    live.stream.write = () => {
      throw new Error("stream closed")
    }
    sessionManager.registerPending(13, live, "read_result", "read", false, { path: "/work/badge.png" })
    const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    expect(await deliverContinuationResults(live, [{
      toolCallId: "cursor_image-read-fail_13",
      sessionId: "image-read-fail",
      execId: 13,
      toolName: "read",
      output: "Image read successfully",
      images: [{ data, filename: "badge.png", mimeType: "image/png" }],
      imageHashes: ["hash-fail"],
    }])).toBeUndefined()
    expect(live.historyImages.sent).toEqual([])
  })

  it("delivers MCP tool images on the held Run instead of waiting for the next user turn", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("mcp-image")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    sessionManager.registerPending(13, live, "mcp_result", "parity_status_badge")
    const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

    expect(await deliverContinuationResults(live, [{
      toolCallId: "cursor_mcp-image_13",
      sessionId: "mcp-image",
      execId: 13,
      toolName: "parity_status_badge",
      output: "Media attached in the following user message.",
      images: [{ data, filename: "image-1", mimeType: "image/png" }],
      imageHashes: ["hash"],
    }])).toBe(live)

    const content = decodeMessage<any>("AgentClientMessage", writes[0]).exec_client_message.mcp_result.success.content
    expect(content).toHaveLength(2)
    expect(Uint8Array.from(content[1].image.data)).toEqual(data)
    expect(content[1].image.mime_type).toBe("image/png")
  })

  it("upgrades a host-authorized external edit read to complete content", async () => {
    const writes: Uint8Array[] = []
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-edit-workspace-"))
    const externalRoot = fs.mkdtempSync(path.join("/tmp", "cursor-edit-authorized-"))
    const target = path.join(externalRoot, "large.ts")
    const source = `${"export const line = true\n".repeat(3000)}export const tail = true\n`
    fs.writeFileSync(target, source)

    try {
      const live = fakeSession("authorized-external-read")
      live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
      live.requestContext = { env: { workspace_paths: [root] } }
      live.editToolCalls = new Map([["edit-call", { path: target }]])
      sessionManager.registerPending(31, live, "read_result", "read", false, {
        path: target,
        correlatedEditCallId: "edit-call",
        correlatedEditReadIdentity: editReadIdentity(target),
      })

      const kept = await deliverContinuationResults(live, [{ toolCallId: "result-290",
        sessionId: "authorized-external-read",
        execId: 31,
        toolName: "read",
        output: "capped host preview\n\n[Partial read: It is NOT the complete file.]",
      }])

      expect(kept).toBe(live)
      const result = decodeMessage<any>("AgentClientMessage", writes[0]).exec_client_message
      expect(result.read_result.success).toMatchObject({
        path: target,
        content: source,
        truncated: false,
        range_applied: false,
      })
      expect(live.editToolCalls.get("edit-call")?.completeRead).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  it.each(["symlink", "replacement"])("does not upgrade an authorized read after a %s swaps its target", async kind => {
    const root = fs.mkdtempSync("/tmp/cursor-edit-swapped-")
    try {
      const target = path.join(root, "target.txt")
      const secret = path.join(root, "secret.txt")
      fs.writeFileSync(target, "authorized content")
      fs.writeFileSync(secret, "must-not-disclose")
      const identity = editReadIdentity(target)
      const writes: Uint8Array[] = []
      const live = fakeSession("swapped-correlated-read")
      live.stream.write = frame => { writes.push(frame) }
      live.requestContext = { env: { workspace_paths: [root] } }
      live.editToolCalls = new Map([["edit-call", { path: target }]])
      sessionManager.registerPending(31, live, "read_result", "read", false, {
        path: target, correlatedEditCallId: "edit-call", correlatedEditReadIdentity: identity,
      })
      fs.renameSync(target, path.join(root, "original.txt"))
      if (kind === "symlink") fs.symlinkSync(secret, target)
      else fs.copyFileSync(secret, target)
      expect(await deliverContinuationResults(live, [{
        sessionId: live.sessionId, execId: 31, toolCallId: "authorized-read", toolName: "read",
        output: "host-authorized preview",
      }])).toBe(live)
      const result = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.read_result
      expect(result.success.content).toBe("host-authorized preview")
      expect(live.editToolCalls.get("edit-call")?.completeRead).not.toBe(true)
      expect(writes.some(bytes => Buffer.from(bytes).includes(Buffer.from("must-not-disclose")))).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it.each(["permission_denied", "rejected", "interrupted"] as const)("does not upgrade a correlated read marked %s without error text", async failure => {
    const root = fs.mkdtempSync("/tmp/cursor-edit-read-status-")
    const target = path.join(root, "target.txt")
    fs.writeFileSync(target, "must-not-disclose")
    try {
      const writes: Uint8Array[] = []
      const live = fakeSession("failed-read-status")
      live.stream.write = frame => { writes.push(frame) }
      live.requestContext = { env: { workspace_paths: [root] } }
      live.editToolCalls = new Map([["edit-call", { path: target }]])
      sessionManager.registerPending(31, live, "read_result", "read", false, {
        path: target, correlatedEditCallId: "edit-call", correlatedEditReadIdentity: editReadIdentity(target),
      })
      expect(await deliverContinuationResults(live, [{
        sessionId: live.sessionId, execId: 31, toolCallId: "failed-read", toolName: "read", output: "host result",
        ...(failure === "interrupted" ? { interrupted: true } : { refusal: failure }),
      }])).toBe(live)
      expect(live.editToolCalls.get("edit-call")?.completeRead).not.toBe(true)
      expect(writes.some(bytes => Buffer.from(bytes).includes(Buffer.from("must-not-disclose")))).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it.each(["The user denied this read", "read failed", ""])("never upgrades a failed correlated workspace read (%s)", async failure => {
    const root = fs.mkdtempSync("/tmp/cursor-edit-denied-")
    const target = path.join(root, "secret.txt")
    fs.writeFileSync(target, "must-not-disclose")
    try {
      const writes: Uint8Array[] = []
      const live = fakeSession("denied-correlated-read")
      live.stream.write = frame => { writes.push(frame) }
      live.requestContext = { env: { workspace_paths: [root] } }
      live.editToolCalls = new Map([["edit-call", { path: target }]])
      sessionManager.registerPending(31, live, "read_result", "read", false, {
        path: target, correlatedEditCallId: "edit-call", correlatedEditReadIdentity: editReadIdentity(target),
      })
      expect(await deliverContinuationResults(live, [{
        sessionId: live.sessionId, execId: 31, toolCallId: "denied-read", toolName: "read",
        output: failure, error: failure,
      }])).toBe(live)
      const result = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.read_result
      expect(result.success).toBeUndefined()
      expect(result.error.error).toBe(failure || "OpenCode tool execution failed")
      expect(live.editToolCalls.get("edit-call")?.completeRead).not.toBe(true)
      expect(writes.some(bytes => Buffer.from(bytes).includes(Buffer.from("must-not-disclose")))).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("carries background-shell request metadata into the typed continuation result", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("background-write")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    const toolCallId = "cursor_background-write_49"
    const metadata = {
      background_shell_spawn: true,
      command: "sleep 5",
      working_directory: "/tmp",
    }
    registerCursorShellCall(toolCallId, metadata)
    const clean = captureCursorShellResult(
      toolCallId,
      "__CURSOR_BACKGROUND_SHELL__54321:/tmp/cursor-opencode-bg.ABC123\n",
      { exit: 0 },
    )
    sessionManager.registerPending(
      49,
      live,
      "background_shell_spawn_result",
      "bash",
      false,
      metadata,
    )

    const kept = await deliverContinuationResults(live, [{
      toolCallId,
      sessionId: "background-write",
      execId: 49,
      toolName: "bash",
      output: clean,
    }])

    expect(kept).toBe(live)
    expect(clean).toBe("Started in the background (pid 54321).\n")
    const result = decodeMessage<any>("AgentClientMessage", writes[0]).exec_client_message
    expect(result.background_shell_spawn_result?.success).toEqual({
      shell_id: 54321,
      command: "sleep 5",
      working_directory: "/tmp",
      pid: 54321,
    })
    expect(live.pending.has(49)).toBe(false)
  })

  it.each(["bash", "shell"])("preserves partial %s output in an interrupted shell stream", async (toolName) => {
    const writes: Uint8Array[] = []
    const live = fakeSession(`partial-${toolName}`)
    live.stream.write = frame => { writes.push(frame) }
    const toolCallId = `cursor_${live.sessionId}_12`
    const output = "feature/cp16\r\n#!/bin/sh\r\nPREFIX=/usr/local\r\na/b.txt  \r\n"
    sessionManager.registerPending(12, live, "shell_stream", toolName)
    const kept = await deliverContinuationResults(live, [{
      toolCallId, sessionId: live.sessionId, execId: 12, toolName,
      output, error: "Tool execution interrupted", interrupted: true,
    }])
    const messages = writes.map(frame => decodeMessage<{
      exec_client_message?: { shell_stream?: { stdout?: { data: string }; stderr?: { data: string }; exit?: { aborted: boolean; abort_reason: number } } }
      exec_client_control_message?: { stream_close?: { id: number } }
    }>("AgentClientMessage", frame))
    expect(kept).toBe(live)
    expect(messages.flatMap(message => message.exec_client_message?.shell_stream?.stdout?.data ?? []).join("")).toBe(output)
    expect(messages[2]?.exec_client_message?.shell_stream?.stderr?.data).toBe("Tool execution interrupted")
    expect(messages[3]?.exec_client_message?.shell_stream?.exit).toMatchObject({ aborted: true, abort_reason: 1 })
    expect(messages[4]?.exec_client_control_message?.stream_close?.id).toBe(12)
    expect(live.pending.size).toBe(0)
  })

  // Cursor CLI streams only what the command wrote; a host failure is not stdout.
  it.each(["shell_stream", "shell_result"])("sends a failed shell call's error once, as stderr, on %s", async (resultField) => {
    const writes: Uint8Array[] = []
    const live = fakeSession(`failed-${resultField}`)
    live.stream.write = frame => { writes.push(frame) }
    const toolCallId = `cursor_${live.sessionId}_13`
    const error = "Working directory does not exist: /workspace/nope"
    // The host projects a failed tool as one error text, as both output and error.
    const [result] = extractTrailingToolResults([{ role: "tool", content: [{
      type: "tool-result", toolCallId, toolName: "shell", output: { type: "error-text", value: error },
    }] }] as LanguageModelV3CallOptions["prompt"])
    expect(result).toMatchObject({ output: error, error })
    sessionManager.registerPending(13, live, resultField, "shell", false, { command: "ls", working_directory: "/workspace/nope" })
    await deliverContinuationResults(live, [{ ...result!, sessionId: live.sessionId, execId: 13 }])
    const messages = writes.map(frame => decodeMessage<{
      exec_client_message?: {
        shell_stream?: { start?: object; stdout?: { data: string }; stderr?: { data: string }; exit?: { code: number } }
        shell_result?: { failure?: { stdout: string; stderr: string; exit_code: number } }
      }
    }>("AgentClientMessage", frame))
    if (resultField === "shell_stream") {
      const events = messages.flatMap(message => Object.keys(message.exec_client_message?.shell_stream ?? {}))
      expect(events).toEqual(["start", "stderr", "exit"])
      expect(messages[1]?.exec_client_message?.shell_stream?.stderr?.data).toBe(error)
    } else {
      expect(messages[0]?.exec_client_message?.shell_result?.failure).toMatchObject({ stdout: "", stderr: error, exit_code: 1 })
    }
    expect(live.pending.size).toBe(0)
  })

  it.each([
    ["shell_stream", false], ["shell_result", false],
    ["shell_stream", true], ["shell_result", true],
  ] as const)("keeps hook-captured %s failures separate from partial stdout (%s)", async (resultField, partial) => {
    const writes: Uint8Array[] = []
    const live = fakeSession(`captured-${resultField}`)
    live.stream.write = frame => { writes.push(frame) }
    const toolCallId = `cursor_${live.sessionId}_14`
    const error = "Shell startup failed"
    const output = partial ? "partial command output\r\n" : error
    const metadata = { shell_stream: true, command: "echo test", working_directory: "/workspace" }
    registerCursorShellCall(toolCallId, metadata)
    captureCursorShellFailure(toolCallId, new Error(error))
    const [result] = extractTrailingToolResults([{ role: "tool", content: [{
      type: "tool-result", toolCallId, toolName: "shell", output: { type: "text", value: output },
    }] }])
    expect(result?.error).toBeUndefined()
    sessionManager.registerPending(14, live, resultField, "shell", false, metadata)
    await deliverContinuationResults(live, [{ ...result!, sessionId: live.sessionId, execId: 14 }])
    const messages = writes.map(frame => decodeMessage<{
      exec_client_message?: {
        shell_stream?: { stdout?: { data: string }; stderr?: { data: string } }
        shell_result?: { failure?: { stdout: string; stderr: string } }
      }
    }>("AgentClientMessage", frame))
    if (resultField === "shell_stream") {
      expect(messages.flatMap(message => message.exec_client_message?.shell_stream?.stdout?.data ?? [])).toEqual(partial ? [output] : [])
      expect(messages.flatMap(message => message.exec_client_message?.shell_stream?.stderr?.data ?? [])).toEqual([error])
    } else {
      expect(messages[0]?.exec_client_message?.shell_result?.failure).toMatchObject({ stdout: partial ? output : "", stderr: error })
    }
    expect(live.pending.size).toBe(0)
  })

  it("returns a sanitized OpenCode timeout as Cursor's typed aborted shell exit", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("timeout-write")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    const toolCallId = "cursor_timeout-write_12"
    const metadata = {
      shell_stream: true,
      command: "./runtests",
      working_directory: "/tmp",
      timeout_ms: 30_000,
      timeout_behavior: 1,
    }
    registerCursorShellCall(toolCallId, metadata)
    const clean = captureCursorShellResult(
      toolCallId,
      "partial output\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.\n</shell_metadata>",
      { exit: null },
    )
    sessionManager.registerPending(12, live, "shell_stream", "bash", false, metadata)

    const kept = await deliverContinuationResults(live, [{
      toolCallId,
      sessionId: "timeout-write",
      execId: 12,
      toolName: "bash",
      output: clean,
    }])

    expect(kept).toBe(live)
    expect(clean).toBe("partial output\nTimed out after 30000ms.\n")
    const stdout = decodeMessage<any>("AgentClientMessage", writes[1]).exec_client_message
    const exit = decodeMessage<any>("AgentClientMessage", writes[2]).exec_client_message
    expect(stdout.shell_stream.stdout.data).toBe("partial output\nTimed out after 30000ms.\n")
    expect(exit.shell_stream.exit).toMatchObject({ code: 0, aborted: true, abort_reason: 2 })
    expect(JSON.stringify(writes.map((frame) => decodeMessage("AgentClientMessage", frame))))
      .not.toContain("shell_metadata")
  })

  it("turns the native proposal result into CreatePlan success", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("native-plan")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    sessionManager.registerPending(
      900_101,
      live,
      CREATE_PLAN_RESULT_FIELD,
      "write",
      false,
      { interactionId: 7, planUri: "local://sample-plan.md" },
    )

    const kept = await deliverContinuationResults(live, [{ toolCallId: "result-408",
      sessionId: "native-plan",
      execId: 900_101,
      toolName: "write",
      output: "Plan ready for review.",
    }])

    expect(kept).toBe(live)
    const response = decodeMessage<any>("AgentClientMessage", writes[0]).interaction_response
    expect(response.id).toBe(7)
    expect(response.create_plan_request_response.result.success).toBeDefined()
    expect(response.create_plan_request_response.result.plan_uri).toBe("local://sample-plan.md")
  })

  it("turns a failed native proposal into CreatePlan error", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("native-plan-error")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    sessionManager.registerPending(
      900_102,
      live,
      CREATE_PLAN_RESULT_FIELD,
      "write",
      false,
      { interactionId: 8, planUri: "local://sample-plan.md" },
    )

    await deliverContinuationResults(live, [{ toolCallId: "result-435",
      sessionId: "native-plan-error",
      execId: 900_102,
      toolName: "write",
      output: "Plan artifact missing",
      error: "Plan artifact missing",
    }])

    const response = decodeMessage<any>("AgentClientMessage", writes[0]).interaction_response
    expect(response.create_plan_request_response.result.plan_uri).toBe("")
    expect(response.create_plan_request_response.result.error.error).toBe("Plan artifact missing")
  })

  it("closes and returns undefined when continuation write fails", async () => {
    const live = fakeSession("dead-write")
    live.stream.write = () => {
      throw new CursorRunInterruptedError("Cursor Run stream is no longer writable")
    }
    live.stream.isClosed = () => true
    sessionManager.registerPending(3, live, "read_result", "read")

    const kept = await deliverContinuationResults(live, [
      { toolCallId: "result-457", sessionId: "dead-write", execId: 3, toolName: "read", output: "content" },
    ])

    expect(kept).toBeUndefined()
    expect(live.pending.size).toBe(0)
    // Closed sessions must not be selected for continuation anymore.
    expect(findContinuationSession([
      { sessionId: "dead-write", execId: 3 },
    ])).toBeUndefined()
  })

  it("clears bridged pending entries without writing exec frames", async () => {
    const writes: Uint8Array[] = []
    const live = fakeSession("bridged")
    live.stream.write = (frame: Uint8Array) => { writes.push(frame) }
    sessionManager.registerPending(900_001, live, "todowrite", "todowrite", true)

    const kept = await deliverContinuationResults(live, [
      { toolCallId: "result-475", sessionId: "bridged", execId: 900_001, toolName: "todowrite", output: "ok" },
    ])

    expect(kept).toBe(live)
    expect(writes).toHaveLength(0)
    expect(live.pending.has(900_001)).toBe(false)
  })

  it("refreshes the mirrored todo snapshot from a host todoread result", async () => {
    // Bridged Cursor TodoRead and direct host todoread share this path. Host
    // JSON is authoritative for later merge:true patches; prose/errors leave
    // the prior snapshot alone.
    const openCodeSessionId = `todoread-refresh-${Date.now()}`
    const live = fakeSession("todoread-sess")
    live.openCodeSessionId = openCodeSessionId
    live.mirroredTodos = [
      { id: "stale", content: "old", status: "pending", priority: "medium" },
    ]
    rememberMirroredTodos(openCodeSessionId, live.mirroredTodos)
    sessionManager.registerPending(900_002, live, "todoread", "todoread", true)

    const kept = await deliverContinuationResults(live, [
      { toolCallId: "result-497",
        sessionId: "todoread-sess",
        execId: 900_002,
        toolName: "todoread",
        output: JSON.stringify({
          todos: [
            { id: "1", content: "from host", status: "completed", priority: "high" },
            { id: "2", content: "still open", status: "pending" },
          ],
        }),
      },
    ])

    expect(kept).toBe(live)
    expect(live.mirroredTodos).toEqual([
      { id: "1", content: "from host", status: "completed", priority: "high" },
      { id: "2", content: "still open", status: "pending", priority: "medium" },
    ])
    expect(snapshotMirroredTodosBySession(openCodeSessionId)).toEqual(live.mirroredTodos)

    // Non-JSON host output must not wipe a useful prior.
    sessionManager.registerPending(900_003, live, "todoread", "todoread", true)
    await deliverContinuationResults(live, [
      { toolCallId: "result-520",
        sessionId: "todoread-sess",
        execId: 900_003,
        toolName: "todoread",
        output: "No todos yet",
      },
    ])
    expect(snapshotMirroredTodosBySession(openCodeSessionId)).toEqual([
      { id: "1", content: "from host", status: "completed", priority: "high" },
      { id: "2", content: "still open", status: "pending", priority: "medium" },
    ])
  })
})

describe("refreshHeldSessionToolCatalog", () => {
  it("keeps the held catalog across session-less continuation shrinks and grows", async () => {
    const live = fakeSession("standalone-grow")
    const schema = { type: "object", properties: {} }
    const call = (names: string[]) => ({
      prompt: [],
      tools: names.map(name => ({ type: "function", name, description: name, inputSchema: schema })),
    }) as LanguageModelV3CallOptions
    await refreshHeldSessionToolCatalog(live, call(["read", "write"]))
    const original = live.toolDescriptors
    await refreshHeldSessionToolCatalog(live, call(["read"]))
    expect(live.toolDescriptors).toEqual(original)
    expect(live.permittedToolNames).toEqual(new Set(["read"]))
    await refreshHeldSessionToolCatalog(live, call(["alpha", "read"]))
    expect(live.toolCatalog?.map(tool => tool.name)).toEqual(["read", "write", "alpha"])
  })

  it("makes tools added after Run open appear in the next exec #36 reply", async () => {
    const live = fakeSession("mcp-grow")
    live.openCodeSessionId = "ses_mcp_grow"
    live.knownMcpServers = ["abmcp"]
    live.toolCatalog = [{ name: "read", description: "Read", inputSchema: { type: "object" } }]
    live.requestContext = {
      tools: [{ tool_name: "read" }],
      env: { workspace_paths: [process.cwd()] },
    }
    const schema = { type: "object", properties: {} }
    await refreshHeldSessionToolCatalog(live, {
      prompt: [],
      tools: [
        { type: "function", name: "read", description: "Read", inputSchema: schema },
        { type: "function", name: "abmcp_ab_secret", description: "Secret", inputSchema: schema },
        { type: "function", name: "websearch", description: "Search", inputSchema: schema },
      ],
    } as LanguageModelV3CallOptions)

    expect(live.toolCatalog?.map((tool) => tool.name)).toContain("abmcp_ab_secret")
    expect(live.permittedToolNames?.has("abmcp_ab_secret")).toBe(true)
    expect(live.toolDescriptors.some((tool) => tool.tool_name === "ab_secret")).toBe(true)
    expect((live.requestContext.tools as Array<{ tool_name: string }>).map((tool) => tool.tool_name))
      .toEqual(["read"])

    const result = decodeMessage<{
      exec_client_message: {
        mcp_state_exec_result: {
          success: { servers: Array<{ tools: Array<{ name: string; tool_name: string }> }> }
        }
      }
    }>("AgentClientMessage", buildMcpStateResult(3, {}, live.toolDescriptors))
      .exec_client_message.mcp_state_exec_result.success
    const listed = result.servers.flatMap((server) => server.tools)
    expect(listed.map((tool) => tool.tool_name)).toContain("ab_secret")
    // #36 names match the aliased names RequestContext advertises.
    expect(listed.map((tool) => tool.name)).toContain("custom_websearch")
    expect(listed.map((tool) => tool.tool_name)).not.toContain("websearch")
  })

  it("grows the conversation overlay so the next Run reuses RequestContext after MCP tools appear", () => withTempHostCache(async () => {
    const live = fakeSession("mcp-reuse")
    live.openCodeSessionId = "ses_mcp_reuse"
    const schema = { type: "object", properties: {} }
    const call = (names: string[]) => ({
      prompt: [],
      tools: names.map((name) => ({ type: "function", name, description: name, inputSchema: schema })),
    }) as LanguageModelV3CallOptions
    live.requestContext = { env: { workspace_paths: [process.cwd()] } }
    await refreshHeldSessionToolCatalog(live, call(["read"]))
    await getOrBuildRequestContext(live.conversationId, {
      workspaceRoot: process.cwd(),
      tools: live.toolCatalog,
      conversationId: live.conversationId,
      mergedConfig: { mcp: {} },
    })
    await refreshHeldSessionToolCatalog(live, call(["read", "github_get_me"]))
    expect(live.requestContext).toEqual({ env: { workspace_paths: [process.cwd()] } })
    expect(live.toolCatalog?.map((tool) => tool.name)).toEqual(["read", "github_get_me"])
    const next = await getOrBuildRequestContext(live.conversationId, {
      workspaceRoot: process.cwd(),
      tools: live.toolCatalog,
      conversationId: live.conversationId,
      mergedConfig: { mcp: {} },
    })
    expect(next.reused).toBe(true)
  }))
})
