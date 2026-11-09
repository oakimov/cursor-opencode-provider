import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildRequestContext } from "../src/context/build.js"
import { getOrBuildRequestContext, resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { decodeMessageSparse, encodeMessage } from "../src/protocol/messages.js"
import { buildRunRequest } from "../src/protocol/request.js"
import { readAllFields } from "../src/protocol/struct.js"
import { buildRequestContextResult } from "../src/protocol/tools.js"

type Context = { env: Record<string, unknown> }
type RunMessage = { run_request: { action: { user_message_action: { request_context: Context } } } }
type ExecMessage = { exec_client_message: { request_context_result: { success: { request_context: Context } } } }

function expectFolder(context: Record<string, unknown>, folder?: string): void {
  const run = decodeMessageSparse<RunMessage>("AgentClientMessage", buildRunRequest({
    text: "Hello",
    modelId: "test-model",
    conversationId: "transcripts-wire",
    requestContext: context,
  }))
  const envs = [
    ["context", context.env],
    ["run", run.run_request.action.user_message_action.request_context.env],
    ["exec", execFolderEnv(context)],
  ] as const
  // The folder is one fact. It has to agree on the context object and on both
  // wire copies, including RequestContextEnv field 12 (absent, not "").
  expect(envs.map(([label, env]) => {
    const record = env as Record<string, unknown>
    return {
      label,
      folder: Object.prototype.hasOwnProperty.call(record, "agent_transcripts_folder")
        ? record.agent_transcripts_folder
        : undefined,
      field12: readAllFields(encodeMessage("RequestContextEnv", record))
        .some(field => field.fn === 12),
    }
  })).toEqual(envs.map(([label]) => ({
    label,
    folder,
    field12: folder !== undefined,
  })))
}

function execFolderEnv(context: Record<string, unknown>): Record<string, unknown> {
  const exec = decodeMessageSparse<ExecMessage>("AgentClientMessage", buildRequestContextResult(1, context))
  return exec.exec_client_message.request_context_result.success.request_context.env
}

for (const [host, tools] of [
  ["OpenCode 1", [{ name: "read" }, { name: "bash" }, { name: "task" }]],
  ["OpenCode 2", [{ name: "read" }, { name: "shell" }, { name: "subagent" }]],
] as const) {
  describe(`${host} agent transcripts folder`, () => {
    let root: string
    let folder: string
    let previousFolder: string | undefined
    let previousCache: string | undefined
    const input = () => ({ workspaceRoot: root, tools: [...tools], mergedConfig: {} })

    beforeEach(() => {
      previousFolder = process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
      previousCache = getHostCacheDirOverride()
      delete process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
      root = mkdtempSync(path.join(tmpdir(), "cursor-transcripts-test-"))
      folder = path.join(root, "past chats")
      mkdirSync(folder)
      setHostCacheDirOverride(path.join(root, "cache"))
      resetFrozenRequestContextsForTests()
    })

    afterEach(() => {
      if (previousFolder === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
      else process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = previousFolder
      setHostCacheDirOverride(previousCache)
      resetFrozenRequestContextsForTests()
      rmSync(root, { recursive: true, force: true })
    })

    it("omits the folder when unset, even if the old default exists", async () => {
      const first = await buildRequestContext(input())
      mkdirSync(path.join((first.env as Record<string, string>).project_folder!, "agent-transcripts"))
      expectFolder(await buildRequestContext(input()))
    })

    for (const value of ["", "   "]) {
      it(`omits an ${value ? "all-whitespace" : "empty"} setting`, async () => {
        process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = value
        expectFolder(await buildRequestContext(input()))
      })
    }

    it("omits a missing directory without creating it", async () => {
      const missing = path.join(root, "missing")
      process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = missing
      expectFolder(await buildRequestContext(input()))
      expect(existsSync(missing)).toBe(false)
    })

    it("omits files and paths that cannot be statted", async () => {
      const file = path.join(root, "file")
      writeFileSync(file, "not a directory")
      for (const value of [file, path.join(file, "child")]) {
        process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = value
        expectFolder(await buildRequestContext(input()))
      }
    })

    it("sends an existing configured directory", async () => {
      process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = folder
      expectFolder(await buildRequestContext(input()), folder)
    })

    it("resolves relative settings against the workspace rather than the daemon cwd", async () => {
      process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = "past chats"
      expectFolder(await buildRequestContext(input()), folder)
    })

    it("accepts directory symlinks and omits broken symlinks", async () => {
      const link = path.join(root, "linked")
      symlinkSync(folder, link, "dir")
      process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = link
      expectFolder(await buildRequestContext(input()), link)
      rmSync(folder, { recursive: true })
      expectFolder(await buildRequestContext(input()))
    })

    it("keeps inclusion frozen; a new conversation rechecks the folder", async () => {
      process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = folder
      const first = await getOrBuildRequestContext("transcripts-present", input())
      expectFolder(first.context, folder)
      rmSync(folder, { recursive: true })
      delete process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
      const later = await getOrBuildRequestContext("transcripts-present", input())
      expect(later.context).toBe(first.context)
      expectFolder(later.context, folder)
      expectFolder((await getOrBuildRequestContext("transcripts-new-absent", input())).context)
    })

    it("keeps omission frozen; a new conversation reads the new setting", async () => {
      const first = await getOrBuildRequestContext("transcripts-absent", input())
      expectFolder(first.context)
      process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = folder
      const later = await getOrBuildRequestContext("transcripts-absent", input())
      expect(later.context).toBe(first.context)
      expectFolder(later.context)
      expectFolder((await getOrBuildRequestContext("transcripts-new-present", input())).context, folder)
    })
  })
}
