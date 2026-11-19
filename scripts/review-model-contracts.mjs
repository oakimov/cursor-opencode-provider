// Trusted review-harness checks run against the archived subject, not this
// checkout's implementation or the contributor's test assertions. No live Run.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const subject = resolve(process.argv[2] ?? process.cwd())
const load = name => import(pathToFileURL(resolve(subject, "src", name + ".ts")).href)
const { modelsToConfig } = await load("model-config")
const catalog = await load("opencode2/catalog")
const { modelsToCatalogModelMap, modelConfigEntryToInfo } = catalog
const { normalizeModelCache } = await load("models")

// The oracle is the accepted upstream metadata, not another catalog produced
// by the same mapper. Comparing only the two outputs can miss shared data loss.
const tupleKey = (parameters) => JSON.stringify(
  [...parameters].sort((left, right) => left.id.localeCompare(right.id)),
)
const objectKey = (value) => value === "prototype" || Object.hasOwn(Object.prototype, value)

const ownedKey = (modelId, parameters) => JSON.stringify([modelId, tupleKey(parameters)])

function inspectHost(host, catalog, models, problems) {
  const expected = new Set(models.flatMap((model) => model.variants.map((variant) => ownedKey(model.id, variant.parameterValues))))
  const retained = new Set()
  for (const [catalogId, entry] of Object.entries(catalog)) {
    if (objectKey(catalogId)) problems.add(`OpenCode ${host} published an object-control model id`)
    const wireId = host === "1.x" ? entry.options?.cursorModelId ?? catalogId : entry.modelID ?? catalogId
    if (!models.some((model) => model.id === wireId)) problems.add(`OpenCode ${host} changed the wire model id`)
    const rates = host === "1.x" ? (entry.cost ? [entry.cost] : []) : (entry.cost ?? [])
    for (const rate of rates) {
      if (![rate.input, rate.output].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
        problems.add(`OpenCode ${host} published invalid catalog rates`)
      }
    }
    const choices = host === "1.x" ? Object.entries(entry.variants ?? {})
      : entry.variants.map((choice) => [choice.id, choice.settings])
    const ids = choices.map(([id]) => id)
    if (ids.includes("default")) problems.add(`OpenCode ${host} advertises the reserved default id; its selector drops the tuple`)
    if (ids.includes("__proto__")) problems.add(`OpenCode ${host} published an object-control variant id`)
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
      problems.add(`OpenCode ${host} has invalid or duplicate ids`)
    }
    for (const [, settings] of choices) {
      const parameters = settings?.cursorVariantParameters ?? []
      const key = ownedKey(wireId, parameters)
      if (!expected.has(key)) {
        const bare = tupleKey(parameters)
        const known = models.some((model) => model.variants.some((variant) => tupleKey(variant.parameterValues) === bare))
        problems.add(known
          ? `OpenCode ${host} assigned a tuple to the wrong model`
          : `OpenCode ${host} published a tuple absent from discovery`)
      }
      retained.add(key)
    }
  }
  if ([...expected].some(key => !retained.has(key))) problems.add(`OpenCode ${host} lost an upstream tuple`)
}

function inspect(models) {
  const problems = new Set()
  if (!normalizeModelCache({ fetchedAt: 1, models: structuredClone(models) })) {
    problems.add("review metadata was rejected by discovery")
  }
  const projections = new Map()
  const before = JSON.stringify(models)
  for (const [host, project] of [["1.x", modelsToConfig], ["2.x", modelsToCatalogModelMap]]) {
    const input = structuredClone(models)
    try {
      const projection = project(input)
      inspectHost(host, projection, models, problems)
      projections.set(host, projection)
    } catch (error) {
      problems.add(`OpenCode ${host} catalog inspection failed: ${error.message}`)
    } finally {
      if (JSON.stringify(input) !== before) problems.add(`OpenCode ${host} catalog construction mutated discovery metadata`)
    }
  }
  const classic = projections.get("1.x")
  const modern = projections.get("2.x")
  if (!classic || !modern) return problems
  for (const [id, entry] of Object.entries(classic)) {
    for (const [label, settings] of Object.entries(entry.variants ?? {})) {
      const choice = modern[id]?.variants.find((variant) => variant.id === label)
      if (!choice || tupleKey(choice.settings?.cursorVariantParameters ?? []) !== tupleKey(settings.cursorVariantParameters ?? [])) {
        problems.add("OpenCode 2.x changed an original display-label selection")
      }
    }
  }
  return problems
}

function* cases(effort) {
  yield {
    id: "sentinel", models: [{ id: "review-catalog-fixture", displayName: "Review catalog fixture",
      variants: ["high", "default", "low"].map((value, index) => ({
        key: `choice-${index}`, displayName: ["High", "Provider Default", "default"][index],
        parameterValues: [{ id: effort, value }], isDefaultNonMax: index === 0, isDefaultMax: false,
      })),
    }],
  }
  // Accepted values, labels and context/speed partitions are varied without
  // copying the producer's alias algorithm or its expected output fixtures.
  for (const label of ["High", "high", "__proto__", "constructor", "toString", "default", "<b>High</b>", "東京"]) {
    for (const value of ["high", "default", "extra-high", "extra high", "unlisted", ""]) {
      for (const context of [undefined, "300k", "500k", "1m"]) {
        for (const fast of [undefined, "false", "true"]) {
          yield { id: `label=${JSON.stringify(label)} effort=${JSON.stringify(value)} context=${context} fast=${fast}`, models: [{
            id: "review-catalog-fixture", maxContext: 300_000,
            variants: [{ key: "choice", displayName: label, isDefaultNonMax: true, isDefaultMax: false,
              parameterValues: [{ id: effort, value },
                ...(context ? [{ id: "context", value: context }] : []),
                ...(fast ? [{ id: "fast", value: fast }] : [])],
            }],
          }] }
        }
      }
    }
  }
  for (const id of ["__proto__", "constructor", "toString", "__proto__-500k", "constructor-500k", "toString-1m"]) {
    yield { id: `model=${id}`, models: [{ id, variants: [{ key: "choice", displayName: "High",
      isDefaultNonMax: true, isDefaultMax: false, parameterValues: [{ id: effort, value: "high" }],
    }] }] }
  }
  const variants = [false, true].flatMap((thinking) => ["300k", "500k", "1m"].flatMap((context) =>
    [false, true].map((fast) => ({ key: "choice", displayName: "Shared", isDefaultNonMax: false, isDefaultMax: false,
      isMaxMode: context !== "300k", parameterValues: [{ id: effort, value: "high" },
        { id: "thinking", value: String(thinking) }, { id: "context", value: context }, { id: "fast", value: String(fast) }],
    })),
  ))
  for (const reverse of [false, true]) {
    yield { id: `mixed reverse=${reverse}`, models: [{ id: "composer-2.5", maxContext: 300_000,
      variants: reverse ? variants.toReversed().map((variant) => ({ ...variant, parameterValues: variant.parameterValues.toReversed() })) : variants,
    }] }
  }
  yield { id: "two-model", models: [
    { id: "review-model-a", variants: [{ key: "a", displayName: "High", isDefaultNonMax: true, isDefaultMax: false,
      parameterValues: [{ id: effort, value: "high" }] }] },
    { id: "review-model-b", variants: [{ key: "b", displayName: "Low", isDefaultNonMax: true, isDefaultMax: false,
      parameterValues: [{ id: effort, value: "low" }] }] },
  ] }
}

let failed = false
for (const effort of ["effort", "reasoning", "reasoning_effort"]) {
  let count = 0
  const problems = new Map()
  for (const fixture of cases(effort)) {
    count++
    for (const message of inspect(fixture.models)) {
      const previous = problems.get(message)
      problems.set(message, { count: (previous?.count ?? 0) + 1, example: previous?.example ?? fixture.id })
      console.error(`MODEL_CONTRACT_CASE=${JSON.stringify([effort, fixture.id, message])}`)
    }
  }
  if (problems.size) {
    failed = true
    console.error(`MODEL_CONTRACT=${effort}:failed cases=${count}\n${[...problems].map(([message, problem]) => `${message}; count=${problem.count}; example=${problem.example}`).join("\n")}`)
  } else console.log(`MODEL_CONTRACT=${effort}:passed cases=${count}`)
}

// A set of retained tuples can agree while the host selects the wrong tuple.
// Use literal host inputs and compare the effective variant's selected settings
// with fixture metadata. Exercise setup and the registered hook when present,
// or exact variant-id lookup for the earlier implementation of #183.
if (!modelConfigEntryToInfo) {
  console.log("MODEL_ALIAS_CONTRACT=feature:skipped unavailable-on-subject")
} else {
  const modelId = "review-alias-fixture"
  const parameters = (...entries) => entries.map(([id, value]) => ({ id, value }))
  const entry = choices => modelConfigEntryToInfo(modelId, {
    limit: { context: 256_000 },
    variants: Object.fromEntries(choices.map(([label, tuple]) => [label, { cursorVariantParameters: tuple }])),
  })
  const high = parameters(["effort", "high"], ["context", "256k"])
  const low = parameters(["effort", "low"], ["context", "128k"])
  const defaultHigh = parameters(["effort", "high"])
  const conflict = parameters(["effort", "high"], ["reasoning_effort", "low"])
  const extra = parameters(["effort", "extra-high"], ["reasoning_effort", "xhigh"])
  const configured = parameters(["reasoning_effort", "medium"])
  const simple = entry([["High", high]])
  const supportsAliases = typeof catalog.shortVariantAliases === "function" || simple.variants.some(choice => choice.id === "high")
  if (!supportsAliases) {
    console.log("MODEL_ALIAS_CONTRACT=feature:skipped unavailable-on-subject")
  } else {
    const { getHostCacheDirOverride, setHostCacheDirOverride } = await load("context/paths")
    const root = await mkdtemp(join(tmpdir(), "review-alias-"))
    const previousCache = getHostCacheDirOverride()
    const previousKey = process.env.CURSOR_API_KEY
    let cleanup
    let resolveModel
    let effective
    setHostCacheDirOverride(root)
    delete process.env.CURSOR_API_KEY
    try {
      const { default: plugin } = await load("plugin-opencode2")
      const register = async () => ({ dispose: async () => {} })
      cleanup = await plugin.setup({
        location: { directory: root },
        integration: { transform: register, connection: { active: async () => undefined } },
        provider: { transform: register },
        aisdk: { hook: register },
        tool: { hook: register, transform: register },
        event: { subscribe: () => undefined },
        model: { list: async () => ({ data: [effective] }) },
        session: { hook: async (name, callback) => {
          if (name === "experimental.model.resolve") resolveModel = callback
          return register()
        } },
      })
      const cases = [
        ["ordinary-label", [["High", high]], "High", high],
        ["declared-base", [["High", high], ["Reduced Low", low]], "high", high],
        ["smaller-tier", [["High", high], ["Reduced Low", low]], "low-128k", low],
        ["ambiguous-base", [["High", high], ["Other High", defaultHigh]], "high", undefined],
        ["conflicting-efforts", [["Dual Effort", conflict]], "high", undefined],
        ["conflicting-efforts-reversed", [["Dual Effort", conflict.toReversed()]], "low", undefined],
        ["equivalent-efforts", [["Extra High", extra]], "xhigh", extra],
        ["host-override", [["High", high]], "high", configured],
        ["picker-single-entry", [["High", high]], "high", high],
      ]
      for (const [id, choices, variant, expected] of cases) {
        effective = entry(choices)
        if (id === "host-override") effective.variants = [
          { id: "high", settings: { cursorVariantParameters: configured } },
          ...effective.variants.filter(choice => choice.id !== "high"),
        ]
        const event = { model: { providerID: "cursor", id: modelId, variant } }
        await resolveModel?.(event)
        const selected = effective.variants.find(choice => choice.id === event.model.variant)
        const actual = selected?.settings?.cursorVariantParameters
        const correct = id === "picker-single-entry" ? effective.variants.length === choices.length
          : expected ? actual && tupleKey(actual) === tupleKey(expected) : !selected
        if (!correct) failed = true
        console[correct ? "log" : "error"](`MODEL_ALIAS_CONTRACT=${id}:${correct ? "passed" : "failed"}`)
      }
    } finally {
      try { await cleanup?.() }
      finally {
        setHostCacheDirOverride(previousCache)
        if (previousKey === undefined) delete process.env.CURSOR_API_KEY
        else process.env.CURSOR_API_KEY = previousKey
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}
console.log(`REVIEW_CONTRACT_COMPLETE=MODEL_CONTRACTS:${failed ? "failed" : "passed"}`)
process.exitCode = failed ? 1 : 0
