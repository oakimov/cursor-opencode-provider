import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  binaryWritePayload,
  decodeWriteBytes,
  mapCursorArgsToOpencode,
  parseExecServerMessage,
  rejectPartialReadMutation,
  remapEditToolsForCatalog,
} from "../src/protocol/tools.js"
import {
  CURSOR_IMAGE_SAVE_TOOL,
  decodeGenerateImageQuery,
  imageMimeForPath,
  remapCursorImageWritePath,
} from "../src/protocol/generate-image.js"
import {
  clearPendingCursorImages,
  pendingCursorImageCount,
  stageCursorImage,
  takePendingCursorImage,
  STAGED_IMAGE_TTL_MS,
} from "../src/image-staging.js"
import {
  executeCursorImageSave,
  resolveContainedImagePath,
  IMAGE_PERMISSION_DENIED_PREFIX,
} from "../src/image-save.js"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

let workspace: string
let projectDir: string

beforeEach(() => {
  clearPendingCursorImages()
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-image-ws-"))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-image-proj-"))
})

afterEach(() => {
  clearPendingCursorImages()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function askRecorder(deny = false) {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    ctx: {
      worktree: workspace,
      directory: workspace,
      async ask(input: Record<string, unknown>) {
        calls.push(input)
        if (deny) throw new Error("The user rejected this request")
      },
    },
  }
}

function stage(target: string, data = PNG) {
  return stageCursorImage({ path: target, projectDir, mime: "image/png", data })
}

function generateImagePayload(args: Record<string, unknown>, id = 42): Uint8Array {
  const query = encodeMessage("GenerateImageRequestQuery", { args, tool_call_id: "tool_img" })
  return encodeMessage("AgentServerMessage", {
    interaction_query: { id, generate_image_request_query: query },
  })
}

// ── Cursor writes the image with an ordinary binary write exec ───────────────

describe("binary write detection", () => {
  it("keeps decoding real text, including a non-utf-8 hint", () => {
    expect(decodeWriteBytes(new TextEncoder().encode("plain"))).toBe("plain")
    expect(decodeWriteBytes(Uint8Array.from([0xe9, 0x74, 0x65]), "latin1")).toBe("éte")
    // An unknown label is a hint problem, not a content problem.
    expect(decodeWriteBytes(new TextEncoder().encode("plain"), "not-a-real-encoding")).toBe("plain")
  })

  it("reports image bytes as binary rather than decoding them lossily", () => {
    expect(decodeWriteBytes(PNG)).toBeUndefined()
    expect(decodeWriteBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBeUndefined()
    // latin1 decodes any byte, so NUL is the signal there.
    expect(decodeWriteBytes(Uint8Array.from([0x41, 0x00, 0x42]), "latin1")).toBeUndefined()
    // utf-16 text legitimately contains NUL bytes.
    expect(decodeWriteBytes(Uint8Array.from([0x68, 0x00, 0x69, 0x00]), "utf-16le")).toBe("hi")
  })

  it("never hands binary bytes to the host write tool as content", () => {
    const mapped = mapCursorArgsToOpencode("write", { path: "logo.png", file_bytes: PNG })
    expect(mapped.args.content).toBeUndefined()
    expect(mapped.binaryBytes).toEqual(PNG)
  })

  it("surfaces the bytes and path off the wire", () => {
    const encoded = encodeMessage("WriteArgs", {
      path: "/proj/assets/icon.png",
      file_bytes: PNG,
      return_file_content_after_write: false,
    })
    const decoded = decodeMessage<Record<string, unknown>>("WriteArgs", encoded)
    const parsed = parseExecServerMessage({ id: 3, write_args: decoded })!
    const payload = binaryWritePayload(parsed)!
    expect(payload.data).toEqual(PNG)
    expect(payload.path).toBe("/proj/assets/icon.png")
    expect(parsed.args.content).toBeUndefined()
  })

  it("survives a host that advertises apply_patch instead of write", () => {
    // OpenCode swaps edit/write for apply_patch on every gpt-* model. A binary
    // write has no patch form, so it must stay a write and keep its bytes.
    const encoded = encodeMessage("WriteArgs", { path: "/proj/assets/icon.png", file_bytes: PNG })
    const decoded = decodeMessage<Record<string, unknown>>("WriteArgs", encoded)
    const parsed = parseExecServerMessage({ id: 3, write_args: decoded })!
    rejectPartialReadMutation(parsed)
    remapEditToolsForCatalog(parsed, ["apply_patch", "read"], "/proj")
    expect(parsed.toolName).toBe("write")
    expect(parsed.localError).toBeUndefined()
    expect(binaryWritePayload(parsed)?.data).toEqual(PNG)
  })

  it("still converts an ordinary text write to a patch on such a host", () => {
    const encoded = encodeMessage("WriteArgs", {
      path: "a.ts",
      file_bytes: new TextEncoder().encode("ok"),
    })
    const decoded = decodeMessage<Record<string, unknown>>("WriteArgs", encoded)
    const parsed = parseExecServerMessage({ id: 3, write_args: decoded })!
    remapEditToolsForCatalog(parsed, ["apply_patch", "read"], "/proj")
    expect(parsed.toolName).toBe("apply_patch")
  })

  it("leaves an ordinary text write alone", () => {
    const encoded = encodeMessage("WriteArgs", { path: "a.ts", file_bytes: new TextEncoder().encode("ok") })
    const decoded = decodeMessage<Record<string, unknown>>("WriteArgs", encoded)
    const parsed = parseExecServerMessage({ id: 3, write_args: decoded })!
    expect(binaryWritePayload(parsed)).toBeUndefined()
    expect(parsed.args).toMatchObject({ filePath: "a.ts", content: "ok" })
  })
})

// ── remapping Cursor's target onto a real host location ──────────────────────

describe("write target remapping", () => {
  const roots = () => ({ workspaceRoot: "/ws", projectDir: "/cache/projects/slug" })

  it("keeps a target Cursor built from the project folder we advertised", () => {
    expect(remapCursorImageWritePath("/cache/projects/slug/assets/icon.png", roots()))
      .toBe(path.resolve("/cache/projects/slug/assets/icon.png"))
  })

  it("keeps a target inside the workspace, which the user can see", () => {
    expect(remapCursorImageWritePath("/ws/docs/icon.png", roots()))
      .toBe(path.resolve("/ws/docs/icon.png"))
  })

  it("rebases an unknown absolute target into the project assets folder", () => {
    expect(remapCursorImageWritePath("/somewhere/else/icon.png", roots()))
      .toBe(path.join("/cache/projects/slug", "assets", "icon.png"))
  })

  it("resolves a relative target against the project folder", () => {
    expect(remapCursorImageWritePath("assets/icon.png", roots()))
      .toBe(path.resolve("/cache/projects/slug/assets/icon.png"))
  })

  it("gives an empty or escaping target a real home instead of failing", () => {
    expect(remapCursorImageWritePath("", roots()))
      .toBe(path.join("/cache/projects/slug", "assets", "generated-image.png"))
    expect(remapCursorImageWritePath("../../etc/passwd", roots()))
      .toBe(path.join("/cache/projects/slug", "assets", "passwd"))
  })
})

// ── staging store ────────────────────────────────────────────────────────────

describe("pending image staging", () => {
  it("hands out an opaque id and yields the bytes exactly once", () => {
    const id = stage("logo.png")
    expect(id).not.toContain("logo.png")
    expect(takePendingCursorImage(id)?.data).toEqual(PNG)
    expect(takePendingCursorImage(id)).toBeUndefined()
  })

  it("does not yield an expired image", () => {
    const id = stageCursorImage({ path: "l.png", projectDir, mime: "image/png", data: PNG }, 1_000)
    expect(takePendingCursorImage(id, 1_000 + STAGED_IMAGE_TTL_MS + 1)).toBeUndefined()
  })

  it("bounds how many uncommitted images accumulate", () => {
    for (let i = 0; i < 20; i++) stage(`img-${i}.png`)
    expect(pendingCursorImageCount()).toBeLessThanOrEqual(8)
  })

  it("refuses an image beyond the size ceiling", () => {
    expect(() => stage("huge.png", new Uint8Array(51 * 1024 * 1024))).toThrow(/above the/)
  })
})

// ── the tool is a handle, not a writer ───────────────────────────────────────

describe("cursor_image_save is not a general file writer", () => {
  it("writes nothing for an id it never issued", async () => {
    const { ctx, calls } = askRecorder()
    expect(typeof await executeCursorImageSave({ image_id: "cursor-image-made-up" }, ctx))
      .toBe("string")
    expect(calls).toHaveLength(0)
    expect(fs.readdirSync(workspace)).toHaveLength(0)
  })

  it("writes nothing when no id is supplied", async () => {
    const { ctx, calls } = askRecorder()
    expect(typeof await executeCursorImageSave({}, ctx)).toBe("string")
    expect(calls).toHaveLength(0)
  })

  it("cannot be replayed to write the same image twice", async () => {
    const { ctx } = askRecorder()
    const id = stage(path.join(projectDir, "assets", "a.png"))
    expect(typeof await executeCursorImageSave({ image_id: id }, ctx)).toBe("object")
    expect(typeof await executeCursorImageSave({ image_id: id }, ctx)).toBe("string")
  })
})

// ── containment ──────────────────────────────────────────────────────────────

describe("containment across both write roots", () => {
  it("accepts a target inside either allowed root", () => {
    expect("error" in resolveContainedImagePath(
      path.join(projectDir, "assets", "a.png"), [projectDir, workspace],
    )).toBe(false)
    expect("error" in resolveContainedImagePath(
      path.join(workspace, "a.png"), [projectDir, workspace],
    )).toBe(false)
  })

  it("refuses a target in neither root", () => {
    const outside = path.join(os.tmpdir(), "cursor-image-neither", "a.png")
    expect(resolveContainedImagePath(outside, [projectDir, workspace]))
      .toEqual({ error: "target path resolves outside the workspace and project folder" })
  })

  it("refuses an escape through a symlinked directory", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-image-outside-"))
    try {
      fs.symlinkSync(outside, path.join(projectDir, "link"))
      expect(resolveContainedImagePath(
        path.join(projectDir, "link", "a.png"), [projectDir, workspace],
      )).toEqual({ error: "target path resolves outside the workspace and project folder" })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("does not ask for permission on a path it cannot honour", async () => {
    const { ctx, calls } = askRecorder()
    const id = stage(path.join(os.tmpdir(), "cursor-image-neither", "a.png"))
    expect(await executeCursorImageSave({ image_id: id }, ctx)).toContain("outside")
    expect(calls).toHaveLength(0)
  })
})

// ── permission and write ─────────────────────────────────────────────────────

describe("committing a staged image", () => {
  it("raises OpenCode's edit permission before writing", async () => {
    const { ctx, calls } = askRecorder()
    const target = path.join(projectDir, "assets", "logo.png")
    const result = await executeCursorImageSave({ image_id: stage(target) }, ctx) as any

    // The project folder lives under the host cache, outside the worktree, so
    // OpenCode's external-directory gate applies first — exactly as its own
    // `write` tool does before asking for `edit`.
    expect(calls.map((c) => c.permission)).toEqual(["external_directory", "edit"])
    expect(calls[0]!.patterns).toEqual([path.join(fs.realpathSync(path.dirname(target)), "*")])
    expect((calls[1]!.metadata as any).bytes).toBe(PNG.length)
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG)
    expect(result.output).toContain("logo.png")
  })

  it("returns no attachments, which would break the held-Run continuation", () => {
    // OpenCode extracts media from tool results into a separate user message
    // for every provider outside its @ai-sdk/* allowlist. That trailing user
    // message stops the next turn from looking like a tool continuation, so the
    // provider opens a fresh Run and Cursor never gets its write result.
    // Observed live before this was removed. Do not re-add attachments here.
    const source = fs.readFileSync(
      path.join(import.meta.dir, "..", "src", "image-save.ts"),
      "utf8",
    )
    expect(source).not.toMatch(/^\s*attachments:/m)
  })

  it("uses a workspace-relative pattern when the target is in the workspace", async () => {
    const { ctx, calls } = askRecorder()
    await executeCursorImageSave({ image_id: stage(path.join(workspace, "a", "logo.png")) }, ctx)
    // Inside the workspace: no external gate, and the edit pattern is relative.
    expect(calls.map((c) => c.permission)).toEqual(["edit"])
    expect(calls[0]!.patterns).toEqual([path.join("a", "logo.png")])
  })

  it("marks a denial so it can be reported as Cursor's permission_denied", async () => {
    const { ctx } = askRecorder(true)
    const target = path.join(projectDir, "assets", "logo.png")
    await expect(executeCursorImageSave({ image_id: stage(target) }, ctx))
      .rejects.toThrow(IMAGE_PERMISSION_DENIED_PREFIX)
    expect(fs.existsSync(target)).toBe(false)
  })

  it("creates the assets directory chain, which never exists on a first generation", async () => {
    const { ctx } = askRecorder()
    expect(fs.readdirSync(projectDir)).toHaveLength(0)
    const target = path.join(projectDir, "assets", "nested", "logo.png")
    await executeCursorImageSave({ image_id: stage(target) }, ctx)
    expect(fs.existsSync(target)).toBe(true)
  })

  it("creates no directories when the permission is refused", async () => {
    const { ctx } = askRecorder(true)
    const target = path.join(projectDir, "assets", "logo.png")
    await expect(executeCursorImageSave({ image_id: stage(target) }, ctx)).rejects.toThrow()
    expect(fs.existsSync(path.join(projectDir, "assets"))).toBe(false)
  })

  it("names the blocked directory when a path component is not a directory", async () => {
    const { ctx } = askRecorder()
    fs.writeFileSync(path.join(projectDir, "assets"), "not a directory")
    const target = path.join(projectDir, "assets", "logo.png")
    await expect(executeCursorImageSave({ image_id: stage(target) }, ctx))
      .rejects.toThrow(/writable directory/)
  })

  it("writes bytes verbatim, with no text transformation", async () => {
    const { ctx } = askRecorder()
    const raw = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const target = path.join(projectDir, "assets", "photo.jpg")
    await executeCursorImageSave({ image_id: stage(target, raw) }, ctx)
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(raw)
  })
})

// ── protocol ─────────────────────────────────────────────────────────────────

describe("generate image protocol", () => {
  it("decodes the approval query", () => {
    const payload = generateImagePayload({
      description: "A flat vector app icon",
      file_path: "assets/icon.png",
      reference_image_paths: ["refs/a.png"],
    })
    const bytes = decodeMessage<any>("AgentServerMessage", payload)
      .interaction_query.generate_image_request_query
    const decoded = decodeGenerateImageQuery(bytes)!
    expect(decoded.description).toBe("A flat vector app icon")
    expect(decoded.filePath).toBe("assets/icon.png")
    expect(decoded.referenceImagePaths).toEqual(["refs/a.png"])
    expect(decoded.toolCallId).toBe("tool_img")
  })

  it("maps mime from the target extension", () => {
    expect(imageMimeForPath("a.jpg")).toBe("image/jpeg")
    expect(imageMimeForPath("a.WEBP")).toBe("image/webp")
    expect(imageMimeForPath("a")).toBe("image/png")
  })

  it("round-trips Cursor's permission_denied write result", () => {
    const encoded = encodeMessage("AgentClientMessage", {
      exec_client_message: {
        id: 7,
        write_result: {
          permission_denied: {
            path: "/p/assets/a.png",
            directory: "/p/assets",
            operation: "write",
            error: "The user rejected this request",
            is_readonly: false,
          },
        },
      },
    })
    const decoded = decodeMessage<any>("AgentClientMessage", encoded)
    expect(decoded.exec_client_message.write_result.permission_denied.operation).toBe("write")
  })
})

// ── approval gating ──────────────────────────────────────────────────────────

describe("generate image approval", () => {
  const handle = (payload: Uint8Array, canSave: boolean) => {
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    return handleInteractionQuery(query, payload, { canSaveGeneratedImage: canSave })
  }

  it("approves and echoes the description when the image can be saved", () => {
    const handled = handle(generateImagePayload({ description: "An icon" }), true)
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.generate_image_request_response.approved.description).toBe("An icon")
  })

  it("rejects rather than spending quota when nothing can commit the result", () => {
    const handled = handle(generateImagePayload({ description: "An icon" }), false)
    expect(handled.outcome).toBe("rejected")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.generate_image_request_response.rejected.reason).toContain("cannot save")
  })

  it("uses Cursor CLI's own reason for an empty query", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_query: { id: 1, generate_image_request_query: new Uint8Array() },
    })
    const handled = handle(payload, true)
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.generate_image_request_response.rejected.reason)
      .toBe("Missing generate image arguments")
  })

  it("names the commit tool consistently with the plugin registration", () => {
    expect(CURSOR_IMAGE_SAVE_TOOL).toBe("cursor_image_save")
  })
})
