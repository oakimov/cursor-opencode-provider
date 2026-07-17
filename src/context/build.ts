import path from "node:path"
import { toolsToDescriptors, toolsToMcpDescriptors, type OpencodeToolDef } from "../protocol/tools.js"
import { collectRules } from "./rules.js"
import { collectSkills } from "./skills.js"
import { collectAgents } from "./agents.js"
import { collectPlugins } from "./plugins.js"
import { collectGit } from "./git.js"
import { collectProjectLayout } from "./layout.js"
import { buildEnv } from "./env.js"

export type BuildRequestContextInput = {
  workspaceRoot: string
  tools?: OpencodeToolDef[]
  providerIdentifier?: string
}

/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Sourced from OpenCode discovery (and .claude/.agents skill fallbacks).
 * Honors `instructions` globs the same way OpenCode does (including `.cursor/` if listed).
 */
export async function buildRequestContext(
  input: BuildRequestContextInput,
): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd())
  const providerIdentifier = input.providerIdentifier ?? "opencode"
  const tools = input.tools ?? []

  const { rules, config, worktree } = await collectRules(workspaceRoot)
  const [skills, agents, plugins, git, layout] = await Promise.all([
    collectSkills(workspaceRoot, worktree),
    collectAgents(workspaceRoot),
    collectPlugins(workspaceRoot, config),
    collectGit(workspaceRoot),
    collectProjectLayout(workspaceRoot),
  ])

  const mcpServerNames = Object.keys(config.mcp ?? {})
  const flat = toolsToDescriptors(tools, providerIdentifier, mcpServerNames)
  const nested = toolsToMcpDescriptors(tools, providerIdentifier, mcpServerNames)

  const ctx: Record<string, unknown> = {
    env: buildEnv(workspaceRoot),
    tools: flat,
    rules: rules.map((r) => ({
      full_path: r.fullPath,
      content: r.content,
    })),
    repository_info: git.repositoryInfo,
    git_repos: git.gitRepos,
    project_layouts: [layout],
    agent_skills: skills.map((s) => ({
      full_path: s.fullPath,
      content: s.content,
      description: s.description,
    })),
    custom_subagents: agents.map((a) => ({
      full_path: a.fullPath,
      name: a.name,
      description: a.description,
      prompt: a.prompt,
    })),
    mcp_file_system_options: {
      enabled: true,
      workspace_project_dir: workspaceRoot,
      mcp_descriptors: nested,
    },
    mcp_meta_tool_options: {
      enabled: true,
      mcp_descriptors: nested,
    },
    // Completeness: true only for sections we actually gathered.
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    git_repo_info_complete: true,
    git_status_info_complete: true,
    agent_skills_info_complete: true,
    custom_subagents_info_complete: true,
    mcp_file_system_info_complete: true,
    mcp_info_complete: true,
  }

  if (plugins.length > 0) {
    ctx.hooks_additional_context = plugins
      .map((p) => `opencode-plugin:${p.source}:${p.id}`)
      .join("\n")
  }

  return ctx
}
