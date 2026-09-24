import { afterEach, describe, expect, it } from "bun:test"
import path from "node:path"
import {
  clearSessionDirectories,
  getSessionDirectory,
  markSessionDirectory,
  opencodeDirectoryHeader,
  resolveSessionWorkspaceRoot,
} from "../src/session-directory.js"

afterEach(() => {
  clearSessionDirectories()
})

describe("v1 / OpenCode 2.0 workspace root compatibility", () => {
  it("classic v1: empty session map uses options.workspaceRoot (input.directory)", () => {
    const project = "/workspace/my-app"
    expect(getSessionDirectory("ses_classic")).toBeUndefined()
    expect(
      resolveSessionWorkspaceRoot({
        sessionKey: "ses_classic",
        workspaceRoot: project,
        cwd: "/workspace",
      }),
    ).toBe(path.resolve(project))
  })

  it("classic v1: never consults a foreign session mark", () => {
    markSessionDirectory("ses_opencode2", "/other/project")
    const project = "/workspace/my-app"
    expect(
      resolveSessionWorkspaceRoot({
        sessionKey: "ses_classic",
        workspaceRoot: project,
        cwd: "/workspace",
      }),
    ).toBe(path.resolve(project))
  })

  it("OpenCode 2.0: session mark wins over static createSdk cwd fallback", () => {
    markSessionDirectory("ses_2", "/home/user/projects/my-app")
    expect(
      resolveSessionWorkspaceRoot({
        sessionKey: "ses_2",
        workspaceRoot: "/workspace",
        cwd: "/workspace",
      }),
    ).toBe(path.resolve("/home/user/projects/my-app"))
  })

  it("OpenCode 2.0: before context hook, falls back to options then cwd", () => {
    expect(
      resolveSessionWorkspaceRoot({
        sessionKey: "ses_new",
        workspaceRoot: "/workspace",
        cwd: "/workspace",
      }),
    ).toBe(path.resolve("/workspace"))
    expect(
      resolveSessionWorkspaceRoot({
        sessionKey: "ses_new",
        cwd: "/tmp/daemon",
      }),
    ).toBe(path.resolve("/tmp/daemon"))
  })

  it("OpenCode 2.0: x-opencode-directory header wins over session marks and fallback", () => {
    markSessionDirectory("ses_header", "/session/mark/dir")
    expect(
      resolveSessionWorkspaceRoot({
        sessionKey: "ses_header",
        workspaceRoot: "/workspace",
        cwd: "/workspace",
        headers: {
          "x-opencode-directory": encodeURIComponent("/custom/header/project"),
        },
      }),
    ).toBe(path.resolve("/custom/header/project"))
  })

  it("decodes URI-encoded headers and accepts raw absolute paths", () => {
    expect(
      opencodeDirectoryHeader({
        "x-opencode-directory": encodeURIComponent("/tmp/a b"),
      }),
    ).toBe("/tmp/a b")
    expect(
      opencodeDirectoryHeader({
        "X-Opencode-Directory": "/tmp/raw",
      }),
    ).toBe("/tmp/raw")
    expect(opencodeDirectoryHeader({ "x-opencode-directory": "  " })).toBeUndefined()
    expect(opencodeDirectoryHeader(undefined)).toBeUndefined()
  })
})
