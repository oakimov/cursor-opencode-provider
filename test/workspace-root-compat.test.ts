import { afterEach, describe, expect, it } from "bun:test"
import path from "node:path"
import {
  clearSessionDirectories,
  getSessionDirectory,
  markSessionDirectory,
} from "../src/session-directory.js"

/**
 * Mirrors `language-model.ts` workspace root resolution so classic OpenCode 1.x
 * (`options.workspaceRoot` from `input.directory`) and OpenCode 2.0
 * (`getSessionDirectory` from `session.hook("context")`) stay compatible on the
 * shared LM path without either host clobbering the other.
 */
function resolveWorkspaceRoot(
  sessionKey: string | undefined,
  optionsWorkspaceRoot: string | undefined,
  cwd: string,
): string {
  return path.resolve(
    getSessionDirectory(sessionKey) ?? (optionsWorkspaceRoot || cwd),
  )
}

afterEach(() => {
  clearSessionDirectories()
})

describe("v1 / OpenCode 2.0 workspace root compatibility", () => {
  it("classic v1: empty session map uses options.workspaceRoot (input.directory)", () => {
    const project = "/Users/mitra/Projects/my-app"
    expect(getSessionDirectory("ses_classic")).toBeUndefined()
    expect(resolveWorkspaceRoot("ses_classic", project, "/Users/mitra")).toBe(
      path.resolve(project),
    )
  })

  it("classic v1: never consults a foreign session mark", () => {
    markSessionDirectory("ses_opencode2", "/other/project")
    const project = "/Users/mitra/Projects/my-app"
    expect(resolveWorkspaceRoot("ses_classic", project, "/Users/mitra")).toBe(
      path.resolve(project),
    )
  })

  it("OpenCode 2.0: session mark wins over static createSdk cwd fallback", () => {
    markSessionDirectory("ses_2", "/home/user/projects/my-app")
    expect(
      resolveWorkspaceRoot("ses_2", "/Users/mitra", "/Users/mitra"),
    ).toBe(path.resolve("/home/user/projects/my-app"))
  })

  it("OpenCode 2.0: before context hook, falls back to options then cwd", () => {
    expect(resolveWorkspaceRoot("ses_new", "/Users/mitra", "/Users/mitra")).toBe(
      path.resolve("/Users/mitra"),
    )
    expect(resolveWorkspaceRoot("ses_new", undefined, "/tmp/daemon")).toBe(
      path.resolve("/tmp/daemon"),
    )
  })
})
