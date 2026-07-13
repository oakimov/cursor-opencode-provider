import { homedir } from "node:os"
import path from "node:path"

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

  return {
    os_version: osVersion,
    workspace_paths: [cwd],
    shell: process.env.SHELL || "/bin/bash",
    sandbox_enabled: false,
    sandbox_supported: false,
    time_zone: timeZone,
    project_folder: cwd,
    process_working_directory: process.cwd(),
    is_working_dir_home_dir: path.resolve(process.cwd()) === path.resolve(home),
  }
}
