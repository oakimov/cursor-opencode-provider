import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: 5000 })
    return stdout.trim()
  } catch {
    return ""
  }
}

export type RepoInfo = {
  relative_workspace_path: string
  remote_urls: string[]
  remote_names: string[]
  repo_name: string
  repo_owner: string
  is_tracked: boolean
  is_local: boolean
  workspace_uri: string
}

export type GitRepoInfo = {
  path: string
  status: string
  branch_name: string
  remote_url?: string
}

export async function collectGit(workspaceRoot: string): Promise<{
  repositoryInfo: RepoInfo[]
  gitRepos: GitRepoInfo[]
}> {
  const root = await git(workspaceRoot, ["rev-parse", "--show-toplevel"])
  if (!root) return { repositoryInfo: [], gitRepos: [] }

  const remotesRaw = await git(root, ["remote", "-v"])
  const remote_urls: string[] = []
  const remote_names: string[] = []
  for (const line of remotesRaw.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
    if (!m) continue
    remote_names.push(m[1]!)
    remote_urls.push(m[2]!)
  }
  const primary = remote_urls[0] ?? ""
  let repo_owner = ""
  let repo_name = path.basename(root)
  const gh = primary.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (gh) {
    repo_owner = gh[1]!
    repo_name = gh[2]!
  }

  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD"
  const status = await git(root, ["status", "--porcelain", "-b"])

  const repositoryInfo: RepoInfo[] = [
    {
      relative_workspace_path: ".",
      remote_urls,
      remote_names,
      repo_name,
      repo_owner,
      is_tracked: remote_urls.length > 0,
      is_local: remote_urls.length === 0,
      workspace_uri: `file://${root}`,
    },
  ]

  const gitRepos: GitRepoInfo[] = [
    {
      path: root,
      status: status.slice(0, 4000),
      branch_name: branch,
      ...(primary ? { remote_url: primary } : {}),
    },
  ]

  return { repositoryInfo, gitRepos }
}
