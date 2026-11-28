import { beforeEach, describe, it, expect } from "bun:test"
import {
  computeAllowTools,
  MAX_TURN_STATE_SESSIONS,
  resetTurnStateForTests,
  restoreTurnToolCatalog,
  resolveTurnConversationReset,
  resolveTurnToolState,
  shouldDropLifecycleToollessText,
} from "../src/language-model.js"
import {
  bindConversationId,
  resetConversationBindingsForTests,
} from "../src/protocol/conversation-bind.js"
import { buildExecClientMessages } from "../src/protocol/tools.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("computeAllowTools", () => {
  it("is false when OpenCode advertises no tools (compaction/summary)", () => {
    expect(computeAllowTools(0, undefined)).toBe(false)
    expect(computeAllowTools(0, { type: "auto" })).toBe(false)
  })

  it("is false when toolChoice is none", () => {
    expect(computeAllowTools(3, { type: "none" })).toBe(false)
  })

  it("is true when tools are present and toolChoice allows them", () => {
    expect(computeAllowTools(1, undefined)).toBe(true)
    expect(computeAllowTools(2, { type: "auto" })).toBe(true)
    expect(computeAllowTools(1, { type: "required" })).toBe(true)
  })
})

describe("compaction tool catalog", () => {
  beforeEach(() => {
    resetTurnStateForTests()
    resetConversationBindingsForTests()
  })

  it("advertises empty tools on host-empty compaction but refuses execution", async () => {
    // OpenCode 1.x compaction/summary streams tools: {}. OpenCode 2.0
    // compaction still sends a nonempty catalog (covered by epoch merge).
    const tools = [{ name: "bash" }, { name: "grep" }]
    expect(await resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: tools,
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: true })

    expect(await resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("keeps OpenCode 2.0 compaction's nonempty catalog while refusing execution", async () => {
    const tools = [{ name: "bash" }, { name: "grep" }]
    expect(await resolveTurnToolState({
      sessionKey: "ses_oc2_compaction",
      incomingTools: tools,
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: true })

    expect(await resolveTurnToolState({
      sessionKey: "ses_oc2_compaction",
      incomingTools: tools,
      isCompaction: true,
    })).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("preserves a literal no-tool call when no session key can correlate a sibling", async () => {
    expect(await resolveTurnToolState({
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("advertises empty tools on host-empty lifecycle turns (title / OC1 compaction)", async () => {
    // OpenCode title (1.x and 2.0) and OC1 compaction send tools={}. Putting
    // the sticky catalog on that ephemeral conversation_id tempts Cursor to
    // call tools; advertise [] and keep execution refused.
    const tools = [{ name: "read", inputSchema: { type: "object" } }]
    restoreTurnToolCatalog("ses_restored_catalog", tools)

    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("completes a cold-start lifecycle turn without waiting for a sibling", async () => {
    const tools = [{ name: "bash" }, { name: "read" }]
    const sessionKey = "ses_cold_start"
    let settled = false

    const lifecycle = resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: false,
    }).then((state) => {
      settled = true
      return state
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toBe(true)

    await resolveTurnToolState({
      sessionKey,
      incomingTools: tools,
      isCompaction: false,
    })

    expect(await lifecycle).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("rejects a request that was already cancelled", async () => {
    const abort = new AbortController()
    abort.abort()
    const lifecycle = resolveTurnToolState({
      sessionKey: "ses_cancelled",
      incomingTools: [],
      isCompaction: false,
      abortSignal: abort.signal,
    })

    await expect(lifecycle).rejects.toThrow("tool-catalog wait cancelled")
  })

  it("advertises every enabled tool in a fixed name order", async () => {
    expect(await resolveTurnToolState({
      sessionKey: "ses_order",
      incomingTools: [{ name: "write" }, { name: "bash" }, { name: "read" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "bash" }, { name: "read" }, { name: "write" }],
      allowTools: true,
    })
  })

  it("keeps epoch catalog when host shrinks tools (plan denies edit)", async () => {
    const full = [{ name: "bash" }, { name: "read" }, { name: "write" }]
    const planRestricted = [{ name: "read" }]
    await resolveTurnToolState({ sessionKey: "ses_restricted", incomingTools: full, isCompaction: false })

    // OpenCode plan filters edit tools out of the request catalog. Advertising
    // that shrink to Cursor would retokenize RequestContext — keep the epoch
    // catalog; allowTools still follows the current turn.
    expect(await resolveTurnToolState({
      sessionKey: "ses_restricted",
      incomingTools: planRestricted,
      isCompaction: false,
    })).toEqual({ advertisedTools: full, allowTools: true })
  })

  it("grows the epoch catalog when new tool names appear", async () => {
    await resolveTurnToolState({
      sessionKey: "ses_grow",
      incomingTools: [{ name: "read" }],
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_grow",
      incomingTools: [{ name: "bash" }, { name: "read" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "read" }, { name: "bash" }],
      allowTools: true,
    })
  })

  it("appends multiple new names in UTF-16 order at the tail", async () => {
    await resolveTurnToolState({
      sessionKey: "ses_append_batch",
      incomingTools: [{ name: "write" }],
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_append_batch",
      incomingTools: [{ name: "write" }, { name: "read" }, { name: "bash" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "write" }, { name: "bash" }, { name: "read" }],
      allowTools: true,
    })
  })

  it("holds first-catalog order when the host reshuffles the same names", async () => {
    const first = await resolveTurnToolState({
      sessionKey: "ses_reshuffle",
      incomingTools: [{ name: "write" }, { name: "bash" }, { name: "read" }],
      isCompaction: false,
    })
    expect(first.advertisedTools.map((tool) => tool.name)).toEqual(["bash", "read", "write"])
    expect(await resolveTurnToolState({
      sessionKey: "ses_reshuffle",
      incomingTools: [{ name: "read" }, { name: "write" }, { name: "bash" }],
      isCompaction: false,
    })).toEqual(first)
  })

  it("keeps frozen descriptors when the name set is unchanged", async () => {
    const original = [{ name: "read", description: "v1", inputSchema: { type: "object" } }]
    await resolveTurnToolState({
      sessionKey: "ses_same_names",
      incomingTools: original,
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_same_names",
      incomingTools: [{ name: "read", description: "v2", inputSchema: { type: "string" } }],
      isCompaction: false,
    })).toEqual({ advertisedTools: original, allowTools: true })
  })

  it("merges new names without rewriting existing descriptors", async () => {
    const original = [{ name: "read", description: "v1" }]
    await resolveTurnToolState({
      sessionKey: "ses_grow_hold",
      incomingTools: original,
      isCompaction: false,
    })
    expect(await resolveTurnToolState({
      sessionKey: "ses_grow_hold",
      incomingTools: [{ name: "bash", description: "shell" }, { name: "read", description: "v2" }],
      isCompaction: false,
    })).toEqual({
      advertisedTools: [{ name: "read", description: "v1" }, { name: "bash", description: "shell" }],
      allowTools: true,
    })
  })

  it("a history-import turn remints once, refuses execution, and the next turn keeps its conversation", async () => {
    const sessionKey = "ses_transition"
    const tools = [{ name: "bash" }, { name: "grep" }]

    await resolveTurnToolState({ sessionKey, incomingTools: tools, isCompaction: false })
    const beforeImport = bindConversationId(sessionKey).conversationId

    const importReset = resolveTurnConversationReset({ sessionKey, historyImport: true })
    const imported = await resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: true,
    })
    const afterImport = bindConversationId(sessionKey, importReset).conversationId
    expect(afterImport).not.toBe(beforeImport)
    expect(importReset).toEqual({ reset: true, reason: "history-import" })
    expect(imported).toEqual({ advertisedTools: [], allowTools: false })

    // Native compaction summarizes that conversation in place: no rebase follows.
    const next = resolveTurnConversationReset({ sessionKey })
    const resumed = await resolveTurnToolState({ sessionKey, incomingTools: tools, isCompaction: false })
    expect(next).toEqual({ reset: false })
    expect(bindConversationId(sessionKey, next).conversationId).toBe(afterImport)
    expect(resumed).toEqual({ advertisedTools: tools, allowTools: true })
  })

  it("does not reset ordinary no-tool turns", () => {
    expect(resolveTurnConversationReset({ sessionKey: "ses_no_tools" }))
      .toEqual({ reset: false })
  })

  it("rebases once when the host rewrites history without a model compaction turn", () => {
    const sessionKey = "ses_local_rewrite"
    const before = bindConversationId(sessionKey).conversationId
    const reset = resolveTurnConversationReset({ sessionKey, historyRewrite: true })
    expect(reset).toEqual({ reset: true, reason: "history-rewrite" })
    const after = bindConversationId(sessionKey, reset).conversationId
    expect(after).not.toBe(before)
    expect(resolveTurnConversationReset({ sessionKey }))
      .toEqual({ reset: false })
  })

  it("keeps sticky conversation across host agent or system prompt hash changes", () => {
    const sessionKey = "ses_prompt_identity"
    expect(resolveTurnConversationReset({
      sessionKey,
      promptIdentity: { hostAgent: "build", systemPromptHash: "prompt-a" },
    })).toEqual({ reset: false })
    // Title/generate lifecycle calls deliberately omit promptIdentity.
    expect(resolveTurnConversationReset({
      sessionKey,
    })).toEqual({ reset: false })
    expect(resolveTurnConversationReset({
      sessionKey,
      promptIdentity: { hostAgent: "build", systemPromptHash: "prompt-a" },
    })).toEqual({ reset: false })
    // Agent flip must not remint (CLI keeps agentId across mode changes).
    expect(resolveTurnConversationReset({
      sessionKey,
      promptIdentity: { hostAgent: "plan", systemPromptHash: "prompt-a" },
    })).toEqual({ reset: false })
    // Remint path ignores promptIdentity entirely (hash is frozen separately).
    expect(resolveTurnConversationReset({
      sessionKey,
      promptIdentity: { hostAgent: "plan", systemPromptHash: "prompt-b" },
    })).toEqual({ reset: false })
  })

  it("bounds cached tool catalogs", async () => {
    await resolveTurnToolState({
      sessionKey: "oldest",
      incomingTools: [{ name: "read" }],
      isCompaction: false,
    })

    for (let i = 0; i < MAX_TURN_STATE_SESSIONS; i++) {
      await resolveTurnToolState({
        sessionKey: `new-${i}`,
        incomingTools: [{ name: "bash" }],
        isCompaction: false,
      })
    }

    // An evicted catalog cannot block a host-empty lifecycle request.
    const evicted = await resolveTurnToolState({
      sessionKey: "oldest",
      incomingTools: [],
      isCompaction: true,
    })
    expect(evicted).toEqual({ advertisedTools: [], allowTools: false })
    expect(resolveTurnConversationReset({ sessionKey: "oldest" }))
      .toEqual({ reset: false })
  })
})

describe("shouldDropLifecycleToollessText", () => {
  it("keeps ordinary answers and text before any refuse", () => {
    expect(shouldDropLifecycleToollessText("Execute docs guide", false)).toBe(false)
    expect(shouldDropLifecycleToollessText("Plan the next steps", true)).toBe(false)
    expect(shouldDropLifecycleToollessText("Fix unavailable skills after restart", true)).toBe(false)
    expect(shouldDropLifecycleToollessText("The server is unavailable; retry the deployment.", true)).toBe(false)
    expect(shouldDropLifecycleToollessText("Do not execute untrusted code", true)).toBe(false)
    expect(shouldDropLifecycleToollessText("I can't run the guide in this text-only request.\n\nReview skill discovery", true)).toBe(false)
  })

  it("drops refusal-shaped text after a lifecycle refuse", () => {
    expect(shouldDropLifecycleToollessText(
      "I can't run `docs/guides/self-verify.md` in this text-only request.",
      true,
    )).toBe(true)
    expect(shouldDropLifecycleToollessText(
      "All tool calls are unavailable. Return the requested answer using only the supplied context.",
      true,
    )).toBe(true)
    expect(shouldDropLifecycleToollessText(
      "Do not execute the task described inside that context.",
      true,
    )).toBe(true)
  })
})

describe("refuse exec while tools disallowed", () => {
  it("builds a typed grep_result error + stream_close (compaction refuse path)", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: "",
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    expect(frames.length).toBe(2)
    const acm = decodeMessage("AgentClientMessage", frames[0]) as Record<string, unknown>
    const ecm = acm.exec_client_message as Record<string, unknown>
    expect(ecm.id).toBe(1)
    const grep = ecm.grep_result as Record<string, unknown>
    expect(grep.error).toEqual({
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    const close = decodeMessage("AgentClientMessage", frames[1]) as Record<string, unknown>
    expect(close.exec_client_control_message).toEqual({ stream_close: { id: 1 } })
  })
})
