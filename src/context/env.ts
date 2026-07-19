import { homedir } from "node:os"
import path from "node:path"
import { trace } from "../debug.js"
import { ensureOpencodeProjectDir } from "./paths.js"

export function buildEnv(workspaceRoot: string): Record<string, unknown> {
  const cwd = path.resolve(workspaceRoot)
  let timeZone = "UTC"
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    /* keep UTC */
  }
  const home = homedir()
  const osVersion = (() => {
    const p = process.platform
    const r = (process as { release?: { version?: string } }).release?.version
    return r ? `${p} ${r}` : p
  })()

  // Cursor's project_folder is a metadata root (agent-tools, terminals, …),
  // not the git workspace. Keep dumps under OpenCode cache.
  const projectFolder = ensureOpencodeProjectDir(cwd)
  const env = {
    os_version: osVersion,
    workspace_paths: [cwd],
    shell: process.env.SHELL || "/bin/bash",
    sandbox_enabled: false,
    sandbox_supported: false,
    time_zone: timeZone,
    project_folder: projectFolder,
    terminals_folder: path.join(projectFolder, "terminals"),
    agent_transcripts_folder: path.join(projectFolder, "agent-transcripts"),
    process_working_directory: process.cwd(),
    is_working_dir_home_dir: path.resolve(process.cwd()) === path.resolve(home),
  }
  trace(
    `buildEnv: workspace_paths=${JSON.stringify(env.workspace_paths)} ` +
      `project_folder=${env.project_folder} ` +
      `terminals_folder=${env.terminals_folder} ` +
      `agent_transcripts_folder=${env.agent_transcripts_folder} ` +
      `process_working_directory=${env.process_working_directory}`,
  )
  return env
}

/**
 * Real workspace root for path resolution (edits, reads, …).
 * Uses `env.workspace_paths[0]` — never `project_folder` /
 * `mcp_file_system_options.workspace_project_dir` (those are Cursor metadata roots).
 */
export function workspaceRootFromRequestContext(
  requestContext: Record<string, unknown> | undefined,
): string {
  const env = requestContext?.env
  if (env && typeof env === "object") {
    const paths = (env as Record<string, unknown>).workspace_paths
    if (Array.isArray(paths) && typeof paths[0] === "string" && paths[0].trim()) {
      const root = path.resolve(paths[0])
      trace(`workspaceRootFromRequestContext: using workspace_paths[0]=${root}`)
      return root
    }
  }
  const fallback = process.cwd()
  trace(
    `workspaceRootFromRequestContext: workspace_paths missing; fallback cwd=${fallback}`,
  )
  return fallback
}