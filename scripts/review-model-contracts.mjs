// Trusted review-harness checks run against the archived subject, not this
// checkout's implementation or the contributor's test assertions. No live Run.
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const subject = resolve(process.argv[2] ?? process.cwd())
const { modelsToConfig } = await import(pathToFileURL(resolve(subject, "src/model-config.ts")).href)
const { modelsToCatalogModelMap } = await import(pathToFileURL(resolve(subject, "src/opencode2/catalog.ts")).href)
const { normalizeModelCache } = await import(pathToFileURL(resolve(subject, "src/models.ts")).href)

// The oracle is the accepted upstream metadata, not another catalog produced
// by the same mapper. Comparing only the two outputs can miss shared data loss.
const tupleKey = (parameters) => JSON.stringify(
  [...parameters].sort((left, right) => left.id.localeCompare(right.id)),
)
const objectKey = (value) => value === "prototype" || Object.hasOwn(Object.prototype, value)

function inspect(models) {
  const before = JSON.stringify(models)
  if (!normalizeModelCache({ fetchedAt: 1, models })) throw new Error("review metadata was rejected by discovery")
  const classic = modelsToConfig(models)
  const modern = modelsToCatalogModelMap(models)
  if (JSON.stringify(models) !== before) throw new Error("catalog construction mutated discovery metadata")
  const expected = new Set(models.flatMap((model) => model.variants.map((variant) => tupleKey(variant.parameterValues))))
  for (const [host, catalog] of [["1.x", classic], ["2.x", modern]]) {
    const retained = new Set()
    for (const [catalogId, entry] of Object.entries(catalog)) {
      if (objectKey(catalogId)) throw new Error(`OpenCode ${host} published an object-control model id`)
      const wireId = host === "1.x" ? entry.options?.cursorModelId ?? catalogId : entry.modelID ?? catalogId
      if (!models.some((model) => model.id === wireId)) throw new Error(`OpenCode ${host} changed the wire model id`)
      const rates = host === "1.x" ? (entry.cost ? [entry.cost] : []) : (entry.cost ?? [])
      for (const rate of rates) {
        if (![rate.input, rate.output].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
          throw new Error(`OpenCode ${host} published invalid catalog rates`)
        }
      }
      const choices = host === "1.x" ? Object.entries(entry.variants ?? {})
        : entry.variants.map((choice) => [choice.id, choice.settings])
      const ids = choices.map(([id]) => id)
      if (ids.includes("default")) throw new Error(`OpenCode ${host} advertises the reserved default id; its selector drops the tuple`)
      if (ids.includes("__proto__")) throw new Error(`OpenCode ${host} published an object-control variant id`)
      if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
        throw new Error(`OpenCode ${host} has invalid or duplicate ids`)
      }
      for (const [, settings] of choices) {
        const key = tupleKey(settings?.cursorVariantParameters ?? [])
        if (!expected.has(key)) throw new Error(`OpenCode ${host} published a tuple absent from discovery`)
        retained.add(key)
      }
    }
    for (const key of expected) {
      if (!retained.has(key)) throw new Error(`OpenCode ${host} lost an upstream tuple`)
    }
  }
  for (const [id, entry] of Object.entries(classic)) {
    for (const [label, settings] of Object.entries(entry.variants ?? {})) {
      const choice = modern[id]?.variants.find((variant) => variant.id === label)
      if (!choice || tupleKey(choice.settings?.cursorVariantParameters ?? []) !== tupleKey(settings.cursorVariantParameters ?? [])) {
        throw new Error("OpenCode 2.x changed an original display-label selection")
      }
    }
  }
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
}

let failed = false
for (const effort of ["effort", "reasoning", "reasoning_effort"]) {
  let count = 0
  const problems = new Map()
  for (const fixture of cases(effort)) {
    count++
    try { inspect(fixture.models) }
    catch (error) {
      const previous = problems.get(error.message)
      problems.set(error.message, { count: (previous?.count ?? 0) + 1, example: previous?.example ?? fixture.id })
    }
  }
  if (problems.size) {
    failed = true
    console.error(`MODEL_CONTRACT=${effort}:failed cases=${count}\n${[...problems].map(([message, problem]) => `${message}; count=${problem.count}; example=${problem.example}`).join("\n")}`)
  } else console.log(`MODEL_CONTRACT=${effort}:passed cases=${count}`)
}
process.exitCode = failed ? 1 : 0
