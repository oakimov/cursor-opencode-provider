import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isTerminalRecordRead, runtimeExecMessages, runtimeLayout, sweepRuntimeFiles, RUNTIME_FILE_TTL_MS, MAX_RUNTIME_READ_BYTES, MAX_RUNTIME_WRITE_BYTES, MAX_RUNTIME_SPILL_BYTES, MAX_RUNTIME_SPILL_FILES } from "../src/runtime-files.js"
import { decodeMessageSparse } from "../src/protocol/messages.js"

const name = "12345678-1234-1234-1234-123456789abc.txt"
let root: string
let ctx: Record<string, unknown>
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-runtime-test-"))
  runtimeLayout(root, true)
  ctx = { env: { project_folder: root } }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const result = (frames: Uint8Array[] | undefined, field: string) => decodeMessageSparse<any>("AgentClientMessage", frames![0]!).exec_client_message[field]

describe("provider-owned runtime files", () => {
  it("bounds total spill bytes even when concurrent writes use fresh filenames", async () => {
    const dir = path.join(root, "agent-tools")
    const filename = (index: number) => path.join(dir, `${String(index).padStart(8, "0")}-1234-1234-1234-123456789abc.txt`)
    for (let index = 0; index < 7; index++) {
      const fd = fs.openSync(filename(index), "w")
      fs.ftruncateSync(fd, 8 * 1024 * 1024)
      fs.closeSync(fd)
    }
    const content = "x".repeat(8 * 1024 * 1024)
    const replies = await Promise.all([7, 8].map(index => runtimeExecMessages({ id: index, write_args: { path: filename(index), file_text: content } }, ctx, true)))
    expect(replies.filter(frames => result(frames, "write_result").success)).toHaveLength(1)
    expect(replies.filter(frames => result(frames, "write_result").error)).toHaveLength(1)
    const total = fs.readdirSync(dir).reduce((sum, entry) => sum + fs.statSync(path.join(dir, entry)).size, 0)
    expect(total).toBe(MAX_RUNTIME_SPILL_BYTES)
    expect(result(await runtimeExecMessages({ id: 9, write_args: { path: filename(0), file_text: "reused" } }, ctx, true), "write_result").success).toBeDefined()
  })

  it("bounds the number of empty spills and permits replacing an existing path", async () => {
    const dir = path.join(root, "agent-tools")
    for (let index = 0; index < MAX_RUNTIME_SPILL_FILES; index++) {
      fs.writeFileSync(path.join(dir, `${String(index).padStart(8, "0")}-1234-1234-1234-123456789abc.txt`), "")
    }
    const file = path.join(dir, name)
    expect(result(await runtimeExecMessages({ id: 1, write_args: { path: file, file_text: "new" } }, ctx, true), "write_result").error).toBeDefined()
    expect(result(await runtimeExecMessages({ id: 2, write_args: { path: path.join(dir, "00000000-1234-1234-1234-123456789abc.txt"), file_text: "reused" } }, ctx, true), "write_result").success).toBeDefined()
  })

  it("intercepts equivalent casing only when the filesystem confirms the directory identity", async () => {
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, "captured")
    const requested = file.toUpperCase()
    const frames = await runtimeExecMessages({ id: 1, read_args: { path: requested } }, ctx, true)
    if (fs.existsSync(requested)) {
      expect(result(frames, "read_result").success.content).toBe("captured")
    } else expect(frames).toBeUndefined()
  })

  it("returns captured terminal output with a partial notice after a genuine storage failure", async () => {
    const layout = runtimeLayout(root)
    const id = "11111111-1111-1111-1111-111111111111"
    const job = path.join(layout.terminals, ".jobs", id)
    fs.mkdirSync(job, { recursive: true })
    fs.writeFileSync(path.join(layout.terminals, ".jobs", "1234.json"), JSON.stringify({ shellId: 1234, job: id }))
    fs.writeFileSync(path.join(job, "error"), "Terminal output storage failed")
    const file = path.join(layout.terminals, "1234.txt")
    fs.writeFileSync(file, "---\nstatus: aborted  \n---\ncaptured\n---\nexit_code: 1\n---\n")
    const read = result(await runtimeExecMessages({ id: 1, read_args: { path: file } }, ctx, true), "read_result").success
    expect(read.content).toContain("captured")
    expect(read.content).toContain("storage failed")
    expect(read.content).not.toContain("output was capped")
    expect(read.truncated).toBe(true)
  })

  it("does not follow a symlinked job directory when reading a terminal record", async () => {
    const layout = runtimeLayout(root)
    const id = "22222222-2222-2222-2222-222222222222"
    const elsewhere = fs.mkdtempSync(path.join(root, "elsewhere-"))
    fs.writeFileSync(path.join(elsewhere, "error"), "Terminal output storage failed")
    fs.mkdirSync(path.join(layout.terminals, ".jobs"), { recursive: true })
    fs.symlinkSync(elsewhere, path.join(layout.terminals, ".jobs", id))
    fs.writeFileSync(path.join(layout.terminals, ".jobs", "1234.json"), JSON.stringify({ shellId: 1234, job: id }))
    const file = path.join(layout.terminals, "1234.txt")
    fs.writeFileSync(file, "---\nstatus: aborted  \n---\ncaptured\n---\nexit_code: 1\n---\n")
    const read = result(await runtimeExecMessages({ id: 1, read_args: { path: file } }, ctx, true), "read_result")
    expect(read.error.error).toBe("Runtime directory is not a real directory")
  })

  it("cleans completed-job metadata promptly while retaining the terminal record", () => {
    const layout = runtimeLayout(root)
    const id = "11111111-1111-1111-1111-111111111111"
    const job = path.join(layout.terminals, ".jobs", id)
    fs.mkdirSync(job, { recursive: true })
    fs.writeFileSync(path.join(job, "owner.json"), JSON.stringify({ shellId: 1234 }))
    fs.writeFileSync(path.join(job, "done"), "0")
    fs.utimesSync(path.join(job, "done"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    fs.writeFileSync(path.join(layout.terminals, ".jobs", "1234.json"), JSON.stringify({ shellId: 1234, job: id }))
    const file = path.join(layout.terminals, "1234.txt")
    fs.writeFileSync(file, "completed")
    sweepRuntimeFiles(layout)
    expect(fs.existsSync(job)).toBe(false)
    expect(fs.existsSync(path.join(layout.terminals, ".jobs", "1234.json"))).toBe(false)
    expect(fs.readFileSync(file, "utf8")).toBe("completed")
  })

  it("retains the storage-failure notice after completed-job metadata is removed", async () => {
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, "---\nstatus: aborted  \n---\ncaptured\n---\nexit_code: 1\noutput_storage_failed: true\n---\n")
    const read = result(await runtimeExecMessages({ id: 1, read_args: { path: file } }, ctx, true), "read_result").success
    expect(read.content).toContain("captured")
    expect(read.content).toContain("storage failed")
    expect(read.content).not.toContain("output was capped")
    expect(read.truncated).toBe(true)
  })

  it("keeps storage failures and byte caps distinct, including paginated reads", async () => {
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, "---\nstatus: aborted  \n---\n" + "λ".repeat(MAX_RUNTIME_READ_BYTES) + "\n---\noutput_storage_failed: true\n---\n")
    const all = result(await runtimeExecMessages({ id: 1, read_args: { path: file } }, ctx, true), "read_result").success
    expect(all.content).toContain("output was capped")
    expect(all.content).toContain("storage failed")
    expect(Buffer.byteLength(all.content)).toBeLessThanOrEqual(MAX_RUNTIME_READ_BYTES)
    expect(all.content).not.toContain("�")
    const page = result(await runtimeExecMessages({ id: 2, read_args: { path: file, offset: 1, limit: 1 } }, ctx, true), "read_result").success
    expect(page.content).toContain("storage failed")
    expect(page.content).not.toContain("output was capped")
    expect(page.truncated).toBe(true)
  })

  it("does not treat a running command's error-shaped stdout as a storage failure", async () => {
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, "---\nstatus: running  \n---\noutput\noutput_storage_failed: true\n---\n")
    const read = result(await runtimeExecMessages({ id: 1, read_args: { path: file } }, ctx, true), "read_result").success
    expect(read.content).not.toContain("storage failed")
    expect(read.truncated).toBe(false)
  })

  it("creates private folders and writes byte-exact catalog spills with native replies", async () => {
    const file = path.join(root, "agent-tools", name)
    const content = "one\nλ two\n"
    const frames = await runtimeExecMessages({ id: 1, write_args: { path: file, file_bytes: Buffer.from(content), file_text: "wrong" } }, ctx, true)
    expect(result(frames, "write_result").success.path).toBe(file)
    expect(result(frames, "write_result").success.file_size).toBe(Buffer.byteLength(content))
    expect(fs.readFileSync(file, "utf8")).toBe(content)
    expect(decodeMessageSparse<any>("AgentClientMessage", frames![1]!).exec_client_control_message.stream_close.id).toBe(1)
    expect(fs.statSync(path.join(root, "agent-tools")).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it("serves paginated reads without treating ordinary pagination as truncation", async () => {
    const file = path.join(root, "agent-tools", name)
    fs.writeFileSync(file, "one\ntwo\nthree\n")
    const frames = await runtimeExecMessages({ id: 2, read_args: { path: file, offset: 2, limit: 1 } }, ctx, true)
    expect(result(frames, "read_result").success).toMatchObject({ content: "two", total_lines: 3, range_applied: true, truncated: false })
  })

  it.each(["", "\n"])("pages lines across read chunks as the whole text splits (ending %j)", async ending => {
    const file = path.join(root, "agent-tools", name)
    const lines = Array.from({ length: 3000 }, (_, i) => i % 7 === 0 ? "" : `${i} ${"λ".repeat(i % 50)}`)
    fs.writeFileSync(file, lines.join("\n") + ending)
    expect(fs.statSync(file).size).toBeGreaterThan(128 * 1024)
    for (const [offset, limit] of [[1, 1], [2, 5], [1000, 700], [2990, 50], [3000, 1], [3001, 1]] as const) {
      const read = result(await runtimeExecMessages({ id: 3, read_args: { path: file, offset, limit } }, ctx, true), "read_result").success
      expect(read).toMatchObject({ content: lines.slice(offset - 1, offset - 1 + limit).join("\n"), total_lines: 3000, truncated: false })
    }
  })

  it("caps a range only when its lines exceed the read budget", async () => {
    const file = path.join(root, "agent-tools", name)
    fs.writeFileSync(file, "a\n" + "x".repeat(MAX_RUNTIME_READ_BYTES) + "\n" + "λ".repeat(MAX_RUNTIME_READ_BYTES / 2) + "y\nb\n")
    const page = async (offset: number) => result(await runtimeExecMessages({ id: 4, read_args: { path: file, offset, limit: 1 } }, ctx, true), "read_result").success
    const fits = await page(2)
    expect(fits).toMatchObject({ total_lines: 4, truncated: false })
    expect(fits.content).toBe("x".repeat(MAX_RUNTIME_READ_BYTES))
    const over = await page(3)
    expect(over.truncated).toBe(true)
    expect(over.content).toEndWith("[Partial read: runtime output was capped. It is NOT the complete file.]\n")
    expect(over.content).not.toContain("�")
    expect(Buffer.byteLength(over.content)).toBeLessThanOrEqual(MAX_RUNTIME_READ_BYTES)
    const spans = result(await runtimeExecMessages({ id: 5, read_args: { path: file, offset: 2, limit: 2 } }, ctx, true), "read_result").success
    expect(spans.truncated).toBe(true)
    expect(spans.content).toEndWith("[Partial read: runtime output was capped. It is NOT the complete file.]\n")
  })

  it("leaves workspace files and image assets to host tools", async () => {
    for (const file of [path.join(root, "source.ts"), path.join(root, "assets", "image.png")]) {
      expect(await runtimeExecMessages({ id: 3, write_args: { path: file, file_text: "content" } }, ctx, true)).toBeUndefined()
      expect(fs.existsSync(file)).toBe(false)
    }
  })

  it("leaves the runtime folders, other names in them and escaping paths to host tools", async () => {
    for (const requested of [
      path.join(root, "agent-tools"),
      path.join(root, "terminals"),
      path.join(root, "agent-tools") + "/../outside",
      path.join(root, "terminals") + "/../assets/image.png",
      path.join(root, "agent-tools", "arbitrary.ts"),
      path.join(root, "terminals", ".jobs", "1234.json"),
      "terminals/1234.txt",
    ]) {
      expect(await runtimeExecMessages({ id: 4, read_args: { path: requested } }, ctx, true)).toBeUndefined()
      expect(await runtimeExecMessages({ id: 4, write_args: { path: requested, file_text: "host" } }, ctx, true)).toBeUndefined()
    }
    expect(fs.existsSync(path.join(root, "agent-tools", "arbitrary.ts"))).toBe(false)
  })

  it("rejects binary spills and terminal-record or lifecycle writes", async () => {
    const file = path.join(root, "agent-tools", name)
    for (const args of [
      { path: file, file_bytes: Uint8Array.of(0xff, 0, 0xff) },
      { path: path.join(root, "terminals", "1234.txt"), file_text: "fake terminal" },
    ]) expect(result(await runtimeExecMessages({ id: 4, write_args: args }, ctx, true), "write_result").error).toBeDefined()
    expect(result(await runtimeExecMessages({ id: 5, write_args: { path: file, file_text: "bad" } }, ctx, false), "write_result").error).toBeDefined()
    expect(fs.existsSync(file)).toBe(false)
  })

  it("rejects directory symlinks, file symlinks and hard links", async () => {
    const outside = path.join(root, "outside")
    fs.writeFileSync(outside, "private")
    const file = path.join(root, "agent-tools", name)
    fs.symlinkSync(outside, file)
    expect(result(await runtimeExecMessages({ id: 6, read_args: { path: file } }, ctx, true), "read_result").error).toBeDefined()
    expect(result(await runtimeExecMessages({ id: 7, write_args: { path: file, file_text: "bad" } }, ctx, true), "write_result").error).toBeDefined()
    fs.unlinkSync(file)
    fs.linkSync(outside, file)
    expect(result(await runtimeExecMessages({ id: 8, read_args: { path: file } }, ctx, true), "read_result").error).toBeDefined()
    fs.rmSync(path.join(root, "agent-tools"), { recursive: true })
    fs.symlinkSync(root, path.join(root, "agent-tools"), "dir")
    expect(result(await runtimeExecMessages({ id: 9, write_args: { path: file, file_text: "bad" } }, ctx, true), "write_result").error).toBeDefined()
    expect(fs.readFileSync(outside, "utf8")).toBe("private")
  })

  it("tells a terminal record read, which history needs no result for, from every other runtime exec", () => {
    const terminal = path.join(root, "terminals", "1234.txt")
    expect(isTerminalRecordRead({ id: 1, read_args: { path: terminal } }, ctx)).toBe(true)
    expect(isTerminalRecordRead({ id: 2, write_args: { path: terminal } }, ctx)).toBe(false)
    expect(isTerminalRecordRead({ id: 3, read_args: { path: path.join(root, "agent-tools", name) } }, ctx)).toBe(false)
    expect(isTerminalRecordRead({ id: 4, read_args: { path: path.join(root, "terminals", "notes.txt") } }, ctx)).toBe(false)
    expect(isTerminalRecordRead({ id: 5, read_args: { path: path.join(root, "src.txt") } }, ctx)).toBe(false)
    expect(isTerminalRecordRead({ id: 6, read_args: { path: terminal } }, { env: {} })).toBe(false)
  })

  it("returns missing metadata locally without a host permission call", async () => {
    const frames = await runtimeExecMessages({ id: 10, read_args: { path: path.join(root, "terminals", "1234.txt") } }, ctx, true)
    expect(result(frames, "read_result").file_not_found).toBeDefined()
  })

  it("caps reads while retaining a terminal footer and explicit partial notice", async () => {
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, "---\nstatus: succeeded\n---\n" + "x".repeat(MAX_RUNTIME_READ_BYTES + 4096) + "\n---\nexit_code: 7\n---\n")
    const read = result(await runtimeExecMessages({ id: 11, read_args: { path: file } }, ctx, true), "read_result").success
    expect(read.truncated).toBe(true)
    expect(read.content).toContain("exit_code: 7")
    expect(read.content).toContain("[Partial read:")
    expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(MAX_RUNTIME_READ_BYTES)
  })

  it("retains exit_code when output beyond the storage cap pushes the footer past the scanned prefix", async () => {
    const file = path.join(root, "terminals", "5678.txt")
    const header = "---\nstatus: succeeded\ncommand: " + "c".repeat(128 * 1024) + "\n---\n"
    const body = "y".repeat(MAX_RUNTIME_WRITE_BYTES + 128 * 1024)
    const footer = "\n---\nexit_code: 9\nended_at: 2026-10-13T00:00:00Z\n---\n"
    fs.writeFileSync(file, header + body + footer)
    const read = result(await runtimeExecMessages({ id: 16, read_args: { path: file } }, ctx, true), "read_result").success
    expect(read.truncated).toBe(true)
    expect(read.content).toContain("exit_code: 9")
    expect(read.content).toContain("[Partial read:")
    expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(MAX_RUNTIME_READ_BYTES)
  })

  it("pages through all retained output after a command longer than the scan's header allowance", async () => {
    const file = path.join(root, "terminals", "5679.txt")
    const header = "---\nstatus: succeeded\ncommand: " + "c".repeat(128 * 1024) + "\n---\n"
    const line = "z".repeat(1023) + "\n"
    const last = "last output line".padEnd(1023, ".")
    // Output exactly at the storage cap.
    const body = line.repeat(MAX_RUNTIME_WRITE_BYTES / line.length - 1) + last + "\n"
    const footer = "---\nexit_code: 0\nended_at: 2026-10-13T00:00:00Z\n---\n"
    fs.writeFileSync(file, header + body + footer)
    const total = (header + body + footer).split("\n").length - 1
    const read = result(await runtimeExecMessages({ id: 17, read_args: { path: file, offset: total - 4, limit: 5 } }, ctx, true), "read_result").success
    expect(read).toMatchObject({ total_lines: total, truncated: false, range_applied: true })
    expect(read.content).toBe(last + "\n---\nexit_code: 0\nended_at: 2026-10-13T00:00:00Z\n---")
  })

  it("includes the partial notice within the read budget without splitting UTF-8", async () => {
    const file = path.join(root, "agent-tools", name)
    fs.writeFileSync(file, "λ".repeat(MAX_RUNTIME_READ_BYTES))
    const read = result(await runtimeExecMessages({ id: 15, read_args: { path: file } }, ctx, true), "read_result").success
    expect(read.truncated).toBe(true)
    expect(read.content).toContain("[Partial read:")
    expect(read.content).not.toContain("�")
    expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(MAX_RUNTIME_READ_BYTES)
  })

  it("sweeps every record untouched for the TTL, retaining refreshed records and unrelated files", () => {
    const layout = runtimeLayout(root)
    const stale = [
      path.join(layout.agentTools, name),
      path.join(layout.terminals, "1234.txt"),
      // A supervisor lost to a crash or reboot never finalizes its record.
      path.join(layout.terminals, "3456.txt"),
      // A reservation whose command never ran.
      path.join(layout.terminals, "4567.txt"),
    ]
    fs.writeFileSync(stale[0]!, "catalog")
    fs.writeFileSync(stale[1]!, "---\nstatus: succeeded\n---\n")
    fs.writeFileSync(stale[2]!, "---\nstatus: running  \n---\n")
    fs.writeFileSync(stale[3]!, "")
    const active = path.join(layout.terminals, "2345.txt")
    fs.writeFileSync(active, "---\nstatus: running  \n---\n")
    const unrelated = path.join(layout.agentTools, "keep")
    fs.writeFileSync(unrelated, "keep")
    const now = Date.now()
    for (const file of [...stale, unrelated]) fs.utimesSync(file, new Date(0), new Date(0))
    sweepRuntimeFiles(layout, now + RUNTIME_FILE_TTL_MS - 60_000)
    for (const file of stale) expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(active)).toBe(true)
    expect(fs.existsSync(unrelated)).toBe(true)
  })

  it("keeps sweeping past many young entries", () => {
    const layout = runtimeLayout(root)
    for (let id = 1000; id < 1200; id++) fs.writeFileSync(path.join(layout.terminals, `${id}.txt`), "")
    const old = Array.from({ length: 80 }, (_, index) => path.join(layout.terminals, `${5000 + index}.txt`))
    for (const file of old) {
      fs.writeFileSync(file, "")
      fs.utimesSync(file, new Date(0), new Date(0))
    }
    const now = Date.now()
    sweepRuntimeFiles(layout, now)
    sweepRuntimeFiles(layout, now)
    for (const file of old) expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(layout.terminals).filter(file => file.endsWith(".txt"))).toHaveLength(200)
  })

  it("removes abandoned jobs and their indexes, retaining jobs whose record is refreshed", () => {
    const layout = runtimeLayout(root)
    const jobs = path.join(layout.terminals, ".jobs")
    fs.mkdirSync(jobs)
    const job = (id: string, shellId: number) => {
      fs.mkdirSync(path.join(jobs, id))
      fs.writeFileSync(path.join(jobs, id, "owner.json"), JSON.stringify({ shellId }))
      fs.writeFileSync(path.join(jobs, `${shellId}.json`), JSON.stringify({ shellId, job: id }))
      fs.writeFileSync(path.join(layout.terminals, `${shellId}.txt`), "---\nstatus: running  \n---\n")
    }
    const abandoned = "11111111-1111-1111-1111-111111111111"
    const live = "22222222-2222-2222-2222-222222222222"
    job(abandoned, 1111)
    job(live, 2222)
    fs.writeFileSync(path.join(jobs, "3333.json"), JSON.stringify({ shellId: 3333, job: "33333333-3333-3333-3333-333333333333" }))
    for (const file of [path.join(jobs, abandoned), path.join(jobs, "1111.json"), path.join(layout.terminals, "1111.txt"), path.join(jobs, live), path.join(jobs, "3333.json")]) {
      fs.utimesSync(file, new Date(0), new Date(0))
    }
    sweepRuntimeFiles(layout)
    expect(fs.existsSync(path.join(jobs, abandoned))).toBe(false)
    expect(fs.existsSync(path.join(jobs, "1111.json"))).toBe(false)
    expect(fs.existsSync(path.join(jobs, "3333.json"))).toBe(false)
    expect(fs.existsSync(path.join(jobs, live))).toBe(true)
    expect(fs.existsSync(path.join(jobs, "2222.json"))).toBe(true)
  })

  it("finalizes a quiet running record whose supervisor no longer exists", async () => {
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"])
    await exited.exited
    const record = (pid: number) => `---\npid: ${pid}\ncwd: "/w"\ncommand: "serve"\nstatus: running  \nstarted_at: 2026-01-01T00:00:00Z\nrunning_for_ms: 1000           \n---\nlistening\n`
    const lost = path.join(root, "terminals", "1234.txt")
    const live = path.join(root, "terminals", "2345.txt")
    fs.writeFileSync(lost, record(exited.pid))
    fs.writeFileSync(live, record(process.pid))
    for (const file of [lost, live]) fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const lostRead = result(await runtimeExecMessages({ id: 12, read_args: { path: lost } }, ctx, true), "read_result").success
    expect(lostRead.content).toContain("status: aborted  \n")
    expect(lostRead.content).toContain("listening\n")
    expect(lostRead.content).toContain("exit_code: unknown")
    const liveRead = result(await runtimeExecMessages({ id: 13, read_args: { path: live } }, ctx, true), "read_result").success
    expect(liveRead.content).toContain("status: running  \n")
    expect(liveRead.content).not.toContain("exit_code:")
  })

  // The command precedes status in the header and has no length limit.
  it.each([
    ["is far longer than one read", () => 100_000],
    ["ends the header across the first read's boundary", (delimiter: number) => 64 * 1024 - 2 - delimiter],
  ])("finalizes a lost record whose command %s", async (_name, commandLength) => {
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"])
    await exited.exited
    const record = (command: string) => `---\npid: ${exited.pid}\ncwd: "/w"\ncommand: "${command}"\nstatus: running  \nstarted_at: 2026-01-01T00:00:00Z\nrunning_for_ms: 1000           \n---\nlistening\n`
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, record("x".repeat(commandLength(record("").indexOf("\n---\n", 3)))))
    fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    expect(result(await runtimeExecMessages({ id: 14, read_args: { path: file } }, ctx, true), "read_result").success).toBeDefined()
    const finalized = fs.readFileSync(file, "latin1")
    expect(finalized).toContain("\nstatus: aborted  \n")
    expect(finalized).toMatch(/\n---\nexit_code: unknown\nended_at: \S+Z\n---\n$/)
  })

  it("rejects a read when the runtime directory is replaced mid-read", async () => {
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, "---\nstatus: running  \n---\nbody\n")
    const filesystem = fs as { lstatSync: typeof fs.lstatSync }
    const lstatSync = fs.lstatSync
    const parent = path.dirname(file)
    // The read stats its directory, then the file, then the directory again.
    // Directory stats before that pair depend on case-sensitive lookup and on
    // whether this call also sweeps.
    let phase = 0
    filesystem.lstatSync = ((target: fs.PathLike) => {
      const stat = lstatSync(target)
      const key = String(target)
      if (key === parent && phase === 2) return { isDirectory: () => false, isSymbolicLink: () => false, ino: stat.ino, dev: stat.dev } as fs.Stats
      if (key === parent) phase = 1
      else if (key === file && phase === 1) phase = 2
      else if (key !== file) phase = 0
      return stat
    }) as typeof fs.lstatSync
    try {
      expect(result(await runtimeExecMessages({ id: 20, read_args: { path: file } }, ctx, true), "read_result").error.error).toContain("changed during read")
    } finally { filesystem.lstatSync = lstatSync }
  })

  it("records a lost-terminal check that cannot patch the header", async () => {
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"])
    await exited.exited
    const file = path.join(root, "terminals", "1234.txt")
    fs.writeFileSync(file, `---\npid: ${exited.pid}\nstatus: running  \n---\nbody\n`)
    fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const writeSync = fs.writeSync
    fs.writeSync = ((fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (typeof data === "string" && data.includes("aborted")) throw new Error("header patch failed")
      return (writeSync as (fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => number)(fd, data, ...rest)
    }) as typeof fs.writeSync
    try {
      const read = result(await runtimeExecMessages({ id: 21, read_args: { path: file } }, ctx, true), "read_result").success
      expect(read.content).toContain("status: running")
    } finally { fs.writeSync = writeSync }
  })

  it("replaces a stale spill lock, refuses a live or unsafe one, and notices a lock that changes", async () => {
    const file = path.join(root, "agent-tools", name)
    const lock = path.join(root, "agent-tools", ".write-lock")
    fs.writeFileSync(lock, "2147483646")
    fs.utimesSync(lock, new Date(0), new Date(0))
    expect(result(await runtimeExecMessages({ id: 22, write_args: { path: file, file_text: "after stale" } }, ctx, true), "write_result").success.file_size).toBeGreaterThan(0)
    expect(fs.existsSync(lock)).toBe(false)

    fs.writeFileSync(lock, String(process.pid))
    expect(result(await runtimeExecMessages({ id: 23, write_args: { path: file, file_text: "busy" } }, ctx, true), "write_result").error.error).toContain("busy")
    fs.rmSync(lock, { force: true })

    fs.mkdirSync(lock)
    expect(result(await runtimeExecMessages({ id: 24, write_args: { path: file, file_text: "unsafe" } }, ctx, true), "write_result").error.error).toContain("Unsafe")
    fs.rmSync(lock, { recursive: true, force: true })

    fs.writeFileSync(lock, "2147483646")
    fs.utimesSync(lock, new Date(0), new Date(0))
    const filesystem = fs as { lstatSync: typeof fs.lstatSync }
    const lstatSync = fs.lstatSync
    let lockStats = 0
    filesystem.lstatSync = ((target: fs.PathLike) => {
      const stat = lstatSync(target)
      if (String(target) !== lock) return stat
      lockStats++
      if (lockStats === 2) return new Proxy(stat, { get: (inner, prop) => prop === "ino" ? inner.ino + 1 : Reflect.get(inner, prop, inner) })
      return stat
    }) as typeof fs.lstatSync
    try {
      expect(result(await runtimeExecMessages({ id: 25, write_args: { path: file, file_text: "changed" } }, ctx, true), "write_result").error.error).toContain("changed")
    } finally { filesystem.lstatSync = lstatSync }
  })

  it("rethrows a lock failure after the lock file was created", async () => {
    const file = path.join(root, "agent-tools", name)
    const writeSync = fs.writeSync
    fs.writeSync = ((fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (typeof data === "string" && data === String(process.pid)) throw new Error("lock write failed")
      return (writeSync as (fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => number)(fd, data, ...rest)
    }) as typeof fs.writeSync
    try {
      expect(result(await runtimeExecMessages({ id: 26, write_args: { path: file, file_text: "no" } }, ctx, true), "write_result").error.error).toContain("lock write failed")
    } finally { fs.writeSync = writeSync }
  })

  it("refuses a spill lock that cannot be created", async () => {
    const file = path.join(root, "agent-tools", name)
    const openSync = fs.openSync
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith(".write-lock")) {
        const error = new Error("denied") as NodeJS.ErrnoException
        error.code = "EACCES"
        throw error
      }
      return openSync(...args)
    }) as typeof fs.openSync
    try {
      expect(result(await runtimeExecMessages({ id: 27, write_args: { path: file, file_text: "no" } }, ctx, true), "write_result").error.error).toContain("denied")
    } finally { fs.openSync = openSync }
  })

  it("deletes an abandoned spill temporary while writing", async () => {
    const abandoned = path.join(root, "agent-tools", ".spill-12345678-1234-1234-1234-123456789abc")
    fs.writeFileSync(abandoned, "partial")
    const file = path.join(root, "agent-tools", name)
    expect(result(await runtimeExecMessages({ id: 28, write_args: { path: file, file_text: "kept" } }, ctx, true), "write_result").success).toBeDefined()
    expect(fs.existsSync(abandoned)).toBe(false)
    expect(fs.readFileSync(file, "utf8")).toBe("kept")
  })

  it("accepts catalog spills supplied as base64 text", async () => {
    const file = path.join(root, "agent-tools", name)
    const frames = await runtimeExecMessages({ id: 29, write_args: { path: file, file_bytes: Buffer.from("hello").toString("base64") } }, ctx, true)
    expect(result(frames, "write_result").success.file_size).toBe(5)
    expect(fs.readFileSync(file, "utf8")).toBe("hello")
  })

  it("recreates runtime folders removed after the conversation was built", async () => {
    fs.rmSync(root, { recursive: true, force: true })
    const file = path.join(root, "agent-tools", name)
    const frames = await runtimeExecMessages({ id: 14, write_args: { path: file, file_text: "catalog" } }, ctx, true)
    expect(result(frames, "write_result").success.path).toBe(file)
    expect(fs.readFileSync(file, "utf8")).toBe("catalog")
  })
})
