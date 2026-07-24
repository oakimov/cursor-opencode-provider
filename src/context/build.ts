import path from "node:path"
import {
  extractHostSubagentCatalog,
  toolsToDescriptors,
  toolsToMcpDescriptors,
  type HostSubagentDefinition,
  type OpencodeToolDef,
} from "../protocol/tools.js"
import { collectRules } from "./rules.js"
import { collectSkills } from "./skills.js"
import { collectAgents } from "./agents.js"
import { collectPlugins } from "./plugins.js"
import { collectGit } from "./git.js"
import { collectProjectLayout } from "./layout.js"
import { buildEnv } from "./env.js"
import { ensureOpencodeProjectDir } from "./paths.js"
import { traceRequestContextPaths } from "../debug.js"

export type BuildRequestContextInput = {
  workspaceRoot: string
  tools?: OpencodeToolDef[]
  providerIdentifier?: string
}

const DEFAULT_HOST_SUBAGENTS: HostSubagentDefinition[] = [
  {
    name: "general",
    description: "General-purpose agent for complex research and multi-step tasks.",
  },
  {
    name: "explore",
    description: "Read-only agent for searching and understanding the local codebase.",
  },
]

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
  const projectDir = ensureOpencodeProjectDir(workspaceRoot)
  const hostSubagents = extractHostSubagentCatalog(tools)
  const discoveredByName = new Map(agents.map((agent) => [agent.name, agent]))
  const advertisedByName = new Map<string, HostSubagentDefinition>()
  if (hostSubagents.executor) {
    const source = hostSubagents.complete
      ? hostSubagents.agents
      : [...DEFAULT_HOST_SUBAGENTS, ...hostSubagents.agents, ...agents]
    for (const agent of source) {
      if (!advertisedByName.has(agent.name)) advertisedByName.set(agent.name, agent)
    }
  }
  const customSubagents = [...advertisedByName.values()].map((agent) => {
    const discovered = discoveredByName.get(agent.name)
    return {
      full_path: discovered?.fullPath ?? "",
      name: agent.name,
      description: discovered?.description || agent.description || "Host-configured subagent.",
      // The host applies the real configured prompt when Task/Actor executes.
      // Cursor only needs enough context to select the recipient intentionally.
      prompt: discovered?.prompt ||
        `Delegate to the host-configured ${agent.name} subagent; its host instructions and tools apply.`,
    }
  })

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
    custom_subagents: customSubagents,
    mcp_file_system_options: {
      enabled: true,
      // Cursor metadata root (mcps / agent-tools), not the git workspace.
      workspace_project_dir: projectDir,
      mcp_descriptors: nested,
    },
    mcp_meta_tool_options: {
      enabled: true,
      mcp_descriptors: nested,
    },
    // This provider always rejects native web_search/web_fetch interaction
    // queries with a headless-UI reason (see interactions.ts). Advertise that
    // unavailability up front so Cursor prefers the collision-safe
    // custom_web* aliases instead of routing through a query doomed to fail.
    web_search_enabled: false,
    web_fetch_enabled: false,
    // Completeness: true only for sections we actually gathered.
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    git_repo_info_complete: true,
    git_status_info_complete: true,
    agent_skills_info_complete: true,
    custom_subagents_info_complete: hostSubagents.complete,
    mcp_file_system_info_complete: true,
    mcp_info_complete: true,
  }

  if (plugins.length > 0) {
    ctx.hooks_additional_context = plugins
      .map((p) => `opencode-plugin:${p.source}:${p.id}`)
      .join("\n")
  }

  traceRequestContextPaths("buildRequestContext", ctx)
  return ctx
}
