import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { persistConversation, resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import {
  planOperationsFor, recordPlanOperation, resetPlanOperationsForTests, restorePlanOperations, serializePlanOperations,
  type PlanOperationReceipt,
} from "../src/protocol/plan-operations.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { CURSOR_COMPACTION_OPTION } from "../src/shared.js"

afterEach(() => resetPlanOperationsForTests())

const receipt = (phase: "write" | "review" = "write"): PlanOperationReceipt => ({
  interactionId: 42, hostCallId: "cursor_plan-run_900000", planPath: "/workspace/plan.md",
  planUri: "file:///workspace/plan.md", markdown: "# Plan\n", phase,
  bridgeKind: "approve", afterWrite: "review", reviewToolName: "question",
})

describe("CreatePlan restart receipts", () => {
  it.each(["write", "review"] as const)("stops an orphaned %s continuation before opening another Run", async phase => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plan-restart-"))
    const previousCache = getHostCacheDirOverride()
    const key = `plan-restart-${phase}`
    resetPlanOperationsForTests()
    try {
      expect(recordPlanOperation(key, receipt(phase)).ok).toBe(true)
      await persistConversation(root, {
        sessionKey: key, conversationId: "plan-conversation", blobs: [], requestContext: { rules_info_complete: true },
        planOperations: serializePlanOperations(key),
      })
      // Read the on-disk receipt through the real doStream hydration path.
      resetConversationPersistenceForTests()
      resetConversationBindingsForTests()
      resetPlanOperationsForTests()
      resetTurnStateForTests()
      let credentials = 0
      const model = createCursor({ name: "cursor", cacheDir: root, getAccessToken: async () => {
        credentials++
        throw new Error("fresh turn reached credential resolver")
      } }).languageModel("gpt-5")
      const prompt: LanguageModelV3CallOptions["prompt"] = [
        { role: "user", content: [{ type: "text", text: "Make a plan." }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: receipt().hostCallId, toolName: "patch", input: { patchText: "saved plan" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: receipt().hostCallId, toolName: "patch", output: { type: "text", value: "Saved" } }] },
      ]
      const call: LanguageModelV3CallOptions = {
        prompt, headers: { "x-opencode-session-id": key },
        tools: [{ type: "function", name: "patch", inputSchema: { type: "object", properties: { patchText: { type: "string" } } } }],
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const { stream } = await model.doStream(call)
        const parts: LanguageModelV3StreamPart[] = []
        const reader = stream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(value)
        }
        expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
        expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
        expect(parts.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join("")).toContain("No implementation was approved")
      }
      expect(credentials).toBe(0)
      expect(planOperationsFor(key)).toHaveLength(1)
      const helperPrompt: typeof prompt = [...prompt,
        { role: "user", content: [{ type: "text", text: "Summarize the conversation." }] },
      ]
      for (const helper of [
        { ...call, prompt: helperPrompt, toolChoice: { type: "none" as const } },
        { ...call, prompt: helperPrompt, providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true } } },
      ]) {
        await expect(model.doStream(helper)).rejects.toThrow("Cursor Run setup failed")
        expect(planOperationsFor(key)).toHaveLength(1)
      }
      await expect(model.doStream({ ...call, prompt: [...prompt,
        { role: "user", content: [{ type: "text", text: "Continue planning." }] },
      ] })).rejects.toThrow("Cursor Run setup failed")
      expect(credentials).toBe(3)
      expect(planOperationsFor(key)).toHaveLength(0)
    } finally {
      setHostCacheDirOverride(previousCache)
      resetConversationPersistenceForTests()
      resetConversationBindingsForTests()
      resetTurnStateForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps active receipts when the global session budget is full", () => {
    resetPlanOperationsForTests()
    expect(Array.from({ length: 64 }, (_, i) => recordPlanOperation(`plan-${i}`, receipt()).ok)).toEqual(Array(64).fill(true))
    expect(recordPlanOperation("overflow", receipt()).ok).toBe(false)
    expect(planOperationsFor("plan-0")).toHaveLength(1)
    restorePlanOperations("restored-overflow", JSON.stringify({ version: 1, receipts: [receipt()] }))
    expect(planOperationsFor("restored-overflow")).toHaveLength(1)
  })

  it("enforces operation-count and byte budgets without losing existing receipts", async () => {
    resetPlanOperationsForTests()
    const { clearPlanOperation } = await import("../src/protocol/plan-operations.js")
    expect(Array.from({ length: 8 }, (_, i) => recordPlanOperation("count", { ...receipt(), hostCallId: `call-${i}` }).ok)).toEqual(Array(8).fill(true))
    expect(recordPlanOperation("count", receipt()).ok).toBe(false)
    clearPlanOperation("count", "call-0")
    expect(planOperationsFor("count")).toHaveLength(7)
    expect(recordPlanOperation("count", receipt()).ok).toBe(true)
    expect(recordPlanOperation("bytes", { ...receipt(), markdown: "x".repeat(512 * 1024 + 1) }).ok).toBe(false)
    expect(planOperationsFor("bytes")).toHaveLength(0)
    expect(recordPlanOperation(undefined, receipt()).ok).toBe(true)
  })

  it("rejects invalid restart receipts and preserves valid optional metadata", () => {
    resetPlanOperationsForTests()
    const invalid = ["{", "null", JSON.stringify({ version: 2, receipts: [] }),
      JSON.stringify({ version: 1, receipts: Array(9).fill(receipt()) }),
      JSON.stringify({ version: 1, receipts: [null] }),
      JSON.stringify({ version: 1, receipts: [{ ...receipt(), phase: "unknown" }] }),
      JSON.stringify({ version: 1, receipts: [{ ...receipt(), markdown: "x".repeat(512 * 1024 + 1) }] }),
    ]
    for (const encoded of invalid) {
      restorePlanOperations("invalid", encoded)
      expect(planOperationsFor("invalid")).toHaveLength(0)
    }
    const valid = { ...receipt(), createPlanToolCallId: "cursor-display", consumedResultId: "write-result" }
    restorePlanOperations("valid", JSON.stringify({ version: 1, receipts: [valid] }))
    expect(planOperationsFor("valid")).toEqual([valid])
    const { afterWrite: _after, reviewToolName: _tool, ...minimal } = receipt()
    restorePlanOperations("minimal", JSON.stringify({ version: 1, receipts: [{ ...minimal, afterWrite: "invalid", reviewToolName: "invalid" }] }))
    expect(planOperationsFor("minimal")).toEqual([minimal])
  })

  it("shares receipts across separately loaded module copies", async () => {
    resetPlanOperationsForTests()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-module-graph-"))
    try {
      fs.cpSync(path.join(import.meta.dir, "../src"), path.join(root, "src"), { recursive: true })
      fs.symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(root, "node_modules"), "dir")
      const copy: typeof import("../src/protocol/plan-operations.js") = await import(pathToFileURL(path.join(root, "src/protocol/plan-operations.ts")).href)
      expect(copy.recordPlanOperation).not.toBe(recordPlanOperation)
      expect(recordPlanOperation("shared-plan", receipt()).ok).toBe(true)
      expect(copy.planOperationsFor("shared-plan")).toHaveLength(1)
      copy.clearPlanOperations("shared-plan")
      expect(planOperationsFor("shared-plan")).toHaveLength(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
