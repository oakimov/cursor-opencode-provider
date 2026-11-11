// Trusted review-harness checks run against the archived subject, not this
// checkout's implementation or the contributor's test assertions. No live Run.
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const subject = resolve(process.argv[2] ?? process.cwd())
const { modelsToConfig } = await import(pathToFileURL(resolve(subject, "src/model-config.ts")).href)
const { modelsToCatalogModelMap } = await import(pathToFileURL(resolve(subject, "src/opencode2/catalog.ts")).href)

let failed = false
for (const effort of ["effort", "reasoning", "reasoning_effort"]) {
  const tuple = (value) => [{ id: effort, value }]
  const models = [{
    id: "review-catalog-fixture", displayName: "Review catalog fixture",
    variants: ["high", "default", "low"].map((value, index) => ({
      key: `choice-${index}`,
      displayName: ["High", "Provider Default", "default"][index],
      parameterValues: tuple(value),
      isDefaultNonMax: index === 0, isDefaultMax: false,
    })),
  }]
  try {
    const classic = modelsToConfig(models)[models[0].id]
    const modern = modelsToCatalogModelMap(models)[models[0].id]
    const classicChoices = Object.entries(classic.variants)
    const modernChoices = modern.variants.map((choice) => [choice.id, choice.settings])
    for (const [host, choices] of [["1.x", classicChoices], ["2.x", modernChoices]]) {
      const ids = choices.map(([id]) => id)
      // OpenCode's selector treats this id as no override. Equal settings on
      // a generated alias do not make that alias a selectable parameter tuple.
      if (ids.includes("default")) throw new Error(`OpenCode ${host} advertises the reserved default id; its selector drops the tuple`)
      if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
        throw new Error(`OpenCode ${host} has invalid or duplicate ids`)
      }
      // A conservative fix must keep the original choices selectable, rather
      // than making the negative assertion pass by deleting the whole catalog.
      for (const value of ["high", "default", "low"]) {
        if (!choices.some(([, settings]) => JSON.stringify(settings?.cursorVariantParameters) === JSON.stringify(tuple(value)))) {
          throw new Error(`OpenCode ${host} lost the original ${value} tuple`)
        }
      }
    }
    console.log(`MODEL_CONTRACT=${effort}:passed`)
  } catch (error) {
    failed = true
    console.error(`MODEL_CONTRACT=${effort}:failed ${error.message}`)
  }
}
process.exitCode = failed ? 1 : 0
