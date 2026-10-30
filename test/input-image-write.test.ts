import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { getHostCacheDirOverride, opencodeProjectDir, setHostCacheDirOverride } from "../src/context/paths.js"
import { executeCursorImageSave, IMAGE_PERMISSION_DENIED_PREFIX } from "../src/image-save.js"
import { imageContentHash } from "../src/image-input.js"
import {
  clearPendingCursorImages,
  distinctInputImagePath,
  finishCursorImageSave,
  stageCursorImage,
  takePendingCursorImage,
} from "../src/image-staging.js"
import {
  attachSessionHeartbeat,
  deliverContinuationResults,
  releaseHostNoteInjectionsForTests,
  pump,
  pumpWithRecovery,
  resetTurnStateForTests,
  settleRunSavesForTests,
} from "../src/language-model.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "../src/protocol/generate-image.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  heldHistoryImageHashes,
  noteHistoryImagesSent,
  resetHeldHistoryImagesForTests,
  runHasHistoryImage,
  runHistoryImages,
} from "../src/protocol/sent-history-images.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { sessionManager, type Frame } from "../src/session.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { sessionFixture } from "./session-fixture.js"

const HOST_SESSION = "ses_input_image"
const PNG_A = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1)
const PNG_B = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2)

const tempDirs: string[] = []
let previousCache: string | undefined
let cacheOverridden = false

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-input-image-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await settleRunSavesForTests()
  sessionManager.dispose()
  clearPendingCursorImages()
  resetToolRequestsListedSeenForTests()
  resetTurnStateForTests()
  resetHeldHistoryImagesForTests()
  if (cacheOverridden) setHostCacheDirOverride(previousCache)
  cacheOverridden = false
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function frame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

const ended = () => frame({ interaction_update: { turn_ended: {} } })
const checkpoint = (bytes: Uint8Array) => frame({ conversation_checkpoint_update: bytes })
const completed = (call_id: string) => frame({ interaction_update: { tool_call_completed: { call_id } } })
// Cursor's copy of an image, and a generated image's write, both name no call.
const imageWrite = (id: number, data: Uint8Array, file = "/elsewhere/assets/cvs.png") => frame({
  exec_server_message: { id, write_args: { path: file, file_bytes: data } },
})
const generateImageStarted = (call_id: string) => frame({ interaction_update: { tool_call_started: {
  call_id, tool_call: { generate_image_tool_call: { args: { description: "a red fox in the snow" } } },
} } })

/**
 * A Run whose conversation holds `inputImages`, with `cursor_image_save`
 * advertised. `closeCleanly` ends its stream the way Cursor ends a finished Run;
 * after `endWithoutNotice`, the next write fails as on a stream Cursor ended
 * before the provider noticed.
 */
function imageRun(
  frames: Frame[],
  inputImages: readonly Uint8Array[] = [],
  sessionId = "input-image-run",
  workspace?: string,
) {
  if (!cacheOverridden) {
    previousCache = getHostCacheDirOverride()
    setHostCacheDirOverride(tempDir())
    cacheOverridden = true
  }
  workspace ??= tempDir()
  const writes: Uint8Array[] = []
  let closed = false
  let endedUnnoticed = false
  let terminal: ((event: { kind: "remote-clean-close" }) => void) | undefined
  const iterator: AsyncIterator<Frame> = {
    next: async () => {
      const value = frames.shift()
      return value ? { done: false, value } : { done: true, value: undefined }
    },
  }
  const tools = [{ name: CURSOR_IMAGE_SAVE_TOOL, description: "Save an image" }]
  const historyImages = runHistoryImages()
  noteHistoryImagesSent(historyImages, inputImages.map(imageContentHash), 0)
  const session = sessionFixture({
    sessionId, conversationId: "input-image-conversation", openCodeSessionId: HOST_SESSION,
    stream: {
      write(data) {
        if (endedUnnoticed) {
          closed = true
          throw new CursorRunInterruptedError("Cursor Run stream is no longer writable")
        }
        writes.push(data)
      },
      end() {}, destroy() {}, isClosed: () => closed,
      onTerminal: (listener) => {
        terminal = listener as typeof terminal
        return () => { terminal = undefined }
      },
      frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
    frames: iterator, pending: new Map(), displayToolCalls: new Map(),
    nextBridgedExecId: 900_000, blobs: new Map(), toolCatalog: tools,
    toolDescriptors: toolsToDescriptors(tools, "opencode"),
    requestContext: { env: { workspace_paths: [workspace] } },
    allowTools: true, pumpActive: false, heartbeat: null, historyImages,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
  })
  const closeCleanly = () => {
    closed = true
    terminal?.({ kind: "remote-clean-close" })
  }
  const endWithoutNotice = () => { endedUnnoticed = true }
  // Cursor's response has ended; the transport announces it a moment later.
  const endResponse = () => { closed = true }
  return {
    session, writes, frames, workspace, closeCleanly, endWithoutNotice, endResponse,
    assets: path.join(opencodeProjectDir(workspace), "assets"),
  }
}

const writeResults = (writes: readonly Uint8Array[]) => writes
  .map((bytes) => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message?.write_result)
  .filter(Boolean)

function collect() {
  const parts: LanguageModelV3StreamPart[] = []
  const controller = {
    desiredSize: 1, close() {},
    enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
    error(error: unknown) { throw error },
  } as ReadableStreamDefaultController<LanguageModelV3StreamPart>
  return { parts, controller }
}

const ids = { textId: "text", reasoningId: "reasoning" }

/** Pump to the save step, answer it with `outcome`, and return the save call. */
async function saveStep(run: ReturnType<typeof imageRun>, execId: number, outcome: "saved" | "denied" | "failed") {
  const first = collect()
  await pump(run.session, first.controller, ids)
  const save = first.parts.find((part) => part.type === "tool-call")
  expect(save).toMatchObject({ toolName: CURSOR_IMAGE_SAVE_TOOL })
  const error = outcome === "denied" ? `${IMAGE_PERMISSION_DENIED_PREFIX} rejected by the user`
    : outcome === "failed" ? "Could not save the generated image: disk full" : undefined
  const metadata = run.session.pending.get(execId)?.resultMetadata
  expect(await deliverContinuationResults(run.session, [{
    sessionId: run.session.sessionId, execId, toolCallId: save!.type === "tool-call" ? save!.toolCallId : "",
    toolName: CURSOR_IMAGE_SAVE_TOOL, output: error ?? "Saved the generated image", ...(error ? { error } : {}),
  }])).toBe(run.session)
  return metadata
}

describe("Cursor's input-image writes", () => {
  it.each(["saved", "denied", "failed"] as const)(
    "let later checkpoints resume the Run once %s, and the turn ends holding the image",
    async outcome => {
      const resume = Uint8Array.of(10, 2, 7, 7)
      const run = imageRun([imageWrite(1, PNG_A), checkpoint(resume), ended()], [PNG_A])
      const metadata = await saveStep(run, 1, outcome)
      expect(metadata).toMatchObject({ inputImage: true })
      expect(metadata?.generateImageCallId).toBeUndefined()
      expect(run.session.unacknowledgedHostResults ?? []).toEqual([])
      await pump(run.session, collect().controller, ids)

      expect(run.session.resumeCheckpoint).toEqual(resume)
      // So the next Run skips the image and Cursor does not write it again.
      expect(heldHistoryImageHashes(HOST_SESSION, run.session.conversationId, resume))
        .toEqual(new Set([imageContentHash(PNG_A)]))
    },
  )

  it("does not count a checkpoint from before the save", async () => {
    const early = Uint8Array.of(10, 2, 1, 1)
    const run = imageRun([checkpoint(early), imageWrite(1, PNG_A), ended()], [PNG_A])
    await saveStep(run, 1, "saved")
    await pump(run.session, collect().controller, ids)
    expect(run.session.resumeCheckpoint).toBeUndefined()
    expect(heldHistoryImageHashes(HOST_SESSION, run.session.conversationId, early)).toBeUndefined()
  })

  it("keeps waiting for any other uncorrelated write, which no completion can acknowledge", async () => {
    const later = Uint8Array.of(10, 2, 3, 3)
    const run = imageRun([imageWrite(1, PNG_B), checkpoint(later), ended()], [PNG_A])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.inputImage).toBeUndefined()
    expect(run.session.unacknowledgedHostResults).toEqual([{ callId: undefined, afterFrame: expect.any(Number) }])
    await pump(run.session, collect().controller, ids)
    expect(run.session.resumeCheckpoint).toBeUndefined()
  })

  it("does not take a model's own write of matching bytes for Cursor's copy", async () => {
    const run = imageRun([frame({ exec_server_message: { id: 1, write_args: {
      path: "/elsewhere/assets/cvs.png", file_bytes: PNG_A, tool_call_id: "model-write",
    } } }), ended()], [PNG_A])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.inputImage).toBeUndefined()
    expect(metadata?.path).toEndWith(`${path.sep}cvs.png`)
  })

  it("saves a same-named different image beside the first and reports that path to Cursor", async () => {
    const run = imageRun([imageWrite(1, PNG_B), ended()], [PNG_B])
    fs.mkdirSync(run.assets, { recursive: true })
    fs.writeFileSync(path.join(run.assets, "cvs.png"), PNG_A)
    const hashed = path.join(run.assets, `cvs-${imageContentHash(PNG_B).slice(0, 12)}.png`)
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.path).toBe(hashed)
    const result = run.writes
      .map((bytes) => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message?.write_result)
      .find(Boolean)
    expect(result.success).toMatchObject({ path: hashed, file_size: PNG_B.length })
    expect(fs.readFileSync(path.join(run.assets, "cvs.png"))).toEqual(Buffer.from(PNG_A))
  })
})

describe("Cursor's input-image writes, which Cursor never waits for", () => {
  it("are answered at once, and the finished save writes nothing more", async () => {
    const run = imageRun([imageWrite(1, PNG_A), ended()], [PNG_A])
    await pump(run.session, collect().controller, ids)
    // Answered before the host runs the save, with the path Cursor will be given.
    const answers = writeResults(run.writes)
    expect(answers).toHaveLength(1)
    expect(answers[0].success).toMatchObject({ path: path.join(run.assets, "cvs.png"), lines_created: 0, file_size: PNG_A.length })
    expect(run.session.pending.get(1)).toMatchObject({ answered: true, toolName: CURSOR_IMAGE_SAVE_TOOL })
    expect(run.session.heartbeat).toBeNull()
    const save = run.session.pending.get(1)!
    const written = run.writes.length
    expect(await deliverContinuationResults(run.session, [{
      sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
      toolName: CURSOR_IMAGE_SAVE_TOOL, output: "Saved the generated image",
    }])).toBe(run.session)
    expect(save.state).toBe("delivered")
    expect(run.writes).toHaveLength(written)
    expect(run.session.unacknowledgedHostResults ?? []).toEqual([])
  })

  it.each(["saved", "denied"] as const)(
    "keep a Run Cursor ended cleanly during the save, and play its reply once the save is %s",
    async outcome => {
      const resume = Uint8Array.of(10, 2, 4, 4)
      const run = imageRun([
        imageWrite(1, PNG_A), checkpoint(resume),
        frame({ interaction_update: { text_delta: { text: "Red" } } }), ended(),
      ], [PNG_A])
      await pump(run.session, collect().controller, ids)
      run.session.policy = { ...run.session.policy, heartbeatMs: 20 }
      attachSessionHeartbeat(run.session)
      const sent = run.writes.length
      run.closeCleanly()
      expect(run.session.closed).toBe(false)
      // Nothing more is written to the ended stream, not even a heartbeat.
      expect(run.session.heartbeat).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, run.session.policy.heartbeatMs + 50))
      expect(run.session.closed).toBe(false)
      expect(run.writes).toHaveLength(sent)
      const error = outcome === "denied" ? `${IMAGE_PERMISSION_DENIED_PREFIX} rejected by the user` : undefined
      expect(await deliverContinuationResults(run.session, [{
        sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
        toolName: CURSOR_IMAGE_SAVE_TOOL, output: error ?? "Saved the generated image", ...(error ? { error } : {}),
      }])).toBe(run.session)
      const reply = collect()
      await pump(run.session, reply.controller, ids)
      expect(reply.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Red"])
      expect(reply.parts.find((part) => part.type === "finish")).toMatchObject({ finishReason: { unified: "stop" } })
      expect(run.session.closed).toBe(true)
      // The turn ended on its own checkpoint, so the next Run skips the image.
      expect(heldHistoryImageHashes(HOST_SESSION, run.session.conversationId, resume))
        .toEqual(new Set([imageContentHash(PNG_A)]))
    },
  )

  const injectedNotes = (writes: readonly Uint8Array[]) => writes
    .map((bytes) => decodeMessage<any>("AgentClientMessage", bytes).conversation_action?.inject_context_action)
    .filter(Boolean)
    .map((action) => action.user_context.user_message.text as string)

  it.each(["ended", "ending unnoticed"] as const)(
    "answer a later image's copy queued in a Run Cursor %s, without writing to it",
    async (state) => {
      const run = imageRun([
        imageWrite(1, PNG_A), imageWrite(2, PNG_B, "/elsewhere/assets/other.png"),
        frame({ interaction_update: { text_delta: { text: "Two" } } }), ended(),
      ], [PNG_A, PNG_B])
      await pump(run.session, collect().controller, ids)
      if (state === "ended") run.closeCleanly()
      else run.endWithoutNotice()
      expect(await deliverContinuationResults(run.session, [{
        sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
        toolName: CURSOR_IMAGE_SAVE_TOOL, output: "Saved the generated image",
      }])).toBe(run.session)
      const second = collect()
      await pump(run.session, second.controller, ids)
      expect(second.parts.find((part) => part.type === "tool-call")).toMatchObject({ toolName: CURSOR_IMAGE_SAVE_TOOL })
      expect(run.session.pending.get(2)).toMatchObject({ answered: true })
      expect(writeResults(run.writes)).toHaveLength(1)
      if (state === "ending unnoticed") return
      expect(await deliverContinuationResults(run.session, [{
        sessionId: run.session.sessionId, execId: 2, toolCallId: "cursor_input-image-run_2",
        toolName: CURSOR_IMAGE_SAVE_TOOL, output: "Saved the generated image",
      }])).toBe(run.session)
      const reply = collect()
      await pump(run.session, reply.controller, ids)
      expect(reply.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Two"])
      expect(reply.parts.find((part) => part.type === "finish")).toMatchObject({ finishReason: { unified: "stop" } })
    },
  )

  it("tell the model a declined copy is not on disk, in the running turn", async () => {
    const run = imageRun([imageWrite(1, PNG_A), ended()], [PNG_A])
    await pump(run.session, collect().controller, ids)
    const denial = `${IMAGE_PERMISSION_DENIED_PREFIX} rejected by the user`
    expect(await deliverContinuationResults(run.session, [{
      sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
      toolName: CURSOR_IMAGE_SAVE_TOOL, output: denial, error: denial,
    }])).toBe(run.session)
    expect(injectedNotes(run.writes)).toEqual([
      `The copy of an attached image at ${path.join(run.assets, "cvs.png")} was not saved (rejected by the user), `
        + "so that file does not exist. The image itself is still in this conversation.",
    ])
  })

  it("tell the model a declined copy is not on disk on the next turn, once Cursor ended the Run", async () => {
    const run = imageRun([imageWrite(1, PNG_A), ended()], [PNG_A])
    await pump(run.session, collect().controller, ids)
    run.closeCleanly()
    const denial = `${IMAGE_PERMISSION_DENIED_PREFIX} rejected by the user`
    expect(await deliverContinuationResults(run.session, [{
      sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
      toolName: CURSOR_IMAGE_SAVE_TOOL, output: denial, error: denial,
    }])).toBe(run.session)
    expect(injectedNotes(run.writes)).toEqual([])
    expect(releaseHostNoteInjectionsForTests(HOST_SESSION).undelivered).toEqual([
      expect.stringContaining(`${path.join(run.assets, "cvs.png")} was not saved (rejected by the user)`),
    ])
  })

  const playsReply = async (run: ReturnType<typeof imageRun>) => {
    const reply = collect()
    await pump(run.session, reply.controller, ids)
    expect(reply.parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Red"])
    expect(reply.parts.find((part) => part.type === "finish")).toMatchObject({ finishReason: { unified: "stop" } })
  }
  const saved = (run: ReturnType<typeof imageRun>) => deliverContinuationResults(run.session, [{
    sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
    toolName: CURSOR_IMAGE_SAVE_TOOL, output: "Saved the generated image",
  }])

  it("deliver a save's result after Cursor ended the Run but before the end is announced", async () => {
    const run = imageRun([imageWrite(1, PNG_A), frame({ interaction_update: { text_delta: { text: "Red" } } }), ended()], [PNG_A])
    await pump(run.session, collect().controller, ids)
    run.endResponse()
    expect(sessionManager.classify(run.session.sessionId, 1)).toMatchObject({ kind: "deliverable" })
    expect(await saved(run)).toBe(run.session)
    run.closeCleanly()
    expect(run.session.closed).toBe(false)
    await playsReply(run)
  })

  it("keep a Run Cursor ends after the save's result was delivered and before its reply is played", async () => {
    const run = imageRun([imageWrite(1, PNG_A), frame({ interaction_update: { text_delta: { text: "Red" } } }), ended()], [PNG_A])
    await pump(run.session, collect().controller, ids)
    expect(await saved(run)).toBe(run.session)
    run.closeCleanly()
    expect(run.session.closed).toBe(false)
    await playsReply(run)
  })

  it("send no heartbeat to a Run whose end is not announced yet", async () => {
    const run = imageRun([imageWrite(1, PNG_A), ended()], [PNG_A])
    await pump(run.session, collect().controller, ids)
    run.session.policy = { ...run.session.policy, heartbeatMs: 20 }
    attachSessionHeartbeat(run.session)
    const sent = run.writes.length
    run.endResponse()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(run.writes).toHaveLength(sent)
    expect(run.session.closed).toBe(false)
    run.session.heartbeatCancel?.()
  })

  it.each(["saved", "declined"] as const)(
    "tell the model where a same-named copy went when it is %s beside Cursor's path",
    async (outcome) => {
      const run = imageRun([imageWrite(1, PNG_B), ended()], [PNG_B])
      fs.mkdirSync(run.assets, { recursive: true })
      fs.writeFileSync(path.join(run.assets, "cvs.png"), PNG_A)
      await pump(run.session, collect().controller, ids)
      const requested = path.join(run.assets, "cvs.png")
      const besides = path.join(run.assets, `cvs-${imageContentHash(PNG_B).slice(0, 12)}.png`)
      const denial = `${IMAGE_PERMISSION_DENIED_PREFIX} rejected by the user`
      expect(await deliverContinuationResults(run.session, [{
        sessionId: run.session.sessionId, execId: 1, toolCallId: "cursor_input-image-run_1",
        toolName: CURSOR_IMAGE_SAVE_TOOL,
        ...(outcome === "saved" ? { output: "Saved the generated image" } : { output: denial, error: denial }),
      }])).toBe(run.session)
      expect(injectedNotes(run.writes)).toEqual([outcome === "saved"
        ? `The copy of an attached image meant for ${requested} was saved as ${besides}, because ${requested} holds a different image.`
        : `The copy of an attached image meant for ${requested} was not saved (rejected by the user); ${requested} `
          + "holds a different image. The image itself is still in this conversation."])
    },
  )

  it("keep the Run when Cursor ends it while the step that answered is still ending", () => {
    const run = imageRun([], [PNG_A])
    sessionManager.registerPending(1, run.session, "write_result", CURSOR_IMAGE_SAVE_TOOL, false, { inputImage: true }, true)
    const owner = Symbol("pump")
    sessionManager.beginPump(run.session, owner)
    run.closeCleanly()
    sessionManager.endPump(run.session, owner)
    expect(run.session.closed).toBe(false)
    expect(sessionManager.classify(run.session.sessionId, 1)).toMatchObject({ kind: "deliverable" })
  })

  it("still close a Run Cursor ended while the host owes it a result", () => {
    const run = imageRun([], [PNG_A])
    sessionManager.registerPending(1, run.session, "write_result", CURSOR_IMAGE_SAVE_TOOL, false, { inputImage: true }, true)
    sessionManager.registerPending(2, run.session, "shell_stream", "bash")
    run.closeCleanly()
    expect(run.session.closed).toBe(true)
    expect(sessionManager.classify(run.session.sessionId, 1)).toMatchObject({ kind: "terminal", reason: "remote-clean-close" })
  })
})

describe("a Run resumed after a cut", () => {
  const unavailable = (): Frame => ({ flags: 0x02, payload: new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable" } })) })

  it("confirms the images the cut Run sent, which the resumed checkpoint holds", async () => {
    const cutAt = Uint8Array.of(10, 2, 5, 5)
    const resumedEnd = Uint8Array.of(10, 2, 6, 6)
    const cut = imageRun([checkpoint(cutAt), frame({ interaction_update: { text_delta: { text: "partial" } } }), unavailable()], [PNG_A])
    const resumed = imageRun([checkpoint(resumedEnd), ended()], [], "input-image-resumed", cut.workspace)
    const recoveries: unknown[] = []
    await pumpWithRecovery({
      initialSession: cut.session,
      controller: collect().controller,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async (recovery) => {
        recoveries.push(recovery)
        return resumed.session
      },
    })
    expect(recoveries).toEqual([{ kind: "resume", conversationId: cut.session.conversationId, checkpoint: cutAt }])
    expect(heldHistoryImageHashes(HOST_SESSION, resumed.session.conversationId, resumedEnd))
      .toEqual(new Set([imageContentHash(PNG_A)]))
  })

  it("carries only the images sent before the checkpoint it resumes", async () => {
    const cutAt = Uint8Array.of(10, 2, 7, 7)
    const resumedEnd = Uint8Array.of(10, 2, 8, 8)
    const cut = imageRun([checkpoint(cutAt), unavailable()], [])
    const resumed = imageRun([checkpoint(resumedEnd), ended()], [], "input-image-resumed", cut.workspace)
    await pumpWithRecovery({
      initialSession: cut.session,
      controller: collect().controller,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => resumed.session,
    })
    expect(heldHistoryImageHashes(HOST_SESSION, resumed.session.conversationId, resumedEnd)).toBeUndefined()
  })
})

describe("a generated image's write", () => {
  it.each([
    ["is acknowledged by its GenerateImage completion", true],
    ["refuses a checkpoint until its GenerateImage completes", false],
  ] as const)("%s", async (_name, completesFirst) => {
    const resume = Uint8Array.of(10, 2, 9, 9)
    const after = completesFirst ? [completed("gen-1"), checkpoint(resume)] : [checkpoint(resume), completed("gen-1")]
    const run = imageRun([generateImageStarted("gen-1"), imageWrite(1, PNG_B), ...after, ended()])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata).toMatchObject({ generateImageCallId: "gen-1" })
    expect(metadata?.inputImage).toBeUndefined()
    expect(run.session.unacknowledgedHostResults).toEqual([{ callId: "gen-1", afterFrame: expect.any(Number) }])
    await pump(run.session, collect().controller, ids)
    expect(run.session.unacknowledgedHostResults).toEqual([])
    expect(run.session.resumeCheckpoint).toEqual(completesFirst ? resume : undefined)
  })

  it("stays uncorrelated while two GenerateImage calls are open", async () => {
    const run = imageRun([generateImageStarted("gen-1"), generateImageStarted("gen-2"), imageWrite(1, PNG_B), ended()])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata?.generateImageCallId).toBeUndefined()
    expect(run.session.unacknowledgedHostResults).toEqual([{ callId: undefined, afterFrame: expect.any(Number) }])
  })

  it("is not taken for an input image that happens to match", async () => {
    const run = imageRun([generateImageStarted("gen-1"), imageWrite(1, PNG_A), ended()], [PNG_A])
    const metadata = await saveStep(run, 1, "saved")
    expect(metadata).toMatchObject({ generateImageCallId: "gen-1" })
    expect(metadata?.inputImage).toBeUndefined()
  })
})

describe("distinctInputImagePath", () => {
  const hash = imageContentHash(PNG_B)
  const hashedName = `cvs-${hash.slice(0, 12)}.png`

  it("moves aside from a different image whose save is waiting for permission", () => {
    const target = path.join(tempDir(), "cvs.png")
    const first = stageCursorImage({ path: target, mime: "image/png", data: PNG_A })
    expect(takePendingCursorImage(first)).toBeDefined()
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(path.dirname(target), hashedName))
    finishCursorImageSave(first)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(target)
  })

  it.each(["declined", "approved"] as const)("keeps the name reserved until a save is %s", async (outcome) => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    const first = stageCursorImage({ path: target, projectDir: dir, mime: "image/png", data: PNG_A })
    let answer: (approved: boolean) => void = () => {}
    const asked = new Promise<boolean>((resolve) => { answer = resolve })
    const save = executeCursorImageSave({ image_id: first }, {
      worktree: dir, directory: dir,
      ask: async () => { if (!await asked) throw new Error("rejected") },
    }).catch((error: unknown) => error)
    await Promise.resolve()
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
    answer(outcome === "approved")
    await save
    // A declined save leaves the name free; an approved one leaves the first image there.
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(outcome === "approved" ? path.join(dir, hashedName) : target)
  })

  it("refuses rather than overwrite when every name beside a taken one is taken", () => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    fs.writeFileSync(target, PNG_A)
    for (let n = 1; n <= 100; n++) {
      fs.writeFileSync(path.join(dir, `cvs-${hash.slice(0, 12)}${n === 1 ? "" : `-${n}`}.png`), `unrelated ${n}`)
    }
    expect(() => distinctInputImagePath(target, PNG_B, hash)).toThrow("nothing was overwritten")
  })

  it("checks the name beside a taken one too, and never overwrites another file there", () => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    fs.writeFileSync(target, PNG_A)
    fs.writeFileSync(path.join(dir, hashedName), "an unrelated file")
    const next = path.join(dir, `cvs-${hash.slice(0, 12)}-2.png`)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(next)
    fs.writeFileSync(next, PNG_B)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(next)
  })

  it("keeps a free target or one already holding the same bytes", () => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(target)
    fs.writeFileSync(target, PNG_B)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(target)
  })

  it("moves aside from other bytes on disk, a link, or a directory", () => {
    const dir = tempDir()
    const target = path.join(dir, "cvs.png")
    fs.writeFileSync(target, PNG_A)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
    fs.rmSync(target)
    fs.writeFileSync(path.join(dir, "real.png"), PNG_B)
    fs.symlinkSync(path.join(dir, "real.png"), target)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
    fs.rmSync(target)
    fs.mkdirSync(target)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(dir, hashedName))
  })

  it.skipIf(process.getuid?.() === 0)("moves aside from a same-size file it cannot read", () => {
    const target = path.join(tempDir(), "cvs.png")
    fs.writeFileSync(target, PNG_A, { mode: 0o000 })
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(path.dirname(target), hashedName))
  })

  it("moves aside from a different image staged for the same name and not yet saved", () => {
    const target = path.join(tempDir(), "cvs.png")
    stageCursorImage({ path: target, mime: "image/png", data: PNG_A })
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(path.join(path.dirname(target), hashedName))
    expect(distinctInputImagePath(target, PNG_A, imageContentHash(PNG_A))).toBe(target)
  })

  it("keeps an extensionless name readable", () => {
    const target = path.join(tempDir(), "cvs")
    fs.writeFileSync(target, PNG_A)
    expect(distinctInputImagePath(target, PNG_B, hash)).toBe(`${target}-${hash.slice(0, 12)}`)
  })
})

describe("runHasHistoryImage", () => {
  it("finds held, checkpointed and sent images", () => {
    const run = runHistoryImages(new Set(["held"]))
    run.checkpointed.push("checkpointed")
    noteHistoryImagesSent(run, ["sent"], 0)
    expect(["held", "checkpointed", "sent", "other"].map((hash) => runHasHistoryImage(run, hash)))
      .toEqual([true, true, true, false])
  })
})
