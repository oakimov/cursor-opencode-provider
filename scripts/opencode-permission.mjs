import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

// OpenCode permission match and evaluate, from anomalyco/opencode
// commit 958f965d35ed44d32b018fd55b02a5357a7748fd:
// packages/core/src/util/wildcard.ts and packages/core/src/permission.ts.
// The installed opencode binary does not expose these functions. This file
// runs those functions so a generated config can be judged the way that
// runtime judges it: the last matching rule wins.

export function match(input, pattern) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

export function evaluate(action, resource, ...rulesets) {
  const rules = rulesets.flat()
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]
    if (match(action, rule.action) && match(resource, rule.resource)) return rule
  }
  return { action, resource: "*", effect: "ask" }
}

// Object key order is the rule order, matching migratePermissions' Object.entries.
export function rulesFromPermission(permission) {
  const rules = []
  for (const [action, raw] of Object.entries(permission)) {
    if (typeof raw === "string") {
      rules.push({ action, resource: "*", effect: raw })
      continue
    }
    for (const [resource, effect] of Object.entries(raw)) {
      rules.push({ action, resource, effect })
    }
  }
  return rules
}

function effect(configPath, action, resource) {
  const permission = JSON.parse(fs.readFileSync(configPath, "utf8")).permission
  return evaluate(action, resource, rulesFromPermission(permission)).effect
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  const [configPath, action, resource] = process.argv.slice(2)
  if (!configPath || !action || resource === undefined) {
    process.stderr.write("usage: opencode-permission.mjs CONFIG ACTION RESOURCE\n")
    process.exit(2)
  }
  process.stdout.write(`${effect(configPath, action, resource)}\n`)
}
