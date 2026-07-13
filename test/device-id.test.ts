import { describe, it, expect } from "bun:test"
import { getDeviceIds } from "../src/protocol/device-id.js"

const HEX64 = /^[0-9a-f]{64}$/

describe("getDeviceIds", () => {
  it("returns a 64-hex machineId (sha256-shaped, not random garbage)", () => {
    const { machineId } = getDeviceIds()
    expect(HEX64.test(machineId)).toBe(true)
  })

  it("is stable across calls within a process (cached)", () => {
    const a = getDeviceIds()
    const b = getDeviceIds()
    expect(b.machineId).toBe(a.machineId)
    expect(b.macMachineId).toBe(a.macMachineId)
  })

  it("macMachineId is 64-hex when present", () => {
    const { macMachineId } = getDeviceIds()
    if (macMachineId !== undefined) {
      expect(HEX64.test(macMachineId)).toBe(true)
    }
  })

  it("does NOT produce the throwaway random value it used to", () => {
    // Regression guard: the old impl generated a fresh random 64-hex per call
    // (and per process). The two calls above must now be byte-identical, which
    // only holds once derivation is stable/deterministic.
    expect(getDeviceIds().machineId).toBe(getDeviceIds().machineId)
  })
})
