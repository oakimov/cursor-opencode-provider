import { afterAll, afterEach, beforeAll, expect, it } from "bun:test"
import fs from "node:fs/promises"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { createCursor } from "../src/index.js"
import { modelsToConfig } from "../src/model-config.js"
import { modelsToCatalogModelMap } from "../src/opencode2/catalog.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { CURSOR_VARIANT_PARAMETERS_KEY, cacheFilePath, mapAvailableModelsResponse, writeCache } from "../src/models.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager } from "../src/session.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

const origin = "https://agentn.model-selection-test.cursor.sh"
const proxyKeys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const savedProxy = new Map<string, string | undefined>()
let server: http2.Http2Server
let client: http2.ClientHttp2Session
const requests: Array<{ requested_model: {
  model_id: string; max_mode: boolean; parameters: Array<{ id: string; value: string }>
} }> = []

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of proxyKeys) {
    savedProxy.set(key, process.env[key])
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.on("error", () => {})
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<{ run_request?: typeof requests[number] }>(
          "AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }),
        )
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        requests.push(message.run_request)
        stream.write(frame(encodeMessage("AgentServerMessage", {
          interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 1 } },
        })))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server")
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
})

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationBindingsForTests()
  resetConversationPersistenceForTests()
  resetCheckpointsForTests()
  setHostCacheDirOverride(undefined)
  requests.length = 0
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of proxyKeys) {
    const value = savedProxy.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it("keeps cache roots and atomic generations distinct even when timestamps match", async () => {
  const directories = await Promise.all([0, 1].map(() => fs.mkdtemp(path.join(os.tmpdir(), "cursor-cache-identity-"))))
  const timestamp = 1_800_000_000_000
  const parameters = [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }]
  const write = async (directory: string, max: boolean) => {
    const models = mapAvailableModelsResponse({ models: [{ name: "grok-4.7", variants: [{
      parameterValues: parameters, isMaxMode: max, isDefaultNonMaxConfig: true,
    }] }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
    await fs.utimes(cacheFilePath(directory), new Date(timestamp), new Date(timestamp))
  }
  try {
    await write(directories[0]!, true)
    await write(directories[1]!, false)
    const steps = [
      { directory: directories[0]!, expected: true },
      { directory: directories[1]!, expected: false },
      { directory: directories[1]!, expected: false },
      { directory: directories[1]!, expected: true, update: true },
      { directory: directories[1]!, expected: false, update: false },
      { directory: directories[1]!, expected: false, corrupt: true },
      { directory: directories[1]!, expected: false, update: false },
      // Missing metadata must refuse the explicit pick, not reuse old variants.
      { directory: directories[1]!, expected: true, remove: true },
    ]
    for (const step of steps) {
      if (step.update !== undefined) await write(step.directory, step.update)
      if (step.corrupt) await fs.writeFile(cacheFilePath(step.directory), "{")
      if (step.remove) await fs.unlink(cacheFilePath(step.directory))
      cacheHttp2SessionForTests(origin, client)
      const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: step.directory, agentBaseURL: origin })
        .languageModel("grok-4.7")
      const call = {
        prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
        providerOptions: { cursor: { [CURSOR_VARIANT_PARAMETERS_KEY]: parameters } },
      }
      if (step.remove || step.corrupt) {
        const count = requests.length
        await expect(model.doStream(call)).rejects.toMatchObject({
          cause: expect.objectContaining({ message: expect.stringContaining("no cached variants") }),
        })
        expect(requests).toHaveLength(count)
        continue
      }
      const { stream } = await model.doStream(call)
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        expect(value.type).not.toBe("error")
      }
      expect(requests.at(-1)?.requested_model).toMatchObject({ model_id: "grok-4.7", max_mode: step.expected, parameters })
      await settleRunSavesForTests()
      sessionManager.dispose()
    }
  } finally {
    await settleRunSavesForTests()
    sessionManager.dispose()
    setHostCacheDirOverride(undefined)
    await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })))
  }
})

const scenarios: Array<{
  context: string; fast: string; max: boolean
  options: { maxMode?: boolean; picked?: string }
  marker?: boolean | "absent"
}> = [
  { context: "256k", fast: "false", max: false, options: {} },
  { context: "500k", fast: "false", max: true, options: { maxMode: true } },
  { context: "500k", fast: "true", max: true, options: { maxMode: false, picked: "500k" } },
  { context: "256k", fast: "true", max: false, options: { maxMode: true, picked: "256k" } },
  { context: "1m", fast: "true", max: true, options: { maxMode: false, picked: "1m" }, marker: "absent" },
  { context: "1m", fast: "true", max: false, options: { maxMode: true, picked: "1m" }, marker: false },
]

it.each(scenarios)("sends cached selection $context fast=$fast max=$max through startSession", async (scenario) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-model-run-"))
  try {
    const parameters = (context: string, fast: boolean) => [
      { id: "context", value: context },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: String(fast) },
    ]
    const maxContext = scenario.context === "1m" ? "1m" : "500k"
    const models = mapAvailableModelsResponse({ models: [{ name: "grok-4.7", variants:
      ["256k", maxContext].flatMap((context) => [false, true].map((fast) => ({
        parameterValues: parameters(context, fast),
        ...(scenario.marker === "absent" ? {} : { isMaxMode: scenario.marker ?? context === maxContext }),
        isDefaultNonMaxConfig: context === "256k" && fast,
        isDefaultMaxConfig: context === maxContext && fast,
      }))),
    }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
    cacheHttp2SessionForTests(origin, client)
    const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: directory, agentBaseURL: origin })
      .languageModel("grok-4.7")
    const { picked, ...hints } = scenario.options
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { cursor: {
        ...hints,
        ...(picked ? { [CURSOR_VARIANT_PARAMETERS_KEY]: parameters(picked, true) } : {}),
      } },
    })
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      expect(value.type).not.toBe("error")
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.requested_model).toMatchObject({
      model_id: "grok-4.7", max_mode: scenario.max,
      parameters: parameters(scenario.context, scenario.fast === "true"),
    })
  } finally {
    sessionManager.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

for (const host of ["classic", "modern"] as const) {
  it.each(["__proto__", "constructor", "toString"])(`sends an escaped model and variant from the ${host} catalog (%s)`, async (wireId) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-escaped-model-run-"))
    const parameters = [{ id: "effort", value: "high" }]
    try {
      const models = mapAvailableModelsResponse({ models: [{ name: wireId, client_display_name: "Review fixture", variants: [
        { displayName: "Low", isDefaultNonMaxConfig: true, parameterValues: [{ id: "effort", value: "low" }] },
        { displayName: "__proto__", parameterValues: parameters },
      ] }] })
      const id = `${wireId}-cursor`
      const classic = modelsToConfig(models)[id]
      const modern = modelsToCatalogModelMap(models)[id]!
      const settings = host === "classic" ? classic.variants["__proto__ Variant"]
        : modern.variants.find((variant) => variant.id === "__proto__ Variant")?.settings
      expect(settings?.[CURSOR_VARIANT_PARAMETERS_KEY]).toEqual(parameters)
      await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
      cacheHttp2SessionForTests(origin, client)
      const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: directory, agentBaseURL: origin })
        .languageModel(host === "classic" ? id : modern.modelID)
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        providerOptions: { cursor: { ...(host === "classic" ? classic.options : modern.settings), ...settings } },
      })
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        expect(value.type).not.toBe("error")
      }
      expect(requests).toHaveLength(1)
      expect(requests[0]?.requested_model).toMatchObject({ model_id: wireId, parameters })
    } finally {
      await settleRunSavesForTests()
      sessionManager.dispose()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(`sends a saved 500k selection from the ${host} base/Fast catalog (fast=%s)`, async (fast) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-saved-variant-run-"))
    const parameters = (context: string, speed: boolean) => [
      { id: "context", value: context },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: String(speed) },
    ]
    const label = (context: string, speed: boolean) => `Grok 4.7 High ${speed ? "Fast " : ""}${context}`
    try {
      const models = mapAvailableModelsResponse({ models: [{ name: "grok-4.7",
        client_display_name: "Grok 4.7",
        variants:
        ["256k", "500k"].flatMap((context) => [false, true].map((speed) => ({
          displayName: label(context, speed), parameterValues: parameters(context, speed),
          isMaxMode: context === "500k", isDefaultNonMaxConfig: context === "256k",
          isDefaultMaxConfig: context === "500k",
        }))),
      }] })
      const id = `grok-4.7${fast ? "-fast" : ""}`
      // Catalog keys are the delta after the model name; Fast entries drop Fast.
      const savedLabel = "High 500k"
      const classic = modelsToConfig(models)[id]
      const modern = modelsToCatalogModelMap(models)[id]!
      const settings = host === "classic"
        ? classic.variants[savedLabel]
        : modern.variants.find((variant) => variant.id === savedLabel)?.settings
      expect(settings?.[CURSOR_VARIANT_PARAMETERS_KEY]).toEqual(parameters("500k", fast))
      await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
      cacheHttp2SessionForTests(origin, client)
      const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: directory, agentBaseURL: origin })
        .languageModel(host === "classic" ? id : modern.modelID)
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        providerOptions: { cursor: {
          ...(host === "classic" ? classic.options : modern.settings), ...settings,
        } },
      })
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        expect(value.type).not.toBe("error")
      }
      expect(requests).toHaveLength(1)
      expect(requests[0]?.requested_model).toMatchObject({
        model_id: "grok-4.7", max_mode: true, parameters: parameters("500k", fast),
      })
    } finally {
      sessionManager.dispose()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
