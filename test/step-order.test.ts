import { describe, expect, it } from "bun:test"
import {
  announceCall,
  createStepOrder,
  dropHeldExec,
  finishCall,
  holdExec,
  isFileChangeDisplay,
  isFileChangeExec,
  noteExecResult,
  noteOrderedCallCount,
  orderExec,
  runExec,
  startOrderedStep,
  takeCancelledExecs,
  takeReleasableExecs,
} from "../src/step-order.js"

const held = (callId: string, execId: number) => ({ callId, execId, frame: execId, request: undefined, pending: undefined })

describe("step order", () => {
  it("recognizes Cursor's file changes by display call, exec result and host tool", () => {
    expect(isFileChangeDisplay({ edit_tool_call: { args: { path: "a" } } })).toBe(true)
    expect(isFileChangeDisplay({ delete_tool_call: {} })).toBe(true)
    expect(isFileChangeDisplay({ shell_tool_call: { args: { command: "ls" } } })).toBe(false)
    // A host file tool called through MCP, by the host tool it resolves to.
    for (const tool of ["edit", "write", "apply_patch", "patch"]) {
      expect(isFileChangeDisplay({ mcp_tool_call: { args: {} } }, tool)).toBe(true)
    }
    expect(isFileChangeDisplay({ mcp_tool_call: { args: {} } }, "bash")).toBe(false)
    expect(isFileChangeExec("write_result", "write")).toBe(true)
    expect(isFileChangeExec("delete_result", "bash")).toBe(true)
    expect(isFileChangeExec("mcp_result", "apply_patch")).toBe(true)
    expect(isFileChangeExec("mcp_result", "patch")).toBe(true)
    expect(isFileChangeExec("shell_stream", "bash")).toBe(false)
    expect(isFileChangeExec("read_result", "read")).toBe(false)
  })

  it("holds a call after an announced file change until its write is delivered", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "edit", true)
    announceCall(order, "shell", false)
    expect(orderExec(order, "shell", false)).toBe("hold")
    holdExec(order, held("shell", 2))
    expect(orderExec(order, "edit", false)).toBe("run")
    runExec(order, "edit", 1, true)
    // The edit's private read does not finish it.
    noteExecResult(order, 1, "done")
    expect(takeReleasableExecs(order)).toEqual([])
    expect(orderExec(order, "edit", true)).toBe("run")
    runExec(order, "edit", 3, false)
    noteExecResult(order, 3, "done")
    expect(takeReleasableExecs(order).map((exec) => exec.execId)).toEqual([2])
    expect(order.held).toEqual([])
  })

  it("lets a file change wait for earlier calls on their way, not for unsent ones", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "status", false)
    announceCall(order, "unsent", false)
    announceCall(order, "edit", true)
    expect(orderExec(order, "status", false)).toBe("run")
    runExec(order, "status", 1, false)
    expect(orderExec(order, "edit", false)).toBe("hold")
    holdExec(order, held("edit", 2))
    noteExecResult(order, 1, "done")
    expect(takeReleasableExecs(order).map((exec) => exec.execId)).toEqual([2])
  })

  it("releases held calls in model order, keeping those after a released file change", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "read", false)
    announceCall(order, "edit-a", true)
    announceCall(order, "shell", false)
    expect(orderExec(order, "read", false)).toBe("run")
    runExec(order, "read", 1, false)
    expect(orderExec(order, "shell", false)).toBe("hold")
    holdExec(order, held("shell", 3))
    expect(orderExec(order, "edit-a", true)).toBe("hold")
    holdExec(order, held("edit-a", 2))
    expect(order.held.map((exec) => exec.execId)).toEqual([2, 3])
    noteExecResult(order, 1, "done")
    expect(takeReleasableExecs(order).map((exec) => exec.execId)).toEqual([2])
    expect(order.held.map((exec) => exec.execId)).toEqual([3])
  })

  it("never runs anything held when nothing it waits for finishes", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "edit", true)
    expect(orderExec(order, "shell", false)).toBe("hold")
    holdExec(order, held("shell", 2))
    expect(takeReleasableExecs(order)).toEqual([])
    // A finish of the held call itself does not release or forget it.
    finishCall(order, "shell")
    expect(order.held.map((exec) => exec.execId)).toEqual([2])
  })

  it("cancels the calls after a file change the host refused", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "edit", true)
    announceCall(order, "shell", false)
    expect(orderExec(order, "edit", true)).toBe("run")
    runExec(order, "edit", 1, false)
    expect(orderExec(order, "shell", false)).toBe("hold")
    holdExec(order, held("shell", 2))
    noteExecResult(order, 1, "refused")
    expect(takeReleasableExecs(order)).toEqual([])
    expect(takeCancelledExecs(order).map((exec) => exec.execId)).toEqual([2])
    // A late exec of the same step is cancelled as well.
    expect(orderExec(order, "late", false)).toBe("cancel")
  })

  it("drops a held exec Cursor withdrew, which ends its own hold on later calls", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "read", false)
    announceCall(order, "edit", true)
    announceCall(order, "shell", false)
    expect(orderExec(order, "read", false)).toBe("run")
    runExec(order, "read", 1, false)
    expect(orderExec(order, "edit", true)).toBe("hold")
    holdExec(order, held("edit", 2))
    expect(orderExec(order, "shell", false)).toBe("hold")
    holdExec(order, held("shell", 3))
    expect(dropHeldExec(order, 2)?.execId).toBe(2)
    noteExecResult(order, 1, "done")
    expect(takeReleasableExecs(order).map((exec) => exec.execId)).toEqual([3])
  })

  it("starts a new step once every call of the last one finished", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "edit", true)
    expect(orderExec(order, "edit", true)).toBe("run")
    runExec(order, "edit", 1, false)
    noteExecResult(order, 1, "refused")
    announceCall(order, "next", false)
    expect(order.calls.has("edit")).toBe(false)
    expect(orderExec(order, "next", false)).toBe("run")
  })

  it("keeps the step while an earlier call still runs", () => {
    const order = createStepOrder<number, undefined>()
    announceCall(order, "edit", true)
    expect(orderExec(order, "edit", true)).toBe("run")
    runExec(order, "edit", 1, false)
    announceCall(order, "shell", false)
    expect(order.calls.has("edit")).toBe(true)
    expect(orderExec(order, "shell", false)).toBe("hold")
  })

  it("retains refusal until every listed call arrived, then admits the next generation's count", () => {
    const order = createStepOrder<number, undefined>()
    noteOrderedCallCount(order, 2)
    announceCall(order, "edit", true)
    runExec(order, "edit", 1, false)
    noteExecResult(order, 1, "refused")
    announceCall(order, "late", false)
    expect(orderExec(order, "late", false)).toBe("cancel")
    finishCall(order, "late")

    noteOrderedCallCount(order, 3)
    announceCall(order, "next-edit", true)
    expect(order.calls.has("edit")).toBe(false)
    expect(order.listedCount).toBe(3)
    runExec(order, "next-edit", 2, false)
    noteExecResult(order, 2, "refused")
    announceCall(order, "next-late", false)
    expect(orderExec(order, "next-late", false)).toBe("cancel")
  })

  it("uses an explicit new generation even if the prior count was incomplete", () => {
    const order = createStepOrder<number, undefined>()
    noteOrderedCallCount(order, 2)
    announceCall(order, "edit", true)
    runExec(order, "edit", 1, false)
    startOrderedStep(order)
    expect(order.calls.has("edit")).toBe(true)
    noteExecResult(order, 1, "refused")
    startOrderedStep(order)
    announceCall(order, "next", false)
    expect(orderExec(order, "next", false)).toBe("run")
    expect(order.listedCount).toBeUndefined()
    noteOrderedCallCount(order, -1)
    noteOrderedCallCount(order, Number.NaN)
    expect(order.listedCount).toBeUndefined()
  })
})
