import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { pump, deliverContinuationResults, resetTurnStateForTests } from "../src/language-model.js"
import { encodeMessage, decodeMessageSparse } from "../src/protocol/messages.js"
import { hostToolDialectFromTools, toolsToDescriptors } from "../src/protocol/tools.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { buildEnv } from "../src/context/env.js"
import { getOrBuildRequestContext, resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { encodeJsonAsValue, readAllFields } from "../src/protocol/struct.js"
import { bindConversationId, resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { persistConversationState, hydrateConversationState } from "../src/protocol/conversation-state.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { sessionFixture } from "./session-fixture.js"
import { sessionManager, type Frame } from "../src/session.js"
import { prepareCursorShellArgs, cursorShellEnvForCall, captureCursorShellResult, captureCursorShellFailure, resetCursorShellCalls, setCursorShellPath } from "../src/shell-timeout.js"
import { stopProcessesUsing } from "./process-cleanup.js"

let root: string
let workspace: string
let oldCache: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-runtime-pump-"))
  workspace = path.join(root, "workspace")
  fs.mkdirSync(workspace)
  oldCache = getHostCacheDirOverride()
  setHostCacheDirOverride(path.join(root, "cache"))
  resetToolRequestsListedSeenForTests()
})
afterEach(async () => {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetFrozenRequestContextsForTests()
  resetConversationBindingsForTests()
  resetConversationPersistenceForTests()
  resetCursorShellCalls()
  resetToolRequestsListedSeenForTests()
  setHostCacheDirOverride(oldCache)
  // A managed terminal's supervisor can still write its job files.
  await stopProcessesUsing(root)
  fs.rmSync(root, { recursive: true, force: true })
})
const frame = (message: Record<string, unknown>): Frame => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) })
const ended = () => frame({ interaction_update: { turn_ended: {} } })
const spill = "12345678-1234-1234-1234-123456789abc.txt"

function fixture(host: 1 | 2, frames: Frame[]) {
  const shellName = host === 1 ? "bash" : "shell"
  const tools = [
    { name: shellName, inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read", inputSchema: { type: "object", properties: { [host === 1 ? "filePath" : "path"]: { type: "string" } } } },
    { name: "apply_patch", inputSchema: { type: "object", properties: { patchText: { type: "string" } } } },
  ]
  const iterator: AsyncIterator<Frame> = { next: async () => { const value = frames.shift(); return value ? { done: false, value } : { done: true, value: undefined } } }
  const writes: Uint8Array[] = []
  const session = sessionFixture({
    sessionId: `runtime-${host}`, conversationId: `runtime-conversation-${host}`,
    stream: { write(data) { writes.push(data) }, end() {}, destroy() {}, isClosed: () => false, onTerminal: () => () => {}, frames: () => ({ [Symbol.asyncIterator]: () => iterator }) },
    frames: iterator, pending: new Map(), displayToolCalls: new Map(), nextBridgedExecId: 900_000, blobs: new Map(),
    toolCatalog: tools, toolDescriptors: toolsToDescriptors(tools, "opencode"), hostToolDialect: hostToolDialectFromTools(tools),
    requestContext: { env: buildEnv(workspace) }, allowTools: true, pumpActive: false, heartbeat: null,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
  })
  const parts: LanguageModelV3StreamPart[] = []
  const controller = { desiredSize: 1, close() {}, enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error(error: unknown) { throw error } } as ReadableStreamDefaultController<LanguageModelV3StreamPart>
  return { session, writes, parts, controller, frames }
}
const ids = { textId: "text", reasoningId: "reasoning" }
const calls = (parts: LanguageModelV3StreamPart[]) => parts.filter(p => p.type === "tool-call")
const messages = (writes: Uint8Array[]) => writes.map(bytes => decodeMessageSparse<any>("AgentClientMessage", bytes))

for (const host of [1, 2] as const) describe(`OpenCode ${host} runtime pump`, () => {
  it("writes and reads spills without a host write/read call, even with only apply_patch", async () => {
    const f = fixture(host, [])
    const file = path.join((f.session.requestContext.env as Record<string, string>).project_folder!, "agent-tools", spill)
    f.frames.push(
      frame({ exec_server_message: { id: 1, write_args: { path: file, file_text: "catalog\n", tool_call_id: "spill-write" } } }),
      frame({ exec_server_message: { id: 2, read_args: { path: file, tool_call_id: "spill-read" } } }), ended(),
    )
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(0)
    const replies = messages(f.writes).map(m => m.exec_client_message).filter(Boolean)
    expect(replies.find(m => m.write_result)?.write_result.success.path).toBe(file)
    expect(replies.find(m => m.read_result)?.read_result.success.content).toBe("catalog\n")
  })

  it("keeps workspace mutations on the host permission path", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, write_args: { path: path.join(workspace, "file.txt"), file_text: "user content\n" } } })])
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(1)
    expect(calls(f.parts)[0]!.toolName).toBe("apply_patch")
    expect(fs.existsSync(path.join(workspace, "file.txt"))).toBe(false)
  })

  it("returns a typed refusal instead of changing an unterminated workspace write", async () => {
    const file = path.join(workspace, "file.txt")
    const f = fixture(host, [frame({ exec_server_message: { id: 1, write_args: {
      path: file, file_text: "user content",
    } } }), ended()])
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(0)
    expect(messages(f.writes)[0].exec_client_message.write_result.error.error).toContain("final newline")
    expect(fs.existsSync(file)).toBe(false)
  })

  it("serves dynamic canonical reads of metadata without host permission prompts", async () => {
    const f = fixture(host, [])
    const file = path.join((f.session.requestContext.env as Record<string, string>).project_folder!, "agent-tools", spill)
    fs.writeFileSync(file, "dynamic catalog")
    const struct = readAllFields(encodeJsonAsValue({ [host === 1 ? "filePath" : "path"]: file }))[0]!.bytes!
    f.frames.push(frame({ exec_server_message: { id: 1, mcp_args: {
      name: "opencode-read", args: readAllFields(struct).map(field => field.bytes!), tool_call_id: "dynamic-read",
    } } }), ended())
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(0)
    const read = messages(f.writes).find(m => m.exec_client_message?.mcp_result)?.exec_client_message.mcp_result
    expect(JSON.stringify(read)).toContain("dynamic catalog")
  })

  it("refuses internal mutations on lifecycle calls", async () => {
    const f = fixture(host, [])
    const file = path.join((f.session.requestContext.env as Record<string, string>).project_folder!, "agent-tools", spill)
    f.session.allowTools = false
    f.frames.push(frame({ exec_server_message: { id: 1, write_args: { path: file, file_text: "no" } } }), ended())
    await pump(f.session, f.controller, ids)
    expect(fs.existsSync(file)).toBe(false)
    expect(messages(f.writes)[0].exec_client_message.write_result.error).toBeDefined()
  })

  it("counts an internal spill alongside an authorized shell in one parallel step", async () => {
    const f = fixture(host, [])
    const file = path.join((f.session.requestContext.env as Record<string, string>).project_folder!, "agent-tools", spill)
    f.frames.push(
      frame({ interaction_update: { tool_requests_listed: { call_count: 2 } } }),
      frame({ exec_server_message: { id: 1, shell_stream_args: { command: "printf authorized", tool_call_id: "shell" } } }),
      frame({ exec_server_message: { id: 2, write_args: { path: file, file_text: "catalog", tool_call_id: "spill" } } }), ended(),
    )
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(1)
    expect(f.session.pending.size).toBe(1)
    expect(messages(f.writes).some(m => m.exec_client_message?.write_result?.success)).toBe(true)
  })

  it("uses the same managed terminal through host hooks, continuation and native polling", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "sleep 0.2; printf 'fin%s' ished", tool_call_id: "shell-bg" } } })])
    await pump(f.session, f.controller, ids)
    const call = calls(f.parts)[0]!
    const args = JSON.parse(call.input)
    const shell = Bun.which("bash") ?? "/bin/sh"
    setCursorShellPath(shell)
    prepareCursorShellArgs(call.toolCallId, args, { preferWrapperCommand: host === 2 })
    const env = host === 1 ? cursorShellEnvForCall(call.toolCallId) : undefined
    const proc = Bun.spawn([shell, "-c", args.command], { cwd: workspace, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
    const raw = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const clean = captureCursorShellResult(call.toolCallId, raw)
    await deliverContinuationResults(f.session, [{ toolCallId: call.toolCallId, sessionId: f.session.sessionId, execId: 1, toolName: call.toolName, output: clean }])
    const spawned = messages(f.writes).find(m => m.exec_client_message?.background_shell_spawn_result)?.exec_client_message.background_shell_spawn_result.success
    expect(spawned.shell_id).toBeGreaterThan(0)
    expect(spawned.working_directory).toBe(workspace)
    const envContext = f.session.requestContext.env as Record<string, string>
    const terminal = path.join(envContext.terminals_folder!, `${spawned.shell_id}.txt`)
    const end = Date.now() + 6000
    while (!fs.readFileSync(terminal, "utf8").includes("exit_code:") && Date.now() < end) await Bun.sleep(25)
    f.frames.push(frame({ exec_server_message: { id: 2, read_args: { path: terminal, tool_call_id: "await" } } }), ended())
    f.parts.length = 0
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(0)
    const read = messages(f.writes).find(m => m.exec_client_message?.read_result)?.exec_client_message.read_result.success
    expect(read.content).toContain("finished")
    expect(read.content).toContain("exit_code: 0")
  })

  it("keeps an unmanaged wrapper when the terminal job directory is not a directory", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "echo plain", tool_call_id: "plain-bg" } } })])
    const terminals = (f.session.requestContext.env as Record<string, string>).terminals_folder!
    fs.writeFileSync(path.join(terminals, ".jobs"), "not a directory")
    await pump(f.session, f.controller, ids)
    const call = calls(f.parts)[0]!
    expect(JSON.parse(call.input).command).not.toContain("cursor_job")
    expect(f.session.pending.get(1)?.resultMetadata?.managed_job_directory).toBeUndefined()
    expect(fs.readdirSync(terminals).filter(file => file.endsWith(".txt"))).toHaveLength(0)
  })

  it("removes a denied background spawn reservation when the host returns an error", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "touch denied", tool_call_id: "denied-bg" } } })])
    await pump(f.session, f.controller, ids)
    const call = calls(f.parts)[0]!
    const directory = f.session.pending.get(1)!.resultMetadata!.managed_job_directory as string
    expect(fs.existsSync(directory)).toBe(true)
    await deliverContinuationResults(f.session, [{ toolCallId: call.toolCallId, sessionId: f.session.sessionId, execId: 1, toolName: call.toolName, output: "Denied", error: "Denied" }])
    expect(fs.existsSync(directory)).toBe(false)
    const env = f.session.requestContext.env as Record<string, string>
    expect(fs.readdirSync(env.terminals_folder!).filter(file => file.endsWith(".txt"))).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, "denied"))).toBe(false)
  })

  it("reports a failed launch when the host SDK returns its error envelope as ordinary text", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "echo denied", tool_call_id: "failed-bg" } } })])
    await pump(f.session, f.controller, ids)
    const call = calls(f.parts)[0]!
    const directory = f.session.pending.get(1)!.resultMetadata!.managed_job_directory as string
    captureCursorShellFailure(call.toolCallId, new Error("Permission denied: shell"))
    await deliverContinuationResults(f.session, [{ toolCallId: call.toolCallId, sessionId: f.session.sessionId, execId: 1, toolName: call.toolName, output: '{"error":{"type":"permission.rejected","message":"Permission denied: shell"},"content":[]}' }])
    expect(fs.existsSync(directory)).toBe(false)
    const reply = messages(f.writes).find(m => m.exec_client_message?.background_shell_spawn_result)?.exec_client_message.background_shell_spawn_result
    expect(reply.error.error).toContain("Permission denied")
    expect(reply.success).toBeUndefined()
  })

  it("keeps RequestContext bytes stable as runtime contents change and hydrate", async () => {
    const input = { workspaceRoot: workspace, tools: [{ name: "read" }], mergedConfig: {} }
    const key = `runtime-freeze-${host}`
    const conversationId = bindConversationId(key).conversationId
    const first = await getOrBuildRequestContext(conversationId, input)
    const bytes = encodeMessage("RequestContext", first.context)
    const env = first.context.env as Record<string, string>
    fs.writeFileSync(path.join(env.project_folder!, "agent-tools", spill), "new metadata")
    fs.writeFileSync(path.join(env.terminals_folder!, "1234.txt"), "new terminal")
    const next = await getOrBuildRequestContext(conversationId, input)
    expect(next.context).toBe(first.context)
    expect(encodeMessage("RequestContext", next.context)).toEqual(bytes)
    await persistConversationState(path.join(root, "cache"), { sessionKey: key, conversationId, requestContext: next.context, toolCatalog: input.tools })
    resetFrozenRequestContextsForTests()
    resetConversationBindingsForTests()
    resetConversationPersistenceForTests()
    const hydrated = await hydrateConversationState(path.join(root, "cache"), key)
    expect(hydrated?.conversationId).toBe(conversationId)
    const restored = await getOrBuildRequestContext(conversationId, input)
    expect(encodeMessage("RequestContext", restored.context)).toEqual(bytes)
  })

  it("keeps the unmanaged background wrapper when this conversation advertised no terminal storage", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "sleep 1", tool_call_id: "legacy" } } })])
    delete (f.session.requestContext.env as Record<string, unknown>).terminals_folder
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(1)
    const args = JSON.parse(calls(f.parts)[0]!.input)
    expect(args.command).toContain("cursor_own_group \"$bg_log\" \"$cursor_payload_shell\" \"$@\" -c 'sleep 1'")
    expect(messages(f.writes).some(m => m.exec_client_message?.background_shell_spawn_result)).toBe(false)
  })

  it("keeps the unmanaged background wrappers on native Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    try {
      const f = fixture(host, [frame({ exec_server_message: { id: 1, shell_stream_args: { command: "npm test", timeout: 1000, timeout_behavior: 2, tool_call_id: "soft" } } })])
      await pump(f.session, f.controller, ids)
      expect(calls(f.parts)).toHaveLength(1)
      expect(JSON.parse(calls(f.parts)[0]!.input).command).toBe("npm test")
      expect(messages(f.writes).some(m => m.exec_client_message?.shell_stream)).toBe(false)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it("keeps a soft-background command's own text and runs it where the supervisor records", async () => {
    fs.mkdirSync(path.join(workspace, "pkg"))
    const f = fixture(host, [frame({ exec_server_message: { id: 1, shell_stream_args: { command: "npm test", working_directory: "pkg", timeout: 1000, timeout_behavior: 2, tool_call_id: "soft" } } })])
    await pump(f.session, f.controller, ids)
    const args = JSON.parse(calls(f.parts)[0]!.input)
    expect(args.command).toBe("npm test")
    expect(args.workdir).toBe(path.join(workspace, "pkg"))
  })

  it("shows a spawned command verbatim in the host command and resolves its directory", async () => {
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "npm run dev", tool_call_id: "spawn" } } })])
    await pump(f.session, f.controller, ids)
    const args = JSON.parse(calls(f.parts)[0]!.input)
    expect(args.command).toContain("\nnpm run dev\n")
    expect(args.workdir).toBe(workspace)
    // The launcher reports within its own startup deadline; a host that runs
    // the command as is keeps its default timeout instead of a short one.
    expect(args.timeout).toBeUndefined()
  })

  it("resolves an unmanaged background command's relative directory against the workspace", async () => {
    fs.mkdirSync(path.join(workspace, "pkg"))
    const f = fixture(host, [frame({ exec_server_message: { id: 1, background_shell_spawn_args: { command: "npm run dev", working_directory: "pkg", tool_call_id: "spawn" } } })])
    delete (f.session.requestContext.env as Record<string, unknown>).terminals_folder
    await pump(f.session, f.controller, ids)
    const args = JSON.parse(calls(f.parts)[0]!.input)
    expect(args.command).toContain("cursor-opencode-bg")
    expect(args.workdir).toBe(path.join(workspace, "pkg"))
  })

  it("leaves paths that only pass through a runtime folder to the host", async () => {
    const f = fixture(host, [])
    const terminals = (f.session.requestContext.env as Record<string, string>).terminals_folder!
    fs.writeFileSync(path.join(terminals, "..", "notes.md"), "host file")
    const struct = readAllFields(encodeJsonAsValue({ [host === 1 ? "filePath" : "path"]: `${terminals}/../notes.md` }))[0]!.bytes!
    f.frames.push(frame({ exec_server_message: { id: 1, mcp_args: {
      name: "opencode-read", args: readAllFields(struct).map(field => field.bytes!), tool_call_id: "escape-read",
    } } }))
    await pump(f.session, f.controller, ids)
    expect(calls(f.parts)).toHaveLength(1)
    expect(calls(f.parts)[0]!.toolName).toBe("read")
    expect(JSON.stringify(messages(f.writes))).not.toContain("runtime metadata")
  })

  it("does not answer a read of the runtime folder itself from the runtime store", async () => {
    const terminals = buildEnv(workspace).terminals_folder as string
    const struct = readAllFields(encodeJsonAsValue({ [host === 1 ? "filePath" : "path"]: terminals }))[0]!.bytes!
    const f = fixture(host, [frame({ exec_server_message: { id: 1, mcp_args: {
      name: "opencode-read", args: readAllFields(struct).map(field => field.bytes!), tool_call_id: "folder-read",
    } } }), ended()])
    await pump(f.session, f.controller, ids)
    expect(JSON.stringify(messages(f.writes))).not.toContain("Unrecognized runtime metadata path")
  })

  it("leaves an MCP background request to the host's own background job", async () => {
    const shellName = host === 1 ? "bash" : "shell"
    const struct = readAllFields(encodeJsonAsValue({ command: "npm run dev", background: true, timeout: 250 }))[0]!.bytes!
    const f = fixture(host, [frame({ exec_server_message: { id: 1, mcp_args: {
      name: `opencode-${shellName}`, args: readAllFields(struct).map(field => field.bytes!), tool_call_id: "mcp-bg",
    } } })])
    await pump(f.session, f.controller, ids)
    const args = JSON.parse(calls(f.parts)[0]!.input)
    expect(args).toMatchObject({ command: "npm run dev", background: true, timeout: 250 })
    const terminals = (f.session.requestContext.env as Record<string, string>).terminals_folder!
    expect(fs.readdirSync(terminals).filter(name => name.endsWith(".txt"))).toEqual([])
  })
})
